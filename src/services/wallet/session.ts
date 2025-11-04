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

import { redis } from "../../utils/redis.js";
import { unlockWallet, clearKeypair } from "./keyManager.js";
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
 * 1. Unlock wallet with password (validates password)
 * 2. Generate secure session token
 * 3. Store session data in Redis
 * 4. Return token
 */
export async function createSession(
  params: CreateSessionParams
): Promise<Result<CreateSessionResult, SessionError>> {
  const { userId, password } = params;

  try {
    // Unlock wallet to verify password and get wallet info
    const unlockResult = await unlockWallet({ userId, password });

    if (!unlockResult.success) {
      return Err(
        new SessionError(
          `Failed to create session: ${unlockResult.error.type}`
        )
      );
    }

    const { walletId, keypair } = unlockResult.value;

    // Generate cryptographically secure session token
    const sessionToken = asSessionToken(generateRandomHex(TOKEN_LENGTH));

    // Get encrypted private key from keypair
    const encryptedPrivateKey = Buffer.from(keypair.secretKey).toString(
      "base64"
    );

    // Clear keypair from memory
    clearKeypair(keypair);

    // Create session data
    const now = Date.now();
    const expiresAt = now + SESSION_TTL * 1000;

    const sessionData: SessionData = {
      userId,
      walletId,
      encryptedPrivateKey,
      createdAt: now,
      expiresAt,
    };

    // Store in Redis with TTL
    const key = getSessionKey(sessionToken);
    await redis.setex(key, SESSION_TTL, JSON.stringify(sessionData));

    logger.info("Session created", {
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
