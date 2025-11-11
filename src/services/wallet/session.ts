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
import { redis, scanKeys } from "../../utils/redis.js";
import { prisma } from "../../utils/db.js";
import { unlockWallet, clearKeypair } from "./keyManager.js";
import { decryptPrivateKey } from "./encryption.js";
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
import {
  decrementActiveSessions,
  incrementActiveSessions,
  incrementWalletUnlockFailures,
} from "../../utils/metrics.js";

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
  encryptedPrivateKey: string;
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
  encryptedPrivateKey: EncryptedPrivateKey;
  expiresAt: Date;
}

// ============================================================================
// Session Creation
// ============================================================================

/**
 * Create new session for user
 *
 * Flow:
 * 1. Unlock wallet with password (validates password only)
 * 2. Get wallet from DB to retrieve encrypted key
 * 3. Generate secure session token
 * 4. Store session data in Redis (with ENCRYPTED key from DB, not plaintext!)
 * 5. Return token
 */
export async function createSession(
  params: CreateSessionParams
): Promise<Result<CreateSessionResult, SessionError>> {
  const { userId, password } = params;

  try {
    // Unlock wallet to verify password is correct
    const unlockResult = await unlockWallet({ userId, password });

    if (!unlockResult.success) {
      const walletError = unlockResult.error;
      if (walletError && walletError.type === "INVALID_PASSWORD") {
        incrementWalletUnlockFailures();
      }
      return Err(
        new SessionError(
          `Failed to create session: ${unlockResult.error.type}`
        )
      );
    }

    const { walletId, keypair } = unlockResult.value;

    // ✅ SECURITY FIX: Get wallet from DB to retrieve ENCRYPTED private key
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      clearKeypair(keypair);
      return Err(new SessionError("Wallet not found in database"));
    }

    // Generate cryptographically secure session token
    const sessionToken = asSessionToken(generateRandomHex(TOKEN_LENGTH));

    // ✅ SECURITY FIX: Store ENCRYPTED key from DB, NOT plaintext
    // Old (UNSAFE): Buffer.from(keypair.secretKey).toString("base64")
    // New (SAFE): wallet.encryptedPrivateKey (already encrypted with Argon2id+AES-256-GCM)
    const encryptedPrivateKey = wallet.encryptedPrivateKey;

    // Clear plaintext keypair from memory immediately
    clearKeypair(keypair);

    // Create session data
    const now = Date.now();
    const expiresAt = now + SESSION_TTL * 1000;

    const sessionData: SessionData = {
      userId,
      walletId,
      encryptedPrivateKey, // Now contains REAL encrypted key from DB
      createdAt: now,
      expiresAt,
    };

  // Store in Redis with TTL
  const key = getSessionKey(sessionToken);
  await redis.setex(key, SESSION_TTL, JSON.stringify(sessionData));
  incrementActiveSessions();

    logger.info("Session created securely", {
      userId,
      walletId,
      expiresAt: new Date(expiresAt).toISOString(),
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
      encryptedPrivateKey: asEncryptedPrivateKey(
        sessionData.encryptedPrivateKey
      ),
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
    const deleted = await redis.del(key);
    if (deleted > 0) {
      decrementActiveSessions();
    }

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
    // ✅ PERFORMANCE FIX: Use non-blocking SCAN instead of blocking KEYS
    // Old: redis.keys() - O(N), blocks Redis entire time
    // New: scanKeys() - O(N), cursor-based iteration, no blocking
    const pattern = `${SESSION_PREFIX}*`;
    const keys = await scanKeys(pattern);

    let deletedCount = 0;

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const sessionData: SessionData = JSON.parse(data);
        if (sessionData.userId === userId) {
          const removed = await redis.del(key);
          if (removed > 0) {
            deletedCount++;
            decrementActiveSessions();
          }
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
 * Get keypair for signing transaction
 *
 * ⚠️ SECURITY: This requires password for EVERY signing operation
 *
 * Flow:
 * 1. Get session from Redis
 * 2. Decrypt encrypted private key with password
 * 3. Reconstruct Keypair
 * 4. Return keypair (caller MUST clear after use!)
 *
 * This is the ONLY way to get plaintext keys from a session.
 * Keys are decrypted on-demand and never stored in plaintext.
 */
export async function getKeypairForSigning(
  sessionToken: SessionToken,
  password: string
): Promise<Result<Keypair, SessionError>> {
  try {
    // Get session
    const sessionResult = await getSession(sessionToken);

    if (!sessionResult.success || !sessionResult.value) {
      return Err(new SessionError("Session not found or expired"));
    }

    const session = sessionResult.value;

    // Decrypt private key with password
    const decryptResult = await decryptPrivateKey(
      session.encryptedPrivateKey,
      password
    );

    if (!decryptResult.success) {
      logger.warn("Failed to decrypt key for signing", {
        userId: session.userId,
        error: decryptResult.error.message,
      });

      return Err(
        new SessionError(
          `Invalid password: ${decryptResult.error.message}`
        )
      );
    }

    const privateKey = decryptResult.value;

    // Reconstruct Keypair
    const keypair = Keypair.fromSecretKey(privateKey);

    logger.debug("Keypair decrypted for signing", {
      userId: session.userId,
      publicKey: keypair.publicKey.toBase58(),
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
    // ✅ PERFORMANCE FIX: Use non-blocking SCAN instead of blocking KEYS
    const pattern = `${SESSION_PREFIX}*`;
    const keys = await scanKeys(pattern);

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
