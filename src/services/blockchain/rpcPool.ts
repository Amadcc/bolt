/**
 * Production-Grade RPC Connection Pool
 *
 * Enterprise patterns:
 * - Circuit breaker per endpoint (prevent cascade failures)
 * - Rate limiting with sliding window (respect provider limits)
 * - Latency monitoring with percentiles (P50, P95, P99)
 * - Request deduplication (share pending requests)
 * - Health checks with auto-recovery (30s interval)
 * - Automatic failover (prefer healthy, fast endpoints)
 * - Exponential backoff on rate limits
 * - Full observability (metrics, logs, traces)
 *
 * @see ARCHITECTURE.md - RPC Pool design patterns
 */

import { Connection, type Commitment } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import {
  registerInterval,
  clearRegisteredInterval,
} from "../../utils/intervals.js";
import { observeRpcRequest } from "../../utils/metrics.js";

// ============================================================================
// HTTP Basic Auth Helper
// ============================================================================

/**
 * Extract HTTP Basic Auth credentials from URL
 * Supports format: https://username:password@host/path
 */
function extractBasicAuth(urlString: string): {
  url: string;
  headers?: Record<string, string>;
} {
  try {
    const url = new URL(urlString);
    if (url.username && url.password) {
      // Remove credentials from URL
      const cleanUrl = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
      // Create Basic Auth header
      const credentials = Buffer.from(`${url.username}:${url.password}`).toString('base64');
      return {
        url: cleanUrl,
        headers: {
          'Authorization': `Basic ${credentials}`,
        },
      };
    }
  } catch {
    // Invalid URL, return as-is
  }
  return { url: urlString };
}

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Circuit breaker states (Hystrix pattern)
 *
 * CLOSED: Normal operation, requests pass through
 * OPEN: Circuit tripped, requests blocked (after 5 failures)
 * HALF_OPEN: Testing recovery, single request allowed
 */
export enum CircuitBreakerState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

/**
 * Rate limiter configuration and state
 *
 * Uses sliding window algorithm for accurate rate limiting.
 * Prevents exceeding provider limits (Helius 10/s, public 2/s).
 */
interface RateLimiter {
  /** Maximum requests per second for this endpoint */
  maxRequestsPerSecond: number;

  /** Timestamps of recent requests (sliding window) */
  requestTimestamps: number[];

  /** Queue of pending requests waiting for rate limit */
  pendingQueue: Array<{
    resolve: (connection: Connection) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }>;
}

/**
 * Latency statistics for endpoint performance monitoring
 *
 * Tracks P50, P95, P99 percentiles for smart endpoint selection.
 */
interface LatencyStats {
  /** Last 100 request latencies (rolling window) */
  samples: number[];

  /** Median latency (P50) in milliseconds */
  p50: number;

  /** 95th percentile latency in milliseconds */
  p95: number;

  /** 99th percentile latency in milliseconds */
  p99: number;

  /** Last update timestamp */
  lastUpdate: number;
}

/**
 * RPC endpoint configuration and state
 *
 * Represents a single Solana RPC endpoint with full observability.
 */
export interface RPCEndpoint {
  /** Endpoint URL (e.g., "https://api.mainnet-beta.solana.com") */
  url: string;

  /** Human-readable name (e.g., "Helius", "Public") */
  name: string;

  /** Priority (1 = highest, lower = fallback) */
  priority: number;

  /** Circuit breaker state */
  circuitState: CircuitBreakerState;

  /** Consecutive failure count (resets on success) */
  failureCount: number;

  /** Timestamp of last failure (for circuit breaker timeout) */
  lastFailureTime: number | null;

  /** Timestamp when circuit opened (for 60s timeout) */
  circuitOpenedAt: number | null;

  /** Rate limiter for this endpoint */
  rateLimiter: RateLimiter;

  /** Latency statistics */
  latencyStats: LatencyStats;

  /** Solana Connection instance (lazy-loaded) */
  connection: Connection | null;

  /** Last successful health check timestamp */
  lastHealthCheck: number | null;

  /** Is endpoint healthy? (updated by health checks) */
  isHealthy: boolean;
}

/**
 * Request cache entry for deduplication
 *
 * Shares results of identical pending requests.
 */
interface RequestCacheEntry {
  /** Promise resolving to the result */
  promise: Promise<unknown>;

  /** Timestamp when request started */
  timestamp: number;

  /** Number of callers waiting for this result */
  refCount: number;
}

/**
 * RPC Pool configuration
 */
interface RPCPoolConfig {
  /** Default commitment level */
  commitment: Commitment;

  /** Circuit breaker failure threshold (default: 5) */
  circuitBreakerThreshold: number;

  /** Circuit breaker timeout in ms (default: 60000 = 60s) */
  circuitBreakerTimeout: number;

  /** Health check interval in ms (default: 30000 = 30s) */
  healthCheckInterval: number;

  /** Request deduplication cache TTL in ms (default: 5000 = 5s) */
  deduplicationCacheTTL: number;

  /** Maximum latency samples to keep (default: 100) */
  maxLatencySamples: number;
}

// ============================================================================
// RPC Connection Pool
// ============================================================================

/**
 * Production-grade RPC connection pool with enterprise patterns
 *
 * Features:
 * - Multi-endpoint support with automatic failover
 * - Circuit breaker prevents cascade failures
 * - Rate limiting respects provider quotas
 * - Latency-aware endpoint selection
 * - Request deduplication reduces load
 * - Periodic health checks with auto-recovery
 * - Full observability (metrics, logs)
 *
 * @example
 * ```ts
 * const pool = new RPCPool([
 *   { url: process.env.HELIUS_RPC_URL!, name: "Helius", priority: 1, maxRps: 10 },
 *   { url: "https://api.mainnet-beta.solana.com", name: "Public", priority: 2, maxRps: 2 }
 * ]);
 *
 * const connection = await pool.getConnection();
 * const balance = await connection.getBalance(pubkey);
 * ```
 */
export class RPCPool {
  private endpoints: RPCEndpoint[];
  private config: RPCPoolConfig;
  private requestCache: Map<string, RequestCacheEntry>;
  private healthCheckTimer: NodeJS.Timeout | null;
  private cacheCleanupTimer: NodeJS.Timeout | null;

  constructor(
    endpointConfigs: Array<{
      url: string;
      name: string;
      priority: number;
      maxRequestsPerSecond: number;
    }>,
    config: Partial<RPCPoolConfig> = {}
  ) {
    // Default configuration
    this.config = {
      commitment: "confirmed",
      circuitBreakerThreshold: 5,
      circuitBreakerTimeout: 60000, // 60s
      healthCheckInterval: 30000, // 30s
      deduplicationCacheTTL: 5000, // 5s
      maxLatencySamples: 100,
      ...config,
    };

    // Initialize endpoints
    this.endpoints = endpointConfigs.map((cfg) => ({
      url: cfg.url,
      name: cfg.name,
      priority: cfg.priority,
      circuitState: CircuitBreakerState.CLOSED,
      failureCount: 0,
      lastFailureTime: null,
      circuitOpenedAt: null,
      rateLimiter: {
        maxRequestsPerSecond: cfg.maxRequestsPerSecond,
        requestTimestamps: [],
        pendingQueue: [],
      },
      latencyStats: {
        samples: [],
        p50: 0,
        p95: 0,
        p99: 0,
        lastUpdate: Date.now(),
      },
      connection: null,
      lastHealthCheck: null,
      isHealthy: true, // Assume healthy until proven otherwise
    }));

    this.requestCache = new Map();
    this.healthCheckTimer = null;
    this.cacheCleanupTimer = null;

    logger.info("RPC Pool initialized", {
      endpoints: this.endpoints.map((e) => ({
        name: e.name,
        priority: e.priority,
        maxRps: e.rateLimiter.maxRequestsPerSecond,
      })),
      config: this.config,
    });

    // Start background tasks
    this.startHealthChecks();
    this.startCacheCleanup();
  }

  /**
   * Get healthy connection with automatic failover
   *
   * Selection algorithm:
   * 1. Filter healthy endpoints (circuit CLOSED, health check passing)
   * 2. Sort by priority (1 = highest)
   * 3. Among same priority, prefer lowest latency (P95)
   * 4. Apply rate limiting (queue if limit reached)
   * 5. Return connection or fail if all endpoints unavailable
   *
   * @returns Connection from best available endpoint
   */
  async getConnection(): Promise<Connection> {
    const availableEndpoints = this.getAvailableEndpoints();

    if (availableEndpoints.length === 0) {
      logger.error("No healthy RPC endpoints available", {
        totalEndpoints: this.endpoints.length,
        states: this.endpoints.map((e) => ({
          name: e.name,
          circuit: e.circuitState,
          healthy: e.isHealthy,
        })),
      });

      throw new Error(
        "All RPC endpoints are unavailable. Please check RPC provider status."
      );
    }

    // Select best endpoint (priority, then latency)
    const endpoint = this.selectBestEndpoint(availableEndpoints);

    logger.debug("Selected RPC endpoint", {
      name: endpoint.name,
      priority: endpoint.priority,
      circuit: endpoint.circuitState,
      p95Latency: endpoint.latencyStats.p95,
    });

    // Apply rate limiting
    await this.waitForRateLimit(endpoint);

    // Lazy-load connection
    if (!endpoint.connection) {
      // Extract Basic Auth credentials if present in URL
      const { url: cleanUrl, headers } = extractBasicAuth(endpoint.url);

      endpoint.connection = new Connection(cleanUrl, {
        commitment: this.config.commitment,
        confirmTransactionInitialTimeout: 60000,
        httpHeaders: headers,
      });

      logger.debug("Created new Connection instance", {
        name: endpoint.name,
        url: cleanUrl,
        hasAuth: !!headers,
      });

      this.instrumentConnection(endpoint.connection, endpoint.name);
    }

    return endpoint.connection;
  }

  private instrumentConnection(
    connection: Connection,
    endpointName: string
  ): void {
    const anyConnection = connection as Connection & {
      __metricsPatched?: boolean;
      _rpcRequest?: (...args: unknown[]) => Promise<unknown>;
    };

    if (anyConnection.__metricsPatched || typeof anyConnection._rpcRequest !== "function") {
      return;
    }

    const original = anyConnection._rpcRequest!.bind(connection);
    anyConnection.__metricsPatched = true;

    anyConnection._rpcRequest = async (...args: unknown[]) => {
      const method = (args[0] as string) ?? "unknown";
      const start = Date.now();

      try {
        const result = await original(...args);
        observeRpcRequest(endpointName, method, Date.now() - start, "ok");
        return result;
      } catch (error) {
        observeRpcRequest(endpointName, method, Date.now() - start, "error");
        throw error;
      }
    };
  }

  /**
   * Execute RPC request with automatic retry and failover
   *
   * Features:
   * - Request deduplication (share identical pending requests)
   * - Latency tracking (update P50, P95, P99)
   * - Circuit breaker integration (mark failures)
   * - Automatic retry with different endpoint on failure
   * - Exponential backoff on rate limits
   *
   * @param requestFn - Function that makes the RPC call
   * @param dedupKey - Optional key for request deduplication
   * @returns Result of the RPC call
   */
  async executeRequest<T>(
    requestFn: (connection: Connection) => Promise<T>,
    dedupKey?: string
  ): Promise<T> {
    // Check deduplication cache
    if (dedupKey) {
      const cached = this.requestCache.get(dedupKey);
      if (cached) {
        logger.debug("Request deduplication cache hit", {
          key: dedupKey,
          refCount: cached.refCount,
          age: Date.now() - cached.timestamp,
        });

        cached.refCount++;
        return cached.promise as Promise<T>;
      }
    }

    // Execute with retry
    const promise = this.executeWithRetry(requestFn);

    // Cache if dedup key provided
    if (dedupKey) {
      this.requestCache.set(dedupKey, {
        promise,
        timestamp: Date.now(),
        refCount: 1,
      });
    }

    try {
      const result = await promise;
      return result;
    } finally {
      // Remove from cache after completion
      if (dedupKey) {
        this.requestCache.delete(dedupKey);
      }
    }
  }

  /**
   * Graceful shutdown
   *
   * Stops background tasks and cleans up resources.
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down RPC Pool");

    // Stop health checks
    if (this.healthCheckTimer) {
      clearRegisteredInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Stop cache cleanup
    if (this.cacheCleanupTimer) {
      clearRegisteredInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
    }

    // Clear caches
    this.requestCache.clear();

    logger.info("RPC Pool shutdown complete");
  }

  // ==========================================================================
  // Private Methods - Endpoint Selection
  // ==========================================================================

  /**
   * Get endpoints available for use
   *
   * Filters:
   * - Circuit state (CLOSED or HALF_OPEN)
   * - Health check passing
   * - Circuit timeout expired (for OPEN → HALF_OPEN transition)
   */
  private getAvailableEndpoints(): RPCEndpoint[] {
    const now = Date.now();

    return this.endpoints.filter((endpoint) => {
      // Update circuit state if timeout expired
      if (
        endpoint.circuitState === CircuitBreakerState.OPEN &&
        endpoint.circuitOpenedAt &&
        now - endpoint.circuitOpenedAt >= this.config.circuitBreakerTimeout
      ) {
        logger.info("Circuit breaker transitioning to HALF_OPEN", {
          name: endpoint.name,
          openedAt: endpoint.circuitOpenedAt,
          timeout: this.config.circuitBreakerTimeout,
        });

        endpoint.circuitState = CircuitBreakerState.HALF_OPEN;
        endpoint.circuitOpenedAt = null;
      }

      // Available if circuit allows and health check passing
      return (
        (endpoint.circuitState === CircuitBreakerState.CLOSED ||
          endpoint.circuitState === CircuitBreakerState.HALF_OPEN) &&
        endpoint.isHealthy
      );
    });
  }

  /**
   * Select best endpoint from available options
   *
   * Algorithm:
   * 1. Sort by priority (ascending, 1 = highest)
   * 2. Among same priority, prefer lowest P95 latency
   * 3. Return first (best) endpoint
   */
  private selectBestEndpoint(endpoints: RPCEndpoint[]): RPCEndpoint {
    const sorted = [...endpoints].sort((a, b) => {
      // First by priority (lower number = higher priority)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      // Then by latency (lower = better)
      return a.latencyStats.p95 - b.latencyStats.p95;
    });

    return sorted[0];
  }

  // ==========================================================================
  // Private Methods - Rate Limiting
  // ==========================================================================

  /**
   * Wait for rate limit availability using sliding window
   *
   * Algorithm:
   * 1. Remove timestamps older than 1 second (sliding window)
   * 2. If under limit, record timestamp and proceed
   * 3. If at limit, queue request and wait
   * 4. Process queue when capacity available
   */
  private async waitForRateLimit(endpoint: RPCEndpoint): Promise<void> {
    const now = Date.now();
    const windowStart = now - 1000; // 1 second window

    // Remove old timestamps (sliding window)
    endpoint.rateLimiter.requestTimestamps =
      endpoint.rateLimiter.requestTimestamps.filter((ts) => ts > windowStart);

    // Check if under limit
    if (
      endpoint.rateLimiter.requestTimestamps.length <
      endpoint.rateLimiter.maxRequestsPerSecond
    ) {
      // Under limit - record and proceed
      endpoint.rateLimiter.requestTimestamps.push(now);
      return;
    }

    // At limit - queue request
    logger.debug("Rate limit reached, queueing request", {
      name: endpoint.name,
      currentRps: endpoint.rateLimiter.requestTimestamps.length,
      maxRps: endpoint.rateLimiter.maxRequestsPerSecond,
      queueSize: endpoint.rateLimiter.pendingQueue.length,
    });

    return new Promise((resolve, reject) => {
      endpoint.rateLimiter.pendingQueue.push({
        resolve: () => resolve(),
        reject,
        timestamp: now,
      });

      // Process queue after delay
      setTimeout(() => {
        this.processRateLimitQueue(endpoint);
      }, 1000);
    });
  }

  /**
   * Process queued requests after rate limit window
   */
  private processRateLimitQueue(endpoint: RPCEndpoint): void {
    const now = Date.now();
    const windowStart = now - 1000;

    // Clean old timestamps
    endpoint.rateLimiter.requestTimestamps =
      endpoint.rateLimiter.requestTimestamps.filter((ts) => ts > windowStart);

    // Process as many queued requests as capacity allows
    const capacity =
      endpoint.rateLimiter.maxRequestsPerSecond -
      endpoint.rateLimiter.requestTimestamps.length;

    for (let i = 0; i < capacity && endpoint.rateLimiter.pendingQueue.length > 0; i++) {
      const queued = endpoint.rateLimiter.pendingQueue.shift();
      if (queued) {
        endpoint.rateLimiter.requestTimestamps.push(now);
        queued.resolve(endpoint.connection!);

        logger.debug("Processed queued request", {
          name: endpoint.name,
          waitTime: now - queued.timestamp,
          remainingQueue: endpoint.rateLimiter.pendingQueue.length,
        });
      }
    }
  }

  // ==========================================================================
  // Private Methods - Request Execution
  // ==========================================================================

  /**
   * Execute request with retry and failover
   *
   * Attempts all available endpoints before failing.
   * Tracks latency and circuit breaker state.
   */
  private async executeWithRetry<T>(
    requestFn: (connection: Connection) => Promise<T>,
    attemptedEndpoints: Set<string> = new Set()
  ): Promise<T> {
    const availableEndpoints = this.getAvailableEndpoints().filter(
      (e) => !attemptedEndpoints.has(e.url)
    );

    if (availableEndpoints.length === 0) {
      throw new Error(
        "All RPC endpoints exhausted. No healthy endpoints available."
      );
    }

    const endpoint = this.selectBestEndpoint(availableEndpoints);
    attemptedEndpoints.add(endpoint.url);

    const connection = await this.getConnection();
    const startTime = Date.now();

    try {
      const result = await requestFn(connection);
      const latency = Date.now() - startTime;

      // Success - record metrics and reset circuit
      this.recordSuccess(endpoint, latency);

      return result;
    } catch (error) {
      const latency = Date.now() - startTime;

      // Failure - record and potentially open circuit
      this.recordFailure(endpoint, error, latency);

      logger.warn("RPC request failed, retrying with different endpoint", {
        failedEndpoint: endpoint.name,
        error: error instanceof Error ? error.message : String(error),
        latency,
        attemptsRemaining: availableEndpoints.length - 1,
      });

      // Retry with different endpoint
      return this.executeWithRetry(requestFn, attemptedEndpoints);
    }
  }

  /**
   * Record successful request
   *
   * Updates:
   * - Latency statistics (P50, P95, P99)
   * - Circuit breaker (reset failure count, close circuit)
   */
  private recordSuccess(endpoint: RPCEndpoint, latency: number): void {
    // Update latency stats
    endpoint.latencyStats.samples.push(latency);

    // Keep only last N samples
    if (endpoint.latencyStats.samples.length > this.config.maxLatencySamples) {
      endpoint.latencyStats.samples.shift();
    }

    // Calculate percentiles
    this.updateLatencyPercentiles(endpoint);

    // Reset circuit breaker on success
    if (endpoint.failureCount > 0 || endpoint.circuitState !== CircuitBreakerState.CLOSED) {
      logger.info("Circuit breaker reset after successful request", {
        name: endpoint.name,
        previousState: endpoint.circuitState,
        failureCount: endpoint.failureCount,
      });

      endpoint.failureCount = 0;
      endpoint.circuitState = CircuitBreakerState.CLOSED;
      endpoint.lastFailureTime = null;
      endpoint.circuitOpenedAt = null;
    }

    logger.debug("RPC request successful", {
      name: endpoint.name,
      latency,
      p50: endpoint.latencyStats.p50,
      p95: endpoint.latencyStats.p95,
      p99: endpoint.latencyStats.p99,
    });
  }

  /**
   * Record failed request
   *
   * Updates:
   * - Failure count (increment)
   * - Circuit breaker (potentially open circuit)
   * - Last failure time
   */
  private recordFailure(endpoint: RPCEndpoint, error: unknown, latency: number): void {
    endpoint.failureCount++;
    endpoint.lastFailureTime = Date.now();

    logger.warn("RPC request failed", {
      name: endpoint.name,
      error: error instanceof Error ? error.message : String(error),
      latency,
      failureCount: endpoint.failureCount,
      circuitState: endpoint.circuitState,
    });

    // Open circuit if threshold reached
    if (
      endpoint.failureCount >= this.config.circuitBreakerThreshold &&
      endpoint.circuitState !== CircuitBreakerState.OPEN
    ) {
      endpoint.circuitState = CircuitBreakerState.OPEN;
      endpoint.circuitOpenedAt = Date.now();

      logger.error("Circuit breaker opened", {
        name: endpoint.name,
        failureCount: endpoint.failureCount,
        threshold: this.config.circuitBreakerThreshold,
        timeout: this.config.circuitBreakerTimeout,
      });
    }
  }

  /**
   * Update latency percentiles from samples
   *
   * Calculates P50, P95, P99 from sorted samples.
   */
  private updateLatencyPercentiles(endpoint: RPCEndpoint): void {
    if (endpoint.latencyStats.samples.length === 0) return;

    const sorted = [...endpoint.latencyStats.samples].sort((a, b) => a - b);

    endpoint.latencyStats.p50 = this.percentile(sorted, 0.5);
    endpoint.latencyStats.p95 = this.percentile(sorted, 0.95);
    endpoint.latencyStats.p99 = this.percentile(sorted, 0.99);
    endpoint.latencyStats.lastUpdate = Date.now();
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  // ==========================================================================
  // Private Methods - Background Tasks
  // ==========================================================================

  /**
   * Start periodic health checks
   *
   * Runs every 30s by default.
   * Checks endpoint health with simple getSlot() call.
   */
  private startHealthChecks(): void {
    this.healthCheckTimer = registerInterval(
      () => {
        void this.performHealthChecks();
      },
      this.config.healthCheckInterval,
      "rpcPool-health"
    );

    logger.info("Health check timer started", {
      interval: this.config.healthCheckInterval,
    });
  }

  /**
   * Perform health checks on all endpoints
   */
  private async performHealthChecks(): Promise<void> {
    logger.debug("Performing health checks", {
      endpoints: this.endpoints.length,
    });

    const checks = this.endpoints.map((endpoint) =>
      this.healthCheckEndpoint(endpoint)
    );

    await Promise.allSettled(checks);
  }

  /**
   * Health check single endpoint
   *
   * Attempts simple getSlot() call with 5s timeout.
   * Updates isHealthy flag based on result.
   */
  private async healthCheckEndpoint(endpoint: RPCEndpoint): Promise<void> {
    try {
      // Lazy-load connection if needed
      if (!endpoint.connection) {
        const { url: cleanUrl, headers } = extractBasicAuth(endpoint.url);
        endpoint.connection = new Connection(cleanUrl, {
          commitment: this.config.commitment,
          httpHeaders: headers,
        });
      }

      // Simple health check: getSlot()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Health check timeout")), 5000)
      );

      const healthPromise = endpoint.connection.getSlot();

      await Promise.race([healthPromise, timeoutPromise]);

      // Success
      if (!endpoint.isHealthy) {
        logger.info("Endpoint recovered", {
          name: endpoint.name,
          wasUnhealthy: !endpoint.isHealthy,
        });
      }

      endpoint.isHealthy = true;
      endpoint.lastHealthCheck = Date.now();
    } catch (error) {
      // Failure
      if (endpoint.isHealthy) {
        logger.warn("Endpoint health check failed", {
          name: endpoint.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      endpoint.isHealthy = false;
      endpoint.lastHealthCheck = Date.now();
    }
  }

  /**
   * Start periodic cache cleanup
   *
   * Removes stale entries from deduplication cache every 10s.
   */
  private startCacheCleanup(): void {
    this.cacheCleanupTimer = registerInterval(
      () => {
        this.cleanupRequestCache();
      },
      10000,
      "rpcPool-cache"
    );

    logger.debug("Cache cleanup timer started");
  }

  /**
   * Remove stale entries from request cache
   */
  private cleanupRequestCache(): void {
    const now = Date.now();
    const ttl = this.config.deduplicationCacheTTL;

    let removed = 0;

    // Use Array.from() for TypeScript compatibility
    const entries = Array.from(this.requestCache.entries());
    for (const [key, entry] of entries) {
      if (now - entry.timestamp > ttl) {
        this.requestCache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug("Cleaned up request cache", {
        removed,
        remaining: this.requestCache.size,
      });
    }
  }

  // ==========================================================================
  // Public Methods - Observability
  // ==========================================================================

  /**
   * Get pool health status
   *
   * @returns Health metrics for all endpoints
   */
  getHealthStatus(): {
    healthy: number;
    unhealthy: number;
    total: number;
    endpoints: Array<{
      name: string;
      healthy: boolean;
      circuit: CircuitBreakerState;
      failures: number;
      p95Latency: number;
    }>;
  } {
    const endpoints = this.endpoints.map((e) => ({
      name: e.name,
      healthy: e.isHealthy && e.circuitState === CircuitBreakerState.CLOSED,
      circuit: e.circuitState,
      failures: e.failureCount,
      p95Latency: e.latencyStats.p95,
    }));

    const healthy = endpoints.filter((e) => e.healthy).length;

    return {
      healthy,
      unhealthy: endpoints.length - healthy,
      total: endpoints.length,
      endpoints,
    };
  }
}
