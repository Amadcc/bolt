import type { SnipeConfig } from "@prisma/client";
import { redis } from "../../utils/redis.js";
import { Err, Ok, type Result } from "../../types/common.js";
import { recordSnipeRateLimitHit } from "../../utils/metrics.js";

const HOUR_WINDOW_SECONDS = 3600;
const DAY_WINDOW_SECONDS = 86400;
const HOUR_KEY_PREFIX = "snipe:hour:";
const DAY_KEY_PREFIX = "snipe:day:";

// Lua script for atomic increment with TTL
// This prevents the race condition where app crashes between INCR and EXPIRE
const INCR_WITH_TTL_SCRIPT = `
  local current = redis.call('incr', KEYS[1])
  if current == 1 then
    redis.call('expire', KEYS[1], ARGV[1])
  end
  return current
`;

async function incrementWithLimit(
  key: string,
  ttlSeconds: number,
  limit: number
): Promise<{ allowed: boolean; count: number }> {
  // Use Lua script to ensure atomicity between increment and expire
  const count = (await redis.eval(
    INCR_WITH_TTL_SCRIPT,
    1,
    key,
    ttlSeconds
  )) as number;

  return {
    allowed: count <= limit,
    count,
  };
}

export async function enforceRateLimits(
  userId: string,
  config: SnipeConfig
): Promise<Result<void, string>> {
  if (config.maxBuysPerHour > 0) {
    const hourKey = `${HOUR_KEY_PREFIX}${userId}`;
    const hourResult = await incrementWithLimit(
      hourKey,
      HOUR_WINDOW_SECONDS,
      config.maxBuysPerHour
    );

    if (!hourResult.allowed) {
      recordSnipeRateLimitHit("hourly");
      return Err(
        `Hourly auto-trade limit reached (${config.maxBuysPerHour}/hour).`
      );
    }
  }

  if (config.maxBuysPerDay > 0) {
    const dayKey = `${DAY_KEY_PREFIX}${userId}`;
    const dayResult = await incrementWithLimit(
      dayKey,
      DAY_WINDOW_SECONDS,
      config.maxBuysPerDay
    );

    if (!dayResult.allowed) {
      recordSnipeRateLimitHit("daily");
      return Err(
        `Daily auto-trade limit reached (${config.maxBuysPerDay}/day).`
      );
    }
  }

  return Ok(undefined);
}

/**
 * Decrement rate limit counters (e.g., when a snipe is rejected before execution).
 * This prevents failed/skipped snipes from counting against user limits.
 */
export async function decrementRateCounters(
  userId: string,
  config: SnipeConfig
): Promise<void> {
  const promises: Promise<unknown>[] = [];

  if (config.maxBuysPerHour > 0) {
    const hourKey = `${HOUR_KEY_PREFIX}${userId}`;
    promises.push(redis.decr(hourKey));
  }

  if (config.maxBuysPerDay > 0) {
    const dayKey = `${DAY_KEY_PREFIX}${userId}`;
    promises.push(redis.decr(dayKey));
  }

  await Promise.all(promises);
}

export async function resetRateCounters(userId: string): Promise<void> {
  await redis.del(`${HOUR_KEY_PREFIX}${userId}`);
  await redis.del(`${DAY_KEY_PREFIX}${userId}`);
}
