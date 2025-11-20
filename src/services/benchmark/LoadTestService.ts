/**
 * Day 14: Performance Optimization & Testing - Load Test Service
 *
 * Service for running concurrent load tests with various scenarios.
 * Simulates production traffic patterns to identify bottlenecks.
 *
 * @module services/benchmark/LoadTestService
 */

import { performance } from "node:perf_hooks";
import { Ok, Err } from "../../types/common.js";
import type {
  LoadTestConfig,
  LoadTestResult,
  LoadTestResultValue,
  LatencyMs,
  LatencyStats,
  ResourceStats,
} from "../../types/benchmark.js";
import {
  asLatencyMs,
  asSuccessRate,
  asThroughputOps,
  asSampleCount,
  asMemoryMB,
  asCpuPercent,
} from "../../types/benchmark.js";
import {
  recordLoadTestRequest,
  setLoadTestConcurrency,
} from "../../utils/metrics.js";

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Function to load test
 */
export type LoadTestFn<T = unknown> = () => Promise<T>;

/**
 * Request result tracking
 */
interface RequestResult {
  readonly duration: LatencyMs;
  readonly success: boolean;
  readonly timestamp: Date;
  readonly error?: Error;
  readonly errorType?: string;
}

// ============================================================================
// LOAD TEST SERVICE
// ============================================================================

export class LoadTestService {
  private readonly activeRequests: Set<Promise<unknown>>;

  constructor() {
    this.activeRequests = new Set();
  }

  /**
   * Run load test with specified configuration
   *
   * @param fn - Function to load test
   * @param config - Load test configuration
   * @returns Load test results with statistics
   */
  async run<T>(
    fn: LoadTestFn<T>,
    config: LoadTestConfig
  ): Promise<LoadTestResultValue> {
    const { scenario, concurrency, duration, rampUp, targetOps } = config;

    console.log(
      `[LoadTest] ${scenario}: Starting with ${concurrency} concurrent requests for ${duration}ms...`
    );

    try {
      const results: RequestResult[] = [];
      const startTime = performance.now();
      const endTime = startTime + duration;

      // Ramp up gradually if specified
      if (rampUp && rampUp > 0) {
        await this.rampUpLoad(
          fn,
          concurrency,
          rampUp,
          endTime,
          results,
          scenario
        );
      }

      // Main load test phase
      let currentConcurrency = rampUp ? concurrency : 0;
      while (performance.now() < endTime) {
        // Maintain target concurrency
        while (this.activeRequests.size < concurrency) {
          const request = this.executeRequest(fn, scenario);
          this.activeRequests.add(request);

          // Track result when done
          void request
            .then((result) => {
              results.push(result);
              this.activeRequests.delete(request);
            })
            .catch(() => {
              this.activeRequests.delete(request);
            });

          // Update concurrency metric
          currentConcurrency = this.activeRequests.size;
          setLoadTestConcurrency(scenario, currentConcurrency);

          // Rate limiting if specified
          if (targetOps) {
            const delayMs = (1000 / targetOps) * concurrency;
            await this.sleep(delayMs);
          }
        }

        // Small delay to avoid tight loop
        await this.sleep(10);
      }

      // Wait for remaining requests to complete
      console.log(
        `[LoadTest] ${scenario}: Waiting for ${this.activeRequests.size} pending requests...`
      );
      await Promise.allSettled([...this.activeRequests]);

      const totalDuration = asLatencyMs(performance.now() - startTime);

      // Calculate statistics
      const totalOps = results.length;
      const successfulOps = results.filter((r) => r.success).length;
      const failedOps = totalOps - successfulOps;
      const successRate = asSuccessRate(
        totalOps > 0 ? (successfulOps / totalOps) * 100 : 0
      );

      // Latency statistics
      const latency = this.calculateLatencyStats(results);

      // Throughput
      const throughput = asThroughputOps((successfulOps / totalDuration) * 1000);

      // Resource statistics (simplified - just end state)
      const resources = this.createResourceStats(scenario, totalDuration);

      // Error analysis
      const errorsByType = this.analyzeErrors(results);

      const result: LoadTestResult = {
        config,
        timestamp: new Date(),
        totalOps,
        successfulOps,
        failedOps,
        successRate,
        latency,
        throughput,
        resources,
        errorsByType,
      };

      // Reset concurrency metric
      setLoadTestConcurrency(scenario, 0);

      console.log(
        `[LoadTest] ${scenario}: Completed - ${successfulOps}/${totalOps} successful (${successRate}% success rate)`
      );

      return Ok(result);
    } catch (error) {
      setLoadTestConcurrency(scenario, 0);
      return Err({
        type: "BENCHMARK_FAILED",
        message: String(error),
        component: "FULL_FLOW",
        reason: "load_test_error",
      });
    }
  }

  /**
   * Gradually ramp up load
   */
  private async rampUpLoad<T>(
    fn: LoadTestFn<T>,
    targetConcurrency: number,
    rampUpDuration: LatencyMs,
    endTime: number,
    results: RequestResult[],
    scenario: string
  ): Promise<void> {
    const steps = 10;
    const stepDuration = rampUpDuration / steps;
    const concurrencyIncrement = Math.ceil(targetConcurrency / steps);

    console.log(
      `[LoadTest] ${scenario}: Ramping up from 0 to ${targetConcurrency} over ${rampUpDuration}ms...`
    );

    for (let step = 1; step <= steps && performance.now() < endTime; step++) {
      const currentTarget = Math.min(
        step * concurrencyIncrement,
        targetConcurrency
      );

      // Launch requests up to current target
      while (
        this.activeRequests.size < currentTarget &&
        performance.now() < endTime
      ) {
        const request = this.executeRequest(fn, scenario);
        this.activeRequests.add(request);

        void request
          .then((result) => {
            results.push(result);
            this.activeRequests.delete(request);
          })
          .catch(() => {
            this.activeRequests.delete(request);
          });

        setLoadTestConcurrency(scenario, this.activeRequests.size);
      }

      // Wait for step duration
      await this.sleep(stepDuration);
    }

    console.log(
      `[LoadTest] ${scenario}: Ramp up complete at ${targetConcurrency} concurrent requests`
    );
  }

  /**
   * Execute single request and track result
   */
  private async executeRequest<T>(
    fn: LoadTestFn<T>,
    scenario: string
  ): Promise<RequestResult> {
    const startTime = performance.now();
    const timestamp = new Date();

    try {
      await fn();
      const duration = asLatencyMs(performance.now() - startTime);

      recordLoadTestRequest(scenario, "success", duration);

      return {
        duration,
        success: true,
        timestamp,
      };
    } catch (error) {
      const duration = asLatencyMs(performance.now() - startTime);
      const errorType = this.classifyError(error as Error);

      recordLoadTestRequest(scenario, "failure", duration);

      return {
        duration,
        success: false,
        timestamp,
        error: error as Error,
        errorType,
      };
    }
  }

  /**
   * Calculate latency statistics from results
   */
  private calculateLatencyStats(results: RequestResult[]): LatencyStats {
    const durations = results
      .map((r) => r.duration)
      .sort((a, b) => a - b);

    if (durations.length === 0) {
      const zero = asLatencyMs(0);
      return {
        component: "FULL_FLOW",
        sampleCount: asSampleCount(0),
        min: zero,
        max: zero,
        mean: zero,
        median: zero,
        p75: zero,
        p90: zero,
        p95: zero,
        p99: zero,
        stdDev: zero,
      };
    }

    const min = durations[0]!;
    const max = durations[durations.length - 1]!;
    const mean = asLatencyMs(
      durations.reduce((sum, d) => sum + d, 0) / durations.length
    );

    const median = this.percentile(durations, 50);
    const p75 = this.percentile(durations, 75);
    const p90 = this.percentile(durations, 90);
    const p95 = this.percentile(durations, 95);
    const p99 = this.percentile(durations, 99);

    const variance =
      durations.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) /
      durations.length;
    const stdDev = asLatencyMs(Math.sqrt(variance));

    return {
      component: "FULL_FLOW",
      sampleCount: asSampleCount(durations.length),
      min,
      max,
      mean,
      median,
      p75,
      p90,
      p95,
      p99,
      stdDev,
    };
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sortedValues: number[], p: number): LatencyMs {
    if (sortedValues.length === 0) return asLatencyMs(0);

    const index = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
      return asLatencyMs(sortedValues[lower]!);
    }

    const fraction = index - lower;
    const value =
      sortedValues[lower]! * (1 - fraction) + sortedValues[upper]! * fraction;
    return asLatencyMs(value);
  }

  /**
   * Create resource statistics
   */
  private createResourceStats(
    _scenario: string,
    duration: LatencyMs
  ): ResourceStats {
    const mem = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    const currentMemory = asMemoryMB(mem.heapUsed / 1024 / 1024);
    const currentCpu = asCpuPercent(
      Math.min(
        100,
        ((cpuUsage.user + cpuUsage.system) / 1000000 / 100) * 100
      )
    );

    return {
      component: "FULL_FLOW",
      duration,
      peakMemory: currentMemory,
      avgMemory: currentMemory,
      peakCpu: currentCpu,
      avgCpu: currentCpu,
      snapshots: [
        {
          timestamp: new Date(),
          heapUsed: asMemoryMB(mem.heapUsed / 1024 / 1024),
          heapTotal: asMemoryMB(mem.heapTotal / 1024 / 1024),
          external: asMemoryMB(mem.external / 1024 / 1024),
          rss: asMemoryMB(mem.rss / 1024 / 1024),
          cpu: currentCpu,
        },
      ],
    };
  }

  /**
   * Analyze errors by type
   */
  private analyzeErrors(results: RequestResult[]): Record<string, number> {
    const errorsByType: Record<string, number> = {};

    for (const result of results) {
      if (!result.success && result.errorType) {
        errorsByType[result.errorType] =
          (errorsByType[result.errorType] ?? 0) + 1;
      }
    }

    return errorsByType;
  }

  /**
   * Classify error by type
   */
  private classifyError(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes("timeout")) return "timeout";
    if (message.includes("rate limit")) return "rate_limit";
    if (message.includes("network")) return "network";
    if (message.includes("connection")) return "connection";
    if (message.includes("not found")) return "not_found";
    if (message.includes("unauthorized")) return "unauthorized";
    if (message.includes("forbidden")) return "forbidden";
    if (message.includes("server error")) return "server_error";

    return "unknown";
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get active request count
   */
  getActiveRequests(): number {
    return this.activeRequests.size;
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const loadTestService = new LoadTestService();
