/**
 * Temporary password vault stored in Redis.
 * Keeps plaintext passwords out of Grammy sessions and memory dumps.
 */

import { redis } from "../../utils/redis.js";
import { logger } from "../../utils/logger.js";
import { SessionError } from "../../utils/errors.js";
import { Err, Ok, type Result, type SessionToken } from "../../types/common.js";

const PASSWORD_KEY_PREFIX = "wallet:pw:";
export const PASSWORD_TTL_SECONDS = 120; // 2 minutes
export const PASSWORD_TTL_MS = PASSWORD_TTL_SECONDS * 1000;

function buildKey(sessionToken: SessionToken): string {
  return `${PASSWORD_KEY_PREFIX}${sessionToken}`;
}

function maskToken(sessionToken: SessionToken): string {
  return `${String(sessionToken).slice(0, 6)}***`;
}

/**
 * Store password in Redis with short TTL.
 */
export async function storePasswordTemporary(
  sessionToken: SessionToken,
  password: string
): Promise<Result<void, SessionError>> {
  try {
    await redis.setex(buildKey(sessionToken), PASSWORD_TTL_SECONDS, password);

    logger.debug("Stored session password in Redis", {
      sessionToken: maskToken(sessionToken),
      ttlSeconds: PASSWORD_TTL_SECONDS,
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
 * Fetch password once and immediately delete it.
 */
export async function getPasswordTemporary(
  sessionToken: SessionToken
): Promise<Result<string | null, SessionError>> {
  const key = buildKey(sessionToken);

  try {
    const password = await redis.get(key);

    if (!password) {
      return Ok(null);
    }

    await redis.del(key);

    logger.debug("Retrieved and deleted session password from Redis", {
      sessionToken: maskToken(sessionToken),
    });

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
