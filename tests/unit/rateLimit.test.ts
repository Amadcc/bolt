/**
 * Rate Limiting Middleware Tests (WEEK 3 - DAY 15)
 *
 * Tests cover:
 * - Basic rate limiting (allow/block)
 * - Sliding window behavior
 * - Fail-closed mode for critical commands
 * - Fail-open mode for non-critical commands
 * - Metrics recording
 * - Atomic operations (Lua script)
 * - Multiple users isolation
 * - TTL expiration
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createRateLimiter, type RateLimitConfig } from "../../src/bot/middleware/rateLimit.js";
import { redis } from "../../src/utils/redis.js";
import type { Context } from "grammy";

// ============================================================================
// Mock Setup
// ============================================================================

/**
 * Create mock Grammy context
 */
function createMockContext(userId: number): Partial<Context> {
  return {
    from: { id: userId, is_bot: false, first_name: "Test" },
    chat: { id: userId, type: "private" },
    reply: mock(async (text: string) => ({
      message_id: 123,
      date: Date.now(),
      chat: { id: userId, type: "private" as const },
    })),
  } as any;
}

/**
 * Create mock next function
 */
function createMockNext() {
  return mock(async () => {});
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Clean up rate limit keys for a user
 */
async function cleanupRateLimit(userId: number, commandName: string) {
  const key = `ratelimit:${commandName}:${userId}`;
  await redis.del(key);
}

/**
 * Get current rate limit count
 */
async function getRateLimitCount(userId: number, commandName: string): Promise<number> {
  const key = `ratelimit:${commandName}:${userId}`;
  return await redis.zcard(key);
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Tests
// ============================================================================

describe("Rate Limiting Middleware", () => {
  const testUserId = 12345;
  const testCommandName = "test_command";

  beforeEach(async () => {
    // Clean up before each test
    await cleanupRateLimit(testUserId, testCommandName);
  });

  afterEach(async () => {
    // Clean up after each test
    await cleanupRateLimit(testUserId, testCommandName);
  });

  // ==========================================================================
  // Basic Rate Limiting
  // ==========================================================================

  it("should allow requests under the limit", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000,
      maxRequests: 5,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);
    const ctx = createMockContext(testUserId) as Context;
    const next = createMockNext();

    // Send 5 requests (all should pass)
    for (let i = 0; i < 5; i++) {
      await limiter(ctx, next);
    }

    // Check that next was called 5 times
    expect(next).toHaveBeenCalledTimes(5);

    // Check Redis count
    const count = await getRateLimitCount(testUserId, testCommandName);
    expect(count).toBe(5);
  });

  it("should block requests over the limit", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000,
      maxRequests: 3,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);
    const ctx = createMockContext(testUserId) as Context;
    const next = createMockNext();

    // Send 3 requests (should pass)
    for (let i = 0; i < 3; i++) {
      await limiter(ctx, next);
    }

    // Send 4th request (should be blocked)
    await limiter(ctx, next);

    // Next should only be called 3 times
    expect(next).toHaveBeenCalledTimes(3);

    // Reply should be called on 4th attempt
    expect(ctx.reply).toHaveBeenCalledTimes(1);

    // Check Redis count (should still be 3, not added)
    const count = await getRateLimitCount(testUserId, testCommandName);
    expect(count).toBe(3);
  });

  it("should block multiple requests over the limit", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000,
      maxRequests: 2,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);
    const ctx = createMockContext(testUserId) as Context;
    const next = createMockNext();

    // Send 5 requests (only first 2 should pass)
    for (let i = 0; i < 5; i++) {
      await limiter(ctx, next);
    }

    // Next should only be called 2 times
    expect(next).toHaveBeenCalledTimes(2);

    // Reply should be called 3 times (requests 3, 4, 5)
    expect(ctx.reply).toHaveBeenCalledTimes(3);
  });

  // ==========================================================================
  // Sliding Window Behavior
  // ==========================================================================

  it("should reset after window expires", async () => {
    const config: RateLimitConfig = {
      windowMs: 100, // 100ms window
      maxRequests: 2,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);
    const ctx = createMockContext(testUserId) as Context;
    const next = createMockNext();

    // Send 2 requests (should pass)
    await limiter(ctx, next);
    await limiter(ctx, next);

    // Send 3rd request (should be blocked)
    await limiter(ctx, next);
    expect(next).toHaveBeenCalledTimes(2);

    // Wait for window to expire
    await sleep(150);

    // Send 4th request (should pass after window reset)
    await limiter(ctx, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it("should use sliding window (not fixed)", async () => {
    const config: RateLimitConfig = {
      windowMs: 200, // 200ms window
      maxRequests: 2,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);
    const ctx = createMockContext(testUserId) as Context;
    const next = createMockNext();

    // t=0: Send 2 requests
    await limiter(ctx, next);
    await limiter(ctx, next);
    expect(next).toHaveBeenCalledTimes(2);

    // t=100: Wait half window, send request (should be blocked - 2 still in window)
    await sleep(100);
    await limiter(ctx, next);
    expect(next).toHaveBeenCalledTimes(2); // Still 2, blocked

    // t=250: Wait until first 2 expire, send request (should pass)
    await sleep(150);
    await limiter(ctx, next);
    expect(next).toHaveBeenCalledTimes(3); // Now 3, passed
  });

  // ==========================================================================
  // Multiple Users Isolation
  // ==========================================================================

  it("should isolate rate limits per user", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000,
      maxRequests: 2,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);

    const user1 = 111;
    const user2 = 222;

    const ctx1 = createMockContext(user1) as Context;
    const ctx2 = createMockContext(user2) as Context;

    const next1 = createMockNext();
    const next2 = createMockNext();

    // User 1: Send 2 requests (should pass)
    await limiter(ctx1, next1);
    await limiter(ctx1, next1);

    // User 1: Send 3rd request (should be blocked)
    await limiter(ctx1, next1);
    expect(next1).toHaveBeenCalledTimes(2);

    // User 2: Send 2 requests (should pass - separate limit)
    await limiter(ctx2, next2);
    await limiter(ctx2, next2);
    expect(next2).toHaveBeenCalledTimes(2);

    // User 2: Send 3rd request (should be blocked)
    await limiter(ctx2, next2);
    expect(next2).toHaveBeenCalledTimes(2);

    // Clean up
    await cleanupRateLimit(user1, testCommandName);
    await cleanupRateLimit(user2, testCommandName);
  });

  // ==========================================================================
  // Fail-Closed Mode (Critical Commands)
  // ==========================================================================

  it("should block request in fail-closed mode if Redis fails", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000,
      maxRequests: 5,
      commandName: testCommandName,
      failClosed: true, // Critical: block on error
    };

    const limiter = createRateLimiter(config);
    const ctx = createMockContext(testUserId) as Context;
    const next = createMockNext();

    // Mock Redis error
    const originalEval = redis.eval;
    redis.eval = mock(async () => {
      throw new Error("Redis connection failed");
    });

    // Try to send request
    await limiter(ctx, next);

    // Should NOT call next (blocked)
    expect(next).toHaveBeenCalledTimes(0);

    // Should call reply with error
    expect(ctx.reply).toHaveBeenCalledTimes(1);

    // Restore Redis
    redis.eval = originalEval;
  });

  // ==========================================================================
  // Fail-Open Mode (Non-Critical Commands)
  // ==========================================================================

  it("should allow request in fail-open mode if Redis fails", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000,
      maxRequests: 5,
      commandName: testCommandName,
      failClosed: false, // Non-critical: allow on error (default)
    };

    const limiter = createRateLimiter(config);
    const ctx = createMockContext(testUserId) as Context;
    const next = createMockNext();

    // Mock Redis error
    const originalEval = redis.eval;
    redis.eval = mock(async () => {
      throw new Error("Redis connection failed");
    });

    // Try to send request
    await limiter(ctx, next);

    // Should call next (allowed despite error)
    expect(next).toHaveBeenCalledTimes(1);

    // Restore Redis
    redis.eval = originalEval;
  });

  // ==========================================================================
  // Atomic Operations (Lua Script)
  // ==========================================================================

  it("should handle concurrent requests atomically", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000,
      maxRequests: 5,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);

    // Send 10 concurrent requests
    const promises = [];
    for (let i = 0; i < 10; i++) {
      const ctx = createMockContext(testUserId) as Context;
      const next = createMockNext();
      promises.push(limiter(ctx, next));
    }

    await Promise.all(promises);

    // Should have exactly 5 entries in Redis (not more due to race conditions)
    const count = await getRateLimitCount(testUserId, testCommandName);
    expect(count).toBe(5);
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  it("should handle missing user gracefully", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000,
      maxRequests: 5,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);
    const ctx = {
      from: undefined,
      reply: mock(async (text: string) => ({
        message_id: 123,
        date: Date.now(),
        chat: { id: 0, type: "private" as const },
      })),
    } as any as Context;
    const next = createMockNext();

    await limiter(ctx, next);

    // Should not call next (no user)
    expect(next).toHaveBeenCalledTimes(0);

    // Should call reply with error
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // TTL Verification
  // ==========================================================================

  it("should set TTL on rate limit keys", async () => {
    const config: RateLimitConfig = {
      windowMs: 60000, // 60 seconds
      maxRequests: 5,
      commandName: testCommandName,
    };

    const limiter = createRateLimiter(config);
    const ctx = createMockContext(testUserId) as Context;
    const next = createMockNext();

    // Send request
    await limiter(ctx, next);

    // Check TTL
    const key = `ratelimit:${testCommandName}:${testUserId}`;
    const ttl = await redis.pttl(key);

    // TTL should be close to 60000ms (allow 1s margin)
    expect(ttl).toBeGreaterThan(59000);
    expect(ttl).toBeLessThanOrEqual(60000);
  });
});
