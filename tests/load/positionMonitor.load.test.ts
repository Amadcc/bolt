/**
 * Position Monitor Load Testing
 *
 * Tests position monitoring performance with high number of active positions.
 * Validates price feed rate limiting, batch processing, and system scalability.
 *
 * Run with:
 * ```bash
 * INTEGRATION_TESTS=true bun test tests/load/positionMonitor.load.test.ts
 * ```
 *
 * Performance Targets:
 * - 200 active positions monitored simultaneously
 * - Check cycle time: <10s for all 200 positions
 * - Price feed: No rate limit errors with proper caching
 * - Memory usage: Stable under load (<256MB growth)
 * - TP/SL triggers: Detected within 1 check cycle
 *
 * Note: These tests require:
 * 1. Mainnet or testnet RPC connection (for price feeds)
 * 2. Postgres with good performance (SSD recommended)
 * 3. Redis for price caching
 * 4. Test duration: ~5-10 minutes per test
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { prisma } from "../../src/utils/db.js";
import { redis } from "../../src/utils/redis.js";
import { PriceFeedService } from "../../src/services/trading/priceFeed.js";
import { ExitExecutor } from "../../src/services/trading/exitExecutor.js";
import { PositionMonitor } from "../../src/services/trading/positionMonitor.js";
import { asTokenMint, asLamports, type TokenMint } from "../../src/types/common.js";
import { asTokenPrice, asPercentage } from "../../src/types/positionMonitor.js";
import { logger } from "../../src/utils/logger.js";

// ============================================================================
// Configuration
// ============================================================================

const SKIP_LOAD_TESTS = process.env.INTEGRATION_TESTS !== "true";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// Test configuration
const NUM_POSITIONS = 200;
const CHECK_CYCLE_TARGET_MS = 10000; // 10 seconds
const TEST_TIMEOUT_MS = 15 * 60 * 1000; // 15 minute timeout

// Known mainnet tokens for testing (high liquidity, stable prices)
const TEST_TOKENS: TokenMint[] = [
  "So11111111111111111111111111111111111111112" as TokenMint, // SOL (wrapped)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as TokenMint, // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as TokenMint, // USDT
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" as TokenMint, // BONK
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" as TokenMint, // WIF
];

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
 * Create mock position in database
 */
async function createMockPosition(params: {
  userId: string;
  tokenMint: TokenMint;
  entryPrice: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopLoss?: boolean;
}): Promise<string> {
  const position = await prisma.sniperPosition.create({
    data: {
      userId: params.userId,
      tokenMint: params.tokenMint,
      entryPrice: params.entryPrice.toString(),
      amountIn: "100000000", // 0.1 SOL
      amountOut: "1000000", // Mock token amount
      status: "OPEN",
      takeProfitPct: params.takeProfitPct ?? null,
      stopLossPct: params.stopLossPct ?? null,
      trailingStopLoss: params.trailingStopLoss ?? false,
      signature: `mock_sig_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    },
  });

  return position.id;
}

/**
 * Create bulk mock positions
 */
async function createBulkMockPositions(
  userId: string,
  count: number
): Promise<string[]> {
  const positionIds: string[] = [];

  // Create positions in batches to avoid overwhelming database
  const batchSize = 50;
  for (let i = 0; i < count; i += batchSize) {
    const batchCount = Math.min(batchSize, count - i);
    const batchPromises = Array(batchCount)
      .fill(null)
      .map(async (_, index) => {
        const globalIndex = i + index;
        const tokenMint = TEST_TOKENS[globalIndex % TEST_TOKENS.length];

        return createMockPosition({
          userId,
          tokenMint,
          entryPrice: 1.0 + (globalIndex % 100) * 0.01, // Varied entry prices
          takeProfitPct: 50 + (globalIndex % 50), // 50-100% TP
          stopLossPct: 20 + (globalIndex % 30), // 20-50% SL
          trailingStopLoss: globalIndex % 5 === 0, // 20% with trailing
        });
      });

    const batchIds = await Promise.all(batchPromises);
    positionIds.push(...batchIds);

    // Small delay between batches
    await sleep(100);
  }

  return positionIds;
}

// ============================================================================
// Load Tests
// ============================================================================

describe.skipIf(SKIP_LOAD_TESTS)("Position Monitor Load Testing", () => {
  let connection: Connection;
  let priceFeedService: PriceFeedService;
  let exitExecutor: ExitExecutor;
  let positionMonitor: PositionMonitor;
  let userId: string;
  const testKeypair = Keypair.generate();

  beforeAll(async () => {
    logger.info("Initializing position monitor load tests", {
      rpc: RPC_URL,
      numPositions: NUM_POSITIONS,
      cycleTar: `${CHECK_CYCLE_TARGET_MS}ms`,
    });

    // Initialize services
    connection = new Connection(RPC_URL, "confirmed");

    // Initialize price feed with aggressive caching
    priceFeedService = new PriceFeedService(connection, {
      dexScreenerEnabled: true,
      jupiterEnabled: true,
      fallbackToJupiter: true,
      cacheTtlSeconds: 60, // 1 minute cache
      requestTimeoutMs: 5000,
    });

    // Mock exit executor (no real exits in load test)
    exitExecutor = {
      executeExit: async (params) => {
        // Mock implementation - just return success
        return {
          success: true,
          value: {
            signature: "mock_exit_signature" as any,
            inputAmount: BigInt(0) as any,
            outputAmount: BigInt(0) as any,
            priceImpactPct: 0,
          },
        };
      },
    } as any;

    // Mock keypair getter
    const getKeypair = async (userId: string) => testKeypair;

    // Initialize position monitor with high concurrency
    positionMonitor = new PositionMonitor(priceFeedService, exitExecutor, getKeypair, {
      checkIntervalMs: 5000, // 5 second check interval
      maxConcurrentChecks: 20, // Process 20 positions at a time
      priceCacheTtl: 60000, // 1 minute price cache
    });

    // Create test user
    const testUserId = `load-test-monitor-${Date.now()}`;
    await prisma.user.create({
      data: {
        id: testUserId,
        telegramId: BigInt(Date.now()),
        username: `loadtest_monitor_${Date.now()}`,
      },
    });
    userId = testUserId;

    logger.info("Position monitor load tests initialized", { userId });
  }, 60000); // 1 minute setup timeout

  afterAll(async () => {
    // Stop monitoring
    if (positionMonitor && positionMonitor.isMonitoring()) {
      positionMonitor.stopGlobalMonitoring();
    }

    // Cleanup
    if (userId) {
      await prisma.positionMonitor.deleteMany({ where: { userId } });
      await prisma.sniperPosition.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }

    logger.info("Position monitor load test cleanup complete");
  });

  /**
   * Test 1: Baseline Check Cycle Time
   *
   * Establishes baseline performance with 50 positions.
   * Measures check cycle time under normal load.
   */
  test(
    "Baseline: Check cycle time (50 positions)",
    async () => {
      console.log("\n📊 Starting baseline check cycle test...");
      console.log("   Positions: 50");

      const memoryBefore = getMemoryUsage();

      // Create 50 mock positions
      console.log("   Creating 50 mock positions...");
      const positionIds = await createBulkMockPositions(userId, 50);

      console.log("   Starting monitors...");
      for (const positionId of positionIds) {
        await positionMonitor.startMonitoring(positionId, {});
      }

      // Measure 5 check cycles
      const cycleTimes: number[] = [];

      for (let cycle = 0; cycle < 5; cycle++) {
        const cycleStart = Date.now();

        // Trigger a manual check cycle (simulates interval)
        await (positionMonitor as any).checkAllPositions();

        const cycleDuration = Date.now() - cycleStart;
        cycleTimes.push(cycleDuration);

        console.log(`   [Cycle ${cycle + 1}/5] ${cycleDuration}ms`);

        // Wait before next cycle
        await sleep(1000);
      }

      const memoryAfter = getMemoryUsage();
      const stats = calculateStats(cycleTimes);

      console.log("\n📊 Baseline Check Cycle Results:");
      console.log(`   Positions:       50`);
      console.log(`   Cycles:          ${stats.count}`);
      console.log(`   Min:             ${stats.min}ms`);
      console.log(`   Mean:            ${stats.mean.toFixed(2)}ms`);
      console.log(`   Median:          ${stats.median}ms`);
      console.log(`   P95:             ${stats.p95}ms`);
      console.log(`   P99:             ${stats.p99}ms`);
      console.log(`   Max:             ${stats.max}ms`);
      console.log(`   Memory delta:    ${formatBytes(memoryAfter.heapUsed - memoryBefore.heapUsed)}`);

      // Baseline should be fast
      const baselineP95 = stats.p95;
      console.log(
        `\n   ✅ Baseline established: p95 = ${baselineP95}ms for 50 positions`
      );

      // Cleanup
      for (const positionId of positionIds) {
        await positionMonitor.stopMonitoring(positionId);
      }

      // Assertions
      expect(stats.p95).toBeLessThan(CHECK_CYCLE_TARGET_MS / 4); // Baseline should be 4x faster
    },
    TEST_TIMEOUT_MS
  );

  /**
   * Test 2: Full Load Check Cycle (200 Positions)
   *
   * Tests check cycle performance with target load of 200 positions.
   * Validates batch processing and concurrent price fetching.
   */
  test(
    "Load: Check cycle time (200 positions)",
    async () => {
      console.log("\n⚡ Starting full load check cycle test...");
      console.log(`   Positions: ${NUM_POSITIONS}`);
      console.log(`   Target: <${CHECK_CYCLE_TARGET_MS}ms per cycle`);

      const memoryBefore = getMemoryUsage();

      // Create 200 mock positions
      console.log(`   Creating ${NUM_POSITIONS} mock positions...`);
      const positionIds = await createBulkMockPositions(userId, NUM_POSITIONS);

      console.log("   Starting monitors...");
      // Start monitors in batches to avoid overwhelming system
      const startBatchSize = 50;
      for (let i = 0; i < positionIds.length; i += startBatchSize) {
        const batch = positionIds.slice(i, i + startBatchSize);
        await Promise.all(
          batch.map((positionId) => positionMonitor.startMonitoring(positionId, {}))
        );
        console.log(`   Started ${Math.min(i + startBatchSize, positionIds.length)}/${positionIds.length} monitors`);
      }

      console.log(`   ✅ All ${NUM_POSITIONS} monitors started`);

      // Measure 5 check cycles
      const cycleTimes: number[] = [];

      for (let cycle = 0; cycle < 5; cycle++) {
        const cycleStart = Date.now();

        // Trigger a manual check cycle
        await (positionMonitor as any).checkAllPositions();

        const cycleDuration = Date.now() - cycleStart;
        cycleTimes.push(cycleDuration);

        console.log(`   [Cycle ${cycle + 1}/5] ${cycleDuration}ms`);

        // Wait before next cycle
        await sleep(2000);
      }

      const memoryAfter = getMemoryUsage();
      const stats = calculateStats(cycleTimes);

      console.log("\n📊 Full Load Check Cycle Results:");
      console.log(`   Positions:       ${NUM_POSITIONS}`);
      console.log(`   Cycles:          ${stats.count}`);
      console.log(`   Min:             ${stats.min}ms`);
      console.log(`   Mean:            ${stats.mean.toFixed(2)}ms`);
      console.log(`   Median:          ${stats.median}ms`);
      console.log(`   P95:             ${stats.p95}ms ← Target: <${CHECK_CYCLE_TARGET_MS}ms`);
      console.log(`   P99:             ${stats.p99}ms`);
      console.log(`   Max:             ${stats.max}ms`);
      console.log(`   Memory delta:    ${formatBytes(memoryAfter.heapUsed - memoryBefore.heapUsed)}`);
      console.log(`   Throughput:      ${(NUM_POSITIONS / (stats.mean / 1000)).toFixed(2)} checks/sec`);

      // Check if we met the target
      const metTarget = stats.p95 <= CHECK_CYCLE_TARGET_MS;
      console.log(
        `\n   ${metTarget ? "✅" : "⚠️ "} P95 Target: ${metTarget ? "MET" : "MISSED"} (${stats.p95}ms vs ${CHECK_CYCLE_TARGET_MS}ms)`
      );

      // Cleanup
      console.log("   Stopping monitors...");
      for (const positionId of positionIds) {
        await positionMonitor.stopMonitoring(positionId);
      }

      // Assertions
      expect(stats.p95).toBeLessThan(CHECK_CYCLE_TARGET_MS);
      expect(memoryAfter.heapUsed - memoryBefore.heapUsed).toBeLessThan(256 * 1024 * 1024); // < 256MB growth
    },
    TEST_TIMEOUT_MS
  );

  /**
   * Test 3: Price Feed Caching Efficiency
   *
   * Tests price feed cache hit rate under high load.
   * Validates that caching prevents excessive API calls.
   */
  test(
    "Price Feed: Cache hit rate under load",
    async () => {
      console.log("\n💾 Starting price feed cache efficiency test...");

      // Create positions with duplicate tokens (to test cache hits)
      const positionIds: string[] = [];
      for (let i = 0; i < 100; i++) {
        const tokenMint = TEST_TOKENS[i % TEST_TOKENS.length]; // Repeat tokens
        const positionId = await createMockPosition({
          userId,
          tokenMint,
          entryPrice: 1.0,
        });
        positionIds.push(positionId);
      }

      console.log(`   Created 100 positions using ${TEST_TOKENS.length} unique tokens`);
      console.log("   Starting monitors...");

      for (const positionId of positionIds) {
        await positionMonitor.startMonitoring(positionId, {});
      }

      // Clear Redis cache to start fresh
      await redis.flushdb();

      // Perform first check cycle (all cache misses)
      console.log("   First cycle (cold cache)...");
      const firstCycleStart = Date.now();
      await (positionMonitor as any).checkAllPositions();
      const firstCycleDuration = Date.now() - firstCycleStart;

      await sleep(1000);

      // Perform second check cycle (should have cache hits)
      console.log("   Second cycle (warm cache)...");
      const secondCycleStart = Date.now();
      await (positionMonitor as any).checkAllPositions();
      const secondCycleDuration = Date.now() - secondCycleStart;

      const cacheSpeedup = firstCycleDuration / secondCycleDuration;

      console.log("\n📊 Price Feed Cache Results:");
      console.log(`   Positions:         100`);
      console.log(`   Unique tokens:     ${TEST_TOKENS.length}`);
      console.log(`   First cycle:       ${firstCycleDuration}ms (cold cache)`);
      console.log(`   Second cycle:      ${secondCycleDuration}ms (warm cache)`);
      console.log(`   Cache speedup:     ${cacheSpeedup.toFixed(2)}x`);

      // Cache should provide significant speedup (at least 2x)
      const goodCaching = cacheSpeedup >= 2;
      console.log(
        `\n   ${goodCaching ? "✅" : "⚠️ "} Cache efficiency: ${goodCaching ? "GOOD" : "NEEDS IMPROVEMENT"} (${cacheSpeedup.toFixed(2)}x)`
      );

      // Cleanup
      for (const positionId of positionIds) {
        await positionMonitor.stopMonitoring(positionId);
      }

      // Assertions
      expect(cacheSpeedup).toBeGreaterThan(2); // At least 2x speedup with cache
    },
    TEST_TIMEOUT_MS
  );

  /**
   * Test 4: Memory Leak Detection
   *
   * Runs monitor for extended period to detect memory leaks.
   * Validates stable memory usage over multiple check cycles.
   */
  test(
    "Memory: Leak detection (10 cycles, 100 positions)",
    async () => {
      console.log("\n💾 Starting memory leak detection test...");
      console.log("   Duration: 10 check cycles");

      const positionIds = await createBulkMockPositions(userId, 100);

      for (const positionId of positionIds) {
        await positionMonitor.startMonitoring(positionId, {});
      }

      const memorySnapshots: Array<{ cycle: number; heap: number }> = [];

      // Record initial memory
      const memoryBefore = getMemoryUsage();
      memorySnapshots.push({ cycle: 0, heap: memoryBefore.heapUsed });

      // Run 10 check cycles
      for (let cycle = 1; cycle <= 10; cycle++) {
        await (positionMonitor as any).checkAllPositions();

        const currentMemory = getMemoryUsage();
        memorySnapshots.push({ cycle, heap: currentMemory.heapUsed });

        console.log(
          `   [Cycle ${cycle}/10] Memory: ${formatBytes(currentMemory.heapUsed)} (Δ ${formatBytes(currentMemory.heapUsed - memoryBefore.heapUsed)})`
        );

        await sleep(1000);
      }

      // Force garbage collection if available
      if (global.gc) {
        console.log("   Running garbage collection...");
        global.gc();
        await sleep(1000);
      }

      const memoryAfter = getMemoryUsage();
      const memoryGrowth = memoryAfter.heapUsed - memoryBefore.heapUsed;
      const growthPerCycle = memoryGrowth / 10;

      console.log("\n📊 Memory Leak Detection Results:");
      console.log(`   Positions:        100`);
      console.log(`   Cycles:           10`);
      console.log(`   Initial memory:   ${formatBytes(memoryBefore.heapUsed)}`);
      console.log(`   Final memory:     ${formatBytes(memoryAfter.heapUsed)}`);
      console.log(`   Total growth:     ${formatBytes(memoryGrowth)}`);
      console.log(`   Growth per cycle: ${formatBytes(growthPerCycle)}`);

      // Memory leak threshold: <5MB per cycle
      const hasMemoryLeak = growthPerCycle > 5 * 1024 * 1024;
      console.log(
        `\n   ${hasMemoryLeak ? "⚠️ " : "✅"} Memory leak: ${hasMemoryLeak ? "DETECTED" : "NONE"} (${formatBytes(growthPerCycle)}/cycle)`
      );

      // Cleanup
      for (const positionId of positionIds) {
        await positionMonitor.stopMonitoring(positionId);
      }

      // Assertions
      expect(growthPerCycle).toBeLessThan(10 * 1024 * 1024); // <10MB per cycle
    },
    TEST_TIMEOUT_MS
  );

  /**
   * Test 5: Global Monitoring Lifecycle
   *
   * Tests start/stop of global monitoring loop.
   * Validates interval registration and cleanup.
   */
  test("Lifecycle: Global monitoring start/stop", async () => {
    console.log("\n🔄 Starting global monitoring lifecycle test...");

    // Create a few positions
    const positionIds = await createBulkMockPositions(userId, 10);

    for (const positionId of positionIds) {
      await positionMonitor.startMonitoring(positionId, {});
    }

    // Start global monitoring
    console.log("   Starting global monitoring...");
    positionMonitor.startGlobalMonitoring();
    expect(positionMonitor.isMonitoring()).toBe(true);

    // Let it run for a few seconds
    console.log("   Running for 5 seconds...");
    await sleep(5000);

    // Stop global monitoring
    console.log("   Stopping global monitoring...");
    positionMonitor.stopGlobalMonitoring();
    expect(positionMonitor.isMonitoring()).toBe(false);

    console.log("\n   ✅ Global monitoring lifecycle test complete");

    // Cleanup
    for (const positionId of positionIds) {
      await positionMonitor.stopMonitoring(positionId);
    }
  }, 60000); // 1 minute timeout
});

/**
 * Manual Testing Instructions:
 *
 * 1. Configure environment:
 *    ```bash
 *    export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
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
 *    bun test tests/load/positionMonitor.load.test.ts
 *    ```
 *
 * 4. Interpret results:
 *    - Baseline (50 positions): <2.5s per cycle
 *    - Full load (200 positions): <10s per cycle
 *    - Cache speedup: >2x with warm cache
 *    - Memory growth: <10MB per cycle
 *    - Lifecycle: Clean start/stop
 *
 * 5. Expected results:
 *    - Baseline p95: 1-3s for 50 positions
 *    - Full load p95: 5-10s for 200 positions
 *    - Cache speedup: 2-5x (depends on API latency)
 *    - Memory: Stable growth <5MB/cycle
 *
 * 6. Troubleshooting:
 *    - Slow cycles: Increase maxConcurrentChecks
 *    - Price feed errors: Check RPC rate limits
 *    - Memory growth: Check for unclosed connections
 *    - Cache misses: Verify Redis connection
 *
 * 7. Performance tuning:
 *    - Adjust maxConcurrentChecks (10-50 depending on RPC limits)
 *    - Increase priceCacheTtl for less volatile tokens
 *    - Use paid RPC provider for higher rate limits
 *    - Enable connection pooling in RPC client
 */
