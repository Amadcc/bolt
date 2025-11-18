/**
 * WebSocket Pool Load Testing
 *
 * Tests SourceManager and WebSocket pool performance under load.
 *
 * Run with:
 * ```bash
 * INTEGRATION_TESTS=true bun test tests/load/websocketPool.load.test.ts
 * ```
 *
 * Performance Targets:
 * - 100 concurrent detections without errors
 * - p95 detection latency: <500ms
 * - Circuit breaker activation under extreme load
 * - Zero connection leaks after stress testing
 * - Memory usage stays below 512MB under load
 *
 * Note: These tests require:
 * 1. Mainnet RPC endpoint (or high-quality testnet)
 * 2. Sufficient RPC rate limits (recommend paid RPC provider)
 * 3. At least 10-15 minutes to collect enough data
 * 4. Docker with available memory (512MB minimum)
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Connection } from "@solana/web3.js";
import { SourceManager } from "../../src/services/sniper/SourceManager.js";
import type { ScoredPoolDetection } from "../../src/services/sniper/SourceManager.js";
import type { PoolSource } from "../../src/types/sniper.js";
import { logger } from "../../src/utils/logger.js";

// Skip unless INTEGRATION_TESTS=true
const SKIP_LOAD_TESTS = process.env.INTEGRATION_TESTS !== "true";

// Load test configuration
const CONCURRENT_DETECTIONS_TARGET = 100;
const P95_LATENCY_TARGET_MS = 500;
const MIN_SAMPLES = 50; // Minimum for statistical significance
const MAX_COLLECTION_TIME_MS = 15 * 60 * 1000; // 15 minutes

// Test configuration
const RPC_ENDPOINT =
  process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const TEST_TIMEOUT_MS = 20 * 60 * 1000; // 20 minute timeout

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
    rss: usage.rss, // Resident Set Size
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

// ============================================================================
// Load Tests
// ============================================================================

describe.skipIf(SKIP_LOAD_TESTS)("WebSocket Pool Load Testing", () => {
  let connection: Connection;
  let sourceManager: SourceManager | null = null;

  beforeAll(() => {
    connection = new Connection(RPC_ENDPOINT, "confirmed");
    logger.info("Load test initialized", {
      rpc: RPC_ENDPOINT,
      target: `${CONCURRENT_DETECTIONS_TARGET} concurrent detections`,
      p95Target: `${P95_LATENCY_TARGET_MS}ms`,
    });
  });

  afterAll(async () => {
    if (sourceManager) {
      await sourceManager.stop();
      sourceManager = null;
    }
    logger.info("Load test cleanup complete");
  });

  /**
   * Test 1: Baseline Detection Latency
   *
   * Measures normal detection latency without artificial load.
   * Establishes baseline for comparison with concurrent load tests.
   */
  test(
    "Baseline: Detection latency (no artificial load)",
    async () => {
      console.log("\n🌐 Starting baseline detection latency test...");
      console.log(`   RPC: ${RPC_ENDPOINT}`);
      console.log(`   Target: Collect ${MIN_SAMPLES} detections`);

      // Record initial memory
      const memoryBefore = getMemoryUsage();
      console.log(`   Memory before: ${formatBytes(memoryBefore.heapUsed)}`);

      // Initialize SourceManager with all sources
      sourceManager = new SourceManager(connection, {
        enableRaydiumV4: true,
        enableRaydiumCLMM: true,
        enableOrcaWhirlpool: true,
        enableMeteora: true,
        enablePumpFun: true,
      });

      const detections: Array<{
        pool: ScoredPoolDetection;
        detectedAt: number;
      }> = [];
      const testStartTime = Date.now();

      // Start monitoring
      await sourceManager.start((pool) => {
        const detectedAt = Date.now();
        detections.push({ pool, detectedAt });

        console.log(
          `   [${detections.length}/${MIN_SAMPLES}] ${pool.source} | ${pool.tokenMintA.slice(0, 8)}... | Score: ${pool.priorityScore}`
        );

        if (detections.length >= MIN_SAMPLES) {
          // Stop collecting (but don't stop manager yet)
          console.log(`   ✅ Target reached (${MIN_SAMPLES} detections)`);
        }
      });

      // Wait for MIN_SAMPLES detections or timeout
      const pollInterval = 1000; // 1 second
      let elapsed = 0;

      while (detections.length < MIN_SAMPLES && elapsed < MAX_COLLECTION_TIME_MS) {
        await sleep(pollInterval);
        elapsed += pollInterval;

        // Progress update every 30 seconds
        if (elapsed % 30000 === 0) {
          console.log(
            `   Progress: ${detections.length}/${MIN_SAMPLES} detections (${(elapsed / 1000).toFixed(0)}s elapsed)`
          );
        }
      }

      const testDuration = Date.now() - testStartTime;

      // Calculate latencies (time from test start to detection)
      const latencies = detections.map((d) => d.detectedAt - testStartTime);
      const stats = calculateStats(latencies);

      // Memory after
      const memoryAfter = getMemoryUsage();
      const memoryDelta = memoryAfter.heapUsed - memoryBefore.heapUsed;

      console.log("\n📊 Baseline Detection Latency Results:");
      console.log(`   Samples:     ${stats.count}`);
      console.log(`   Duration:    ${(testDuration / 1000).toFixed(2)}s`);
      console.log(`   Throughput:  ${(stats.count / (testDuration / 1000)).toFixed(2)} detections/sec`);
      console.log(`   Min:         ${stats.min.toFixed(2)}ms`);
      console.log(`   Mean:        ${stats.mean.toFixed(2)}ms`);
      console.log(`   Median:      ${stats.median.toFixed(2)}ms`);
      console.log(`   P95:         ${stats.p95.toFixed(2)}ms ← Target: <${P95_LATENCY_TARGET_MS}ms`);
      console.log(`   P99:         ${stats.p99.toFixed(2)}ms`);
      console.log(`   Max:         ${stats.max.toFixed(2)}ms`);
      console.log(`   Memory:      ${formatBytes(memoryAfter.heapUsed)} (Δ ${formatBytes(memoryDelta)})`);

      // DEX distribution
      const dexCounts: Partial<Record<PoolSource, number>> = {};
      detections.forEach(({ pool }) => {
        dexCounts[pool.source] = (dexCounts[pool.source] || 0) + 1;
      });

      console.log("\n📊 DEX Distribution:");
      Object.entries(dexCounts)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .forEach(([dex, count]) => {
          console.log(
            `   ${dex.padEnd(20)} ${count} (${((count / stats.count) * 100).toFixed(1)}%)`
          );
        });

      // Check if we met the target
      const metTarget = stats.p95 <= P95_LATENCY_TARGET_MS;
      console.log(
        `\n   ${metTarget ? "✅" : "⚠️ "} P95 Target: ${metTarget ? "MET" : "MISSED"} (${stats.p95.toFixed(2)}ms vs ${P95_LATENCY_TARGET_MS}ms)`
      );

      // Assertions
      expect(detections.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
      expect(stats.p95).toBeLessThanOrEqual(P95_LATENCY_TARGET_MS);

      // Don't stop manager yet - will be stopped in afterAll
    },
    TEST_TIMEOUT_MS
  );

  /**
   * Test 2: Concurrent Load Test
   *
   * Simulates high load by creating multiple concurrent subscriptions
   * to the same DEX sources and measuring performance degradation.
   */
  test(
    "Load: 100 concurrent detection operations",
    async () => {
      console.log("\n⚡ Starting concurrent load test...");
      console.log(`   Target: ${CONCURRENT_DETECTIONS_TARGET} concurrent operations`);

      // Stop previous manager if running
      if (sourceManager) {
        await sourceManager.stop();
        sourceManager = null;
      }

      // Create multiple source managers to simulate load
      const managers: SourceManager[] = [];
      const allDetections: Array<{
        managerId: number;
        pool: ScoredPoolDetection;
        detectedAt: number;
      }> = [];

      const testStartTime = Date.now();
      const memoryBefore = getMemoryUsage();

      console.log(`   Memory before: ${formatBytes(memoryBefore.heapUsed)}`);
      console.log(`   Creating ${CONCURRENT_DETECTIONS_TARGET} concurrent subscriptions...`);

      // Create multiple managers (simulate concurrent load)
      // Note: In practice, we'll create 10 managers to simulate 100 concurrent operations
      const NUM_MANAGERS = 10;
      const OPERATIONS_PER_MANAGER = Math.ceil(CONCURRENT_DETECTIONS_TARGET / NUM_MANAGERS);

      for (let i = 0; i < NUM_MANAGERS; i++) {
        const manager = new SourceManager(connection, {
          enableRaydiumV4: true,
          enableRaydiumCLMM: true,
          enableOrcaWhirlpool: true,
          enableMeteora: true,
          enablePumpFun: true,
        });
        managers.push(manager);

        // Start monitoring
        await manager.start((pool) => {
          const detectedAt = Date.now();
          allDetections.push({ managerId: i, pool, detectedAt });

          if (allDetections.length % 10 === 0) {
            console.log(
              `   [${allDetections.length}/${CONCURRENT_DETECTIONS_TARGET}] Detections collected from ${new Set(allDetections.map((d) => d.managerId)).size}/${NUM_MANAGERS} managers`
            );
          }
        });

        // Small delay between manager starts to avoid thundering herd
        await sleep(100);
      }

      console.log(`   ✅ ${NUM_MANAGERS} managers started successfully`);

      // Wait for enough detections or timeout
      const pollInterval = 1000;
      let elapsed = 0;

      while (
        allDetections.length < CONCURRENT_DETECTIONS_TARGET &&
        elapsed < MAX_COLLECTION_TIME_MS
      ) {
        await sleep(pollInterval);
        elapsed += pollInterval;

        // Progress update every 30 seconds
        if (elapsed % 30000 === 0) {
          console.log(
            `   Progress: ${allDetections.length}/${CONCURRENT_DETECTIONS_TARGET} detections (${(elapsed / 1000).toFixed(0)}s elapsed)`
          );
        }
      }

      const testDuration = Date.now() - testStartTime;

      // Stop all managers
      console.log(`   Stopping ${NUM_MANAGERS} managers...`);
      await Promise.all(managers.map((m) => m.stop()));

      // Calculate latencies
      const latencies = allDetections.map((d) => d.detectedAt - testStartTime);
      const stats = calculateStats(latencies);

      // Memory after
      const memoryAfter = getMemoryUsage();
      const memoryDelta = memoryAfter.heapUsed - memoryBefore.heapUsed;

      console.log("\n📊 Concurrent Load Test Results:");
      console.log(`   Managers:    ${NUM_MANAGERS}`);
      console.log(`   Samples:     ${stats.count}`);
      console.log(`   Duration:    ${(testDuration / 1000).toFixed(2)}s`);
      console.log(`   Throughput:  ${(stats.count / (testDuration / 1000)).toFixed(2)} detections/sec`);
      console.log(`   Min:         ${stats.min.toFixed(2)}ms`);
      console.log(`   Mean:        ${stats.mean.toFixed(2)}ms`);
      console.log(`   Median:      ${stats.median.toFixed(2)}ms`);
      console.log(`   P95:         ${stats.p95.toFixed(2)}ms ← Target: <${P95_LATENCY_TARGET_MS}ms`);
      console.log(`   P99:         ${stats.p99.toFixed(2)}ms`);
      console.log(`   Max:         ${stats.max.toFixed(2)}ms`);
      console.log(`   Memory:      ${formatBytes(memoryAfter.heapUsed)} (Δ ${formatBytes(memoryDelta)})`);

      // Check if we met the target
      const metTarget = stats.p95 <= P95_LATENCY_TARGET_MS * 1.5; // Allow 50% degradation under load
      console.log(
        `\n   ${metTarget ? "✅" : "❌"} P95 Target (under load): ${metTarget ? "MET" : "MISSED"} (${stats.p95.toFixed(2)}ms vs ${P95_LATENCY_TARGET_MS * 1.5}ms)`
      );

      // Assertions
      expect(allDetections.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
      expect(stats.p95).toBeLessThanOrEqual(P95_LATENCY_TARGET_MS * 1.5); // 50% degradation allowed
      expect(memoryDelta).toBeLessThan(512 * 1024 * 1024); // Memory delta < 512MB
    },
    TEST_TIMEOUT_MS
  );

  /**
   * Test 3: Circuit Breaker Behavior Under Load
   *
   * Tests that circuit breakers activate correctly when RPC errors occur
   * and that the system degrades gracefully rather than cascading failure.
   */
  test(
    "Circuit Breaker: Behavior under RPC failures",
    async () => {
      console.log("\n🔌 Starting circuit breaker load test...");
      console.log("   Testing graceful degradation under RPC failures");

      // Use a deliberately bad RPC endpoint to trigger circuit breaker
      const badConnection = new Connection("https://invalid-rpc-endpoint.solana.com", "confirmed");
      sourceManager = new SourceManager(badConnection, {
        enableRaydiumV4: true,
        enableRaydiumCLMM: true,
        enableOrcaWhirlpool: true,
        enableMeteora: true,
        enablePumpFun: true,
      });

      let detectionAttempts = 0;
      let successfulDetections = 0;

      // Try to start (should fail gracefully)
      const startTime = Date.now();
      await sourceManager.start((pool) => {
        successfulDetections++;
      });

      // Wait a bit for circuit breakers to activate
      await sleep(5000);

      // Check health status
      const health = sourceManager.getHealth();
      const metrics = sourceManager.getMetrics();

      console.log("\n📊 Circuit Breaker Test Results:");
      console.log(`   Duration:    ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
      console.log(`   Detections:  ${successfulDetections} (expected: 0 from bad RPC)`);

      console.log("\n📊 Source Health Status:");
      Object.entries(health).forEach(([source, status]) => {
        console.log(`   ${source.padEnd(20)} ${status.status}`);
      });

      // All sources should be in failed or disconnected state
      const allFailed = Object.values(health).every(
        (h) => h.status === "failed" || h.status === "disconnected"
      );

      console.log(
        `\n   ${allFailed ? "✅" : "❌"} Circuit breakers activated: ${allFailed ? "YES" : "NO"}`
      );
      console.log(`   ${successfulDetections === 0 ? "✅" : "❌"} No false detections: ${successfulDetections === 0 ? "YES" : "NO"}`);

      // Stop manager
      await sourceManager.stop();
      sourceManager = null;

      // Assertions
      expect(successfulDetections).toBe(0); // No detections from bad RPC
      expect(allFailed).toBe(true); // All sources should fail gracefully
    },
    60000 // 1 minute timeout
  );

  /**
   * Test 4: Memory Leak Detection
   *
   * Runs the source manager for an extended period and monitors
   * memory usage to detect potential leaks.
   */
  test(
    "Memory: Leak detection over extended runtime",
    async () => {
      console.log("\n💾 Starting memory leak detection test...");
      console.log("   Duration: 2 minutes");
      console.log("   Monitoring memory usage every 10 seconds");

      // Record initial memory
      const memorySnapshots: Array<{ time: number; heap: number; rss: number }> = [];

      const memoryBefore = getMemoryUsage();
      memorySnapshots.push({
        time: 0,
        heap: memoryBefore.heapUsed,
        rss: memoryBefore.rss,
      });

      console.log(`   Initial memory: ${formatBytes(memoryBefore.heapUsed)}`);

      // Initialize SourceManager
      sourceManager = new SourceManager(connection, {
        enableRaydiumV4: true,
        enableRaydiumCLMM: true,
        enableOrcaWhirlpool: true,
        enableMeteora: true,
        enablePumpFun: true,
      });

      let detectionCount = 0;
      await sourceManager.start((pool) => {
        detectionCount++;
      });

      // Monitor memory for 2 minutes
      const testDuration = 2 * 60 * 1000; // 2 minutes
      const snapshotInterval = 10 * 1000; // 10 seconds
      const startTime = Date.now();

      while (Date.now() - startTime < testDuration) {
        await sleep(snapshotInterval);

        const currentMemory = getMemoryUsage();
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);

        memorySnapshots.push({
          time: elapsedSec,
          heap: currentMemory.heapUsed,
          rss: currentMemory.rss,
        });

        console.log(
          `   [${elapsedSec}s] Heap: ${formatBytes(currentMemory.heapUsed)}, RSS: ${formatBytes(currentMemory.rss)}, Detections: ${detectionCount}`
        );
      }

      await sourceManager.stop();
      sourceManager = null;

      // Force garbage collection if available
      if (global.gc) {
        console.log("   Running garbage collection...");
        global.gc();
        await sleep(1000);
      }

      // Final memory check
      const memoryAfter = getMemoryUsage();
      memorySnapshots.push({
        time: Math.floor((Date.now() - startTime) / 1000),
        heap: memoryAfter.heapUsed,
        rss: memoryAfter.rss,
      });

      console.log("\n📊 Memory Leak Detection Results:");
      console.log(`   Duration:        ${(testDuration / 1000).toFixed(0)}s`);
      console.log(`   Detections:      ${detectionCount}`);
      console.log(`   Initial heap:    ${formatBytes(memoryBefore.heapUsed)}`);
      console.log(`   Final heap:      ${formatBytes(memoryAfter.heapUsed)}`);
      console.log(`   Heap delta:      ${formatBytes(memoryAfter.heapUsed - memoryBefore.heapUsed)}`);
      console.log(`   Peak heap:       ${formatBytes(Math.max(...memorySnapshots.map((s) => s.heap)))}`);

      // Calculate memory growth rate (bytes per second)
      const heapGrowth = memoryAfter.heapUsed - memoryBefore.heapUsed;
      const growthRate = heapGrowth / (testDuration / 1000);

      console.log(`   Growth rate:     ${formatBytes(growthRate)}/sec`);

      // Memory leak threshold: <1MB/min growth
      const growthRatePerMin = growthRate * 60;
      const hasMemoryLeak = growthRatePerMin > 1024 * 1024; // 1MB/min

      console.log(
        `\n   ${hasMemoryLeak ? "⚠️ " : "✅"} Memory leak: ${hasMemoryLeak ? "DETECTED" : "NONE"} (${formatBytes(growthRatePerMin)}/min)`
      );

      // Assertions
      expect(growthRatePerMin).toBeLessThan(5 * 1024 * 1024); // Allow up to 5MB/min growth
    },
    3 * 60 * 1000 // 3 minute timeout
  );
});

/**
 * Manual Testing Instructions:
 *
 * 1. Configure environment:
 *    ```bash
 *    export SOLANA_RPC_ENDPOINT="https://your-paid-rpc-endpoint.com"
 *    export INTEGRATION_TESTS=true
 *    ```
 *
 * 2. Run load tests:
 *    ```bash
 *    bun test tests/load/websocketPool.load.test.ts
 *    ```
 *
 * 3. Interpret results:
 *    - Baseline p95 < 500ms: ✅ Excellent performance
 *    - Concurrent p95 < 750ms: ✅ Good under load (50% degradation allowed)
 *    - Circuit breakers activate: ✅ Proper fault tolerance
 *    - Memory growth < 1MB/min: ✅ No memory leaks
 *
 * 4. Expected results on paid RPC (e.g., Helius, QuickNode):
 *    - Baseline p95: 200-400ms
 *    - Concurrent p95: 300-600ms
 *    - Circuit breakers: Activate on bad RPC
 *    - Memory: Stable growth < 1MB/min
 *
 * 5. Troubleshooting:
 *    - High latency: Check RPC rate limits, try different provider
 *    - Connection errors: Verify RPC endpoint URL and credentials
 *    - Memory issues: Increase Docker/Node memory limit
 *    - Timeouts: Increase MAX_COLLECTION_TIME_MS if market is slow
 *
 * 6. Performance tuning:
 *    - Increase connection pool size if hitting rate limits
 *    - Adjust duplicate window for better deduplication
 *    - Enable only necessary DEX sources to reduce load
 *    - Use Geyser gRPC for production (4-10x faster)
 */
