/**
 * Production-Grade Circuit Breaker Pattern Implementation
 *
 * Prevents cascade failures by failing fast when downstream service is unhealthy.
 * Based on Martin Fowler's Circuit Breaker pattern with Redis persistence.
 *
 * Features:
 * - Redis-backed state persistence (multi-instance support)
 * - Prometheus metrics integration
 * - Configurable thresholds and timeouts
 * - Graceful degradation support
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Too many failures, requests blocked (fail fast)
 * - HALF_OPEN: Testing recovery, limited requests allowed
 *
 * Transitions:
 * - CLOSED -> OPEN: After N failures within monitoring period
 * - OPEN -> HALF_OPEN: After timeout expires
 * - HALF_OPEN -> CLOSED: After M successful requests
 * - HALF_OPEN -> OPEN: On any failure
 */

import { logger } from "../../utils/logger.js";
import { redis } from "../../utils/redis.js";
import * as client from "prom-client";
import { getAlertService } from "../monitoring/alerts.js";

// ============================================================================
// Types
// ============================================================================

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold: number; // Failures before opening circuit (default: 5)
  successThreshold: number; // Successes to close from half-open (default: 2)
  timeout: number; // Time to wait before half-open (ms, default: 60000)
  monitoringPeriod: number; // Time window for failure tracking (ms, default: 120000)
  enableRedis?: boolean; // Enable Redis persistence (default: true)
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextAttemptTime: number | null;
}

interface CircuitBreakerPersistedState {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextAttemptTime: number | null;
  failureTimestamps: number[];
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 5, // 5 failures -> OPEN
  successThreshold: 2, // 2 successes -> CLOSED (from HALF_OPEN)
  timeout: 60000, // 60s before trying HALF_OPEN
  monitoringPeriod: 120000, // 2min window for failure tracking
  enableRedis: true,
};

// ============================================================================
// Prometheus Metrics
// ============================================================================

const register = new client.Registry();

const circuitBreakerStateGauge = new client.Gauge({
  name: "circuit_breaker_state",
  help: "Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)",
  labelNames: ["name"],
  registers: [register],
});

const circuitBreakerFailuresTotal = new client.Counter({
  name: "circuit_breaker_failures_total",
  help: "Total failures recorded by circuit breaker",
  labelNames: ["name"],
  registers: [register],
});

const circuitBreakerSuccessesTotal = new client.Counter({
  name: "circuit_breaker_successes_total",
  help: "Total successes recorded by circuit breaker",
  labelNames: ["name"],
  registers: [register],
});

const circuitBreakerStateTransitionsTotal = new client.Counter({
  name: "circuit_breaker_state_transitions_total",
  help: "Total state transitions",
  labelNames: ["name", "from_state", "to_state"],
  registers: [register],
});

const circuitBreakerRejectedTotal = new client.Counter({
  name: "circuit_breaker_rejected_total",
  help: "Total requests rejected due to circuit being OPEN",
  labelNames: ["name"],
  registers: [register],
});

// Export for Prometheus /metrics endpoint
export const circuitBreakerMetricsRegistry = register;

// ============================================================================
// Circuit Breaker Class
// ============================================================================

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttemptTime: number | null = null;
  private failureTimestamps: number[] = [];
  private readonly config: Required<CircuitBreakerConfig>;
  private readonly redisKey: string;

  constructor(
    private readonly name: string,
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.redisKey = `circuit_breaker:${this.name}`;

    logger.debug("Circuit breaker initialized", {
      name: this.name,
      config: this.config,
    });

    // Initialize Prometheus gauge
    this.updatePrometheusGauge();

    // Load state from Redis if enabled
    if (this.config.enableRedis) {
      this.loadStateFromRedis().catch((error) => {
        logger.warn("Failed to load circuit breaker state from Redis", {
          name: this.name,
          error: String(error),
        });
      });
    }
  }

  /**
   * Execute function with circuit breaker protection
   * Returns null if circuit is OPEN (fail fast)
   */
  async execute<T>(fn: () => Promise<T>): Promise<T | null> {
    // Check if circuit is OPEN
    if (this.state === "OPEN") {
      if (!this.shouldAttemptReset()) {
        logger.debug("Circuit breaker OPEN, rejecting request", {
          name: this.name,
          nextAttemptTime: this.nextAttemptTime,
          timeRemaining: this.nextAttemptTime
            ? this.nextAttemptTime - Date.now()
            : 0,
        });

        circuitBreakerRejectedTotal.inc({ name: this.name });
        return null;
      }

      // Transition to HALF_OPEN for testing
      await this.transitionTo("HALF_OPEN");
    }

    // Execute function
    try {
      const result = await fn();
      await this.onSuccess();
      return result;
    } catch (error) {
      await this.onFailure();
      throw error;
    }
  }

  /**
   * Check if circuit breaker is in CLOSED state (allowing requests)
   */
  async isAvailable(): Promise<boolean> {
    if (this.state === "OPEN" && this.shouldAttemptReset()) {
      await this.transitionTo("HALF_OPEN");
    }

    return this.state !== "OPEN";
  }

  /**
   * Get current metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      nextAttemptTime: this.nextAttemptTime,
    };
  }

  /**
   * Reset circuit breaker to CLOSED state (for testing/admin)
   */
  async reset(): Promise<void> {
    logger.info("Circuit breaker manually reset", { name: this.name });
    await this.transitionTo("CLOSED");
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttemptTime = null;
    this.failureTimestamps = [];

    if (this.config.enableRedis) {
      await this.persistStateToRedis();
    }
  }

  // ==========================================================================
  // Private Methods - State Management
  // ==========================================================================

  /**
   * Handle successful request
   */
  private async onSuccess(): Promise<void> {
    this.lastSuccessTime = Date.now();
    circuitBreakerSuccessesTotal.inc({ name: this.name });

    if (this.state === "HALF_OPEN") {
      this.successCount++;

      logger.debug("Circuit breaker success in HALF_OPEN", {
        name: this.name,
        successCount: this.successCount,
        threshold: this.config.successThreshold,
      });

      // Transition back to CLOSED after enough successes
      if (this.successCount >= this.config.successThreshold) {
        await this.transitionTo("CLOSED");
        this.failureCount = 0;
        this.successCount = 0;
        this.failureTimestamps = [];
      }
    } else if (this.state === "CLOSED") {
      // Reset failure count on success in CLOSED state
      this.failureCount = 0;
      this.failureTimestamps = [];
    }

    if (this.config.enableRedis) {
      await this.persistStateToRedis();
    }
  }

  /**
   * Handle failed request
   */
  private async onFailure(): Promise<void> {
    const now = Date.now();
    this.lastFailureTime = now;
    this.failureCount++;
    this.failureTimestamps.push(now);

    circuitBreakerFailuresTotal.inc({ name: this.name });

    // Remove old failures outside monitoring period
    this.failureTimestamps = this.failureTimestamps.filter(
      (timestamp) => now - timestamp < this.config.monitoringPeriod
    );

    const recentFailures = this.failureTimestamps.length;

    logger.debug("Circuit breaker failure recorded", {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      recentFailures,
      threshold: this.config.failureThreshold,
    });

    if (this.state === "HALF_OPEN") {
      // Any failure in HALF_OPEN -> back to OPEN
      await this.transitionTo("OPEN");
      this.successCount = 0;
    } else if (this.state === "CLOSED") {
      // Check if we should open circuit
      if (recentFailures >= this.config.failureThreshold) {
        await this.transitionTo("OPEN");
      }
    }

    if (this.config.enableRedis) {
      await this.persistStateToRedis();
    }
  }

  /**
   * Check if enough time has passed to attempt reset from OPEN -> HALF_OPEN
   */
  private shouldAttemptReset(): boolean {
    if (!this.nextAttemptTime) return false;
    return Date.now() >= this.nextAttemptTime;
  }

  /**
   * Transition to new state
   */
  private async transitionTo(newState: CircuitBreakerState): Promise<void> {
    const oldState = this.state;

    if (oldState === newState) {
      return; // No transition needed
    }

    this.state = newState;

    // Set next attempt time when opening circuit
    if (newState === "OPEN") {
      this.nextAttemptTime = Date.now() + this.config.timeout;
    } else {
      this.nextAttemptTime = null;
    }

    logger.info("Circuit breaker state transition", {
      name: this.name,
      oldState,
      newState,
      failureCount: this.failureCount,
      nextAttemptTime: this.nextAttemptTime,
    });

    // SPRINT 4: Send alerts on circuit breaker state changes
    const alertService = getAlertService();
    if (newState === "OPEN") {
      await alertService.alertCircuitBreakerOpen(this.name, this.failureCount);
    } else if (newState === "CLOSED" && oldState === "HALF_OPEN") {
      // Only alert when fully recovered (HALF_OPEN -> CLOSED)
      await alertService.alertCircuitBreakerClosed(this.name);
    }

    // Record state transition metric
    circuitBreakerStateTransitionsTotal.inc({
      name: this.name,
      from_state: oldState,
      to_state: newState,
    });

    // Update Prometheus gauge
    this.updatePrometheusGauge();

    // Persist to Redis
    if (this.config.enableRedis) {
      await this.persistStateToRedis();
    }
  }

  /**
   * Update Prometheus gauge based on current state
   */
  private updatePrometheusGauge(): void {
    const stateValue =
      this.state === "CLOSED" ? 0 : this.state === "HALF_OPEN" ? 1 : 2;
    circuitBreakerStateGauge.set({ name: this.name }, stateValue);
  }

  // ==========================================================================
  // Private Methods - Redis Persistence
  // ==========================================================================

  /**
   * Load state from Redis
   */
  private async loadStateFromRedis(): Promise<void> {
    try {
      const stateJson = await redis.get(this.redisKey);

      if (!stateJson) {
        logger.debug("No persisted state found in Redis", { name: this.name });
        return;
      }

      const persisted: CircuitBreakerPersistedState = JSON.parse(stateJson);

      this.state = persisted.state;
      this.failureCount = persisted.failureCount;
      this.successCount = persisted.successCount;
      this.lastFailureTime = persisted.lastFailureTime;
      this.lastSuccessTime = persisted.lastSuccessTime;
      this.nextAttemptTime = persisted.nextAttemptTime;
      this.failureTimestamps = persisted.failureTimestamps;

      logger.info("Loaded circuit breaker state from Redis", {
        name: this.name,
        state: this.state,
      });

      // Update Prometheus gauge
      this.updatePrometheusGauge();
    } catch (error) {
      logger.error("Failed to load circuit breaker state from Redis", {
        name: this.name,
        error: String(error),
      });
      // Continue with default state
    }
  }

  /**
   * Persist state to Redis with TTL
   */
  private async persistStateToRedis(): Promise<void> {
    try {
      const state: CircuitBreakerPersistedState = {
        state: this.state,
        failureCount: this.failureCount,
        successCount: this.successCount,
        lastFailureTime: this.lastFailureTime,
        lastSuccessTime: this.lastSuccessTime,
        nextAttemptTime: this.nextAttemptTime,
        failureTimestamps: this.failureTimestamps,
      };

      const stateJson = JSON.stringify(state);

      // Store with TTL (monitoring period + timeout)
      const ttlSeconds = Math.ceil(
        (this.config.monitoringPeriod + this.config.timeout) / 1000
      );

      await redis.setex(this.redisKey, ttlSeconds, stateJson);

      logger.debug("Persisted circuit breaker state to Redis", {
        name: this.name,
        ttlSeconds,
      });
    } catch (error) {
      logger.error("Failed to persist circuit breaker state to Redis", {
        name: this.name,
        error: String(error),
      });
      // Continue without persistence
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new circuit breaker with default configuration
 */
export function createCircuitBreaker(
  name: string,
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  return new CircuitBreaker(name, config);
}
