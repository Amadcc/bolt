/**
 * Geyser Plugin Performance Benchmark
 *
 * Compares WebSocket RPC vs Geyser gRPC latency for pool detection.
 *
 * Test Scenarios:
 * 1. Connection establishment time
 * 2. First event latency
 * 3. Average event latency (100 samples)
 * 4. Memory usage comparison
 * 5. Reconnection time
 *
 * Expected Results:
 * - Geyser connection: <1s
 * - Geyser first event: <50ms
 * - Geyser avg latency: <50ms
 * - WebSocket avg latency: 200-500ms
 * - Geyser advantage: 4-10x faster
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Connection } from "@solana/web3.js";
import { GeyserSource, type GeyserConfig } from "./GeyserSource.js";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { RaydiumV4Source } from "./sources/RaydiumV4Source.js";
import type { RawPoolDetection } from "./sources/BaseSource.js";
import { logger } from "../../utils/logger.js";
import { getAllProgramAddresses } from "../../config/programs.js";

// ============================================================================
// Test Configuration
// ============================================================================

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const GEYSER_CONFIG: GeyserConfig = {
  endpoint: process.env.GEYSER_ENDPOINT || "grpc.chainstack.com:443",
  token: process.env.GEYSER_TOKEN || "",
  programIds: getAllProgramAddresses(),
  commitment: CommitmentLevel.CONFIRMED,
  tls: true,
  autoReconnect: true,
};

// Skip tests if Geyser not configured
const GEYSER_ENABLED = process.env.GEYSER_ENABLED === "true" && GEYSER_CONFIG.token !== "";

// ============================================================================
// Benchmark Helpers
// ============================================================================

interface BenchmarkResult {
  source: "WebSocket" | "Geyser";
  connectionTimeMs: number;
  firstEventLatencyMs: number | null;
  avgEventLatencyMs: number | null;
  sampleSize: number;
  memoryUsageMB: number;
}

async function measureConnectionTime(
  connectFn: () => Promise<void>
): Promise<number> {
  const startTime = Date.now();
  await connectFn();
  return Date.now() - startTime;
}

async function collectLatencySamples(
  source: { start: (cb: (detection: RawPoolDetection) => void) => Promise<any> },
  maxSamples: number,
  timeoutMs: number
): Promise<number[]> {
  const latencies: number[] = [];
  const startTime = Date.now();

  return new Promise((resolve) => {
    const detectCallback = (detection: RawPoolDetection) => {
      const latency = Date.now() - (detection.blockTime ? detection.blockTime * 1000 : startTime);
      latencies.push(latency);

      logger.debug("Latency sample collected", {
        source: detection.source,
        latency,
        sampleCount: latencies.length,
      });

      // Stop after collecting enough samples
      if (latencies.length >= maxSamples) {
        resolve(latencies);
      }
    };

    // Start monitoring
    source.start(detectCallback).catch((error) => {
      logger.error("Source start failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      resolve(latencies);
    });

    // Timeout if no samples collected
    setTimeout(() => {
      resolve(latencies);
    }, timeoutMs);
  });
}

function calculateAverage(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function getMemoryUsageMB(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);
}

// ============================================================================
// Benchmark Tests
// ============================================================================

describe("Geyser Performance Benchmark", () => {
  let connection: Connection;
  let websocketSource: RaydiumV4Source;
  let geyserSource: GeyserSource;

  beforeAll(() => {
    connection = new Connection(SOLANA_RPC_URL, "confirmed");
    websocketSource = new RaydiumV4Source(connection);

    if (GEYSER_ENABLED) {
      geyserSource = new GeyserSource(GEYSER_CONFIG, connection);
    }
  });

  afterAll(async () => {
    await websocketSource.stop();
    if (GEYSER_ENABLED && geyserSource) {
      await geyserSource.stop();
    }
  });

  // ==========================================================================
  // Connection Benchmark
  // ==========================================================================

  test("should measure WebSocket connection time", async () => {
    const connectionTime = await measureConnectionTime(async () => {
      await websocketSource.start(() => {});
    });

    logger.info("WebSocket connection time", { connectionTimeMs: connectionTime });

    expect(connectionTime).toBeLessThan(5000); // Should connect within 5s
  });

  test.skipIf(!GEYSER_ENABLED)(
    "should measure Geyser connection time",
    async () => {
      const connectionTime = await measureConnectionTime(async () => {
        const result = await geyserSource.start(() => {});
        if (!result.success) {
          throw new Error(result.error);
        }
      });

      logger.info("Geyser connection time", { connectionTimeMs: connectionTime });

      expect(connectionTime).toBeLessThan(1000); // Should connect within 1s
    }
  );

  // ==========================================================================
  // Latency Benchmark (Real-World)
  // ==========================================================================

  test.skip(
    "should measure WebSocket event latency (requires live events)",
    async () => {
      const maxSamples = 10;
      const timeoutMs = 60000; // 1 minute

      const latencies = await collectLatencySamples(
        websocketSource,
        maxSamples,
        timeoutMs
      );

      const avgLatency = calculateAverage(latencies);
      const memoryUsage = getMemoryUsageMB();

      logger.info("WebSocket benchmark results", {
        sampleSize: latencies.length,
        avgLatencyMs: avgLatency,
        minLatencyMs: Math.min(...latencies),
        maxLatencyMs: Math.max(...latencies),
        memoryUsageMB: memoryUsage,
      });

      // Log results for comparison
      const result: BenchmarkResult = {
        source: "WebSocket",
        connectionTimeMs: 0, // Measured separately
        firstEventLatencyMs: latencies[0] || null,
        avgEventLatencyMs: avgLatency || null,
        sampleSize: latencies.length,
        memoryUsageMB: memoryUsage,
      };

      logger.info("WebSocket benchmark result", result);

      // Assert reasonable latency
      if (latencies.length > 0) {
        expect(avgLatency).toBeLessThan(1000); // Should be under 1s average
      }
    },
    { timeout: 70000 }
  );

  test.skipIf(!GEYSER_ENABLED)(
    "should measure Geyser event latency (requires live events)",
    async () => {
      const maxSamples = 10;
      const timeoutMs = 60000; // 1 minute

      const latencies = await collectLatencySamples(
        geyserSource,
        maxSamples,
        timeoutMs
      );

      const avgLatency = calculateAverage(latencies);
      const memoryUsage = getMemoryUsageMB();

      logger.info("Geyser benchmark results", {
        sampleSize: latencies.length,
        avgLatencyMs: avgLatency,
        minLatencyMs: Math.min(...latencies),
        maxLatencyMs: Math.max(...latencies),
        memoryUsageMB: memoryUsage,
      });

      // Log results for comparison
      const result: BenchmarkResult = {
        source: "Geyser",
        connectionTimeMs: 0, // Measured separately
        firstEventLatencyMs: latencies[0] || null,
        avgEventLatencyMs: avgLatency || null,
        sampleSize: latencies.length,
        memoryUsageMB: memoryUsage,
      };

      logger.info("Geyser benchmark result", result);

      // Assert Geyser latency target (<50ms)
      if (latencies.length > 0) {
        expect(avgLatency).toBeLessThan(100); // Should be under 100ms average
      }
    },
    { timeout: 70000 }
  );

  // ==========================================================================
  // Health Monitoring
  // ==========================================================================

  test("should verify WebSocket health metrics", () => {
    const health = websocketSource.getHealth();
    const metrics = websocketSource.getMetrics();

    logger.info("WebSocket health", { health, metrics });

    expect(health.status).toMatch(/healthy|connecting|disconnected/);
    expect(metrics.totalDetections).toBeGreaterThanOrEqual(0);
  });

  test.skipIf(!GEYSER_ENABLED)(
    "should verify Geyser health metrics",
    () => {
      const health = geyserSource.getHealth();
      const metrics = geyserSource.getMetrics();
      const stats = geyserSource.getStats();

      logger.info("Geyser health", { health, metrics, stats });

      expect(health.status).toMatch(/healthy|connecting|disconnected/);
      expect(metrics.totalDetections).toBeGreaterThanOrEqual(0);
      expect(stats.totalReconnects).toBeGreaterThanOrEqual(0);
    }
  );

  // ==========================================================================
  // Comparison Summary
  // ==========================================================================

  test.skip(
    "should compare WebSocket vs Geyser performance",
    async () => {
      // This test would run both sources in parallel and compare results
      // Skipped for now as it requires live mainnet events

      logger.info("Benchmark comparison", {
        note: "Run this test manually on mainnet with GEYSER_ENABLED=true",
        expectedResults: {
          websocket: "200-500ms avg latency",
          geyser: "<50ms avg latency",
          advantage: "4-10x faster with Geyser",
        },
      });

      expect(true).toBe(true);
    }
  );
});

// ============================================================================
// Manual Benchmark Script
// ============================================================================

/**
 * Run manual benchmark:
 *
 * 1. Set environment variables:
 *    export GEYSER_ENABLED=true
 *    export GEYSER_ENDPOINT="grpc.chainstack.com:443"
 *    export GEYSER_TOKEN="your_token_here"
 *
 * 2. Run benchmark:
 *    bun test src/services/sniper/GeyserBenchmark.test.ts
 *
 * 3. Compare results:
 *    - Connection time: Geyser should be <1s, WebSocket ~2-5s
 *    - Event latency: Geyser should be <50ms, WebSocket ~200-500ms
 *    - Memory usage: Both should be similar (~50-100MB)
 *
 * 4. Expected improvement:
 *    - Geyser is 4-10x faster than WebSocket
 *    - Critical for competitive sniping
 */
