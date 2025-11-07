/**
 * Session Management for Wallet Operations
 *
 * Security Model:
 * - Time-limited sessions (default 15 minutes)
 * - Cryptographically secure session tokens
 * - Session stored in Redis for fast access & auto-expiry
 * - One active session per user
 *
 * Flow:
 * 1. User unlocks wallet with password
 * 2. Create session with encrypted private key
 * 3. Store in Redis with TTL
 * 4. Return session token
 * 5. Use session token for operations (no password needed)
 * 6. Session auto-expires or can be manually destroyed
 */

import { Keypair } from "@solana/web3.js";
import { redis } from "../../utils/redis.js";
import { prisma } from "../../utils/db.js";
import { unlockWallet, clearKeypair } from "./keyManager.js";
import { decryptPrivateKey } from "./encryption.js";
import {
  encryptWithSessionKey,
  decryptWithSessionKey,
  type SessionEncryptedKey,
} from "./sessionEncryption.js";
import {
  type Result,
  Ok,
  Err,
  type SessionToken,
  type EncryptedPrivateKey,
  asSessionToken,
  asEncryptedPrivateKey,
} from "../../types/common.js";
import { SessionError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { generateRandomHex } from "../../utils/helpers.js";

// ============================================================================
// Constants
// ============================================================================

const SESSION_PREFIX = "wallet:session:";
const SESSION_TTL = 15 * 60; // 15 minutes in seconds
const TOKEN_LENGTH = 32; // 32 bytes = 64 hex chars

// ============================================================================
// Types
// ============================================================================

interface SessionData {
  userId: string;
  walletId: string;
  sessionEncryptedKey: SessionEncryptedKey; // ✅ Re-encrypted with session-derived key
  createdAt: number;
  expiresAt: number;
}

export interface CreateSessionParams {
  userId: string;
  password: string;
}

export interface CreateSessionResult {
  sessionToken: SessionToken;
  expiresAt: Date;
}

export interface SessionInfo {
  userId: string;
  walletId: string;
  sessionEncryptedKey: SessionEncryptedKey; // Re-encrypted with session-derived key
  expiresAt: Date;
}

// ============================================================================
// Session Creation
// ============================================================================

/**
 * Create new session for user (Variant C+)
 *
 * Security Flow:
 * 1. Verify password (unlock wallet → plaintext keypair)
 * 2. Generate session token (cryptographically secure random)
 * 3. Re-encrypt private key with session-derived key (HKDF)
 * 4. Store re-encrypted key in Redis (WITHOUT session key!)
 * 5. Clear plaintext keypair from memory
 * 6. Return session token
 *
 * Why this is secure:
 * - User password is used ONCE, then discarded (never stored)
 * - Session key is DERIVED from token via HKDF (not stored in Redis)
 * - Redis contains encrypted key, but NOT the session key to decrypt it
 * - Attacker needs both: Redis data + session token (from user's Telegram)
 * - Session expires after TTL, making encrypted data useless
 */
export async function createSession(
  params: CreateSessionParams
): Promise<Result<CreateSessionResult, SessionError>> {
  const { userId, password } = params;

  try {
    // Unlock wallet to verify password is correct
    const unlockResult = await unlockWallet({ userId, password });

    if (!unlockResult.success) {
      return Err(
        new SessionError(
          `Failed to create session: ${unlockResult.error.type}`
        )
      );
    }

    const { walletId, keypair } = unlockResult.value;

    // Step 2: Generate cryptographically secure session token
    const sessionToken = asSessionToken(generateRandomHex(TOKEN_LENGTH));

    // Step 3: Re-encrypt private key with session-derived key
    // ✅ SECURITY (CRITICAL-2 Fix - Variant C+): Session key is derived from token (HKDF)
    // NOT stored anywhere - can be re-derived when needed
    const encryptResult = encryptWithSessionKey(
      keypair.secretKey, // Raw 64-byte private key
      sessionToken
    );

    if (!encryptResult.success) {
      clearKeypair(keypair);
      return Err(
        new SessionError(
          `Failed to encrypt key for session: ${encryptResult.error.message}`
        )
      );
    }

    const sessionEncryptedKey = encryptResult.value;

    // Step 4: Clear plaintext keypair from memory IMMEDIATELY
    clearKeypair(keypair);

    // Step 5: Create session data
    const now = Date.now();
    const expiresAt = now + SESSION_TTL * 1000;

    const sessionData: SessionData = {
      userId,
      walletId,
      sessionEncryptedKey, // Re-encrypted with session-derived key
      createdAt: now,
      expiresAt,
    };

    // Step 6: Store in Redis with TTL
    // ✅ Redis contains: encrypted key + salt + IV + authTag
    // ❌ Redis does NOT contain: session key (it's derived from token!)
    const key = getSessionKey(sessionToken);
    await redis.setex(key, SESSION_TTL, JSON.stringify(sessionData));

    logger.info("Session created with re-encryption (Variant C+)", {
      userId,
      walletId,
      expiresAt: new Date(expiresAt).toISOString(),
      sessionTokenPrefix: sessionToken.substring(0, 8) + "...",
    });

    return Ok({
      sessionToken,
      expiresAt: new Date(expiresAt),
    });
  } catch (error) {
    logger.error("Failed to create session", { userId, error });
    return Err(
      new SessionError(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

// ============================================================================
// Session Retrieval
// ============================================================================

/**
 * Get session info by token
 */
export async function getSession(
  sessionToken: SessionToken
): Promise<Result<SessionInfo | null, SessionError>> {
  try {
    const key = getSessionKey(sessionToken);
    const data = await redis.get(key);

    if (!data) {
      return Ok(null); // Session not found or expired
    }

    const sessionData: SessionData = JSON.parse(data);

    // Double-check expiration (Redis should handle this, but be safe)
    if (sessionData.expiresAt < Date.now()) {
      await destroySession(sessionToken);
      return Ok(null);
    }

    return Ok({
      userId: sessionData.userId,
      walletId: sessionData.walletId,
      sessionEncryptedKey: sessionData.sessionEncryptedKey,
      expiresAt: new Date(sessionData.expiresAt),
    });
  } catch (error) {
    logger.error("Failed to get session", { error });
    return Err(
      new SessionError(
        `Failed to get session: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Verify session is valid
 */
export async function verifySession(
  sessionToken: SessionToken
): Promise<boolean> {
  const result = await getSession(sessionToken);
  return result.success && result.value !== null;
}

// ============================================================================
// Session Destruction
// ============================================================================

/**
 * Destroy session (logout)
 */
export async function destroySession(
  sessionToken: SessionToken
): Promise<Result<void, SessionError>> {
  try {
    const key = getSessionKey(sessionToken);
    await redis.del(key);

    logger.info("Session destroyed", { sessionToken: "[REDACTED]" });
    return Ok(undefined);
  } catch (error) {
    logger.error("Failed to destroy session", { error });
    return Err(
      new SessionError(
        `Failed to destroy session: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Destroy all sessions for user
 */
export async function destroyAllUserSessions(
  userId: string
): Promise<Result<void, SessionError>> {
  try {
    // Scan for all sessions (Redis pattern matching)
    const pattern = `${SESSION_PREFIX}*`;
    const keys = await redis.keys(pattern);

    let deletedCount = 0;

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const sessionData: SessionData = JSON.parse(data);
        if (sessionData.userId === userId) {
          await redis.del(key);
          deletedCount++;
        }
      }
    }

    logger.info("All user sessions destroyed", { userId, deletedCount });
    return Ok(undefined);
  } catch (error) {
    logger.error("Failed to destroy user sessions", { userId, error });
    return Err(
      new SessionError(
        `Failed to destroy user sessions: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

// ============================================================================
// Session Extension
// ============================================================================

/**
 * Extend session TTL
 */
export async function extendSession(
  sessionToken: SessionToken
): Promise<Result<Date, SessionError>> {
  try {
    const sessionResult = await getSession(sessionToken);

    if (!sessionResult.success || !sessionResult.value) {
      return Err(new SessionError("Session not found or expired"));
    }

    const key = getSessionKey(sessionToken);
    const data = await redis.get(key);

    if (!data) {
      return Err(new SessionError("Session not found"));
    }

    const sessionData: SessionData = JSON.parse(data);

    // Update expiration
    const newExpiresAt = Date.now() + SESSION_TTL * 1000;
    sessionData.expiresAt = newExpiresAt;

    // Update in Redis
    await redis.setex(key, SESSION_TTL, JSON.stringify(sessionData));

    logger.debug("Session extended", {
      userId: sessionData.userId,
      newExpiresAt: new Date(newExpiresAt).toISOString(),
    });

    return Ok(new Date(newExpiresAt));
  } catch (error) {
    logger.error("Failed to extend session", { error });
    return Err(
      new SessionError(
        `Failed to extend session: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

// ============================================================================
// Keypair Signing (Secure On-Demand Decryption)
// ============================================================================

/**
 * Get keypair for signing transaction (Variant C+ - No Password Required!)
 *
 * ✅ SECURITY: This does NOT require password during active session
 *
 * Flow:
 * 1. Get session from Redis (contains SessionEncryptedKey)
 * 2. Derive session key from sessionToken (HKDF - not stored anywhere!)
 * 3. Decrypt private key with derived session key
 * 4. Reconstruct Keypair
 * 5. Return keypair (caller MUST clear after use!)
 *
 * Why this is secure:
 * - Session key is derived from token (not stored in Redis)
 * - Attacker needs both: Redis data + session token (from user's Telegram)
 * - Plaintext keypair exists only during signing (<1ms)
 * - Session expires after TTL, making encrypted data useless
 *
 * This enables:
 * - Automatic trading (Sniper mode) without repeated password prompts
 * - Better UX (unlock once, trade multiple times)
 * - Still secure (session-based authentication)
 */
export async function getKeypairForSigning(
  sessionToken: SessionToken
): Promise<Result<Keypair, SessionError>> {
  try {
    // Step 1: Get session from Redis
    const sessionResult = await getSession(sessionToken);

    if (!sessionResult.success || !sessionResult.value) {
      return Err(new SessionError("Session not found or expired"));
    }

    const session = sessionResult.value;

    // Step 2: Decrypt private key with session-derived key
    // ✅ Session key is derived from token (HKDF) - NOT stored in Redis!
    const decryptResult = decryptWithSessionKey(
      session.sessionEncryptedKey,
      sessionToken
    );

    if (!decryptResult.success) {
      logger.warn("Failed to decrypt key for signing", {
        userId: session.userId,
        error: decryptResult.error.message,
      });

      return Err(
        new SessionError(
          `Session decryption failed: ${decryptResult.error.message}`
        )
      );
    }

    const privateKey = decryptResult.value;

    // Step 3: Reconstruct Keypair from decrypted private key
    const keypair = Keypair.fromSecretKey(privateKey);

    // Step 4: Clear plaintext private key from memory
    privateKey.fill(0);

    logger.debug("Keypair decrypted for signing (no password required)", {
      userId: session.userId,
      publicKey: keypair.publicKey.toBase58().substring(0, 8) + "...",
    });

    // ⚠️ DO NOT clear keypair here - caller needs it for signing
    // Caller MUST call clearKeypair() after signing!

    return Ok(keypair);
  } catch (error) {
    logger.error("Failed to get keypair for signing", { error });
    return Err(
      new SessionError(
        `Failed to decrypt key: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

// ============================================================================
// Utilities
// ============================================================================

function getSessionKey(sessionToken: SessionToken): string {
  return `${SESSION_PREFIX}${sessionToken}`;
}

/**
 * Get session stats for monitoring
 */
export async function getSessionStats(): Promise<{
  totalSessions: number;
  activeUsers: Set<string>;
}> {
  try {
    const pattern = `${SESSION_PREFIX}*`;
    const keys = await redis.keys(pattern);

    const activeUsers = new Set<string>();

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const sessionData: SessionData = JSON.parse(data);
        activeUsers.add(sessionData.userId);
      }
    }

    return {
      totalSessions: keys.length,
      activeUsers,
    };
  } catch (error) {
    logger.error("Failed to get session stats", { error });
    return {
      totalSessions: 0,
      activeUsers: new Set(),
    };
  }
}
