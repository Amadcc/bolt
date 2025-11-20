/**
 * Day 14: Load Testing - Concurrent Snipes
 *
 * Tests system behavior under concurrent load.
 * Run with: bun test tests/load/concurrent-snipes.test.ts
 *
 * Scenarios:
 * - BASELINE: 10 concurrent (normal operation)
 * - MODERATE: 50 concurrent (busy period)
 * - HEAVY: 100 concurrent (target capacity)
 * - STRESS: 200+ concurrent (stress test)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadTestService } from "../../src/services/benchmark/LoadTestService.js";
import { asLatencyMs, type LoadTestScenario } from "../../src/types/benchmark.js";

// ============================================================================
// MOCK SNIPE OPERATION
// ============================================================================

/**
 * Simulate complete snipe operation:
 * 1. Detect pool
 * 2. Check honeypot
 * 3. Validate filters
 * 4. Execute trade
 */
async function mockSnipeOperation(): Promise<void> {
  // Simulate detection (150-250ms)
  await sleep(150 + Math.random() * 100);

  // Simulate honeypot check (800-1200ms)
  await sleep(800 + Math.random() * 400);

  // Simulate filter validation (30-60ms)
  await sleep(30 + Math.random() * 30);

  // Simulate fee optimization (30-70ms)
  await sleep(30 + Math.random() * 40);

  // Simulate execution (800-1200ms)
  await sleep(800 + Math.random() * 400);

  // Random failures (5% failure rate)
  if (Math.random() < 0.05) {
    throw new Error("Transaction failed");
  }
}

/**
 * Simulate fast snipe (using Geyser + aggressive settings)
 */
async function mockFastSnipeOperation(): Promise<void> {
  // Faster detection with Geyser (20-50ms)
  await sleep(20 + Math.random() * 30);

  // Parallel honeypot + filters (600-900ms)
  await Promise.all([
    sleep(600 + Math.random() * 300),
    sleep(30 + Math.random() * 30),
  ]);

  // Quick execution with Jito (500-800ms)
  await sleep(500 + Math.random() * 300);

  if (Math.random() < 0.03) {
    throw new Error("Bundle failed");
  }
}

/**
 * Simulate slow snipe (network congestion, fallbacks)
 */
async function mockSlowSnipeOperation(): Promise<void> {
  // Detection (normal)
  await sleep(200 + Math.random() * 100);

  // Honeypot check with retries (1500-2500ms)
  await sleep(1500 + Math.random() * 1000);

  // Filters
  await sleep(50 + Math.random() * 50);

  // Execution with retries (1500-2500ms)
  await sleep(1500 + Math.random() * 1000);

  // Higher failure rate (15%)
  if (Math.random() < 0.15) {
    throw new Error("Timeout");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// LOAD TEST SCENARIOS
// ============================================================================

describe("Load Testing - Concurrent Snipes", () => {
  beforeAll(() => {
    console.log("\n🚀 Starting concurrent load tests...\n");
    console.log("⚠️  These tests will take several minutes to complete.\n");
  });

  afterAll(() => {
    console.log("\n✅ Load tests complete!\n");
  });

  // --------------------------------------------------------------------------
  // BASELINE LOAD (10 concurrent)
  // --------------------------------------------------------------------------

  it("BASELINE: 10 concurrent snipes for 30s", async () => {
    console.log("📊 Testing BASELINE load (10 concurrent)...");

    const result = await loadTestService.run(mockSnipeOperation, {
      scenario: "BASELINE",
      concurrency: 10,
      duration: asLatencyMs(30000), // 30 seconds
      rampUp: asLatencyMs(5000), // 5s ramp-up
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { successfulOps, failedOps, successRate, latency, throughput } =
      result.value;

    console.log(`  ✓ Total Operations: ${successfulOps + failedOps}`);
    console.log(`  ✓ Successful: ${successfulOps}`);
    console.log(`  ✓ Failed: ${failedOps}`);
    console.log(`  ✓ Success Rate: ${successRate}%`);
    console.log(`  ✓ Median Latency: ${latency.median}ms`);
    console.log(`  ✓ p95 Latency: ${latency.p95}ms`);
    console.log(`  ✓ p99 Latency: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput} ops/s`);

    // Baseline should handle 10 concurrent easily
    expect(successRate).toBeGreaterThanOrEqual(90);
    expect(latency.p95).toBeLessThan(5000); // <5s p95
    expect(throughput).toBeGreaterThan(0);
  }, 120000); // 2 min timeout

  // --------------------------------------------------------------------------
  // MODERATE LOAD (50 concurrent)
  // --------------------------------------------------------------------------

  it("MODERATE: 50 concurrent snipes for 60s", async () => {
    console.log("📊 Testing MODERATE load (50 concurrent)...");

    const result = await loadTestService.run(mockSnipeOperation, {
      scenario: "MODERATE",
      concurrency: 50,
      duration: asLatencyMs(60000), // 60 seconds
      rampUp: asLatencyMs(10000), // 10s ramp-up
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { successfulOps, failedOps, successRate, latency, throughput } =
      result.value;

    console.log(`  ✓ Total Operations: ${successfulOps + failedOps}`);
    console.log(`  ✓ Successful: ${successfulOps}`);
    console.log(`  ✓ Failed: ${failedOps}`);
    console.log(`  ✓ Success Rate: ${successRate}%`);
    console.log(`  ✓ Median Latency: ${latency.median}ms`);
    console.log(`  ✓ p95 Latency: ${latency.p95}ms`);
    console.log(`  ✓ p99 Latency: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput} ops/s`);

    // Moderate load should maintain good performance
    expect(successRate).toBeGreaterThanOrEqual(85);
    expect(latency.p95).toBeLessThan(7000); // <7s p95
    expect(throughput).toBeGreaterThan(0);
  }, 180000); // 3 min timeout

  // --------------------------------------------------------------------------
  // HEAVY LOAD (100 concurrent) - TARGET CAPACITY
  // --------------------------------------------------------------------------

  it("HEAVY: 100 concurrent snipes for 90s", async () => {
    console.log("📊 Testing HEAVY load (100 concurrent - target capacity)...");

    const result = await loadTestService.run(mockSnipeOperation, {
      scenario: "HEAVY",
      concurrency: 100,
      duration: asLatencyMs(90000), // 90 seconds
      rampUp: asLatencyMs(15000), // 15s ramp-up
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const {
      successfulOps,
      failedOps,
      successRate,
      latency,
      throughput,
      resources,
    } = result.value;

    console.log(`  ✓ Total Operations: ${successfulOps + failedOps}`);
    console.log(`  ✓ Successful: ${successfulOps}`);
    console.log(`  ✓ Failed: ${failedOps}`);
    console.log(`  ✓ Success Rate: ${successRate}%`);
    console.log(`  ✓ Median Latency: ${latency.median}ms`);
    console.log(`  ✓ p95 Latency: ${latency.p95}ms`);
    console.log(`  ✓ p99 Latency: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput} ops/s`);
    console.log(`  ✓ Peak Memory: ${resources.peakMemory}MB`);
    console.log(`  ✓ Peak CPU: ${resources.peakCpu}%`);

    // Heavy load should still maintain acceptable performance
    expect(successRate).toBeGreaterThanOrEqual(80);
    expect(latency.p95).toBeLessThan(10000); // <10s p95
    expect(throughput).toBeGreaterThan(0);
    expect(resources.peakMemory).toBeLessThan(500); // <500MB memory
  }, 300000); // 5 min timeout

  // --------------------------------------------------------------------------
  // STRESS TEST (200 concurrent)
  // --------------------------------------------------------------------------

  it("STRESS: 200 concurrent snipes for 60s", async () => {
    console.log("📊 Testing STRESS load (200 concurrent - beyond capacity)...");

    const result = await loadTestService.run(mockSnipeOperation, {
      scenario: "STRESS",
      concurrency: 200,
      duration: asLatencyMs(60000), // 60 seconds
      rampUp: asLatencyMs(20000), // 20s ramp-up
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const {
      successfulOps,
      failedOps,
      successRate,
      latency,
      throughput,
      resources,
      errorsByType,
    } = result.value;

    console.log(`  ✓ Total Operations: ${successfulOps + failedOps}`);
    console.log(`  ✓ Successful: ${successfulOps}`);
    console.log(`  ✓ Failed: ${failedOps}`);
    console.log(`  ✓ Success Rate: ${successRate}%`);
    console.log(`  ✓ Median Latency: ${latency.median}ms`);
    console.log(`  ✓ p95 Latency: ${latency.p95}ms`);
    console.log(`  ✓ p99 Latency: ${latency.p99}ms`);
    console.log(`  ✓ Throughput: ${throughput} ops/s`);
    console.log(`  ✓ Peak Memory: ${resources.peakMemory}MB`);
    console.log(`  ✓ Peak CPU: ${resources.peakCpu}%`);
    console.log("  ✓ Errors by type:", errorsByType);

    // Stress test - system should degrade gracefully
    expect(successRate).toBeGreaterThanOrEqual(60); // Lower threshold OK
    expect(throughput).toBeGreaterThan(0);
    expect(resources.peakMemory).toBeLessThan(1000); // <1GB memory
  }, 300000); // 5 min timeout

  // --------------------------------------------------------------------------
  // SPIKE TEST (0→100→0)
  // --------------------------------------------------------------------------

  it("SPIKE: Sudden spike from 0 to 100 concurrent", async () => {
    console.log("📊 Testing SPIKE load (0→100 sudden spike)...");

    const result = await loadTestService.run(mockSnipeOperation, {
      scenario: "SPIKE",
      concurrency: 100,
      duration: asLatencyMs(60000), // 60 seconds
      rampUp: asLatencyMs(2000), // 2s rapid ramp-up
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { successfulOps, failedOps, successRate, latency, throughput } =
      result.value;

    console.log(`  ✓ Total Operations: ${successfulOps + failedOps}`);
    console.log(`  ✓ Successful: ${successfulOps}`);
    console.log(`  ✓ Failed: ${failedOps}`);
    console.log(`  ✓ Success Rate: ${successRate}%`);
    console.log(`  ✓ Median Latency: ${latency.median}ms`);
    console.log(`  ✓ p95 Latency: ${latency.p95}ms`);

    // Spike test - system should handle sudden load
    expect(successRate).toBeGreaterThanOrEqual(70);
    expect(throughput).toBeGreaterThan(0);
  }, 240000); // 4 min timeout

  // --------------------------------------------------------------------------
  // FAST SNIPES (Geyser + Jito)
  // --------------------------------------------------------------------------

  it("FAST SNIPES: 50 concurrent with Geyser + Jito", async () => {
    console.log("📊 Testing FAST snipes (Geyser + Jito optimization)...");

    const result = await loadTestService.run(mockFastSnipeOperation, {
      scenario: "MODERATE",
      concurrency: 50,
      duration: asLatencyMs(60000),
      rampUp: asLatencyMs(10000),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { successfulOps, failedOps, successRate, latency, throughput } =
      result.value;

    console.log(`  ✓ Total Operations: ${successfulOps + failedOps}`);
    console.log(`  ✓ Successful: ${successfulOps}`);
    console.log(`  ✓ Success Rate: ${successRate}%`);
    console.log(`  ✓ Median Latency: ${latency.median}ms`);
    console.log(`  ✓ p95 Latency: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput} ops/s`);

    // Fast snipes should have low latency
    expect(successRate).toBeGreaterThanOrEqual(95);
    expect(latency.p95).toBeLessThan(2000); // <2s with optimizations
    expect(throughput).toBeGreaterThan(0);
  }, 180000);

  // --------------------------------------------------------------------------
  // SLOW SNIPES (Network issues, retries)
  // --------------------------------------------------------------------------

  it("SLOW SNIPES: 30 concurrent with network issues", async () => {
    console.log("📊 Testing SLOW snipes (network congestion, retries)...");

    const result = await loadTestService.run(mockSlowSnipeOperation, {
      scenario: "BASELINE",
      concurrency: 30,
      duration: asLatencyMs(60000),
      rampUp: asLatencyMs(10000),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { successfulOps, failedOps, successRate, latency, throughput } =
      result.value;

    console.log(`  ✓ Total Operations: ${successfulOps + failedOps}`);
    console.log(`  ✓ Successful: ${successfulOps}`);
    console.log(`  ✓ Failed: ${failedOps}`);
    console.log(`  ✓ Success Rate: ${successRate}%`);
    console.log(`  ✓ Median Latency: ${latency.median}ms`);
    console.log(`  ✓ p95 Latency: ${latency.p95}ms`);
    console.log(`  ✓ Throughput: ${throughput} ops/s`);

    // Slow snipes should still succeed with retries
    expect(successRate).toBeGreaterThanOrEqual(70);
    expect(throughput).toBeGreaterThan(0);
  }, 180000);
});
