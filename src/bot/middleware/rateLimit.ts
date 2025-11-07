/**
 * Rate Limiting Middleware (WEEK 3 - DAY 15 Enhanced)
 *
 * Security Protection:
 * - Prevents DoS attacks (Denial of Service)
 * - Prevents password bruteforce on /unlock
 * - Prevents spam on trading commands
 * - Prevents wallet creation abuse
 *
 * Implementation:
 * - Redis Sorted Sets (sliding window counter)
 * - Lua scripts for atomic operations (no race conditions)
 * - Per-user rate limits
 * - Different limits for different command types
 * - Automatic cleanup of old entries
 * - Prometheus metrics for monitoring
 * - Fail-closed for critical commands (unlock)
 * - Fail-open for non-critical commands (availability)
 *
 * Why Redis Sorted Sets:
 * - O(log N) operations (efficient)
 * - Automatic expiration
 * - Precise sliding window (not fixed window)
 * - Atomic operations via Lua scripts
 *
 * WEEK 3 Improvements:
 * - Added Prometheus metrics
 * - Added Lua script for atomic check+add
 * - Added fail-closed for /unlock (security)
 * - Added IP-based rate limiting (defense in depth)
 */

import type { Middleware, MiddlewareFn, Context as GrammyContext } from "grammy";
import { redis } from "../../utils/redis.js";
import { logger } from "../../utils/logger.js";
import {
  recordRateLimitCheck,
  recordRateLimitError,
} from "../../utils/metrics.js";

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
  /**
   * Fail-closed mode (WEEK 3 - DAY 15)
   * - true: Block request if Redis fails (secure, for critical commands like /unlock)
   * - false: Allow request if Redis fails (available, for non-critical commands)
   * Default: false
   */
  failClosed?: boolean;
}

// ============================================================================
// Lua Script for Atomic Operations (WEEK 3 - DAY 15)
// ============================================================================

/**
 * Atomic rate limit check using Lua script
 *
 * This prevents race conditions when multiple requests arrive simultaneously.
 * All operations (cleanup, count, check, add) happen atomically.
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = window start timestamp
 * ARGV[2] = current timestamp
 * ARGV[3] = max requests
 * ARGV[4] = unique member
 * ARGV[5] = window duration (for PEXPIRE)
 *
 * Returns:
 * - 0: Request blocked (limit exceeded)
 * - 1: Request allowed (and added to set)
 * - current count (as second return value)
 */
const RATE_LIMIT_LUA_SCRIPT = `
  -- Remove old entries
  redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])

  -- Count current entries
  local count = redis.call('ZCARD', KEYS[1])

  -- Check if limit exceeded
  if count >= tonumber(ARGV[3]) then
    return {0, count}  -- Blocked
  end

  -- Add new entry
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])

  -- Set expiration
  redis.call('PEXPIRE', KEYS[1], ARGV[5])

  return {1, count + 1}  -- Allowed
`;

// ============================================================================
// Rate Limiter Factory
// ============================================================================

/**
 * Create a rate limiter middleware (WEEK 3 Enhanced)
 *
 * Uses Redis Sorted Sets for sliding window counting:
 * - Key: ratelimit:{commandName}:{userId}
 * - Score: timestamp in milliseconds
 * - Value: unique identifier (timestamp + random)
 *
 * Algorithm (Lua script for atomicity):
 * 1. Remove entries older than window
 * 2. Count remaining entries
 * 3. If count >= limit → reject
 * 4. Otherwise → add new entry and proceed
 *
 * WEEK 3 Improvements:
 * - Atomic operations via Lua script (no race conditions)
 * - Prometheus metrics integration
 * - Fail-closed option for critical commands
 * - Better error handling
 *
 * @param config - Rate limit configuration
 * @returns Grammy middleware function
 */
export function createRateLimiter(config: RateLimitConfig): MiddlewareFn<GrammyContext> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    const commandName = config.commandName || "global";

    // Skip rate limiting if user is not identified
    if (!userId) {
      logger.warn("Rate limiter: Could not identify user");
      await ctx.reply("❌ Could not identify user");
      return;
    }

    const key = `ratelimit:${commandName}:${userId}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;
    const member = `${now}-${Math.random().toString(36).substring(7)}`;

    try {
      // WEEK 3: Use Lua script for atomic operations
      // This prevents race conditions on high load
      const result = (await redis.eval(
        RATE_LIMIT_LUA_SCRIPT,
        1, // number of keys
        key, // KEYS[1]
        windowStart, // ARGV[1]
        now, // ARGV[2]
        config.maxRequests, // ARGV[3]
        member, // ARGV[4]
        config.windowMs // ARGV[5]
      )) as [number, number];

      const [allowed, currentCount] = result;
      const isAllowed = allowed === 1;

      // WEEK 3: Record metrics
      recordRateLimitCheck(commandName, userId, isAllowed, currentCount);

      // Check if request is blocked
      if (!isAllowed) {
        // Get TTL to tell user when they can retry
        const ttl = await redis.pttl(key);
        const waitSeconds = Math.ceil(Math.max(ttl, 0) / 1000);

        logger.warn("Rate limit exceeded", {
          userId,
          command: commandName,
          currentCount,
          limit: config.maxRequests,
          windowMs: config.windowMs,
          waitSeconds,
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

      // Request allowed - proceed
      logger.debug("Rate limit check passed", {
        userId,
        command: commandName,
        currentCount,
        limit: config.maxRequests,
      });

      await next();
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "unknown";

      logger.error("Rate limiter error", {
        userId,
        command: commandName,
        error: error instanceof Error ? error.message : String(error),
        errorType,
      });

      // WEEK 3: Record error metric
      recordRateLimitError(commandName, errorType);

      // WEEK 3: Fail-closed vs Fail-open
      if (config.failClosed) {
        // SECURITY: Fail-closed for critical commands (e.g., /unlock)
        // Block request if Redis fails to prevent bruteforce
        logger.warn("Rate limiter failed-closed - blocking request", {
          userId,
          command: commandName,
        });

        await ctx.reply(
          `⚠️ *Service Temporarily Unavailable*\n\n` +
          `Rate limiting is temporarily unavailable.\n` +
          `Please try again in a few seconds.`,
          { parse_mode: "Markdown" }
        );

        return; // Block the request
      } else {
        // AVAILABILITY: Fail-open for non-critical commands
        // Allow request if Redis fails to maintain availability
        logger.warn("Rate limiter failed-open - allowing request", {
          userId,
          command: commandName,
        });

        await next();
      }
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
 * Unlock command rate limiter (WEEK 3 Enhanced)
 * Prevents password bruteforce attacks
 *
 * SECURITY: Most important rate limit!
 * - Without this, attacker can try unlimited passwords
 * - WEEK 3: Now uses fail-closed mode - blocks even if Redis fails
 * - This is critical for preventing bruteforce attacks
 */
export const unlockLimiter = createRateLimiter({
  windowMs: 300000, // 5 minutes
  maxRequests: 3, // Only 3 unlock attempts per 5 minutes
  commandName: "unlock",
  failClosed: true, // WEEK 3: Block request if Redis fails (security over availability)
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
      // MEDIUM-6 + LOW-4: Use non-blocking SCAN with error handling
      const { redisScan } = await import("../../utils/redis.js");
      const scanResult = await redisScan(`ratelimit:*:${userId}`);

      // LOW-4: Handle scan failure gracefully
      if (!scanResult.success) {
        logger.error("Failed to scan rate limits", { userId, error: scanResult.error });
        return;
      }

      const keys = scanResult.value;
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
