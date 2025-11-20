/**
 * Day 14: Performance Optimization & Testing - Benchmark Service
 *
 * Core benchmarking service for measuring component performance.
 * Provides statistical analysis, resource profiling, and performance comparisons.
 *
 * @module services/benchmark/BenchmarkService
 */

import { performance } from "node:perf_hooks";
import { Ok, Err } from "../../types/common.js";
import type {
  BenchmarkComponent,
  BenchmarkOptions,
  BenchmarkResult,
  BenchmarkResultValue,
  LatencyMs,
  LatencyStats,
  ThroughputStats,
  ResourceStats,
  ResourceSnapshot,
} from "../../types/benchmark.js";
import { PERFORMANCE_TARGETS } from "../../types/benchmark.js";
import {
  asLatencyMs,
  asMemoryMB,
  asCpuPercent,
  asSuccessRate,
  asThroughputOps,
  asSampleCount,
  type SampleCount,
} from "../../types/benchmark.js";
import {
  recordBenchmarkDuration,
  recordBenchmarkSuccess,
  recordBenchmarkError,
  setBenchmarkMemory,
  setBenchmarkCpu,
} from "../../utils/metrics.js";

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Function to benchmark
 * Returns success boolean or throws error
 */
export type BenchmarkFn<T = unknown> = () => Promise<T>;

/**
 * Measurement data point
 */
interface Measurement {
  readonly duration: LatencyMs;
  readonly success: boolean;
  readonly timestamp: Date;
  readonly error?: Error;
}

// ============================================================================
// BENCHMARK SERVICE
// ============================================================================

export class BenchmarkService {
  private readonly measurements: Map<BenchmarkComponent, Measurement[]>;
  private readonly resourceSnapshots: Map<BenchmarkComponent, ResourceSnapshot[]>;

  constructor() {
    this.measurements = new Map();
    this.resourceSnapshots = new Map();
  }

  /**
   * Run benchmark for a component
   *
   * @param fn - Function to benchmark
   * @param options - Benchmark configuration
   * @returns Benchmark result with statistics
   */
  async run<T>(
    fn: BenchmarkFn<T>,
    options: BenchmarkOptions
  ): Promise<BenchmarkResultValue> {
    const {
      component,
      warmup = asSampleCount(10),
      samples,
      timeout = asLatencyMs(30000),
      collectResources = true,
      resourceSampleInterval = asLatencyMs(100),
      failFast = false,
    } = options;

    try {
      // Initialize measurement arrays
      this.measurements.set(component, []);
      if (collectResources) {
        this.resourceSnapshots.set(component, []);
      }

      // Warmup phase (not counted in results)
      console.log(
        `[Benchmark] ${component}: Running ${warmup} warmup iterations...`
      );
      for (let i = 0; i < warmup; i++) {
        try {
          await this.executeWithTimeout(fn, timeout);
        } catch (error) {
          // Warmup errors are ignored unless failFast
          if (failFast) {
            return Err({
              type: "BENCHMARK_FAILED",
              message: `Warmup failed: ${String(error)}`,
              component,
              reason: "warmup_error",
            });
          }
        }
      }

      // Measurement phase
      console.log(
        `[Benchmark] ${component}: Running ${samples} measurement iterations...`
      );

      // Start resource monitoring if enabled
      let resourceInterval: NodeJS.Timeout | undefined;
      if (collectResources) {
        resourceInterval = setInterval(() => {
          this.captureResourceSnapshot(component);
        }, resourceSampleInterval);
      }

      const startTime = performance.now();

      // Run measurements
      for (let i = 0; i < samples; i++) {
        const measurement = await this.measure(fn, timeout, component);

        // Track measurement
        const measurements = this.measurements.get(component) ?? [];
        measurements.push(measurement);
        this.measurements.set(component, measurements);

        // Fail fast on error
        if (failFast && !measurement.success) {
          if (resourceInterval) clearInterval(resourceInterval);
          return Err({
            type: "BENCHMARK_FAILED",
            message: `Measurement failed: ${measurement.error?.message}`,
            component,
            reason: "measurement_error",
          });
        }
      }

      const totalDuration = asLatencyMs(performance.now() - startTime);

      // Stop resource monitoring
      if (resourceInterval) {
        clearInterval(resourceInterval);
      }

      // Calculate statistics
      const latency = this.calculateLatencyStats(component, samples);
      const throughput = this.calculateThroughputStats(
        component,
        totalDuration
      );
      const resources = collectResources
        ? this.calculateResourceStats(component, totalDuration)
        : this.createEmptyResourceStats(component, totalDuration);

      // Check if meets target
      const target = this.getTargetLatency(component);
      const meetsTarget = latency.median <= target;

      // Calculate comparison
      const delta = asLatencyMs(latency.median - target);
      const percentDiff = ((latency.median - target) / target) * 100;

      const result: BenchmarkResult = {
        component,
        timestamp: new Date(),
        latency,
        throughput,
        resources,
        meetsTarget,
        targetComparison: {
          target,
          actual: latency.median,
          delta,
          percentDiff,
        },
      };

      // Record metrics
      recordBenchmarkDuration(component, latency.median);
      recordBenchmarkSuccess(component, throughput.successRate);
      setBenchmarkMemory(component, resources.peakMemory);
      setBenchmarkCpu(component, resources.peakCpu);

      return Ok(result);
    } catch (error) {
      recordBenchmarkError(component);
      return Err({
        type: "BENCHMARK_FAILED",
        message: String(error),
        component,
        reason: "unexpected_error",
      });
    }
  }

  /**
   * Measure single execution
   */
  private async measure<T>(
    fn: BenchmarkFn<T>,
    timeout: LatencyMs,
    component: BenchmarkComponent
  ): Promise<Measurement> {
    const startTime = performance.now();
    const timestamp = new Date();

    try {
      await this.executeWithTimeout(fn, timeout);
      const duration = asLatencyMs(performance.now() - startTime);

      return {
        duration,
        success: true,
        timestamp,
      };
    } catch (error) {
      const duration = asLatencyMs(performance.now() - startTime);

      // Check if timeout
      if (error instanceof TimeoutError) {
        recordBenchmarkError(component, "timeout");
      } else {
        recordBenchmarkError(component, "error");
      }

      return {
        duration,
        success: false,
        timestamp,
        error: error as Error,
      };
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout<T>(
    fn: BenchmarkFn<T>,
    timeout: LatencyMs
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new TimeoutError(`Operation exceeded ${timeout}ms`)),
          timeout
        )
      ),
    ]);
  }

  /**
   * Calculate latency statistics
   */
  private calculateLatencyStats(
    component: BenchmarkComponent,
    sampleCount: SampleCount
  ): LatencyStats {
    const measurements = this.measurements.get(component) ?? [];
    const durations = measurements.map((m) => m.duration).sort((a, b) => a - b);

    if (durations.length === 0) {
      // Return zeros if no measurements
      return {
        component,
        sampleCount,
        min: asLatencyMs(0),
        max: asLatencyMs(0),
        mean: asLatencyMs(0),
        median: asLatencyMs(0),
        p75: asLatencyMs(0),
        p90: asLatencyMs(0),
        p95: asLatencyMs(0),
        p99: asLatencyMs(0),
        stdDev: asLatencyMs(0),
      };
    }

    const min = durations[0]!;
    const max = durations[durations.length - 1]!;
    const mean = asLatencyMs(
      durations.reduce((sum, d) => sum + d, 0) / durations.length
    );

    // Calculate percentiles
    const median = this.percentile(durations, 50);
    const p75 = this.percentile(durations, 75);
    const p90 = this.percentile(durations, 90);
    const p95 = this.percentile(durations, 95);
    const p99 = this.percentile(durations, 99);

    // Calculate standard deviation
    const variance =
      durations.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) /
      durations.length;
    const stdDev = asLatencyMs(Math.sqrt(variance));

    return {
      component,
      sampleCount,
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
   * Calculate throughput statistics
   */
  private calculateThroughputStats(
    component: BenchmarkComponent,
    duration: LatencyMs
  ): ThroughputStats {
    const measurements = this.measurements.get(component) ?? [];
    const successful = measurements.filter((m) => m.success).length;
    const errors = measurements.length - successful;

    const opsPerSecond = asThroughputOps((successful / duration) * 1000);
    const successRate = asSuccessRate(
      (successful / measurements.length) * 100
    );

    return {
      component,
      duration,
      totalOps: measurements.length,
      opsPerSecond,
      successRate,
      errorCount: errors,
    };
  }

  /**
   * Calculate resource usage statistics
   */
  private calculateResourceStats(
    component: BenchmarkComponent,
    duration: LatencyMs
  ): ResourceStats {
    const snapshots = this.resourceSnapshots.get(component) ?? [];

    if (snapshots.length === 0) {
      return this.createEmptyResourceStats(component, duration);
    }

    const memories = snapshots.map((s) => s.heapUsed);
    const cpus = snapshots.map((s) => s.cpu);

    const peakMemory = asMemoryMB(Math.max(...memories));
    const avgMemory = asMemoryMB(
      memories.reduce((sum, m) => sum + m, 0) / memories.length
    );

    const peakCpu = asCpuPercent(Math.max(...cpus));
    const avgCpu = asCpuPercent(
      cpus.reduce((sum, c) => sum + c, 0) / cpus.length
    );

    return {
      component,
      duration,
      peakMemory,
      avgMemory,
      peakCpu,
      avgCpu,
      snapshots,
    };
  }

  /**
   * Create empty resource stats (when not collected)
   */
  private createEmptyResourceStats(
    component: BenchmarkComponent,
    duration: LatencyMs
  ): ResourceStats {
    return {
      component,
      duration,
      peakMemory: asMemoryMB(0),
      avgMemory: asMemoryMB(0),
      peakCpu: asCpuPercent(0),
      avgCpu: asCpuPercent(0),
      snapshots: [],
    };
  }

  /**
   * Capture resource usage snapshot
   */
  private captureResourceSnapshot(component: BenchmarkComponent): void {
    const mem = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    // Calculate CPU percentage (rough approximation)
    const cpuPercent = asCpuPercent(
      Math.min(
        100,
        ((cpuUsage.user + cpuUsage.system) / 1000000 / 100) * 100
      )
    );

    const snapshot: ResourceSnapshot = {
      timestamp: new Date(),
      heapUsed: asMemoryMB(mem.heapUsed / 1024 / 1024),
      heapTotal: asMemoryMB(mem.heapTotal / 1024 / 1024),
      external: asMemoryMB(mem.external / 1024 / 1024),
      rss: asMemoryMB(mem.rss / 1024 / 1024),
      cpu: cpuPercent,
    };

    const snapshots = this.resourceSnapshots.get(component) ?? [];
    snapshots.push(snapshot);
    this.resourceSnapshots.set(component, snapshots);
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

    // Linear interpolation
    const fraction = index - lower;
    const value =
      sortedValues[lower]! * (1 - fraction) + sortedValues[upper]! * fraction;
    return asLatencyMs(value);
  }

  /**
   * Get target latency for component
   */
  private getTargetLatency(component: BenchmarkComponent): LatencyMs {
    const targets = PERFORMANCE_TARGETS as typeof PERFORMANCE_TARGETS;

    switch (component) {
      case "DETECTION":
        return targets.DETECTION_LATENCY;
      case "HONEYPOT":
        return targets.HONEYPOT_CHECK;
      case "EXECUTION":
        return targets.EXECUTION_TIME;
      case "FULL_FLOW":
        return targets.TOTAL_SNIPER_TIME;
      default:
        // Default to 1s for other components
        return asLatencyMs(1000);
    }
  }

  /**
   * Clear all measurements
   */
  clear(): void {
    this.measurements.clear();
    this.resourceSnapshots.clear();
  }

  /**
   * Get all measurements for a component
   */
  getMeasurements(component: BenchmarkComponent): readonly Measurement[] {
    return this.measurements.get(component) ?? [];
  }

  /**
   * Get all resource snapshots for a component
   */
  getResourceSnapshots(
    component: BenchmarkComponent
  ): readonly ResourceSnapshot[] {
    return this.resourceSnapshots.get(component) ?? [];
  }
}

// ============================================================================
// TIMEOUT ERROR
// ============================================================================

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const benchmarkService = new BenchmarkService();
