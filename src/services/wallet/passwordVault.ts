/**
 * Temporary password vault stored in Redis.
 * Keeps plaintext passwords out of Grammy sessions and memory dumps.
 */

import { redis } from "../../utils/redis.js";
import { logger } from "../../utils/logger.js";
import { SessionError } from "../../utils/errors.js";
import { Err, Ok, type Result, type SessionToken } from "../../types/common.js";

const PASSWORD_KEY_PREFIX = "wallet:pw:";

// Strict mode: password consumed after single use (default, most secure)
export const PASSWORD_TTL_SECONDS = 120; // 2 minutes
export const PASSWORD_TTL_MS = PASSWORD_TTL_SECONDS * 1000;

// Reuse mode: password persists for multiple trades (opt-in, convenience vs security)
export const PASSWORD_REUSE_TTL_SECONDS = Number(
  process.env.PASSWORD_REUSE_TTL_SECONDS || "900"
); // 15 minutes
export const PASSWORD_REUSE_TTL_MS = PASSWORD_REUSE_TTL_SECONDS * 1000;

function buildKey(sessionToken: SessionToken): string {
  return `${PASSWORD_KEY_PREFIX}${sessionToken}`;
}

function maskToken(sessionToken: SessionToken): string {
  return `${String(sessionToken).slice(0, 6)}***`;
}

/**
 * Store password in Redis with configurable TTL.
 *
 * @param sessionToken - Session identifier
 * @param password - Plaintext password (cleared from caller's memory immediately)
 * @param options.ttlSeconds - Custom TTL (defaults to strict 2-minute mode)
 */
export async function storePasswordTemporary(
  sessionToken: SessionToken,
  password: string,
  options?: { ttlSeconds?: number }
): Promise<Result<void, SessionError>> {
  try {
    const ttl = options?.ttlSeconds ?? PASSWORD_TTL_SECONDS;

    await redis.setex(buildKey(sessionToken), ttl, password);

    logger.debug("Stored session password in Redis", {
      sessionToken: maskToken(sessionToken),
      ttlSeconds: ttl,
      mode: ttl > PASSWORD_TTL_SECONDS ? "reuse" : "strict",
    });

    return Ok(undefined);
  } catch (error) {
    logger.error("Failed to store password in Redis", {
      error,
      sessionToken: maskToken(sessionToken),
    });

    return Err(
      new SessionError(
        `Unable to store password securely: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Fetch password from Redis with optional consumption.
 *
 * @param sessionToken - Session identifier
 * @param options.consume - If true (default), deletes password after read (strict mode).
 *                          If false, leaves password in Redis for reuse (opt-in convenience).
 * @returns Password string or null if expired/missing
 */
export async function getPasswordTemporary(
  sessionToken: SessionToken,
  options?: { consume?: boolean }
): Promise<Result<string | null, SessionError>> {
  const key = buildKey(sessionToken);
  const consume = options?.consume ?? true; // Default: strict single-use mode

  try {
    const password = await redis.get(key);

    if (!password) {
      return Ok(null);
    }

    if (consume) {
      // Strict mode: delete after reading (default, most secure)
      await redis.del(key);

      logger.debug("Retrieved and deleted session password from Redis", {
        sessionToken: maskToken(sessionToken),
        mode: "strict",
      });
    } else {
      // Reuse mode: keep password in Redis for subsequent trades
      logger.debug("Retrieved session password from Redis (reuse mode)", {
        sessionToken: maskToken(sessionToken),
        mode: "reuse",
      });
    }

    return Ok(password);
  } catch (error) {
    logger.error("Failed to fetch password from Redis", {
      error,
      sessionToken: maskToken(sessionToken),
    });

    return Err(
      new SessionError(
        `Unable to fetch password securely: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Delete password without reading it (used when locking session manually).
 */
export async function deletePasswordTemporary(
  sessionToken: SessionToken
): Promise<Result<boolean, SessionError>> {
  const key = buildKey(sessionToken);

  try {
    const deleted = await redis.del(key);

    if (deleted > 0) {
      logger.debug("Deleted temporary password from Redis", {
        sessionToken: maskToken(sessionToken),
      });
    }

    return Ok(deleted > 0);
  } catch (error) {
    logger.error("Failed to delete temporary password", {
      error,
      sessionToken: maskToken(sessionToken),
    });

    return Err(
      new SessionError(
        `Unable to delete password securely: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}
