/**
 * Geyser gRPC Performance Benchmarks
 *
 * Benchmarks Geyser vs WebSocket pool detection latency.
 *
 * Run with:
 * ```bash
 * INTEGRATION_TESTS=true bun test tests/performance/GeyserBenchmark.test.ts
 * ```
 *
 * Performance Targets:
 * - Geyser detection latency: <50ms p95
 * - WebSocket detection latency: <500ms p95
 * - Geyser throughput: >100 detections/sec
 *
 * Note: These tests require:
 * 1. Geyser gRPC endpoint configured (GEYSER_ENDPOINT, GEYSER_TOKEN)
 * 2. Mainnet RPC endpoint for WebSocket comparison
 * 3. At least 100 real pool detections for statistical significance
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Connection } from "@solana/web3.js";
import { GeyserSource, initializeGeyserSource } from "../../src/services/sniper/GeyserSource.js";
import { SourceManager } from "../../src/services/sniper/SourceManager.js";
import type { RawPoolDetection, ScoredPoolDetection } from "../../src/services/sniper/sources/BaseSource.js";
import { getAllProgramAddresses } from "../../src/config/programs.js";
import type { CommitmentLevel } from "@triton-one/yellowstone-grpc";

// Skip unless INTEGRATION_TESTS=true
const INTEGRATION_TESTS = process.env.INTEGRATION_TESTS === "true";
const skipTest = INTEGRATION_TESTS ? test : test.skip;

// Performance thresholds
const GEYSER_P95_TARGET_MS = 50;
const WEBSOCKET_P95_TARGET_MS = 500;
const MIN_SAMPLES = 100;

// Test configuration
const GEYSER_ENDPOINT = process.env.GEYSER_ENDPOINT || "grpc.chainstack.com:443";
const GEYSER_TOKEN = process.env.GEYSER_TOKEN || "";
const RPC_ENDPOINT =
  process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

describe("Geyser gRPC Performance Benchmarks", () => {
  let connection: Connection;
  let geyserSource: GeyserSource | null = null;
  let sourceManager: SourceManager | null = null;

  beforeAll(() => {
    connection = new Connection(RPC_ENDPOINT, "confirmed");
  });

  afterAll(async () => {
    if (geyserSource) {
      await geyserSource.stop();
    }
    if (sourceManager) {
      await sourceManager.stop();
    }
  });

  /**
   * Helper: Calculate percentile from sorted array
   */
  function calculatePercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[index];
  }

  /**
   * Helper: Calculate statistics from latency samples
   */
  function calculateStats(latencies: number[]) {
    if (latencies.length === 0) {
      return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
      p50: calculatePercentile(sorted, 50),
      p95: calculatePercentile(sorted, 95),
      p99: calculatePercentile(sorted, 99),
    };
  }

  skipTest("Benchmark: Geyser gRPC Detection Latency", async () => {
    if (!GEYSER_TOKEN) {
      console.log("⚠️  Skipping Geyser benchmark - GEYSER_TOKEN not set");
      return;
    }

    console.log("\n🚀 Starting Geyser gRPC benchmark...");
    console.log(`   Endpoint: ${GEYSER_ENDPOINT}`);
    console.log(`   Target: Collect ${MIN_SAMPLES} pool detections`);

    // Initialize Geyser source
    geyserSource = initializeGeyserSource(
      {
        endpoint: GEYSER_ENDPOINT,
        token: GEYSER_TOKEN,
        programIds: getAllProgramAddresses(),
        commitment: "confirmed" as CommitmentLevel,
        autoReconnect: true,
      },
      connection
    );

    const detections: Array<{ pool: RawPoolDetection; latency: number }> = [];
    const startTime = Date.now();

    // Start monitoring
    await geyserSource.start((pool) => {
      const latency = Date.now() - startTime;
      detections.push({ pool, latency });

      console.log(
        `   [${detections.length}/${MIN_SAMPLES}] Pool detected: ${pool.source} | ${pool.tokenMintA} | ${latency}ms`
      );

      if (detections.length >= MIN_SAMPLES) {
        // Stop collecting
        geyserSource?.stop();
      }
    });

    // Wait for MIN_SAMPLES detections (timeout after 10 minutes)
    const timeout = 10 * 60 * 1000; // 10 minutes
    const pollInterval = 1000; // 1 second
    let elapsed = 0;

    while (detections.length < MIN_SAMPLES && elapsed < timeout) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }

    await geyserSource.stop();

    // Calculate statistics
    const latencies = detections.map((d) => d.latency);
    const stats = calculateStats(latencies);

    console.log("\n📊 Geyser gRPC Benchmark Results:");
    console.log(`   Samples: ${detections.length}`);
    console.log(`   Min:     ${stats.min.toFixed(2)}ms`);
    console.log(`   Mean:    ${stats.mean.toFixed(2)}ms`);
    console.log(`   Median:  ${stats.p50.toFixed(2)}ms`);
    console.log(`   P95:     ${stats.p95.toFixed(2)}ms ← Target: <${GEYSER_P95_TARGET_MS}ms`);
    console.log(`   P99:     ${stats.p99.toFixed(2)}ms`);
    console.log(`   Max:     ${stats.max.toFixed(2)}ms`);

    // Check if we met the target
    const metTarget = stats.p95 <= GEYSER_P95_TARGET_MS;
    console.log(
      `   ${metTarget ? "✅" : "❌"} Target: ${metTarget ? "MET" : "MISSED"} (${stats.p95.toFixed(2)}ms vs ${GEYSER_P95_TARGET_MS}ms)`
    );

    // Assert
    expect(detections.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
    expect(stats.p95).toBeLessThanOrEqual(GEYSER_P95_TARGET_MS);
  }, 15 * 60 * 1000); // 15 minute timeout

  skipTest("Benchmark: WebSocket Detection Latency", async () => {
    console.log("\n🌐 Starting WebSocket benchmark...");
    console.log(`   RPC: ${RPC_ENDPOINT}`);
    console.log(`   Target: Collect ${MIN_SAMPLES} pool detections`);

    // Initialize SourceManager with all sources
    sourceManager = new SourceManager(connection, {
      enableRaydiumV4: true,
      enableRaydiumCLMM: true,
      enableOrcaWhirlpool: true,
      enableMeteora: true,
      enablePumpFun: true,
    });

    const detections: Array<{ pool: ScoredPoolDetection; latency: number }> = [];
    const startTime = Date.now();

    // Start monitoring
    await sourceManager.start((pool) => {
      const latency = Date.now() - startTime;
      detections.push({ pool, latency });

      console.log(
        `   [${detections.length}/${MIN_SAMPLES}] Pool detected: ${pool.source} | ${pool.tokenMintA} | ${latency}ms`
      );

      if (detections.length >= MIN_SAMPLES) {
        // Stop collecting
        sourceManager?.stop();
      }
    });

    // Wait for MIN_SAMPLES detections (timeout after 10 minutes)
    const timeout = 10 * 60 * 1000; // 10 minutes
    const pollInterval = 1000; // 1 second
    let elapsed = 0;

    while (detections.length < MIN_SAMPLES && elapsed < timeout) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }

    await sourceManager.stop();

    // Calculate statistics
    const latencies = detections.map((d) => d.latency);
    const stats = calculateStats(latencies);

    console.log("\n📊 WebSocket Benchmark Results:");
    console.log(`   Samples: ${detections.length}`);
    console.log(`   Min:     ${stats.min.toFixed(2)}ms`);
    console.log(`   Mean:    ${stats.mean.toFixed(2)}ms`);
    console.log(`   Median:  ${stats.p50.toFixed(2)}ms`);
    console.log(`   P95:     ${stats.p95.toFixed(2)}ms ← Target: <${WEBSOCKET_P95_TARGET_MS}ms`);
    console.log(`   P99:     ${stats.p99.toFixed(2)}ms`);
    console.log(`   Max:     ${stats.max.toFixed(2)}ms`);

    // Check if we met the target
    const metTarget = stats.p95 <= WEBSOCKET_P95_TARGET_MS;
    console.log(
      `   ${metTarget ? "✅" : "❌"} Target: ${metTarget ? "MET" : "MISSED"} (${stats.p95.toFixed(2)}ms vs ${WEBSOCKET_P95_TARGET_MS}ms)`
    );

    // Assert
    expect(detections.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
    expect(stats.p95).toBeLessThanOrEqual(WEBSOCKET_P95_TARGET_MS);
  }, 15 * 60 * 1000); // 15 minute timeout

  skipTest("Comparison: Geyser vs WebSocket", async () => {
    console.log("\n⚡ Geyser vs WebSocket Comparison");
    console.log("   This test should be run after the individual benchmarks");
    console.log("   Results will be compared from metrics exported");

    // In production, this would query Prometheus for:
    // - geyser_latency_milliseconds (histogram)
    // - websocket_pool_detection_latency (if added)
    // - geyser_detections_total
    // - websocket_detections_total

    // For MVP, we just document the comparison method
    console.log("\n📊 Comparison Method:");
    console.log("   1. Run Geyser benchmark → collect p95 latency");
    console.log("   2. Run WebSocket benchmark → collect p95 latency");
    console.log("   3. Calculate speedup: WebSocket p95 / Geyser p95");
    console.log("   4. Expected speedup: 4-10x (500ms / 50ms = 10x)");
    console.log("\n   Example results:");
    console.log("   - Geyser p95:    45ms");
    console.log("   - WebSocket p95: 420ms");
    console.log("   - Speedup:       9.3x ✅");
  });

  skipTest("Benchmark: Geyser Throughput", async () => {
    if (!GEYSER_TOKEN) {
      console.log("⚠️  Skipping Geyser throughput benchmark - GEYSER_TOKEN not set");
      return;
    }

    console.log("\n🚀 Starting Geyser throughput benchmark...");
    console.log(`   Endpoint: ${GEYSER_ENDPOINT}`);
    console.log(`   Duration: 60 seconds`);

    // Initialize Geyser source
    geyserSource = initializeGeyserSource(
      {
        endpoint: GEYSER_ENDPOINT,
        token: GEYSER_TOKEN,
        programIds: getAllProgramAddresses(),
        commitment: "confirmed" as CommitmentLevel,
        autoReconnect: true,
      },
      connection
    );

    let detectionCount = 0;
    const startTime = Date.now();

    // Start monitoring
    await geyserSource.start((_pool) => {
      detectionCount++;
    });

    // Run for 60 seconds
    await new Promise((resolve) => setTimeout(resolve, 60 * 1000));

    await geyserSource.stop();

    const durationSec = (Date.now() - startTime) / 1000;
    const throughput = detectionCount / durationSec;

    console.log("\n📊 Geyser Throughput Results:");
    console.log(`   Duration:    ${durationSec.toFixed(2)}s`);
    console.log(`   Detections:  ${detectionCount}`);
    console.log(`   Throughput:  ${throughput.toFixed(2)} detections/sec`);
    console.log(`   Target:      >100 detections/sec`);

    // Check if we met the target
    const metTarget = throughput >= 100;
    console.log(
      `   ${metTarget ? "✅" : "❌"} Target: ${metTarget ? "MET" : "MISSED"} (${throughput.toFixed(2)} vs 100)`
    );

    // Assert
    expect(throughput).toBeGreaterThanOrEqual(100);
  }, 2 * 60 * 1000); // 2 minute timeout
});

/**
 * Manual Testing Instructions:
 *
 * 1. Configure Geyser credentials:
 *    ```bash
 *    export GEYSER_ENDPOINT="grpc.chainstack.com:443"
 *    export GEYSER_TOKEN="your-token-here"
 *    export SOLANA_RPC_ENDPOINT="https://api.mainnet-beta.solana.com"
 *    ```
 *
 * 2. Run benchmarks:
 *    ```bash
 *    INTEGRATION_TESTS=true bun test tests/performance/GeyserBenchmark.test.ts
 *    ```
 *
 * 3. Interpret results:
 *    - Geyser p95 < 50ms: ✅ Excellent (HFT-ready)
 *    - Geyser p95 < 100ms: ✅ Good (Fast sniper)
 *    - Geyser p95 < 200ms: ⚠️  Acceptable (Still faster than WebSocket)
 *    - Geyser p95 > 200ms: ❌ Investigate (Network issues?)
 *
 * 4. Expected results on Chainstack:
 *    - Geyser p95: 30-50ms
 *    - WebSocket p95: 300-500ms
 *    - Speedup: 6-10x
 *    - Throughput: 200-500 detections/sec (depending on market activity)
 *
 * 5. Troubleshooting:
 *    - High latency: Check network connection, try different Geyser provider
 *    - Connection errors: Verify GEYSER_TOKEN, check endpoint URL
 *    - No detections: Market may be slow, wait longer or try during peak hours
 */
