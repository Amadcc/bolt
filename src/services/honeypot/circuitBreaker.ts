/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascade failures by failing fast when downstream service is unhealthy.
 * Based on Martin Fowler's Circuit Breaker pattern.
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
import type {
  CircuitBreakerState,
  CircuitBreakerConfig,
  CircuitBreakerMetrics,
} from "../../types/honeypot.js";

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,        // 5 failures -> OPEN
  successThreshold: 2,        // 2 successes -> CLOSED (from HALF_OPEN)
  timeout: 60000,             // 60s before trying HALF_OPEN
  monitoringPeriod: 120000,   // 2min window for failure tracking
};

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

  constructor(
    private readonly name: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_CONFIG
  ) {
    logger.debug("Circuit breaker initialized", {
      name: this.name,
      config: this.config,
    });
  }

  /**
   * Execute function with circuit breaker protection
   * Returns null if circuit is OPEN (fail fast)
   */
  async execute<T>(
    fn: () => Promise<T>
  ): Promise<T | null> {
    // Check if circuit is OPEN
    if (this.state === "OPEN") {
      if (!this.shouldAttemptReset()) {
        logger.debug("Circuit breaker OPEN, rejecting request", {
          name: this.name,
          nextAttemptTime: this.nextAttemptTime,
          timeRemaining: this.nextAttemptTime ? this.nextAttemptTime - Date.now() : 0,
        });
        return null;
      }

      // Transition to HALF_OPEN for testing
      this.transitionTo("HALF_OPEN");
    }

    // Execute function
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Check if circuit breaker is in CLOSED state (allowing requests)
   */
  isAvailable(): boolean {
    if (this.state === "OPEN" && this.shouldAttemptReset()) {
      this.transitionTo("HALF_OPEN");
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
  reset(): void {
    logger.info("Circuit breaker manually reset", { name: this.name });
    this.transitionTo("CLOSED");
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttemptTime = null;
    this.failureTimestamps = [];
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Handle successful request
   */
  private onSuccess(): void {
    this.lastSuccessTime = Date.now();

    if (this.state === "HALF_OPEN") {
      this.successCount++;

      logger.debug("Circuit breaker success in HALF_OPEN", {
        name: this.name,
        successCount: this.successCount,
        threshold: this.config.successThreshold,
      });

      // Transition back to CLOSED after enough successes
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo("CLOSED");
        this.failureCount = 0;
        this.successCount = 0;
        this.failureTimestamps = [];
      }
    } else if (this.state === "CLOSED") {
      // Reset failure count on success in CLOSED state
      this.failureCount = 0;
      this.failureTimestamps = [];
    }
  }

  /**
   * Handle failed request
   */
  private onFailure(): void {
    const now = Date.now();
    this.lastFailureTime = now;
    this.failureCount++;
    this.failureTimestamps.push(now);

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
      this.transitionTo("OPEN");
      this.successCount = 0;
    } else if (this.state === "CLOSED") {
      // Check if we should open circuit
      if (recentFailures >= this.config.failureThreshold) {
        this.transitionTo("OPEN");
      }
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
  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
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
  }
}
