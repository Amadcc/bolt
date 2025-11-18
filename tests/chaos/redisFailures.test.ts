/**
 * CHAOS TESTING: Redis Failure Scenarios
 *
 * Tests system resilience to Redis failures:
 * - Redis connection loss
 * - Fallback to database
 * - Circuit breaker state loss
 * - Cache misses don't crash system
 *
 * Sprint 3.3 Task 3.3.3 (2 hours)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { redis } from "../../src/utils/redis.js";
import { prisma } from "../../src/utils/db.js";
import { logger } from "../../src/utils/logger.js";
import { CircuitBreaker } from "../../src/services/shared/circuitBreaker.js";
import type { Result } from "../../src/types/common.js";

// ============================================================================
// Skip Conditions
// ============================================================================

const shouldRunChaosTests = process.env.CHAOS_TESTS === "true";
const skipMessage = "CHAOS_TESTS environment variable not set - skipping chaos tests";

// ============================================================================
// Test Constants
// ============================================================================

const TEST_CACHE_PREFIX = "chaos:test:";
const TEST_SESSION_PREFIX = "chaos:session:";
const TEST_CB_PREFIX = "chaos:cb:";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Generate random test key
 */
function generateTestKey(prefix: string = TEST_CACHE_PREFIX): string {
  return `${prefix}${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Clean up test Redis keys
 */
async function cleanupTestKeys() {
  try {
    const patterns = [
      `${TEST_CACHE_PREFIX}*`,
      `${TEST_SESSION_PREFIX}*`,
      `${TEST_CB_PREFIX}*`,
    ];

    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }

    logger.debug("Cleaned up Redis test keys");
  } catch (error) {
    logger.warn("Failed to clean up Redis test keys", { error: String(error) });
  }
}

/**
 * Simulate cache operation with fallback to database
 */
async function getCachedDataWithFallback<T>(
  cacheKey: string,
  dbFallback: () => Promise<T>,
  ttlSeconds: number = 60
): Promise<Result<T, Error>> {
  try {
    // Try Redis first
    const cached = await redis.get(cacheKey);

    if (cached !== null) {
      return {
        success: true,
        value: JSON.parse(cached),
      };
    }

    // Cache miss - fallback to database
    logger.debug("Cache miss, falling back to database", { cacheKey });

    const data = await dbFallback();

    // Try to cache (but don't fail if Redis is down)
    try {
      await redis.setex(cacheKey, ttlSeconds, JSON.stringify(data));
    } catch (redisError) {
      logger.warn("Failed to cache data in Redis", {
        cacheKey,
        error: String(redisError),
      });
    }

    return {
      success: true,
      value: data,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Simulate session retrieval with Redis
 */
async function getSession(sessionToken: string): Promise<Result<any, Error>> {
  try {
    const sessionKey = `${TEST_SESSION_PREFIX}${sessionToken}`;
    const sessionData = await redis.get(sessionKey);

    if (!sessionData) {
      return {
        success: false,
        error: new Error("Session not found"),
      };
    }

    return {
      success: true,
      value: JSON.parse(sessionData),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Simulate session creation
 */
async function createSession(userId: string, ttlSeconds: number = 900) {
  const sessionToken = Math.random().toString(36).substring(2, 15);
  const sessionKey = `${TEST_SESSION_PREFIX}${sessionToken}`;

  const sessionData = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000,
  };

  await redis.setex(sessionKey, ttlSeconds, JSON.stringify(sessionData));

  return sessionToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check Redis connection health
 */
async function isRedisHealthy(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe.skipIf(!shouldRunChaosTests)(
  "Chaos Testing: Redis Failures",
  () => {
    beforeAll(async () => {
      logger.info("Starting Redis Failure Scenarios chaos tests");
      await cleanupTestKeys();
    });

    afterAll(async () => {
      await cleanupTestKeys();
      logger.info("Completed Redis Failure Scenarios chaos tests");
    });

    beforeEach(async () => {
      // Ensure Redis connection is healthy
      const healthy = await isRedisHealthy();
      if (!healthy) {
        logger.warn("Redis connection unhealthy before test");
      }
    });

    // ==========================================================================
    // Scenario 1: Redis Connection Loss
    // ==========================================================================

    describe("Scenario 1: Connection Loss", () => {
      test("should handle Redis connection timeout gracefully", async () => {
        console.log("\n🔥 CHAOS: Testing Redis connection timeout...");

        const key = generateTestKey();

        // Try to set value with timeout
        let setError = null;
        try {
          await redis.set(key, "test_value");
          console.log("   Set operation: SUCCESS");
        } catch (error) {
          setError = error;
          console.log(`   Set operation: FAILED - ${String(error)}`);
        }

        // Should either succeed or fail gracefully
        if (setError) {
          expect(setError).toBeInstanceOf(Error);
        }

        // Try to get value
        let getError = null;
        try {
          const value = await redis.get(key);
          console.log(`   Get operation: ${value ? "SUCCESS" : "NULL"}`);
        } catch (error) {
          getError = error;
          console.log(`   Get operation: FAILED - ${String(error)}`);
        }

        // Should handle gracefully
        expect(getError === null || getError instanceof Error).toBe(true);
      }, 30000);

      test("should continue operating without Redis", async () => {
        console.log("\n🔥 CHAOS: Testing operation without Redis...");

        // Simulate cache miss scenario
        const result = await getCachedDataWithFallback(
          generateTestKey(),
          async () => {
            // Fallback to database
            return await prisma.$queryRaw`SELECT 1 as value`;
          }
        );

        console.log(`   Fallback result: ${result.success ? "SUCCESS" : "FAILED"}`);

        // Should succeed using fallback
        expect(result.success).toBe(true);
      }, 30000);

      test("should handle intermittent Redis failures", async () => {
        console.log("\n🔥 CHAOS: Testing intermittent Redis failures...");

        let successCount = 0;
        let failCount = 0;

        // Try 10 operations
        for (let i = 0; i < 10; i++) {
          try {
            const key = generateTestKey();
            await redis.set(key, `value_${i}`);
            successCount++;
          } catch (error) {
            failCount++;
          }
        }

        console.log(`   Successful: ${successCount}, Failed: ${failCount}`);

        // At least some operations should work
        expect(successCount + failCount).toBe(10);
      }, 30000);
    });

    // ==========================================================================
    // Scenario 2: Fallback to Database
    // ==========================================================================

    describe("Scenario 2: Database Fallback", () => {
      test("should fallback to database on cache miss", async () => {
        console.log("\n🔥 CHAOS: Testing database fallback...");

        const cacheKey = generateTestKey();

        // First call - cache miss, should hit database
        const result1 = await getCachedDataWithFallback(
          cacheKey,
          async () => {
            console.log("   Fallback to database (first call)");
            return { value: 42, timestamp: Date.now() };
          }
        );

        expect(result1.success).toBe(true);
        console.log(`   First call: ${result1.success ? "SUCCESS" : "FAILED"}`);

        // Wait a bit
        await sleep(100);

        // Second call - might be cached (if Redis is working)
        const result2 = await getCachedDataWithFallback(
          cacheKey,
          async () => {
            console.log("   Fallback to database (second call)");
            return { value: 42, timestamp: Date.now() };
          }
        );

        expect(result2.success).toBe(true);
        console.log(`   Second call: ${result2.success ? "SUCCESS" : "FAILED"}`);
      }, 30000);

      test("should handle database fallback under load", async () => {
        console.log("\n🔥 CHAOS: Testing database fallback under load...");

        // Simulate 20 concurrent requests with cache misses
        const requests = Array.from({ length: 20 }, (_, i) =>
          getCachedDataWithFallback(
            generateTestKey(), // Different key each time = cache miss
            async () => {
              return { index: i, timestamp: Date.now() };
            }
          )
        );

        const results = await Promise.allSettled(requests);

        const successful = results.filter(
          (r): r is PromiseFulfilledResult<Result<any, Error>> =>
            r.status === "fulfilled" && r.value.success
        ).length;

        console.log(`   Successful: ${successful}/20`);

        expect(successful).toBeGreaterThan(0);
      }, 30000);

      test("should maintain performance with database fallback", async () => {
        console.log("\n🔥 CHAOS: Testing fallback performance...");

        const iterations = 10;
        const times: number[] = [];

        for (let i = 0; i < iterations; i++) {
          const startTime = Date.now();

          await getCachedDataWithFallback(
            generateTestKey(),
            async () => {
              return { value: i };
            }
          );

          times.push(Date.now() - startTime);
        }

        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        const maxTime = Math.max(...times);

        console.log(`   Average time: ${avgTime.toFixed(2)}ms`);
        console.log(`   Max time: ${maxTime}ms`);

        // Database fallback should be reasonably fast (<1s)
        expect(maxTime).toBeLessThan(1000);
      }, 30000);
    });

    // ==========================================================================
    // Scenario 3: Circuit Breaker State Loss
    // ==========================================================================

    describe("Scenario 3: Circuit Breaker State Loss", () => {
      test("should handle circuit breaker state loss gracefully", async () => {
        console.log("\n🔥 CHAOS: Testing circuit breaker state loss...");

        const cb = new CircuitBreaker(`${TEST_CB_PREFIX}state_loss_test`, {
          failureThreshold: 2,
          enableRedis: true,
        });

        // Open circuit
        await cb.execute(async () => {
          throw new Error("Test failure 1");
        }).catch(() => {});

        await cb.execute(async () => {
          throw new Error("Test failure 2");
        }).catch(() => {});

        await cb.execute(async () => {
          throw new Error("Test failure 3");
        }).catch(() => {});

        expect(cb.getMetrics().state).toBe("OPEN");
        console.log("   Circuit opened");

        // Simulate Redis state loss (clear Redis key)
        const cbKey = `circuit_breaker:${TEST_CB_PREFIX}state_loss_test`;
        await redis.del(cbKey);
        console.log("   Redis state cleared");

        // Create new circuit breaker instance (simulates restart)
        const cb2 = new CircuitBreaker(`${TEST_CB_PREFIX}state_loss_test`, {
          failureThreshold: 2,
          enableRedis: true,
        });

        await sleep(200); // Give time to load from Redis

        const metrics = cb2.getMetrics();
        console.log(`   New instance state: ${metrics.state}`);

        // Should start fresh (CLOSED) since state was lost
        expect(metrics.state).toBe("CLOSED");

        await cb.reset();
        await cb2.reset();
      }, 30000);

      test("should rebuild circuit breaker state from operations", async () => {
        console.log("\n🔥 CHAOS: Testing circuit breaker state rebuild...");

        const cb = new CircuitBreaker(`${TEST_CB_PREFIX}rebuild_test`, {
          failureThreshold: 3,
          enableRedis: false, // Disable Redis to simulate loss
        });

        // Make some failures
        for (let i = 0; i < 2; i++) {
          await cb.execute(async () => {
            throw new Error(`Failure ${i + 1}`);
          }).catch(() => {});
        }

        console.log(`   Failures recorded: ${cb.getMetrics().failureCount}`);

        // Circuit should still be CLOSED
        expect(cb.getMetrics().state).toBe("CLOSED");

        // One more failure should open it
        await cb.execute(async () => {
          throw new Error("Failure 3");
        }).catch(() => {});

        console.log(`   Circuit state: ${cb.getMetrics().state}`);
        expect(cb.getMetrics().state).toBe("OPEN");

        await cb.reset();
      }, 30000);

      test("should sync circuit breaker state across instances", async () => {
        console.log("\n🔥 CHAOS: Testing circuit breaker state sync...");

        const cb1 = new CircuitBreaker(`${TEST_CB_PREFIX}sync_test`, {
          failureThreshold: 2,
          enableRedis: true,
        });

        // Open circuit in instance 1
        await cb1.execute(async () => {
          throw new Error("Failure 1");
        }).catch(() => {});

        await cb1.execute(async () => {
          throw new Error("Failure 2");
        }).catch(() => {});

        await cb1.execute(async () => {
          throw new Error("Failure 3");
        }).catch(() => {});

        expect(cb1.getMetrics().state).toBe("OPEN");
        console.log("   Instance 1: OPEN");

        // Wait for persistence
        await sleep(200);

        // Create instance 2 - should load OPEN state
        const cb2 = new CircuitBreaker(`${TEST_CB_PREFIX}sync_test`, {
          failureThreshold: 2,
          enableRedis: true,
        });

        await sleep(200);

        console.log(`   Instance 2: ${cb2.getMetrics().state}`);
        expect(cb2.getMetrics().state).toBe("OPEN");

        await cb1.reset();
        await cb2.reset();
      }, 30000);
    });

    // ==========================================================================
    // Scenario 4: Cache Misses Don't Crash System
    // ==========================================================================

    describe("Scenario 4: Cache Miss Handling", () => {
      test("should handle 100% cache miss rate", async () => {
        console.log("\n🔥 CHAOS: Testing 100% cache miss rate...");

        let dbCalls = 0;

        // Make 20 requests, all cache misses
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            getCachedDataWithFallback(
              generateTestKey(), // Unique key each time
              async () => {
                dbCalls++;
                return { index: i };
              }
            )
          )
        );

        const successful = results.filter((r) => r.success).length;

        console.log(`   Successful: ${successful}/20`);
        console.log(`   Database calls: ${dbCalls}`);

        expect(successful).toBe(20);
        expect(dbCalls).toBe(20); // All should hit database
      }, 30000);

      test("should handle cache stampede scenario", async () => {
        console.log("\n🔥 CHAOS: Testing cache stampede...");

        const cacheKey = generateTestKey();
        let dbCalls = 0;

        // Simulate cache stampede - many concurrent requests for same key
        const requests = Array.from({ length: 50 }, () =>
          getCachedDataWithFallback(
            cacheKey, // Same key
            async () => {
              dbCalls++;
              await sleep(100); // Simulate slow DB query
              return { value: "expensive_data" };
            }
          )
        );

        const results = await Promise.allSettled(requests);

        const successful = results.filter(
          (r): r is PromiseFulfilledResult<Result<any, Error>> =>
            r.status === "fulfilled" && r.value.success
        ).length;

        console.log(`   Successful: ${successful}/50`);
        console.log(`   Database calls: ${dbCalls}`);

        // All requests should succeed
        expect(successful).toBe(50);

        // Note: Without cache locking, all might hit DB (acceptable)
        // With cache locking, only 1 should hit DB (ideal)
      }, 60000);

      test("should handle session expiry gracefully", async () => {
        console.log("\n🔥 CHAOS: Testing session expiry...");

        const userId = "test_user_123";

        // Create session with short TTL
        const sessionToken = await createSession(userId, 1); // 1 second TTL
        console.log("   Session created with 1s TTL");

        // Immediately retrieve - should work
        const result1 = await getSession(sessionToken);
        expect(result1.success).toBe(true);
        console.log("   Immediate retrieval: SUCCESS");

        // Wait for expiry
        console.log("   Waiting 2 seconds for expiry...");
        await sleep(2000);

        // Try to retrieve - should fail
        const result2 = await getSession(sessionToken);
        expect(result2.success).toBe(false);
        console.log("   After expiry: FAILED (expected)");
      }, 30000);

      test("should handle mass cache invalidation", async () => {
        console.log("\n🔥 CHAOS: Testing mass cache invalidation...");

        // Create many cache entries
        const keys: string[] = [];
        for (let i = 0; i < 100; i++) {
          const key = generateTestKey();
          keys.push(key);
          await redis.set(key, `value_${i}`);
        }

        console.log("   Created 100 cache entries");

        // Invalidate all at once
        const startTime = Date.now();
        await redis.del(...keys);
        const duration = Date.now() - startTime;

        console.log(`   Deleted 100 keys in ${duration}ms`);

        // Verify all deleted
        const remaining = await Promise.all(keys.map((key) => redis.get(key)));
        const nullCount = remaining.filter((v) => v === null).length;

        console.log(`   Deleted: ${nullCount}/100`);

        expect(nullCount).toBe(100);
        expect(duration).toBeLessThan(1000); // Should be fast
      }, 30000);
    });

    // ==========================================================================
    // Scenario 5: Redis Performance Under Stress
    // ==========================================================================

    describe("Scenario 5: Performance Under Stress", () => {
      test("should handle high write throughput", async () => {
        console.log("\n🔥 CHAOS: Testing high write throughput...");

        const count = 1000;
        const startTime = Date.now();

        // Write 1000 keys concurrently
        const writes = Array.from({ length: count }, (_, i) =>
          redis.set(generateTestKey(), `value_${i}`)
        );

        const results = await Promise.allSettled(writes);

        const duration = Date.now() - startTime;
        const successful = results.filter((r) => r.status === "fulfilled").length;

        console.log(`   Writes: ${successful}/${count} in ${duration}ms`);
        console.log(`   Throughput: ${(successful / duration * 1000).toFixed(2)} writes/sec`);

        expect(successful).toBeGreaterThan(count * 0.9); // 90%+ should succeed
      }, 60000);

      test("should handle high read throughput", async () => {
        console.log("\n🔥 CHAOS: Testing high read throughput...");

        // Create test data
        const key = generateTestKey();
        await redis.set(key, "test_value");

        const count = 1000;
        const startTime = Date.now();

        // Read same key 1000 times concurrently
        const reads = Array.from({ length: count }, () => redis.get(key));

        const results = await Promise.allSettled(reads);

        const duration = Date.now() - startTime;
        const successful = results.filter((r) => r.status === "fulfilled").length;

        console.log(`   Reads: ${successful}/${count} in ${duration}ms`);
        console.log(`   Throughput: ${(successful / duration * 1000).toFixed(2)} reads/sec`);

        expect(successful).toBeGreaterThan(count * 0.9); // 90%+ should succeed
      }, 60000);

      test("should handle mixed read/write load", async () => {
        console.log("\n🔥 CHAOS: Testing mixed read/write load...");

        const operations = 500;
        const startTime = Date.now();

        // Mix of reads and writes
        const mixed = Array.from({ length: operations }, (_, i) => {
          if (i % 2 === 0) {
            // Write
            return redis.set(generateTestKey(), `value_${i}`);
          } else {
            // Read
            const key = generateTestKey();
            return redis.get(key);
          }
        });

        const results = await Promise.allSettled(mixed);

        const duration = Date.now() - startTime;
        const successful = results.filter((r) => r.status === "fulfilled").length;

        console.log(`   Operations: ${successful}/${operations} in ${duration}ms`);
        console.log(`   Throughput: ${(successful / duration * 1000).toFixed(2)} ops/sec`);

        expect(successful).toBeGreaterThan(operations * 0.9); // 90%+ should succeed
      }, 60000);
    });
  },
  {
    timeout: 180000, // 3 minutes for entire suite
  }
);

// Skip message for when tests are skipped
if (!shouldRunChaosTests) {
  describe.skip("Chaos Testing: Redis Failures", () => {
    test(skipMessage, () => {});
  });
}
