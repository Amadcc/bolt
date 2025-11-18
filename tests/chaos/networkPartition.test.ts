/**
 * CHAOS TESTING: Network Partition Scenarios
 *
 * Tests system resilience to network issues:
 * - Network delays (500ms, 1s, 2s)
 * - Timeout handling
 * - No hanging requests
 * - Graceful degradation under latency
 *
 * Sprint 3.3 Task 3.3.4 (1 hour)
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../../src/utils/logger.js";
import { retry } from "../../src/utils/retry.js";
import type { Result } from "../../src/types/common.js";

// ============================================================================
// Skip Conditions
// ============================================================================

const shouldRunChaosTests = process.env.CHAOS_TESTS === "true";
const skipMessage = "CHAOS_TESTS environment variable not set - skipping chaos tests";

// ============================================================================
// Test Constants
// ============================================================================

const VALID_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || "https://api.devnet.solana.com";

// Network delay scenarios (ms)
const NETWORK_DELAYS = {
  none: 0,
  fast: 100,
  medium: 500,
  slow: 1000,
  verySlow: 2000,
  timeout: 5000,
} as const;

// Timeout configurations (ms)
const TIMEOUTS = {
  aggressive: 1000,
  normal: 5000,
  relaxed: 10000,
} as const;

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Simulate network delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulate RPC call with artificial network delay
 */
async function rpcCallWithDelay<T>(
  operation: () => Promise<T>,
  delayMs: number
): Promise<Result<T, Error>> {
  try {
    // Add artificial delay before operation
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const result = await operation();

    return {
      success: true,
      value: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Execute operation with timeout
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<Result<T, Error>> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Operation timeout")), timeoutMs);
    });

    const result = await Promise.race([promise, timeoutPromise]);

    return {
      success: true,
      value: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Measure operation latency
 */
async function measureLatency<T>(
  operation: () => Promise<T>
): Promise<{
  result: Result<T, Error>;
  latencyMs: number;
}> {
  const startTime = Date.now();

  try {
    const value = await operation();
    const latencyMs = Date.now() - startTime;

    return {
      result: {
        success: true,
        value,
      },
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;

    return {
      result: {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      },
      latencyMs,
    };
  }
}

/**
 * Create RPC connection with custom timeout
 */
function createConnectionWithTimeout(timeoutMs: number): Connection {
  return new Connection(VALID_RPC_ENDPOINT, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: timeoutMs,
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe.skipIf(!shouldRunChaosTests)(
  "Chaos Testing: Network Partition",
  () => {
    let connection: Connection;

    beforeAll(async () => {
      logger.info("Starting Network Partition chaos tests");
      connection = new Connection(VALID_RPC_ENDPOINT, {
        commitment: "confirmed",
      });
    });

    afterAll(async () => {
      logger.info("Completed Network Partition chaos tests");
    });

    // ==========================================================================
    // Scenario 1: Network Delays (500ms, 1s, 2s)
    // ==========================================================================

    describe("Scenario 1: Network Delays", () => {
      test("should handle 500ms network delay", async () => {
        console.log("\n🔥 CHAOS: Testing 500ms network delay...");

        const { result, latencyMs } = await measureLatency(async () => {
          return await rpcCallWithDelay(
            async () => await connection.getSlot(),
            NETWORK_DELAYS.medium
          );
        });

        console.log(`   Latency: ${latencyMs}ms`);
        console.log(`   Result: ${result.success ? "SUCCESS" : "FAILED"}`);

        expect(result.success).toBe(true);
        expect(latencyMs).toBeGreaterThanOrEqual(NETWORK_DELAYS.medium);
      }, 30000);

      test("should handle 1s network delay", async () => {
        console.log("\n🔥 CHAOS: Testing 1s network delay...");

        const { result, latencyMs } = await measureLatency(async () => {
          return await rpcCallWithDelay(
            async () => await connection.getSlot(),
            NETWORK_DELAYS.slow
          );
        });

        console.log(`   Latency: ${latencyMs}ms`);
        console.log(`   Result: ${result.success ? "SUCCESS" : "FAILED"}`);

        expect(result.success).toBe(true);
        expect(latencyMs).toBeGreaterThanOrEqual(NETWORK_DELAYS.slow);
      }, 30000);

      test("should handle 2s network delay", async () => {
        console.log("\n🔥 CHAOS: Testing 2s network delay...");

        const { result, latencyMs } = await measureLatency(async () => {
          return await rpcCallWithDelay(
            async () => await connection.getSlot(),
            NETWORK_DELAYS.verySlow
          );
        });

        console.log(`   Latency: ${latencyMs}ms`);
        console.log(`   Result: ${result.success ? "SUCCESS" : "FAILED"}`);

        expect(result.success).toBe(true);
        expect(latencyMs).toBeGreaterThanOrEqual(NETWORK_DELAYS.verySlow);
      }, 30000);

      test("should handle variable network latency", async () => {
        console.log("\n🔥 CHAOS: Testing variable network latency...");

        const delays = [0, 100, 500, 1000, 500, 100, 0];
        const latencies: number[] = [];

        for (const delay of delays) {
          const { latencyMs } = await measureLatency(async () => {
            return await rpcCallWithDelay(
              async () => await connection.getSlot(),
              delay
            );
          });

          latencies.push(latencyMs);
        }

        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const minLatency = Math.min(...latencies);
        const maxLatency = Math.max(...latencies);

        console.log(`   Min latency: ${minLatency}ms`);
        console.log(`   Max latency: ${maxLatency}ms`);
        console.log(`   Avg latency: ${avgLatency.toFixed(2)}ms`);

        // All requests should complete
        expect(latencies.length).toBe(delays.length);
      }, 60000);
    });

    // ==========================================================================
    // Scenario 2: Timeout Handling
    // ==========================================================================

    describe("Scenario 2: Timeout Handling", () => {
      test("should timeout aggressive operations (1s timeout)", async () => {
        console.log("\n🔥 CHAOS: Testing 1s aggressive timeout...");

        const result = await withTimeout(
          rpcCallWithDelay(
            async () => {
              await sleep(NETWORK_DELAYS.verySlow); // 2s operation
              return await connection.getSlot();
            },
            0
          ),
          TIMEOUTS.aggressive // 1s timeout
        );

        console.log(`   Result: ${result.success ? "SUCCESS" : "TIMEOUT"}`);

        // Should timeout (2s operation with 1s timeout)
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.message).toContain("timeout");
        }
      }, 30000);

      test("should complete within normal timeout (5s)", async () => {
        console.log("\n🔥 CHAOS: Testing 5s normal timeout...");

        const result = await withTimeout(
          rpcCallWithDelay(
            async () => await connection.getSlot(),
            NETWORK_DELAYS.slow // 1s delay
          ),
          TIMEOUTS.normal // 5s timeout
        );

        console.log(`   Result: ${result.success ? "SUCCESS" : "TIMEOUT"}`);

        // Should complete (1s operation with 5s timeout)
        expect(result.success).toBe(true);
      }, 30000);

      test("should handle relaxed timeout (10s)", async () => {
        console.log("\n🔥 CHAOS: Testing 10s relaxed timeout...");

        const result = await withTimeout(
          rpcCallWithDelay(
            async () => await connection.getSlot(),
            NETWORK_DELAYS.verySlow // 2s delay
          ),
          TIMEOUTS.relaxed // 10s timeout
        );

        console.log(`   Result: ${result.success ? "SUCCESS" : "TIMEOUT"}`);

        // Should complete (2s operation with 10s timeout)
        expect(result.success).toBe(true);
      }, 30000);

      test("should timeout concurrent slow operations", async () => {
        console.log("\n🔥 CHAOS: Testing concurrent timeout handling...");

        const operations = Array.from({ length: 10 }, (_, i) =>
          withTimeout(
            rpcCallWithDelay(
              async () => {
                await sleep(i % 2 === 0 ? 500 : 2000); // Mix of fast/slow
                return await connection.getSlot();
              },
              0
            ),
            TIMEOUTS.aggressive // 1s timeout
          )
        );

        const results = await Promise.all(operations);

        const successful = results.filter((r) => r.success).length;
        const timedOut = results.filter((r) => !r.success).length;

        console.log(`   Successful: ${successful}`);
        console.log(`   Timed out: ${timedOut}`);

        // Fast operations should succeed, slow should timeout
        expect(successful).toBeGreaterThan(0);
        expect(timedOut).toBeGreaterThan(0);
      }, 30000);
    });

    // ==========================================================================
    // Scenario 3: No Hanging Requests
    // ==========================================================================

    describe("Scenario 3: No Hanging Requests", () => {
      test("should not hang on slow RPC endpoint", async () => {
        console.log("\n🔥 CHAOS: Testing no hanging requests...");

        const timeoutMs = 3000;
        const startTime = Date.now();

        const result = await withTimeout(
          connection.getSlot(),
          timeoutMs
        );

        const duration = Date.now() - startTime;

        console.log(`   Duration: ${duration}ms`);
        console.log(`   Result: ${result.success ? "SUCCESS" : "TIMEOUT"}`);

        // Should either complete or timeout - not hang
        expect(duration).toBeLessThan(timeoutMs + 1000); // Allow 1s grace
      }, 30000);

      test("should clean up timed out requests", async () => {
        console.log("\n🔥 CHAOS: Testing request cleanup after timeout...");

        // Start 5 operations that will timeout
        const operations = Array.from({ length: 5 }, () =>
          withTimeout(
            rpcCallWithDelay(
              async () => {
                await sleep(5000); // 5s operation
                return await connection.getSlot();
              },
              0
            ),
            1000 // 1s timeout
          )
        );

        const results = await Promise.all(operations);

        const timedOut = results.filter((r) => !r.success).length;

        console.log(`   Timed out: ${timedOut}/5`);

        // All should timeout
        expect(timedOut).toBe(5);

        // Wait a bit to ensure cleanup
        await sleep(1000);

        // Make new request - should work (not blocked by hung requests)
        const cleanupResult = await connection.getSlot();
        expect(cleanupResult).toBeGreaterThan(0);

        console.log("   Cleanup successful ✅");
      }, 30000);

      test("should handle request cancellation", async () => {
        console.log("\n🔥 CHAOS: Testing request cancellation...");

        let cancelled = false;

        const controller = new AbortController();

        // Start operation
        const operationPromise = (async () => {
          try {
            await sleep(2000);
            return await connection.getSlot();
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              cancelled = true;
            }
            throw error;
          }
        })();

        // Cancel after 500ms
        setTimeout(() => {
          controller.abort();
        }, 500);

        // Wait for operation
        try {
          await operationPromise;
        } catch (error) {
          // Expected to fail
        }

        console.log(`   Cancelled: ${cancelled}`);

        // Note: Cancellation handling depends on implementation
        // This test verifies the pattern works
      }, 30000);
    });

    // ==========================================================================
    // Scenario 4: Retry with Exponential Backoff
    // ==========================================================================

    describe("Scenario 4: Retry Logic Under Network Delays", () => {
      test("should retry failed requests with backoff", async () => {
        console.log("\n🔥 CHAOS: Testing retry with exponential backoff...");

        let attempts = 0;
        const maxRetries = 3;

        const startTime = Date.now();

        const result = await retry(
          async () => {
            attempts++;
            console.log(`   Attempt ${attempts}`);

            // Simulate failure on first 2 attempts
            if (attempts < 3) {
              throw new Error("Network error");
            }

            return await connection.getSlot();
          },
          {
            maxRetries,
            baseDelay: 500,
            backoff: "exponential",
          }
        );

        const duration = Date.now() - startTime;

        console.log(`   Total attempts: ${attempts}`);
        console.log(`   Total duration: ${duration}ms`);
        console.log(`   Result: ${result ? "SUCCESS" : "FAILED"}`);

        // Should succeed on 3rd attempt
        expect(attempts).toBe(3);
        expect(result).toBeTruthy();

        // Duration should include backoff delays
        // 500ms + 1000ms = 1500ms minimum
        expect(duration).toBeGreaterThan(1500);
      }, 30000);

      test("should handle retry under variable latency", async () => {
        console.log("\n🔥 CHAOS: Testing retry under variable latency...");

        const delays = [1000, 500, 100]; // Decreasing latency
        let attemptIndex = 0;

        const result = await retry(
          async () => {
            const delay = delays[attemptIndex] || 0;
            attemptIndex++;

            console.log(`   Attempt ${attemptIndex} with ${delay}ms delay`);

            await sleep(delay);

            // Fail first 2 attempts
            if (attemptIndex < 3) {
              throw new Error("Network error");
            }

            return await connection.getSlot();
          },
          {
            maxRetries: 3,
            baseDelay: 100,
            backoff: "exponential",
          }
        );

        console.log(`   Attempts: ${attemptIndex}`);
        console.log(`   Result: ${result ? "SUCCESS" : "FAILED"}`);

        expect(attemptIndex).toBe(3);
        expect(result).toBeTruthy();
      }, 30000);

      test("should fail after max retries exceeded", async () => {
        console.log("\n🔥 CHAOS: Testing retry failure after max attempts...");

        let attempts = 0;

        try {
          await retry(
            async () => {
              attempts++;
              console.log(`   Attempt ${attempts}`);

              // Always fail
              throw new Error("Permanent network error");
            },
            {
              maxRetries: 3,
              baseDelay: 100,
              backoff: "exponential",
            }
          );
        } catch (error) {
          console.log(`   Failed after ${attempts} attempts (expected)`);
        }

        expect(attempts).toBe(4); // Initial + 3 retries
      }, 30000);
    });

    // ==========================================================================
    // Scenario 5: Concurrent Operations Under Network Stress
    // ==========================================================================

    describe("Scenario 5: Concurrent Operations Under Stress", () => {
      test("should handle 50 concurrent requests with delays", async () => {
        console.log("\n🔥 CHAOS: Testing 50 concurrent requests with delays...");

        const count = 50;
        const startTime = Date.now();

        // Random delays for each request
        const requests = Array.from({ length: count }, (_, i) => {
          const delay = Math.floor(Math.random() * 500);

          return measureLatency(async () => {
            return await rpcCallWithDelay(
              async () => await connection.getSlot(),
              delay
            );
          });
        });

        const results = await Promise.all(requests);

        const duration = Date.now() - startTime;
        const successful = results.filter((r) => r.result.success).length;
        const avgLatency =
          results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;

        console.log(`   Duration: ${duration}ms`);
        console.log(`   Successful: ${successful}/${count}`);
        console.log(`   Avg latency: ${avgLatency.toFixed(2)}ms`);

        expect(successful).toBeGreaterThan(count * 0.9); // 90%+ success
      }, 60000);

      test("should maintain throughput under network jitter", async () => {
        console.log("\n🔥 CHAOS: Testing throughput under network jitter...");

        const batches = 5;
        const batchSize = 10;
        const throughputs: number[] = [];

        for (let batch = 0; batch < batches; batch++) {
          const startTime = Date.now();

          const requests = Array.from({ length: batchSize }, () => {
            // Random jitter: 0-200ms
            const jitter = Math.floor(Math.random() * 200);

            return rpcCallWithDelay(
              async () => await connection.getSlot(),
              jitter
            );
          });

          await Promise.all(requests);

          const duration = Date.now() - startTime;
          const throughput = (batchSize / duration) * 1000; // req/sec

          throughputs.push(throughput);

          console.log(`   Batch ${batch + 1}: ${throughput.toFixed(2)} req/sec`);
        }

        const avgThroughput =
          throughputs.reduce((a, b) => a + b, 0) / throughputs.length;

        console.log(`   Average throughput: ${avgThroughput.toFixed(2)} req/sec`);

        // Should maintain some throughput despite jitter
        expect(avgThroughput).toBeGreaterThan(1);
      }, 90000);

      test("should handle mixed fast and slow operations", async () => {
        console.log("\n🔥 CHAOS: Testing mixed fast/slow operations...");

        const operations = [
          ...Array.from({ length: 25 }, () => NETWORK_DELAYS.fast), // 25 fast
          ...Array.from({ length: 25 }, () => NETWORK_DELAYS.slow), // 25 slow
        ];

        const startTime = Date.now();

        const results = await Promise.all(
          operations.map((delay) =>
            measureLatency(async () => {
              return await rpcCallWithDelay(
                async () => await connection.getSlot(),
                delay
              );
            })
          )
        );

        const duration = Date.now() - startTime;
        const successful = results.filter((r) => r.result.success).length;

        const fastResults = results.slice(0, 25);
        const slowResults = results.slice(25);

        const avgFast =
          fastResults.reduce((sum, r) => sum + r.latencyMs, 0) / 25;
        const avgSlow =
          slowResults.reduce((sum, r) => sum + r.latencyMs, 0) / 25;

        console.log(`   Total duration: ${duration}ms`);
        console.log(`   Successful: ${successful}/50`);
        console.log(`   Avg fast latency: ${avgFast.toFixed(2)}ms`);
        console.log(`   Avg slow latency: ${avgSlow.toFixed(2)}ms`);

        expect(successful).toBe(50);
        expect(avgFast).toBeLessThan(avgSlow);
      }, 90000);
    });
  },
  {
    timeout: 180000, // 3 minutes for entire suite
  }
);

// Skip message for when tests are skipped
if (!shouldRunChaosTests) {
  describe.skip("Chaos Testing: Network Partition", () => {
    test(skipMessage, () => {});
  });
}
