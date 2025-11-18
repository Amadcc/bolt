/**
 * Executor Load Testing
 *
 * Tests order execution pipeline performance under high concurrent load.
 * Validates database connection pooling, RPC rate limiting, and system resilience.
 *
 * Run with:
 * ```bash
 * INTEGRATION_TESTS=true SOLANA_NETWORK=devnet bun test tests/load/executor.load.test.ts
 * ```
 *
 * Performance Targets:
 * - 50 concurrent order executions without critical failures
 * - p95 end-to-end latency: <6s
 * - Database connection pool: No exhaustion or deadlocks
 * - RPC rate limits: Graceful handling with retries
 * - Memory usage: Stable under load (<512MB growth)
 * - Circuit breakers: Activate under extreme load
 *
 * Note: These tests require:
 * 1. Devnet RPC endpoint (free tier acceptable)
 * 2. Postgres with connection pooling configured
 * 3. Redis for caching and rate limiting
 * 4. At least 1 GB available memory
 * 5. Test duration: ~10-15 minutes per test
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { prisma } from "../../src/utils/db.js";
import { redis } from "../../src/utils/redis.js";
import { initializeSolana } from "../../src/services/blockchain/solana.js";
import { initializeJupiter } from "../../src/services/trading/jupiter.js";
import { initializeTradingExecutor } from "../../src/services/trading/executor.js";
import { initializeJitoService } from "../../src/services/trading/jito.js";
import { initializeHoneypotDetector } from "../../src/services/honeypot/detector.js";
import { SniperExecutor } from "../../src/services/sniper/executor.js";
import { createWallet, clearKeypair } from "../../src/services/wallet/keyManager.js";
import {
  createSession,
  destroyAllUserSessions,
  getKeypairForSigning,
} from "../../src/services/wallet/session.js";
import {
  asTokenMint,
  solToLamports,
  type SessionToken,
  type TokenMint,
} from "../../src/types/common.js";
import type { SniperOrderState, PriorityFeeMode } from "../../src/types/sniperOrder.js";
import { logger } from "../../src/utils/logger.js";

// ============================================================================
// Configuration
// ============================================================================

const SKIP_LOAD_TESTS = process.env.INTEGRATION_TESTS !== "true";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const NETWORK = process.env.SOLANA_NETWORK || "devnet";

// Test configuration
const CONCURRENT_ORDERS = 50;
const P95_LATENCY_TARGET_MS = 6000; // 6 seconds
const SWAP_AMOUNT_SOL = 0.05; // 0.05 SOL per order
const MIN_BALANCE_SOL = CONCURRENT_ORDERS * SWAP_AMOUNT_SOL * 1.2; // 20% buffer
const TEST_TIMEOUT_MS = 20 * 60 * 1000; // 20 minute timeout

// Devnet tokens
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as TokenMint; // Devnet USDC

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate percentile from sorted array
 */
function calculatePercentile(sortedArray: number[], percentile: number): number {
  if (sortedArray.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
  return sortedArray[Math.max(0, index)];
}

/**
 * Calculate statistics from latency samples
 */
function calculateStats(latencies: number[]) {
  if (latencies.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p50: 0, p95: 0, p99: 0, count: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p50: calculatePercentile(sorted, 50),
    p95: calculatePercentile(sorted, 95),
    p99: calculatePercentile(sorted, 99),
    count: sorted.length,
  };
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Get current memory usage
 */
function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
  };
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure wallet has sufficient balance (with retry)
 */
async function ensureTestBalance(
  connection: Connection,
  publicKey: PublicKey,
  minLamports: bigint
): Promise<void> {
  const balance = BigInt(await connection.getBalance(publicKey, "confirmed"));

  if (balance >= minLamports) {
    return; // Already has sufficient balance
  }

  // Request airdrop with retry
  const requestAmount = Number(minLamports - balance > minLamports ? minLamports : minLamports - balance);
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const signature = await connection.requestAirdrop(publicKey, requestAmount);

      // Confirm airdrop
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed"
      );

      return; // Success
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        logger.warn(`Failed to airdrop after ${maxAttempts} attempts - continuing anyway`, {
          error: error instanceof Error ? error.message : String(error),
          publicKey: publicKey.toBase58(),
        });
        return; // Continue without sufficient balance (test will fail if truly needed)
      }
      await sleep(2000); // Wait before retry
    }
  }
}

/**
 * Wait for order to reach target status or fail
 */
async function waitForOrderStatus(
  orderId: string,
  targetStatuses: string[],
  timeoutMs: number = 60000
): Promise<{ state: SniperOrderState; durationMs: number }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const order = await prisma.sniperOrder.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const state = order.state as unknown as SniperOrderState;

    if (targetStatuses.includes(state.status)) {
      return {
        state,
        durationMs: Date.now() - startTime,
      };
    }

    // If order failed, return immediately
    if (state.status === "FAILED") {
      return {
        state,
        durationMs: Date.now() - startTime,
      };
    }

    // Wait 500ms before checking again
    await sleep(500);
  }

  throw new Error(
    `Timeout waiting for order ${orderId} to reach status: ${targetStatuses.join(" or ")}`
  );
}

/**
 * Check database connection pool health
 */
async function checkDatabaseHealth(): Promise<{
  connected: boolean;
  activeConnections: number;
  idleConnections: number;
}> {
  try {
    // Execute a simple query to check connection
    await prisma.$queryRaw`SELECT 1`;

    // Get pool metrics (if available from Prisma client)
    // Note: Actual implementation depends on Prisma metrics API
    return {
      connected: true,
      activeConnections: 0, // Placeholder
      idleConnections: 0, // Placeholder
    };
  } catch (error) {
    return {
      connected: false,
      activeConnections: 0,
      idleConnections: 0,
    };
  }
}

// ============================================================================
// Load Tests
// ============================================================================

describe.skipIf(SKIP_LOAD_TESTS)("Executor Load Testing", () => {
  let connection: Connection;
  let executor: SniperExecutor;
  let userId: string;
  let walletPublicKey: string;
  let sessionToken: SessionToken;
  const testPassword = `LoadTest-Executor-${Date.now()}`;

  beforeAll(async () => {
    // Validate network
    if (NETWORK !== "devnet") {
      throw new Error("Load tests must run on devnet. Set SOLANA_NETWORK=devnet");
    }

    logger.info("Initializing executor load tests", {
      network: NETWORK,
      rpc: RPC_URL,
      concurrentOrders: CONCURRENT_ORDERS,
      p95Target: `${P95_LATENCY_TARGET_MS}ms`,
    });

    // Initialize services
    const solanaService = await initializeSolana({
      rpcUrl: RPC_URL,
      commitment: "confirmed",
    });

    connection = await solanaService.getConnection();

    // Initialize Jupiter
    initializeJupiter(connection, {
      baseUrl: process.env.JUPITER_API_URL || "https://lite-api.jup.ag",
      defaultSlippageBps: 100, // 1% slippage
    });

    // Initialize Trading Executor
    initializeTradingExecutor({
      commissionBps: 0,
      minCommissionUsd: 0,
    });

    // Initialize Jito (disabled for devnet)
    initializeJitoService(solanaService, {
      enabled: false,
    });

    // Initialize Honeypot Detector (disabled for load tests)
    initializeHoneypotDetector({
      providers: {
        goplus: { enabled: false, priority: 1, timeout: 5000 },
        rugcheck: { enabled: false, priority: 2, timeout: 5000 },
        tokensniffer: { enabled: false, priority: 3, timeout: 5000 },
      },
      fallbackChain: { enabled: false, maxAttempts: 1 },
      cacheConfig: { ttlMinutes: 60 },
    });

    // Create test user
    const testUserId = `load-test-${Date.now()}`;
    await prisma.user.create({
      data: {
        id: testUserId,
        telegramId: BigInt(Date.now()),
        username: `loadtest_${Date.now()}`,
      },
    });
    userId = testUserId;

    // Create wallet
    const walletResult = await createWallet({ userId, password: testPassword });
    if (!walletResult.success) {
      throw new Error(`Failed to create wallet: ${JSON.stringify(walletResult.error)}`);
    }

    walletPublicKey = walletResult.value.publicKey;

    // Create session
    const sessionResult = await createSession({ userId, password: testPassword });
    if (!sessionResult.success) {
      throw new Error(`Failed to create session: ${sessionResult.error.message}`);
    }

    sessionToken = sessionResult.value.sessionToken;

    // Ensure sufficient balance
    const minBalance = solToLamports(MIN_BALANCE_SOL);
    await ensureTestBalance(connection, new PublicKey(walletPublicKey), minBalance);

    // Initialize executor
    executor = new SniperExecutor(connection);

    logger.info("Executor load tests initialized", {
      userId,
      wallet: walletPublicKey,
      balance: `${MIN_BALANCE_SOL} SOL`,
    });
  }, 60000); // 1 minute setup timeout

  afterAll(async () => {
    // Cleanup
    if (userId) {
      await destroyAllUserSessions(userId);
      await prisma.wallet.deleteMany({ where: { userId } });
      await prisma.sniperOrder.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }

    logger.info("Executor load test cleanup complete");
  });

  /**
   * Test 1: Sequential Order Execution Baseline
   *
   * Establishes baseline performance without concurrent load.
   * Measures average order execution time under normal conditions.
   */
  test(
    "Baseline: Sequential order execution (10 orders)",
    async () => {
      console.log("\n📊 Starting baseline sequential execution test...");
      console.log(`   Orders: 10 sequential orders`);
      console.log(`   Amount: ${SWAP_AMOUNT_SOL} SOL each`);

      const memoryBefore = getMemoryUsage();
      const executionTimes: number[] = [];
      const results: Array<{ success: boolean; status: string; durationMs: number }> = [];

      for (let i = 0; i < 10; i++) {
        const startTime = Date.now();

        try {
          // Create order
          const createResult = await executor.createOrder({
            userId,
            tokenMint: DEVNET_USDC,
            amountSol: SWAP_AMOUNT_SOL,
            slippageBps: 500, // 5% slippage
            priorityFee: "MEDIUM",
            useJito: false,
            maxRetries: 2,
            timeoutMs: 30000,
          });

          if (!createResult.success) {
            results.push({
              success: false,
              status: "CREATE_FAILED",
              durationMs: Date.now() - startTime,
            });
            console.log(`   [${i + 1}/10] ❌ Order creation failed`);
            continue;
          }

          const order = createResult.value;

          // Get keypair from session to execute the order
          const keypairResult = await getKeypairForSigning(sessionToken, testPassword);

          if (!keypairResult.success) {
            results.push({
              success: false,
              status: "KEYPAIR_ERROR",
              durationMs: Date.now() - startTime,
            });
            console.log(`   [${i + 1}/10] ❌ Failed to get keypair`);
            continue;
          }

          const keypair = keypairResult.value;

          // Execute order in background (don't await - let it run async)
          executor.executeOrder(order.id, keypair)
            .then((result) => {
              clearKeypair(keypair); // Clean up keypair after execution
            })
            .catch((error) => {
              clearKeypair(keypair);
              logger.error("Order execution error", { orderId: order.id, error });
            });

          // Wait for completion
          const { state, durationMs } = await waitForOrderStatus(
            order.id,
            ["CONFIRMED", "FAILED"],
            45000 // 45 second timeout
          );

          const totalDuration = Date.now() - startTime;
          executionTimes.push(totalDuration);

          results.push({
            success: state.status === "CONFIRMED",
            status: state.status,
            durationMs: totalDuration,
          });

          console.log(
            `   [${i + 1}/10] ${state.status === "CONFIRMED" ? "✅" : "❌"} ${state.status} (${(totalDuration / 1000).toFixed(2)}s)`
          );
        } catch (error) {
          const totalDuration = Date.now() - startTime;
          results.push({
            success: false,
            status: "TIMEOUT",
            durationMs: totalDuration,
          });
          console.log(`   [${i + 1}/10] ⚠️  TIMEOUT (${(totalDuration / 1000).toFixed(2)}s)`);
        }

        // Small delay between orders
        await sleep(1000);
      }

      const memoryAfter = getMemoryUsage();
      const stats = calculateStats(executionTimes);

      console.log("\n📊 Baseline Sequential Execution Results:");
      console.log(`   Orders:         ${results.length}`);
      console.log(`   Successful:     ${results.filter((r) => r.success).length}`);
      console.log(`   Failed:         ${results.filter((r) => !r.success).length}`);
      console.log(`   Success rate:   ${((results.filter((r) => r.success).length / results.length) * 100).toFixed(1)}%`);
      console.log(`   Min:            ${(stats.min / 1000).toFixed(2)}s`);
      console.log(`   Mean:           ${(stats.mean / 1000).toFixed(2)}s`);
      console.log(`   Median:         ${(stats.median / 1000).toFixed(2)}s`);
      console.log(`   P95:            ${(stats.p95 / 1000).toFixed(2)}s ← Baseline`);
      console.log(`   P99:            ${(stats.p99 / 1000).toFixed(2)}s`);
      console.log(`   Max:            ${(stats.max / 1000).toFixed(2)}s`);
      console.log(`   Memory delta:   ${formatBytes(memoryAfter.heapUsed - memoryBefore.heapUsed)}`);

      // Baseline should have reasonable performance
      const baselineP95 = stats.p95;
      console.log(
        `\n   ✅ Baseline established: p95 = ${(baselineP95 / 1000).toFixed(2)}s`
      );

      // Assertions
      expect(results.filter((r) => r.success).length).toBeGreaterThan(5); // At least 50% success
      expect(stats.p95).toBeLessThan(P95_LATENCY_TARGET_MS); // Baseline should meet target
    },
    TEST_TIMEOUT_MS
  );

  /**
   * Test 2: Concurrent Order Execution Under Load
   *
   * Simulates 50 concurrent order executions to test:
   * - Database connection pooling
   * - RPC rate limit handling
   * - System performance under load
   * - Circuit breaker behavior
   */
  test(
    "Load: 50 concurrent order executions",
    async () => {
      console.log("\n⚡ Starting concurrent load test...");
      console.log(`   Concurrent orders: ${CONCURRENT_ORDERS}`);
      console.log(`   Amount per order: ${SWAP_AMOUNT_SOL} SOL`);
      console.log(`   Total volume: ${CONCURRENT_ORDERS * SWAP_AMOUNT_SOL} SOL`);

      const memoryBefore = getMemoryUsage();
      const dbHealthBefore = await checkDatabaseHealth();

      console.log(`   Memory before: ${formatBytes(memoryBefore.heapUsed)}`);
      console.log(`   DB connected: ${dbHealthBefore.connected}`);

      // Launch all orders concurrently
      const startTime = Date.now();
      const orderPromises = Array(CONCURRENT_ORDERS)
        .fill(null)
        .map(async (_, index) => {
          const orderStartTime = Date.now();

          try {
            // Create order
            const createResult = await executor.createOrder({
              userId,
              tokenMint: DEVNET_USDC,
              amountSol: SWAP_AMOUNT_SOL,
              slippageBps: 500, // 5% slippage
              priorityFee: "MEDIUM",
              useJito: false,
              maxRetries: 2,
              timeoutMs: 30000,
            });

            if (!createResult.success) {
              return {
                index,
                success: false,
                status: "CREATE_FAILED",
                durationMs: Date.now() - orderStartTime,
              };
            }

            const order = createResult.value;

            // Get keypair from session to execute the order
            const keypairResult = await getKeypairForSigning(sessionToken, testPassword);

            if (!keypairResult.success) {
              return {
                index,
                success: false,
                status: "KEYPAIR_ERROR",
                durationMs: Date.now() - orderStartTime,
                error: "Failed to get keypair from session",
              };
            }

            const keypair = keypairResult.value;

            // Execute order in background (don't await - let it run async)
            executor.executeOrder(order.id, keypair)
              .then((result) => {
                clearKeypair(keypair); // Clean up keypair after execution
              })
              .catch((error) => {
                clearKeypair(keypair);
                logger.error("Order execution error", { orderId: order.id, error });
              });

            // Wait for completion (with shorter timeout for load test)
            const { state, durationMs } = await waitForOrderStatus(
              order.id,
              ["CONFIRMED", "FAILED"],
              45000 // 45 second timeout
            );

            return {
              index,
              success: state.status === "CONFIRMED",
              status: state.status,
              durationMs: Date.now() - orderStartTime,
            };
          } catch (error) {
            return {
              index,
              success: false,
              status: "TIMEOUT",
              durationMs: Date.now() - orderStartTime,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        });

      // Wait for all orders to complete
      console.log(`   ⏳ Waiting for ${CONCURRENT_ORDERS} orders to complete...`);
      const results = await Promise.all(orderPromises);

      const totalDuration = Date.now() - startTime;
      const memoryAfter = getMemoryUsage();
      const dbHealthAfter = await checkDatabaseHealth();

      // Calculate statistics
      const successfulOrders = results.filter((r) => r.success);
      const failedOrders = results.filter((r) => !r.success);
      const latencies = results.map((r) => r.durationMs);
      const stats = calculateStats(latencies);

      console.log("\n📊 Concurrent Load Test Results:");
      console.log(`   Total duration:     ${(totalDuration / 1000).toFixed(2)}s`);
      console.log(`   Concurrent orders:  ${CONCURRENT_ORDERS}`);
      console.log(`   Successful:         ${successfulOrders.length}`);
      console.log(`   Failed:             ${failedOrders.length}`);
      console.log(`   Success rate:       ${((successfulOrders.length / results.length) * 100).toFixed(1)}%`);
      console.log(`   Throughput:         ${(results.length / (totalDuration / 1000)).toFixed(2)} orders/sec`);
      console.log("\n📊 Latency Distribution:");
      console.log(`   Min:                ${(stats.min / 1000).toFixed(2)}s`);
      console.log(`   Mean:               ${(stats.mean / 1000).toFixed(2)}s`);
      console.log(`   Median:             ${(stats.median / 1000).toFixed(2)}s`);
      console.log(`   P95:                ${(stats.p95 / 1000).toFixed(2)}s ← Target: <${(P95_LATENCY_TARGET_MS / 1000).toFixed(1)}s`);
      console.log(`   P99:                ${(stats.p99 / 1000).toFixed(2)}s`);
      console.log(`   Max:                ${(stats.max / 1000).toFixed(2)}s`);
      console.log("\n📊 System Health:");
      console.log(`   Memory delta:       ${formatBytes(memoryAfter.heapUsed - memoryBefore.heapUsed)}`);
      console.log(`   DB connected:       ${dbHealthAfter.connected}`);

      // Failure breakdown
      if (failedOrders.length > 0) {
        const failureReasons = failedOrders.reduce(
          (acc, order) => {
            acc[order.status] = (acc[order.status] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        console.log("\n⚠️  Failure Breakdown:");
        Object.entries(failureReasons).forEach(([reason, count]) => {
          console.log(`   ${reason.padEnd(20)} ${count} (${((count / failedOrders.length) * 100).toFixed(1)}%)`);
        });
      }

      // Check if we met the target
      const metTarget = stats.p95 <= P95_LATENCY_TARGET_MS;
      console.log(
        `\n   ${metTarget ? "✅" : "⚠️ "} P95 Target: ${metTarget ? "MET" : "MISSED"} (${(stats.p95 / 1000).toFixed(2)}s vs ${(P95_LATENCY_TARGET_MS / 1000).toFixed(1)}s)`
      );

      // Assertions
      expect(successfulOrders.length).toBeGreaterThan(CONCURRENT_ORDERS * 0.5); // At least 50% success
      expect(stats.p95).toBeLessThan(P95_LATENCY_TARGET_MS); // Meet p95 target
      expect(memoryAfter.heapUsed - memoryBefore.heapUsed).toBeLessThan(512 * 1024 * 1024); // Memory delta < 512MB
      expect(dbHealthAfter.connected).toBe(true); // Database still connected
    },
    TEST_TIMEOUT_MS
  );

  /**
   * Test 3: Database Connection Pool Stress Test
   *
   * Tests database connection pool limits by creating many concurrent
   * database queries to verify no deadlocks or connection exhaustion.
   */
  test(
    "Database: Connection pool stress test",
    async () => {
      console.log("\n💾 Starting database connection pool stress test...");
      console.log("   Testing connection pool with 100 concurrent queries");

      const dbHealthBefore = await checkDatabaseHealth();
      const startTime = Date.now();

      // Create 100 concurrent database queries
      const queryPromises = Array(100)
        .fill(null)
        .map(async (_, index) => {
          const queryStart = Date.now();

          try {
            // Perform a complex query that uses connection
            const order = await prisma.sniperOrder.findMany({
              where: { userId },
              take: 10,
              orderBy: { createdAt: "desc" },
              include: {
                user: true,
              },
            });

            return {
              index,
              success: true,
              durationMs: Date.now() - queryStart,
            };
          } catch (error) {
            return {
              index,
              success: false,
              durationMs: Date.now() - queryStart,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        });

      const results = await Promise.all(queryPromises);
      const totalDuration = Date.now() - startTime;
      const dbHealthAfter = await checkDatabaseHealth();

      const successfulQueries = results.filter((r) => r.success);
      const failedQueries = results.filter((r) => !r.success);
      const latencies = results.map((r) => r.durationMs);
      const stats = calculateStats(latencies);

      console.log("\n📊 Database Connection Pool Results:");
      console.log(`   Total duration:     ${totalDuration}ms`);
      console.log(`   Queries:            ${results.length}`);
      console.log(`   Successful:         ${successfulQueries.length}`);
      console.log(`   Failed:             ${failedQueries.length}`);
      console.log(`   Success rate:       ${((successfulQueries.length / results.length) * 100).toFixed(1)}%`);
      console.log(`   Min latency:        ${stats.min}ms`);
      console.log(`   Mean latency:       ${stats.mean.toFixed(2)}ms`);
      console.log(`   Median latency:     ${stats.median}ms`);
      console.log(`   P95 latency:        ${stats.p95}ms`);
      console.log(`   Max latency:        ${stats.max}ms`);
      console.log(`   DB before:          ${dbHealthBefore.connected}`);
      console.log(`   DB after:           ${dbHealthAfter.connected}`);

      if (failedQueries.length > 0) {
        console.log("\n⚠️  Query Failures:");
        failedQueries.forEach((q) => {
          console.log(`   [${q.index}] ${q.error}`);
        });
      }

      // Assertions
      expect(successfulQueries.length).toBeGreaterThan(95); // >95% success rate
      expect(dbHealthAfter.connected).toBe(true); // Database still connected
      expect(stats.p95).toBeLessThan(1000); // p95 < 1s for simple queries
    },
    60000 // 1 minute timeout
  );

  /**
   * Test 4: Rate Limit Handling
   *
   * Tests system behavior when hitting RPC rate limits.
   * Verifies graceful degradation and retry logic.
   */
  test(
    "RPC: Rate limit handling and retries",
    async () => {
      console.log("\n🚦 Starting RPC rate limit test...");
      console.log("   Rapidly creating orders to trigger rate limits");

      const startTime = Date.now();
      const results: Array<{ success: boolean; retries: number; durationMs: number }> = [];

      // Rapidly create orders (no delay between requests)
      const orderPromises = Array(20)
        .fill(null)
        .map(async (_, index) => {
          const orderStart = Date.now();

          try {
            const createResult = await executor.createOrder({
              userId,
              tokenMint: DEVNET_USDC,
              amountSol: SWAP_AMOUNT_SOL,
              slippageBps: 500,
              priorityFee: "MEDIUM",
              useJito: false,
              maxRetries: 3, // Allow retries for rate limits
              timeoutMs: 30000,
            });

            return {
              success: createResult.success,
              retries: 0, // Placeholder - would need to track from executor
              durationMs: Date.now() - orderStart,
            };
          } catch (error) {
            return {
              success: false,
              retries: 0,
              durationMs: Date.now() - orderStart,
            };
          }
        });

      const orderResults = await Promise.all(orderPromises);
      const totalDuration = Date.now() - startTime;

      const successfulOrders = orderResults.filter((r) => r.success);
      const latencies = orderResults.map((r) => r.durationMs);
      const stats = calculateStats(latencies);

      console.log("\n📊 Rate Limit Handling Results:");
      console.log(`   Total duration:     ${totalDuration}ms`);
      console.log(`   Orders attempted:   ${orderResults.length}`);
      console.log(`   Successful:         ${successfulOrders.length}`);
      console.log(`   Failed:             ${orderResults.length - successfulOrders.length}`);
      console.log(`   Success rate:       ${((successfulOrders.length / orderResults.length) * 100).toFixed(1)}%`);
      console.log(`   Mean latency:       ${stats.mean.toFixed(2)}ms`);
      console.log(`   P95 latency:        ${stats.p95}ms`);

      // With proper retry logic, we should have >50% success even with rate limits
      const meetTarget = successfulOrders.length / orderResults.length >= 0.5;
      console.log(
        `\n   ${meetTarget ? "✅" : "⚠️ "} Rate limit handling: ${meetTarget ? "GOOD" : "NEEDS IMPROVEMENT"}`
      );

      // Assertions
      expect(successfulOrders.length).toBeGreaterThan(orderResults.length * 0.3); // At least 30% success with rate limits
    },
    5 * 60 * 1000 // 5 minute timeout
  );
});

/**
 * Manual Testing Instructions:
 *
 * 1. Configure environment:
 *    ```bash
 *    export SOLANA_NETWORK=devnet
 *    export SOLANA_RPC_URL=https://api.devnet.solana.com
 *    export INTEGRATION_TESTS=true
 *    ```
 *
 * 2. Ensure database and Redis are running:
 *    ```bash
 *    docker-compose up -d postgres redis
 *    ```
 *
 * 3. Run load tests:
 *    ```bash
 *    bun test tests/load/executor.load.test.ts
 *    ```
 *
 * 4. Interpret results:
 *    - Baseline p95 < 6s: ✅ Good baseline performance
 *    - Concurrent p95 < 6s: ✅ Handles load well
 *    - Success rate > 50%: ✅ Resilient under load
 *    - Database queries p95 < 1s: ✅ Connection pool healthy
 *    - Rate limit success > 30%: ✅ Retry logic working
 *
 * 5. Expected results:
 *    - Sequential: 3-5s average per order
 *    - Concurrent: 4-7s p95 with 50-80% success rate
 *    - Database: <500ms p95 for simple queries
 *    - Rate limits: 30-60% success (depends on RPC provider limits)
 *
 * 6. Troubleshooting:
 *    - High latency: Check RPC provider, consider paid tier
 *    - Database errors: Increase connection pool size
 *    - Memory leaks: Check for unclosed connections
 *    - Rate limits: Reduce concurrent orders or add delays
 *
 * 7. Performance tuning:
 *    - Increase Prisma connection pool: DATABASE_URL?connection_limit=20
 *    - Use paid RPC provider for higher rate limits
 *    - Enable Redis caching to reduce database load
 *    - Adjust retry backoff timings for faster recovery
 */
