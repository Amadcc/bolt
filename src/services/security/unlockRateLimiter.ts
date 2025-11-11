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

export async function recordUnlockFailure(
  userId: string
): Promise<{ attempts: number; retryAfterSeconds: number }> {
  const key = buildKey(userId);
  const attempts = await redis.incr(key);

  if (attempts === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  let ttl = await redis.ttl(key);
  if (ttl < 0) {
    await redis.expire(key, WINDOW_SECONDS);
    ttl = WINDOW_SECONDS;
  }

  logger.warn("Recorded unlock failure", {
    userId,
    attempts,
    retryAfterSeconds: ttl,
  });

  return { attempts, retryAfterSeconds: ttl };
}

export async function clearUnlockFailures(userId: string): Promise<void> {
  const key = buildKey(userId);
  await redis.del(key);
}
