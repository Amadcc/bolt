import { redis } from "../../utils/redis.js";
import { logger } from "../../utils/logger.js";

const RATE_LIMIT_KEY_PREFIX = "unlock:attempts:";
export const MAX_UNLOCK_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60; // 15 minutes

function buildKey(userId: string): string {
  return `${RATE_LIMIT_KEY_PREFIX}${userId}`;
}

export interface UnlockRateLimitStatus {
  blocked: boolean;
  retryAfterSeconds: number | null;
  attempts: number;
}

export async function isUnlockRateLimited(
  userId: string
): Promise<UnlockRateLimitStatus> {
  const key = buildKey(userId);
  const rawAttempts = await redis.get(key);
  const attempts = rawAttempts ? Number(rawAttempts) : 0;

  if (attempts < MAX_UNLOCK_ATTEMPTS) {
    return { blocked: false, retryAfterSeconds: null, attempts };
  }

  const ttl = await redis.ttl(key);
  const retryAfterSeconds = ttl > 0 ? ttl : WINDOW_SECONDS;

  return {
    blocked: true,
    retryAfterSeconds,
    attempts,
  };
}

/**
 * Atomically increments unlock failure counter and checks if rate limited.
 * MUST be called BEFORE attempting unlock to prevent race conditions.
 *
 * @returns attempts count and whether blocked (true if >= MAX_UNLOCK_ATTEMPTS)
 */
export async function recordUnlockFailure(
  userId: string
): Promise<{ attempts: number; retryAfterSeconds: number; blocked: boolean }> {
  const key = buildKey(userId);

  // Atomic INCR - prevents race conditions on concurrent requests
  const attempts = await redis.incr(key);

  // Set TTL only on first attempt
  if (attempts === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  // Get remaining TTL
  let ttl = await redis.ttl(key);
  if (ttl < 0) {
    // Fallback: if TTL was lost somehow, reset it
    await redis.expire(key, WINDOW_SECONDS);
    ttl = WINDOW_SECONDS;
  }

  const blocked = attempts >= MAX_UNLOCK_ATTEMPTS;

  if (blocked) {
    logger.warn("Unlock blocked due to rate limit", {
      userId,
      attempts,
      retryAfterSeconds: ttl,
    });
  } else {
    logger.warn("Recorded unlock failure", {
      userId,
      attempts,
      remainingAttempts: MAX_UNLOCK_ATTEMPTS - attempts,
      retryAfterSeconds: ttl,
    });
  }

  return { attempts, retryAfterSeconds: ttl, blocked };
}

export async function clearUnlockFailures(userId: string): Promise<void> {
  const key = buildKey(userId);
  await redis.del(key);
}
