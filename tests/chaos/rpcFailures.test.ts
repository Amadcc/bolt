/**
 * CHAOS TESTING: RPC Failure Scenarios
 *
 * Tests system resilience to RPC endpoint failures:
 * - All RPC endpoints failing
 * - Intermittent failures
 * - Circuit breaker recovery
 * - Graceful degradation
 *
 * Sprint 3.3 Task 3.3.1 (3 hours)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { CircuitBreaker, type CircuitBreakerMetrics } from "../../src/services/shared/circuitBreaker.js";
import { logger } from "../../src/utils/logger.js";
import { redis } from "../../src/utils/redis.js";
import type { Result } from "../../src/types/common.js";

// ============================================================================
// Skip Conditions
// ============================================================================

const shouldRunChaosTests = process.env.CHAOS_TESTS === "true";
const skipMessage = "CHAOS_TESTS environment variable not set - skipping chaos tests";

// ============================================================================
// Test Constants
// ============================================================================

// Valid endpoints for testing
const VALID_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || "https://api.devnet.solana.com";

// Invalid endpoints for failure simulation
const INVALID_RPC_ENDPOINTS = [
  "https://invalid-rpc-endpoint-that-does-not-exist.com",
  "https://timeout-endpoint.example.com",
  "http://localhost:99999", // Port that doesn't exist
];

// Network delays for timeout testing (ms)
const NETWORK_DELAYS = {
  fast: 100,
  slow: 1000,
  timeout: 5000,
} as const;

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Simulate RPC call that may fail
 */
async function simulateRpcCall(
  connection: Connection,
  shouldFail: boolean = false,
  delay: number = 0
): Promise<Result<number, Error>> {
  if (delay > 0) {
    await sleep(delay);
  }

  if (shouldFail) {
    return {
      success: false,
      error: new Error("Simulated RPC failure"),
    };
  }

  try {
    const slot = await connection.getSlot();
    return {
      success: true,
      value: slot,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Make multiple RPC calls with circuit breaker protection
 */
async function makeProtectedRpcCalls(
  circuitBreaker: CircuitBreaker,
  connection: Connection,
  count: number,
  shouldFail: boolean = false
): Promise<{
  successful: number;
  failed: number;
  rejected: number;
  results: (number | null)[];
}> {
  const results: (number | null)[] = [];
  let successful = 0;
  let failed = 0;
  let rejected = 0;

  for (let i = 0; i < count; i++) {
    try {
      const result = await circuitBreaker.execute(async () => {
        const callResult = await simulateRpcCall(connection, shouldFail);
        if (!callResult.success) {
          throw callResult.error;
        }
        return callResult.value;
      });

      if (result === null) {
        rejected++;
        results.push(null);
      } else {
        successful++;
        results.push(result);
      }
    } catch (error) {
      failed++;
      results.push(null);
    }
  }

  return { successful, failed, rejected, results };
}

/**
 * Wait for circuit breaker to reach specific state
 */
async function waitForCircuitBreakerState(
  circuitBreaker: CircuitBreaker,
  targetState: "CLOSED" | "OPEN" | "HALF_OPEN",
  timeoutMs: number = 5000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const metrics = circuitBreaker.getMetrics();
    if (metrics.state === targetState) {
      return true;
    }
    await sleep(100);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create bad RPC connection for testing failures
 */
function createBadConnection(): Connection {
  return new Connection(INVALID_RPC_ENDPOINTS[0], {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 1000, // 1s timeout for fast failures
  });
}

/**
 * Create good RPC connection for testing recovery
 */
function createGoodConnection(): Connection {
  return new Connection(VALID_RPC_ENDPOINT, {
    commitment: "confirmed",
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe.skipIf(!shouldRunChaosTests)(
  "Chaos Testing: RPC Failures",
  () => {
    beforeAll(async () => {
      logger.info("Starting RPC Failure Scenarios chaos tests");
    });

    afterAll(async () => {
      logger.info("Completed RPC Failure Scenarios chaos tests");
    });

    // ==========================================================================
    // Scenario 1: All RPC Endpoints Failing
    // ==========================================================================

    describe("Scenario 1: Total RPC Failure", () => {
      test("should activate circuit breaker after multiple failures", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_total_failure_test", {
          failureThreshold: 3,
          successThreshold: 2,
          timeout: 2000,
          monitoringPeriod: 5000,
          enableRedis: false, // Disable Redis for isolated testing
        });

        const badConnection = createBadConnection();

        console.log("\n🔥 CHAOS: Simulating total RPC failure...");

        // Make 5 calls - should trigger circuit breaker (threshold = 3)
        const result = await makeProtectedRpcCalls(
          circuitBreaker,
          badConnection,
          5,
          false // Use real bad connection, not simulated failure
        );

        console.log(`   Failed: ${result.failed}, Rejected: ${result.rejected}`);

        const metrics = circuitBreaker.getMetrics();
        console.log(`   Circuit state: ${metrics.state}`);
        console.log(`   Failure count: ${metrics.failureCount}`);

        // Verify circuit breaker activated
        expect(metrics.state).toBe("OPEN");
        expect(metrics.failureCount).toBeGreaterThanOrEqual(3);
        expect(result.failed + result.rejected).toBeGreaterThan(0);

        await circuitBreaker.reset();
      }, 10000);

      test("should reject requests when circuit is OPEN", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_open_rejection_test", {
          failureThreshold: 2,
          timeout: 5000,
          enableRedis: false,
        });

        const badConnection = createBadConnection();

        console.log("\n🔥 CHAOS: Testing request rejection with OPEN circuit...");

        // Trigger circuit breaker
        await makeProtectedRpcCalls(circuitBreaker, badConnection, 3, false);

        // Wait for state to be OPEN
        const isOpen = await waitForCircuitBreakerState(circuitBreaker, "OPEN", 2000);
        expect(isOpen).toBe(true);

        // Try more requests - should be rejected immediately
        const rejectedResult = await makeProtectedRpcCalls(
          circuitBreaker,
          badConnection,
          5,
          false
        );

        console.log(`   Rejected: ${rejectedResult.rejected}/5 requests`);

        expect(rejectedResult.rejected).toBeGreaterThan(0);
        expect(circuitBreaker.getMetrics().state).toBe("OPEN");

        await circuitBreaker.reset();
      }, 10000);

      test("should handle cascading failures across multiple services", async () => {
        // Simulate multiple services with circuit breakers
        const services = [
          new CircuitBreaker("service_1", {
            failureThreshold: 3,
            timeout: 2000,
            enableRedis: false,
          }),
          new CircuitBreaker("service_2", {
            failureThreshold: 3,
            timeout: 2000,
            enableRedis: false,
          }),
          new CircuitBreaker("service_3", {
            failureThreshold: 3,
            timeout: 2000,
            enableRedis: false,
          }),
        ];

        const badConnection = createBadConnection();

        console.log("\n🔥 CHAOS: Testing cascading failures across services...");

        // Fail all services simultaneously
        const results = await Promise.all(
          services.map((cb) => makeProtectedRpcCalls(cb, badConnection, 5, false))
        );

        // Check all circuits opened
        const openCount = services.filter(
          (cb) => cb.getMetrics().state === "OPEN"
        ).length;

        console.log(`   Circuits opened: ${openCount}/${services.length}`);

        expect(openCount).toBeGreaterThan(0); // At least one should open

        // Cleanup
        await Promise.all(services.map((cb) => cb.reset()));
      }, 15000);
    });

    // ==========================================================================
    // Scenario 2: Intermittent Failures
    // ==========================================================================

    describe("Scenario 2: Intermittent Failures", () => {
      test("should handle sporadic failures without opening circuit", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_intermittent_test", {
          failureThreshold: 5,
          timeout: 2000,
          monitoringPeriod: 10000,
          enableRedis: false,
        });

        const goodConnection = createGoodConnection();

        console.log("\n🔥 CHAOS: Testing intermittent failures (20% failure rate)...");

        let successful = 0;
        let failed = 0;

        // Make 20 calls with 20% failure rate
        for (let i = 0; i < 20; i++) {
          const shouldFail = Math.random() < 0.2; // 20% chance

          try {
            const result = await circuitBreaker.execute(async () => {
              const callResult = await simulateRpcCall(goodConnection, shouldFail);
              if (!callResult.success) {
                throw callResult.error;
              }
              return callResult.value;
            });

            if (result !== null) {
              successful++;
            }
          } catch (error) {
            failed++;
          }

          await sleep(50); // Small delay between requests
        }

        console.log(`   Successful: ${successful}, Failed: ${failed}`);

        const metrics = circuitBreaker.getMetrics();
        console.log(`   Circuit state: ${metrics.state}`);

        // Circuit should remain CLOSED with sporadic failures
        expect(metrics.state).toBe("CLOSED");
        expect(successful).toBeGreaterThan(0);

        await circuitBreaker.reset();
      }, 15000);

      test("should open circuit only when failure rate exceeds threshold", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_threshold_test", {
          failureThreshold: 3,
          timeout: 2000,
          monitoringPeriod: 5000,
          enableRedis: false,
        });

        const goodConnection = createGoodConnection();

        console.log("\n🔥 CHAOS: Testing failure threshold activation...");

        // Phase 1: Low failure rate - should stay CLOSED
        console.log("   Phase 1: 2 failures (below threshold)");
        await makeProtectedRpcCalls(circuitBreaker, goodConnection, 2, true);
        expect(circuitBreaker.getMetrics().state).toBe("CLOSED");

        await sleep(100);

        // Phase 2: Cross threshold - should open
        console.log("   Phase 2: 2 more failures (crossing threshold)");
        await makeProtectedRpcCalls(circuitBreaker, goodConnection, 2, true);

        const metrics = circuitBreaker.getMetrics();
        console.log(`   Circuit state: ${metrics.state}`);
        console.log(`   Failure count: ${metrics.failureCount}`);

        expect(metrics.state).toBe("OPEN");

        await circuitBreaker.reset();
      }, 10000);

      test("should track failures within monitoring period only", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_monitoring_period_test", {
          failureThreshold: 3,
          timeout: 2000,
          monitoringPeriod: 1000, // 1 second window
          enableRedis: false,
        });

        const goodConnection = createGoodConnection();

        console.log("\n🔥 CHAOS: Testing monitoring period window...");

        // Fail twice
        await makeProtectedRpcCalls(circuitBreaker, goodConnection, 2, true);
        console.log("   2 failures recorded");

        // Wait for monitoring period to expire
        console.log("   Waiting 1.5s for monitoring period to expire...");
        await sleep(1500);

        // Old failures should be forgotten - 2 more shouldn't open circuit
        await makeProtectedRpcCalls(circuitBreaker, goodConnection, 2, true);

        const metrics = circuitBreaker.getMetrics();
        console.log(`   Circuit state: ${metrics.state}`);

        // Should still be CLOSED (old failures expired)
        expect(metrics.state).toBe("CLOSED");

        await circuitBreaker.reset();
      }, 10000);
    });

    // ==========================================================================
    // Scenario 3: Circuit Breaker Recovery
    // ==========================================================================

    describe("Scenario 3: Circuit Breaker Recovery", () => {
      test("should transition from OPEN -> HALF_OPEN after timeout", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_recovery_test", {
          failureThreshold: 2,
          successThreshold: 2,
          timeout: 1000, // 1 second timeout
          enableRedis: false,
        });

        const badConnection = createBadConnection();

        console.log("\n🔥 CHAOS: Testing circuit breaker recovery...");

        // Open circuit
        await makeProtectedRpcCalls(circuitBreaker, badConnection, 3, false);
        expect(circuitBreaker.getMetrics().state).toBe("OPEN");
        console.log("   Circuit OPEN");

        // Wait for timeout
        console.log("   Waiting 1.2s for timeout...");
        await sleep(1200);

        // Make request - should transition to HALF_OPEN
        const goodConnection = createGoodConnection();
        await circuitBreaker.execute(async () => {
          return await connection.getSlot();
        });

        const metrics = circuitBreaker.getMetrics();
        console.log(`   Circuit state: ${metrics.state}`);

        // Should be HALF_OPEN or CLOSED (if request succeeded)
        expect(["HALF_OPEN", "CLOSED"]).toContain(metrics.state);

        await circuitBreaker.reset();
      }, 10000);

      test("should close circuit after successful requests in HALF_OPEN", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_half_open_recovery_test", {
          failureThreshold: 2,
          successThreshold: 2,
          timeout: 1000,
          enableRedis: false,
        });

        const goodConnection = createGoodConnection();
        const badConnection = createBadConnection();

        console.log("\n🔥 CHAOS: Testing HALF_OPEN -> CLOSED recovery...");

        // Open circuit
        await makeProtectedRpcCalls(circuitBreaker, badConnection, 3, false);
        expect(circuitBreaker.getMetrics().state).toBe("OPEN");

        // Wait for timeout
        await sleep(1200);

        // Make successful requests to close circuit
        const result = await makeProtectedRpcCalls(
          circuitBreaker,
          goodConnection,
          3,
          false
        );

        console.log(`   Successful: ${result.successful}`);

        const metrics = circuitBreaker.getMetrics();
        console.log(`   Circuit state: ${metrics.state}`);

        // Should be CLOSED after enough successes
        expect(metrics.state).toBe("CLOSED");

        await circuitBreaker.reset();
      }, 10000);

      test("should reopen circuit on failure during HALF_OPEN", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_half_open_failure_test", {
          failureThreshold: 2,
          timeout: 1000,
          enableRedis: false,
        });

        const goodConnection = createGoodConnection();
        const badConnection = createBadConnection();

        console.log("\n🔥 CHAOS: Testing HALF_OPEN failure -> OPEN...");

        // Open circuit
        await makeProtectedRpcCalls(circuitBreaker, badConnection, 3, false);
        expect(circuitBreaker.getMetrics().state).toBe("OPEN");

        // Wait for timeout
        await sleep(1200);

        // Fail during HALF_OPEN - should go back to OPEN
        await makeProtectedRpcCalls(circuitBreaker, badConnection, 1, false);

        const metrics = circuitBreaker.getMetrics();
        console.log(`   Circuit state: ${metrics.state}`);

        expect(metrics.state).toBe("OPEN");

        await circuitBreaker.reset();
      }, 10000);
    });

    // ==========================================================================
    // Scenario 4: Graceful Degradation
    // ==========================================================================

    describe("Scenario 4: Graceful Degradation", () => {
      test("should provide fallback data when RPC fails", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_fallback_test", {
          failureThreshold: 2,
          enableRedis: false,
        });

        const badConnection = createBadConnection();

        console.log("\n🔥 CHAOS: Testing graceful degradation with fallback...");

        // Simulate service with fallback
        async function getSlotWithFallback(): Promise<number> {
          const result = await circuitBreaker.execute(async () => {
            const callResult = await simulateRpcCall(badConnection, false);
            if (!callResult.success) {
              throw callResult.error;
            }
            return callResult.value;
          });

          if (result === null) {
            console.log("   Using fallback data (circuit OPEN)");
            return -1; // Fallback value
          }

          return result;
        }

        // Open circuit
        await makeProtectedRpcCalls(circuitBreaker, badConnection, 3, false);
        expect(circuitBreaker.getMetrics().state).toBe("OPEN");

        // Try to get slot - should return fallback
        const slot = await getSlotWithFallback();
        console.log(`   Slot value: ${slot}`);

        expect(slot).toBe(-1); // Got fallback value

        await circuitBreaker.reset();
      }, 10000);

      test("should continue operating with degraded functionality", async () => {
        console.log("\n🔥 CHAOS: Testing degraded mode operation...");

        const primaryCircuit = new CircuitBreaker("primary_rpc", {
          failureThreshold: 2,
          enableRedis: false,
        });

        const fallbackCircuit = new CircuitBreaker("fallback_rpc", {
          failureThreshold: 5,
          enableRedis: false,
        });

        const badConnection = createBadConnection();
        const goodConnection = createGoodConnection();

        // Fail primary
        await makeProtectedRpcCalls(primaryCircuit, badConnection, 3, false);
        expect(primaryCircuit.getMetrics().state).toBe("OPEN");
        console.log("   Primary RPC: OPEN");

        // Use fallback
        const fallbackResult = await makeProtectedRpcCalls(
          fallbackCircuit,
          goodConnection,
          5,
          false
        );

        console.log(`   Fallback successful: ${fallbackResult.successful}/5`);

        expect(fallbackResult.successful).toBeGreaterThan(0);
        expect(fallbackCircuit.getMetrics().state).toBe("CLOSED");

        await primaryCircuit.reset();
        await fallbackCircuit.reset();
      }, 15000);

      test("should log degraded mode and recovery", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_logging_test", {
          failureThreshold: 2,
          timeout: 1000,
          enableRedis: false,
        });

        const badConnection = createBadConnection();
        const goodConnection = createGoodConnection();

        console.log("\n🔥 CHAOS: Testing degraded mode logging...");

        const events: string[] = [];

        // Open circuit (degraded mode)
        await makeProtectedRpcCalls(circuitBreaker, badConnection, 3, false);
        if (circuitBreaker.getMetrics().state === "OPEN") {
          events.push("DEGRADED_MODE_ENTERED");
          console.log("   ⚠️  Degraded mode entered");
        }

        // Wait and recover
        await sleep(1200);

        // Successful recovery
        const recoveryResult = await makeProtectedRpcCalls(
          circuitBreaker,
          goodConnection,
          3,
          false
        );

        if (circuitBreaker.getMetrics().state === "CLOSED") {
          events.push("NORMAL_MODE_RESTORED");
          console.log("   ✅ Normal mode restored");
        }

        expect(events).toContain("DEGRADED_MODE_ENTERED");
        expect(events).toContain("NORMAL_MODE_RESTORED");

        await circuitBreaker.reset();
      }, 10000);
    });

    // ==========================================================================
    // Scenario 5: Redis Persistence (State Survival)
    // ==========================================================================

    describe("Scenario 5: Circuit Breaker State Persistence", () => {
      beforeEach(async () => {
        // Clear Redis before each test
        const keys = await redis.keys("circuit_breaker:*");
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      });

      test("should persist circuit breaker state to Redis", async () => {
        const circuitBreaker = new CircuitBreaker("rpc_persistence_test", {
          failureThreshold: 2,
          enableRedis: true, // Enable Redis
        });

        const badConnection = createBadConnection();

        console.log("\n🔥 CHAOS: Testing Redis state persistence...");

        // Open circuit
        await makeProtectedRpcCalls(circuitBreaker, badConnection, 3, false);
        expect(circuitBreaker.getMetrics().state).toBe("OPEN");

        // Wait for persistence
        await sleep(200);

        // Check Redis
        const redisState = await redis.get("circuit_breaker:rpc_persistence_test");
        console.log(`   Redis state exists: ${redisState !== null}`);

        expect(redisState).not.toBeNull();

        if (redisState) {
          const state = JSON.parse(redisState);
          console.log(`   Persisted state: ${state.state}`);
          expect(state.state).toBe("OPEN");
        }

        await circuitBreaker.reset();
      }, 10000);

      test("should restore circuit breaker state from Redis", async () => {
        console.log("\n🔥 CHAOS: Testing state restoration from Redis...");

        // Create first circuit breaker and open it
        const cb1 = new CircuitBreaker("rpc_restore_test", {
          failureThreshold: 2,
          enableRedis: true,
        });

        const badConnection = createBadConnection();
        await makeProtectedRpcCalls(cb1, badConnection, 3, false);
        expect(cb1.getMetrics().state).toBe("OPEN");

        // Wait for persistence
        await sleep(200);

        console.log("   First instance: OPEN");

        // Create new circuit breaker with same name - should load OPEN state
        const cb2 = new CircuitBreaker("rpc_restore_test", {
          failureThreshold: 2,
          enableRedis: true,
        });

        // Give it time to load from Redis
        await sleep(200);

        const metrics = cb2.getMetrics();
        console.log(`   Second instance state: ${metrics.state}`);

        // Should restore OPEN state
        expect(metrics.state).toBe("OPEN");

        await cb1.reset();
        await cb2.reset();
      }, 15000);
    });
  },
  {
    timeout: 180000, // 3 minutes for entire suite
  }
);

// Skip message for when tests are skipped
if (!shouldRunChaosTests) {
  describe.skip("Chaos Testing: RPC Failures", () => {
    test(skipMessage, () => {});
  });
}
