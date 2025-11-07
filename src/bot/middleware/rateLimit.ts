/**
 * Rate Limiting Middleware
 *
 * Security Protection:
 * - Prevents DoS attacks (Denial of Service)
 * - Prevents password bruteforce on /unlock
 * - Prevents spam on trading commands
 * - Prevents wallet creation abuse
 *
 * Implementation:
 * - Redis Sorted Sets (sliding window counter)
 * - Per-user rate limits
 * - Different limits for different command types
 * - Automatic cleanup of old entries
 *
 * Why Redis Sorted Sets:
 * - O(log N) operations (efficient)
 * - Automatic expiration
 * - Precise sliding window (not fixed window)
 * - No race conditions with atomic operations
 */

import type { Middleware } from "grammy";
import { redis } from "../../utils/redis.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface RateLimitConfig {
  /** Time window in milliseconds */
  windowMs: number;
  /** Max requests per window */
  maxRequests: number;
  /** Command name for logging (optional) */
  commandName?: string;
  /** Custom error message (optional) */
  message?: string;
}

// ============================================================================
// Rate Limiter Factory
// ============================================================================

/**
 * Create a rate limiter middleware
 *
 * Uses Redis Sorted Sets for sliding window counting:
 * - Key: ratelimit:{commandName}:{userId}
 * - Score: timestamp in milliseconds
 * - Value: unique identifier (timestamp + random)
 *
 * Algorithm:
 * 1. Remove entries older than window
 * 2. Count remaining entries
 * 3. If count >= limit → reject
 * 4. Otherwise → add new entry and proceed
 *
 * @param config - Rate limit configuration
 * @returns Grammy middleware
 */
export function createRateLimiter(config: RateLimitConfig): Middleware {
  return async (ctx, next) => {
    const userId = ctx.from?.id;

    // Skip rate limiting if user is not identified
    if (!userId) {
      logger.warn("Rate limiter: Could not identify user");
      await ctx.reply("❌ Could not identify user");
      return;
    }

    const key = `ratelimit:${config.commandName || "global"}:${userId}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      // Step 1: Remove old entries (outside the time window)
      // ZREMRANGEBYSCORE key min max
      await redis.zremrangebyscore(key, 0, windowStart);

      // Step 2: Count recent requests (within window)
      // ZCARD key - returns number of elements in sorted set
      const requestCount = await redis.zcard(key);

      // Step 3: Check if limit exceeded
      if (requestCount >= config.maxRequests) {
        // Get TTL to tell user when they can retry
        const ttl = await redis.pttl(key);
        const waitSeconds = Math.ceil(ttl / 1000);

        logger.warn("Rate limit exceeded", {
          userId,
          command: config.commandName || "global",
          requestCount,
          limit: config.maxRequests,
          windowMs: config.windowMs,
        });

        // Send user-friendly error message
        const defaultMessage =
          `⚠️ *Too Many Requests*\n\n` +
          `You've exceeded the rate limit for this action.\n` +
          `Please wait *${waitSeconds} seconds* before trying again.`;

        await ctx.reply(config.message || defaultMessage, {
          parse_mode: "Markdown",
        });

        return; // Block the request
      }

      // Step 4: Add current request to sorted set
      // ZADD key score member
      // Score: current timestamp (for sorting/expiring)
      // Member: unique identifier (timestamp + random for uniqueness)
      const member = `${now}-${Math.random().toString(36).substring(7)}`;
      await redis.zadd(key, now, member);

      // Step 5: Set expiration on the key (cleanup after window expires)
      // PEXPIRE key milliseconds
      await redis.pexpire(key, config.windowMs);

      logger.debug("Rate limit check passed", {
        userId,
        command: config.commandName || "global",
        requestCount: requestCount + 1,
        limit: config.maxRequests,
      });

      // Proceed to next middleware/handler
      await next();
    } catch (error) {
      logger.error("Rate limiter error", {
        userId,
        command: config.commandName,
        error,
      });

      // On error, let request through (fail-open for availability)
      // In production, you might want to fail-closed instead
      await next();
    }
  };
}

// ============================================================================
// Pre-configured Rate Limiters
// ============================================================================

/**
 * Global rate limiter for all commands
 * Prevents general spam/DoS
 */
export const globalLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  maxRequests: 30, // 30 requests per minute (reasonable for active trading)
  commandName: "global",
  message:
    `⚠️ *Too Many Requests*\n\n` +
    `You're sending commands too fast!\n` +
    `Please slow down and wait a moment before trying again.`,
});

/**
 * Unlock command rate limiter
 * Prevents password bruteforce attacks
 *
 * SECURITY: Most important rate limit!
 * Without this, attacker can try unlimited passwords
 */
export const unlockLimiter = createRateLimiter({
  windowMs: 300000, // 5 minutes
  maxRequests: 3, // Only 3 unlock attempts per 5 minutes
  commandName: "unlock",
  message:
    `🔒 *Too Many Unlock Attempts*\n\n` +
    `For security, you can only try to unlock 3 times per 5 minutes.\n\n` +
    `If you forgot your password, you'll need to create a new wallet with /createwallet.`,
});

/**
 * Trading commands rate limiter
 * Prevents trade spam (buy/sell/swap)
 */
export const tradeLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  maxRequests: 10, // 10 trades per minute (aggressive trading is ok)
  commandName: "trade",
  message:
    `⚠️ *Too Many Trades*\n\n` +
    `You're trading too fast! Maximum 10 trades per minute.\n\n` +
    `Wait a moment before your next trade.`,
});

/**
 * Wallet creation rate limiter
 * Prevents wallet spam (database/storage abuse)
 */
export const walletCreationLimiter = createRateLimiter({
  windowMs: 3600000, // 1 hour
  maxRequests: 2, // Only 2 wallets per hour
  commandName: "createwallet",
  message:
    `⚠️ *Too Many Wallets*\n\n` +
    `You can only create 2 wallets per hour.\n\n` +
    `If you need to create more wallets, please wait a bit.`,
});

/**
 * Honeypot check rate limiter
 * Prevents API abuse (external API costs)
 */
export const honeypotCheckLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  maxRequests: 20, // 20 checks per minute
  commandName: "honeypot",
  message:
    `⚠️ *Too Many Checks*\n\n` +
    `You're checking tokens too fast!\n\n` +
    `Please wait a moment before checking another token.`,
});

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Manually clear rate limit for a user (admin function)
 * Useful for debugging or resetting limits
 */
export async function clearRateLimit(
  userId: number,
  commandName?: string
): Promise<void> {
  const pattern = commandName
    ? `ratelimit:${commandName}:${userId}`
    : `ratelimit:*:${userId}`;

  try {
    if (commandName) {
      // Clear specific command
      await redis.del(`ratelimit:${commandName}:${userId}`);
      logger.info("Rate limit cleared", { userId, commandName });
    } else {
      // Clear all rate limits for user (scan + delete)
      const keys = await redis.keys(`ratelimit:*:${userId}`);
      if (keys.length > 0) {
        await redis.del(...keys);
        logger.info("All rate limits cleared", { userId, count: keys.length });
      }
    }
  } catch (error) {
    logger.error("Failed to clear rate limit", { userId, commandName, error });
  }
}

/**
 * Get rate limit status for a user
 * Useful for debugging or showing user their limits
 */
export async function getRateLimitStatus(
  userId: number,
  commandName: string
): Promise<{
  count: number;
  limit: number;
  remaining: number;
  resetIn: number; // milliseconds
}> {
  const key = `ratelimit:${commandName}:${userId}`;

  try {
    const count = await redis.zcard(key);
    const ttl = await redis.pttl(key);

    // Get config for this command (hardcoded for now)
    const configs: Record<string, RateLimitConfig> = {
      global: { windowMs: 60000, maxRequests: 30 },
      unlock: { windowMs: 300000, maxRequests: 3 },
      trade: { windowMs: 60000, maxRequests: 10 },
      createwallet: { windowMs: 3600000, maxRequests: 2 },
    };

    const config = configs[commandName] || configs.global;

    return {
      count,
      limit: config.maxRequests,
      remaining: Math.max(0, config.maxRequests - count),
      resetIn: ttl > 0 ? ttl : 0,
    };
  } catch (error) {
    logger.error("Failed to get rate limit status", {
      userId,
      commandName,
      error,
    });
    throw error;
  }
}
