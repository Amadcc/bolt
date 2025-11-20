/**
 * Day 14: Performance Optimization & Testing - Type System
 *
 * Complete type system for benchmarking and performance monitoring.
 * Follows project guidelines: branded types, discriminated unions, Result<T> pattern.
 *
 * @module types/benchmark
 */

import type { Result } from "./common.js";

// ============================================================================
// BRANDED TYPES - Type-safe performance metrics
// ============================================================================

/**
 * Latency in milliseconds (0-30000ms = 30s max)
 * Used for measuring execution time of operations
 */
export type LatencyMs = number & { readonly __brand: "LatencyMs" };

/**
 * Throughput in operations per second (0-10000)
 * Used for measuring processing capacity
 */
export type ThroughputOps = number & { readonly __brand: "ThroughputOps" };

/**
 * Memory usage in megabytes (0-10000MB = 10GB max)
 * Used for memory profiling
 */
export type MemoryMB = number & { readonly __brand: "MemoryMB" };

/**
 * CPU usage percentage (0-100%)
 * Used for CPU profiling
 */
export type CpuPercent = number & { readonly __brand: "CpuPercent" };

/**
 * Success rate percentage (0-100%)
 * Used for measuring operation reliability
 */
export type SuccessRate = number & { readonly __brand: "SuccessRate" };

/**
 * Sample count for benchmarks (1-10000)
 * Number of iterations for statistical validity
 */
export type SampleCount = number & { readonly __brand: "SampleCount" };

// ============================================================================
// CONSTRUCTORS - With validation
// ============================================================================

export function asLatencyMs(value: number): LatencyMs {
  if (!Number.isFinite(value) || value < 0 || value > 30000) {
    throw new TypeError(
      `Invalid latency: ${value}ms (must be 0-30000 for max 30s)`
    );
  }
  return value as LatencyMs;
}

export function asThroughputOps(value: number): ThroughputOps {
  if (!Number.isFinite(value) || value < 0 || value > 10000) {
    throw new TypeError(
      `Invalid throughput: ${value} ops/s (must be 0-10000)`
    );
  }
  return value as ThroughputOps;
}

export function asMemoryMB(value: number): MemoryMB {
  if (!Number.isFinite(value) || value < 0 || value > 10000) {
    throw new TypeError(`Invalid memory: ${value}MB (must be 0-10000)`);
  }
  return value as MemoryMB;
}

export function asCpuPercent(value: number): CpuPercent {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`Invalid CPU: ${value}% (must be 0-100)`);
  }
  return value as CpuPercent;
}

export function asSuccessRate(value: number): SuccessRate {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`Invalid success rate: ${value}% (must be 0-100)`);
  }
  return value as SuccessRate;
}

export function asSampleCount(value: number): SampleCount {
  if (!Number.isInteger(value) || value < 1 || value > 10000) {
    throw new TypeError(`Invalid sample count: ${value} (must be 1-10000)`);
  }
  return value as SampleCount;
}

// ============================================================================
// BENCHMARK TARGETS - Performance goals
// ============================================================================

/**
 * Performance targets for sniper system
 * Based on competitive analysis of existing bots
 */
export const PERFORMANCE_TARGETS = {
  /** Pool detection latency: <500ms (detection → event emitted) */
  DETECTION_LATENCY: asLatencyMs(500),

  /** Honeypot check time: <2s (full multi-layer analysis) */
  HONEYPOT_CHECK: asLatencyMs(2000),

  /** Transaction execution: <1.5s (tx built → confirmed) */
  EXECUTION_TIME: asLatencyMs(1500),

  /** Total sniper time: <4s (end-to-end from detection to confirmation) */
  TOTAL_SNIPER_TIME: asLatencyMs(4000),

  /** Honeypot accuracy: >90% (correctly identified honeypots) */
  HONEYPOT_ACCURACY: asSuccessRate(90),

  /** Win rate: >70% (successful snipes / total attempts) */
  WIN_RATE: asSuccessRate(70),

  /** Memory usage: <500MB (peak during operation) */
  MEMORY_USAGE: asMemoryMB(500),

  /** CPU usage: <80% (average during load) */
  CPU_USAGE: asCpuPercent(80),

  /** Concurrent snipes: 100+ (simultaneous operations) */
  CONCURRENT_CAPACITY: 100,
} as const;

// ============================================================================
// BENCHMARK COMPONENTS - What to measure
// ============================================================================

/**
 * Components that can be benchmarked
 */
export type BenchmarkComponent =
  | "DETECTION" // Pool detection (WebSocket/Geyser)
  | "HONEYPOT" // Honeypot detection (multi-layer)
  | "FILTERS" // Filter validation
  | "EXECUTION" // Trade execution (Jupiter + Jito)
  | "POSITION_MONITOR" // Position monitoring
  | "RUG_MONITOR" // Rug detection
  | "PRIVACY_LAYER" // Copy-trade protection
  | "WALLET_ROTATION" // Wallet rotation
  | "FEE_OPTIMIZER" // Priority fee optimization
  | "METADATA" // Token metadata fetching
  | "PRICE_FEED" // Price feed (DexScreener)
  | "EXIT_EXECUTOR" // Exit execution
  | "FULL_FLOW"; // End-to-end sniper flow

// ============================================================================
// LATENCY STATISTICS - Statistical analysis of measurements
// ============================================================================

/**
 * Latency statistics for a set of measurements
 * Provides statistical analysis of performance data
 */
export interface LatencyStats {
  readonly component: BenchmarkComponent;
  readonly sampleCount: SampleCount;

  /** Minimum latency observed */
  readonly min: LatencyMs;

  /** Maximum latency observed */
  readonly max: LatencyMs;

  /** Average (mean) latency */
  readonly mean: LatencyMs;

  /** Median (p50) latency */
  readonly median: LatencyMs;

  /** 75th percentile latency */
  readonly p75: LatencyMs;

  /** 90th percentile latency */
  readonly p90: LatencyMs;

  /** 95th percentile latency */
  readonly p95: LatencyMs;

  /** 99th percentile latency */
  readonly p99: LatencyMs;

  /** Standard deviation */
  readonly stdDev: LatencyMs;
}

// ============================================================================
// THROUGHPUT STATISTICS - Operations per second analysis
// ============================================================================

/**
 * Throughput statistics for a component
 * Measures processing capacity over time
 */
export interface ThroughputStats {
  readonly component: BenchmarkComponent;
  readonly duration: LatencyMs; // Total measurement duration

  /** Total operations completed */
  readonly totalOps: number;

  /** Operations per second */
  readonly opsPerSecond: ThroughputOps;

  /** Success rate */
  readonly successRate: SuccessRate;

  /** Error count */
  readonly errorCount: number;
}

// ============================================================================
// RESOURCE USAGE - Memory and CPU profiling
// ============================================================================

/**
 * Resource usage snapshot
 * Captures memory and CPU usage at a point in time
 */
export interface ResourceSnapshot {
  readonly timestamp: Date;

  /** Heap memory used (MB) */
  readonly heapUsed: MemoryMB;

  /** Total heap size (MB) */
  readonly heapTotal: MemoryMB;

  /** External memory (MB) */
  readonly external: MemoryMB;

  /** RSS (Resident Set Size) - total memory (MB) */
  readonly rss: MemoryMB;

  /** CPU usage percentage */
  readonly cpu: CpuPercent;
}

/**
 * Resource usage statistics over time
 * Aggregates resource snapshots
 */
export interface ResourceStats {
  readonly component: BenchmarkComponent;
  readonly duration: LatencyMs;

  /** Peak memory usage */
  readonly peakMemory: MemoryMB;

  /** Average memory usage */
  readonly avgMemory: MemoryMB;

  /** Peak CPU usage */
  readonly peakCpu: CpuPercent;

  /** Average CPU usage */
  readonly avgCpu: CpuPercent;

  /** Individual snapshots */
  readonly snapshots: readonly ResourceSnapshot[];
}

// ============================================================================
// BENCHMARK RESULT - Complete benchmark output
// ============================================================================

/**
 * Complete benchmark result for a component
 * Combines latency, throughput, and resource stats
 */
export interface BenchmarkResult {
  readonly component: BenchmarkComponent;
  readonly timestamp: Date;

  /** Latency statistics */
  readonly latency: LatencyStats;

  /** Throughput statistics */
  readonly throughput: ThroughputStats;

  /** Resource usage statistics */
  readonly resources: ResourceStats;

  /** Whether component met performance targets */
  readonly meetsTarget: boolean;

  /** Comparison to targets */
  readonly targetComparison: {
    readonly target: LatencyMs;
    readonly actual: LatencyMs;
    readonly delta: LatencyMs; // Negative = faster than target
    readonly percentDiff: number; // Negative = better than target
  };
}

// ============================================================================
// LOAD TEST SCENARIO - Concurrent load testing configuration
// ============================================================================

/**
 * Load test scenario type
 */
export type LoadTestScenario =
  | "BASELINE" // Normal load (10 concurrent)
  | "MODERATE" // Moderate load (50 concurrent)
  | "HEAVY" // Heavy load (100 concurrent)
  | "STRESS" // Stress test (200+ concurrent)
  | "SPIKE" // Sudden spike (0→100→0)
  | "SUSTAINED"; // Sustained high load (100 for 10 minutes)

/**
 * Load test configuration
 */
export interface LoadTestConfig {
  readonly scenario: LoadTestScenario;

  /** Number of concurrent operations */
  readonly concurrency: number;

  /** Duration of test (ms) */
  readonly duration: LatencyMs;

  /** Ramp-up time (ms) - gradual increase in load */
  readonly rampUp?: LatencyMs;

  /** Target operations per second (optional rate limiting) */
  readonly targetOps?: ThroughputOps;
}

/**
 * Load test result
 */
export interface LoadTestResult {
  readonly config: LoadTestConfig;
  readonly timestamp: Date;

  /** Total operations attempted */
  readonly totalOps: number;

  /** Successful operations */
  readonly successfulOps: number;

  /** Failed operations */
  readonly failedOps: number;

  /** Success rate */
  readonly successRate: SuccessRate;

  /** Latency statistics */
  readonly latency: LatencyStats;

  /** Throughput achieved */
  readonly throughput: ThroughputOps;

  /** Resource usage */
  readonly resources: ResourceStats;

  /** Errors by type */
  readonly errorsByType: Record<string, number>;
}

// ============================================================================
// BENCHMARK ERROR - Discriminated union for errors
// ============================================================================

/**
 * Benchmark execution error (discriminated union)
 */
export type BenchmarkError =
  | {
      readonly type: "TIMEOUT";
      readonly message: string;
      readonly component: BenchmarkComponent;
      readonly duration: LatencyMs;
    }
  | {
      readonly type: "RESOURCE_EXHAUSTED";
      readonly message: string;
      readonly component: BenchmarkComponent;
      readonly memory: MemoryMB;
      readonly cpu: CpuPercent;
    }
  | {
      readonly type: "TOO_MANY_ERRORS";
      readonly message: string;
      readonly component: BenchmarkComponent;
      readonly errorCount: number;
      readonly errorRate: SuccessRate;
    }
  | {
      readonly type: "INVALID_CONFIG";
      readonly message: string;
      readonly field: string;
    }
  | {
      readonly type: "BENCHMARK_FAILED";
      readonly message: string;
      readonly component: BenchmarkComponent;
      readonly reason: string;
    };

// ============================================================================
// OPERATION RESULTS - Result types for benchmark operations
// ============================================================================

export type BenchmarkResultValue = Result<BenchmarkResult, BenchmarkError>;
export type LoadTestResultValue = Result<LoadTestResult, BenchmarkError>;
export type LatencyStatsValue = Result<LatencyStats, BenchmarkError>;
export type ResourceStatsValue = Result<ResourceStats, BenchmarkError>;

// ============================================================================
// BENCHMARK OPTIONS - Configuration for running benchmarks
// ============================================================================

/**
 * Options for running a benchmark
 */
export interface BenchmarkOptions {
  readonly component: BenchmarkComponent;

  /** Number of warmup iterations (not counted in results) */
  readonly warmup?: SampleCount;

  /** Number of measurement iterations */
  readonly samples: SampleCount;

  /** Maximum time for single operation (ms) */
  readonly timeout?: LatencyMs;

  /** Whether to collect resource usage stats */
  readonly collectResources?: boolean;

  /** Interval for resource sampling (ms) */
  readonly resourceSampleInterval?: LatencyMs;

  /** Whether to fail on first error */
  readonly failFast?: boolean;

  /** Custom labels for metrics */
  readonly labels?: Record<string, string>;
}

// ============================================================================
// PROFILER SNAPSHOT - Single profiling measurement
// ============================================================================

/**
 * Profiler snapshot for a single operation
 */
export interface ProfilerSnapshot {
  readonly operation: string;
  readonly timestamp: Date;

  /** Operation duration (ms) */
  readonly duration: LatencyMs;

  /** Memory delta (MB) - change during operation */
  readonly memoryDelta: number; // Can be negative

  /** Memory before operation */
  readonly memoryBefore: MemoryMB;

  /** Memory after operation */
  readonly memoryAfter: MemoryMB;

  /** CPU usage during operation */
  readonly cpu: CpuPercent;

  /** Custom metadata */
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// PERFORMANCE REPORT - Aggregated performance analysis
// ============================================================================

/**
 * Component performance status
 */
export type PerformanceStatus = "PASS" | "WARN" | "FAIL";

/**
 * Component performance assessment
 */
export interface ComponentPerformance {
  readonly component: BenchmarkComponent;
  readonly status: PerformanceStatus;

  /** Current latency */
  readonly latency: LatencyMs;

  /** Target latency */
  readonly target: LatencyMs;

  /** Success rate */
  readonly successRate: SuccessRate;

  /** Resource usage */
  readonly resources: {
    readonly memory: MemoryMB;
    readonly cpu: CpuPercent;
  };

  /** Recommendations for improvement */
  readonly recommendations: readonly string[];
}

/**
 * Full performance report
 * Aggregates all component benchmarks
 */
export interface PerformanceReport {
  readonly timestamp: Date;
  readonly overallStatus: PerformanceStatus;

  /** Individual component results */
  readonly components: readonly ComponentPerformance[];

  /** System-wide metrics */
  readonly systemMetrics: {
    readonly totalMemory: MemoryMB;
    readonly peakMemory: MemoryMB;
    readonly avgCpu: CpuPercent;
    readonly peakCpu: CpuPercent;
  };

  /** Performance summary */
  readonly summary: {
    readonly passing: number;
    readonly warnings: number;
    readonly failing: number;
    readonly total: number;
  };

  /** High-level recommendations */
  readonly recommendations: readonly string[];
}

// ============================================================================
// OPTIMIZATION SUGGESTION - AI-generated optimization hints
// ============================================================================

/**
 * Optimization priority
 */
export type OptimizationPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Optimization suggestion based on benchmark results
 */
export interface OptimizationSuggestion {
  readonly component: BenchmarkComponent;
  readonly priority: OptimizationPriority;

  /** What is slow */
  readonly issue: string;

  /** Why it matters */
  readonly impact: string;

  /** How to fix */
  readonly suggestion: string;

  /** Expected improvement */
  readonly expectedImprovement: {
    readonly current: LatencyMs;
    readonly target: LatencyMs;
    readonly improvement: number; // Percentage improvement
  };

  /** Code locations to check */
  readonly locations?: readonly string[];
}

// ============================================================================
// COMPARISON - Compare two benchmark runs
// ============================================================================

/**
 * Comparison between two benchmark runs
 * Useful for regression testing
 */
export interface BenchmarkComparison {
  readonly component: BenchmarkComponent;
  readonly baseline: BenchmarkResult;
  readonly current: BenchmarkResult;

  /** Latency change */
  readonly latencyChange: {
    readonly baseline: LatencyMs;
    readonly current: LatencyMs;
    readonly delta: LatencyMs;
    readonly percentChange: number; // Negative = improvement
  };

  /** Throughput change */
  readonly throughputChange: {
    readonly baseline: ThroughputOps;
    readonly current: ThroughputOps;
    readonly delta: ThroughputOps;
    readonly percentChange: number; // Positive = improvement
  };

  /** Resource usage change */
  readonly resourceChange: {
    readonly memory: {
      readonly baseline: MemoryMB;
      readonly current: MemoryMB;
      readonly delta: MemoryMB;
      readonly percentChange: number;
    };
    readonly cpu: {
      readonly baseline: CpuPercent;
      readonly current: CpuPercent;
      readonly delta: CpuPercent;
      readonly percentChange: number;
    };
  };

  /** Overall assessment */
  readonly regression: boolean; // True if performance got worse
  readonly improvement: boolean; // True if performance got better
}
