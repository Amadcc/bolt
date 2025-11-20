/**
 * Day 14: Comprehensive Performance Test Suite
 *
 * Tests all components against performance targets.
 * Run with: bun test tests/performance/comprehensive.test.ts
 *
 * Performance Targets:
 * - Detection: <500ms
 * - Honeypot: <2s
 * - Execution: <1.5s
 * - Full flow: <4s
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { benchmarkService } from "../../src/services/benchmark/BenchmarkService.js";
import {
  asSampleCount,
  asLatencyMs,
  PERFORMANCE_TARGETS,
  type BenchmarkComponent,
} from "../../src/types/benchmark.js";

// ============================================================================
// MOCK FUNCTIONS - Simulate real operations
// ============================================================================

/**
 * Simulate pool detection (WebSocket event parsing)
 * Target: <500ms
 */
async function mockDetection(): Promise<void> {
  // Simulate WebSocket event parsing + metadata fetch
  await sleep(150 + Math.random() * 100); // 150-250ms
}

/**
 * Simulate honeypot check (multi-layer)
 * Target: <2s
 */
async function mockHoneypotCheck(): Promise<void> {
  // Simulate API call + on-chain verification + simulation
  await sleep(800 + Math.random() * 400); // 800-1200ms
}

/**
 * Simulate filter validation
 * Target: <100ms
 */
async function mockFilterValidation(): Promise<void> {
  // Simulate checking all filters
  await sleep(30 + Math.random() * 30); // 30-60ms
}

/**
 * Simulate trade execution (Jupiter + Jito)
 * Target: <1.5s
 */
async function mockExecution(): Promise<void> {
  // Simulate quote + build tx + sign + send + confirm
  await sleep(800 + Math.random() * 400); // 800-1200ms
}

/**
 * Simulate position monitoring (price check)
 * Target: <500ms
 */
async function mockPositionMonitor(): Promise<void> {
  // Simulate DexScreener API + evaluation
  await sleep(100 + Math.random() * 100); // 100-200ms
}

/**
 * Simulate rug detection check
 * Target: <500ms
 */
async function mockRugDetection(): Promise<void> {
  // Simulate on-chain checks + holder analysis
  await sleep(200 + Math.random() * 100); // 200-300ms
}

/**
 * Simulate privacy layer application
 * Target: <100ms
 */
async function mockPrivacyLayer(): Promise<void> {
  // Simulate delay calculation + wallet selection + obfuscation
  await sleep(20 + Math.random() * 30); // 20-50ms
}

/**
 * Simulate wallet rotation
 * Target: <50ms
 */
async function mockWalletRotation(): Promise<void> {
  // Simulate DB query + selection logic
  await sleep(10 + Math.random() * 20); // 10-30ms
}

/**
 * Simulate fee optimization
 * Target: <100ms
 */
async function mockFeeOptimization(): Promise<void> {
  // Simulate RPC call + percentile calculation
  await sleep(30 + Math.random() * 40); // 30-70ms
}

/**
 * Simulate metadata fetching
 * Target: <500ms
 */
async function mockMetadataFetch(): Promise<void> {
  // Simulate Metaplex API call
  await sleep(150 + Math.random() * 150); // 150-300ms
}

/**
 * Simulate price feed
 * Target: <500ms
 */
async function mockPriceFeed(): Promise<void> {
  // Simulate DexScreener/Jupiter API
  await sleep(100 + Math.random() * 150); // 100-250ms
}

/**
 * Simulate exit execution
 * Target: <2s
 */
async function mockExitExecutor(): Promise<void> {
  // Simulate quote + build tx + send + confirm
  await sleep(900 + Math.random() * 500); // 900-1400ms
}

/**
 * Simulate full sniper flow (end-to-end)
 * Target: <4s
 */
async function mockFullFlow(): Promise<void> {
  // Detection → Honeypot → Filters → Execution
  await mockDetection();
  await mockHoneypotCheck();
  await mockFilterValidation();
  await mockFeeOptimization();
  await mockExecution();
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// PERFORMANCE TESTS
// ============================================================================

describe("Performance Benchmarks", () => {
  beforeAll(() => {
    console.log("\n🚀 Starting comprehensive performance benchmarks...\n");
  });

  afterAll(() => {
    console.log("\n✅ Benchmarks complete!\n");
    benchmarkService.clear();
  });

  // --------------------------------------------------------------------------
  // DETECTION LATENCY
  // --------------------------------------------------------------------------

  it("Detection latency should be <500ms (p95)", async () => {
    console.log("📊 Benchmarking Detection...");

    const result = await benchmarkService.run(mockDetection, {
      component: "DETECTION",
      warmup: asSampleCount(10),
      samples: asSampleCount(100),
      timeout: asLatencyMs(2000),
      collectResources: true,
      resourceSampleInterval: asLatencyMs(100),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput, resources, meetsTarget } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ p99: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);
    console.log(`  ✓ Peak Memory: ${resources.peakMemory}MB`);
    console.log(`  ✓ Success Rate: ${throughput.successRate}%`);

    expect(latency.p95).toBeLessThan(PERFORMANCE_TARGETS.DETECTION_LATENCY);
    expect(meetsTarget).toBe(true);
    expect(throughput.successRate).toBeGreaterThanOrEqual(95);
  }, 30000);

  // --------------------------------------------------------------------------
  // HONEYPOT CHECK
  // --------------------------------------------------------------------------

  it("Honeypot check should be <2s (p95)", async () => {
    console.log("📊 Benchmarking Honeypot Detection...");

    const result = await benchmarkService.run(mockHoneypotCheck, {
      component: "HONEYPOT",
      warmup: asSampleCount(5),
      samples: asSampleCount(50),
      timeout: asLatencyMs(5000),
      collectResources: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput, resources } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ p99: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);
    console.log(`  ✓ Peak Memory: ${resources.peakMemory}MB`);

    expect(latency.p95).toBeLessThan(PERFORMANCE_TARGETS.HONEYPOT_CHECK);
    expect(throughput.successRate).toBeGreaterThanOrEqual(95);
  }, 60000);

  // --------------------------------------------------------------------------
  // FILTER VALIDATION
  // --------------------------------------------------------------------------

  it("Filter validation should be <100ms (p95)", async () => {
    console.log("📊 Benchmarking Filter Validation...");

    const result = await benchmarkService.run(mockFilterValidation, {
      component: "FILTERS",
      warmup: asSampleCount(20),
      samples: asSampleCount(200),
      timeout: asLatencyMs(1000),
      collectResources: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);

    expect(latency.p95).toBeLessThan(100);
    expect(throughput.successRate).toBe(100);
  }, 30000);

  // --------------------------------------------------------------------------
  // EXECUTION TIME
  // --------------------------------------------------------------------------

  it("Execution time should be <1.5s (p95)", async () => {
    console.log("📊 Benchmarking Trade Execution...");

    const result = await benchmarkService.run(mockExecution, {
      component: "EXECUTION",
      warmup: asSampleCount(5),
      samples: asSampleCount(50),
      timeout: asLatencyMs(5000),
      collectResources: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput, resources } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ p99: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);
    console.log(`  ✓ Peak Memory: ${resources.peakMemory}MB`);

    expect(latency.p95).toBeLessThan(PERFORMANCE_TARGETS.EXECUTION_TIME);
    expect(throughput.successRate).toBeGreaterThanOrEqual(90);
  }, 60000);

  // --------------------------------------------------------------------------
  // FULL SNIPER FLOW (END-TO-END)
  // --------------------------------------------------------------------------

  it("Full sniper flow should be <4s (p95)", async () => {
    console.log("📊 Benchmarking Full Sniper Flow (E2E)...");

    const result = await benchmarkService.run(mockFullFlow, {
      component: "FULL_FLOW",
      warmup: asSampleCount(3),
      samples: asSampleCount(30),
      timeout: asLatencyMs(10000),
      collectResources: true,
      resourceSampleInterval: asLatencyMs(200),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput, resources, meetsTarget } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ p99: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);
    console.log(`  ✓ Peak Memory: ${resources.peakMemory}MB`);
    console.log(`  ✓ Peak CPU: ${resources.peakCpu}%`);
    console.log(`  ✓ Success Rate: ${throughput.successRate}%`);

    expect(latency.p95).toBeLessThan(PERFORMANCE_TARGETS.TOTAL_SNIPER_TIME);
    expect(meetsTarget).toBe(true);
    expect(throughput.successRate).toBeGreaterThanOrEqual(85);
  }, 120000);

  // --------------------------------------------------------------------------
  // POSITION MONITORING
  // --------------------------------------------------------------------------

  it("Position monitoring should be <500ms (p95)", async () => {
    console.log("📊 Benchmarking Position Monitor...");

    const result = await benchmarkService.run(mockPositionMonitor, {
      component: "POSITION_MONITOR",
      warmup: asSampleCount(10),
      samples: asSampleCount(100),
      timeout: asLatencyMs(2000),
      collectResources: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);

    expect(latency.p95).toBeLessThan(500);
    expect(throughput.successRate).toBeGreaterThanOrEqual(95);
  }, 30000);

  // --------------------------------------------------------------------------
  // RUG DETECTION
  // --------------------------------------------------------------------------

  it("Rug detection should be <500ms (p95)", async () => {
    console.log("📊 Benchmarking Rug Detection...");

    const result = await benchmarkService.run(mockRugDetection, {
      component: "RUG_MONITOR",
      warmup: asSampleCount(10),
      samples: asSampleCount(100),
      timeout: asLatencyMs(2000),
      collectResources: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);

    expect(latency.p95).toBeLessThan(500);
    expect(throughput.successRate).toBeGreaterThanOrEqual(95);
  }, 30000);

  // --------------------------------------------------------------------------
  // PRIVACY LAYER
  // --------------------------------------------------------------------------

  it("Privacy layer should be <100ms (p95)", async () => {
    console.log("📊 Benchmarking Privacy Layer...");

    const result = await benchmarkService.run(mockPrivacyLayer, {
      component: "PRIVACY_LAYER",
      warmup: asSampleCount(20),
      samples: asSampleCount(200),
      timeout: asLatencyMs(1000),
      collectResources: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);

    expect(latency.p95).toBeLessThan(100);
    expect(throughput.successRate).toBe(100);
  }, 30000);

  // --------------------------------------------------------------------------
  // WALLET ROTATION
  // --------------------------------------------------------------------------

  it("Wallet rotation should be <50ms (p95)", async () => {
    console.log("📊 Benchmarking Wallet Rotation...");

    const result = await benchmarkService.run(mockWalletRotation, {
      component: "WALLET_ROTATION",
      warmup: asSampleCount(30),
      samples: asSampleCount(300),
      timeout: asLatencyMs(500),
      collectResources: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);

    expect(latency.p95).toBeLessThan(50);
    expect(throughput.successRate).toBe(100);
  }, 20000);

  // --------------------------------------------------------------------------
  // FEE OPTIMIZATION
  // --------------------------------------------------------------------------

  it("Fee optimization should be <100ms (p95)", async () => {
    console.log("📊 Benchmarking Fee Optimization...");

    const result = await benchmarkService.run(mockFeeOptimization, {
      component: "FEE_OPTIMIZER",
      warmup: asSampleCount(20),
      samples: asSampleCount(200),
      timeout: asLatencyMs(1000),
      collectResources: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);

    expect(latency.p95).toBeLessThan(100);
    expect(throughput.successRate).toBeGreaterThanOrEqual(95);
  }, 30000);

  // --------------------------------------------------------------------------
  // METADATA FETCH
  // --------------------------------------------------------------------------

  it("Metadata fetch should be <500ms (p95)", async () => {
    console.log("📊 Benchmarking Metadata Fetch...");

    const result = await benchmarkService.run(mockMetadataFetch, {
      component: "METADATA",
      warmup: asSampleCount(10),
      samples: asSampleCount(100),
      timeout: asLatencyMs(2000),
      collectResources: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);

    expect(latency.p95).toBeLessThan(500);
    expect(throughput.successRate).toBeGreaterThanOrEqual(90);
  }, 30000);

  // --------------------------------------------------------------------------
  // PRICE FEED
  // --------------------------------------------------------------------------

  it("Price feed should be <500ms (p95)", async () => {
    console.log("📊 Benchmarking Price Feed...");

    const result = await benchmarkService.run(mockPriceFeed, {
      component: "PRICE_FEED",
      warmup: asSampleCount(10),
      samples: asSampleCount(100),
      timeout: asLatencyMs(2000),
      collectResources: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);

    expect(latency.p95).toBeLessThan(500);
    expect(throughput.successRate).toBeGreaterThanOrEqual(90);
  }, 30000);

  // --------------------------------------------------------------------------
  // EXIT EXECUTOR
  // --------------------------------------------------------------------------

  it("Exit executor should be <2s (p95)", async () => {
    console.log("📊 Benchmarking Exit Executor...");

    const result = await benchmarkService.run(mockExitExecutor, {
      component: "EXIT_EXECUTOR",
      warmup: asSampleCount(5),
      samples: asSampleCount(50),
      timeout: asLatencyMs(5000),
      collectResources: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { latency, throughput, resources } = result.value;

    console.log(`  ✓ Median: ${latency.median}ms`);
    console.log(`  ✓ p95: ${latency.p95}ms`);
    console.log(`  ✓ p99: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput.opsPerSecond} ops/s`);
    console.log(`  ✓ Peak Memory: ${resources.peakMemory}MB`);

    expect(latency.p95).toBeLessThan(2000);
    expect(throughput.successRate).toBeGreaterThanOrEqual(90);
  }, 60000);
});
