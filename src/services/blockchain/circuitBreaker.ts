/**
 * Circuit Breaker Pattern Implementation (HIGH-2)
 *
 * Protects against cascade failures in RPC and external API calls.
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Fast-fail mode, requests immediately rejected
 * - HALF_OPEN: Recovery test, limited requests allowed
 *
 * Use cases:
 * - RPC endpoint protection (Solana)
 * - External API calls (Jupiter, GoPlus)
 * - Database connection pools
 *
 * Production features:
 * - Automatic state transitions
 * - Configurable thresholds and timeouts
 * - Detailed metrics and logging
 * - Manual reset capability (admin/testing)
 */

import { logger } from "../../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures to open circuit
   * Recommended: 3-5 for RPC, 2-3 for critical APIs
   */
  failureThreshold: number;

  /**
   * Time in milliseconds before attempting recovery (half-open)
   * Recommended: 30000ms (30s) for RPC, 60000ms (60s) for external APIs
   */
  resetTimeout: number;

  /**
   * Number of consecutive successes in half-open to close circuit
   * Default: 2
   */
  successThreshold?: number;

  /**
   * Name for logging and monitoring
   */
  name?: string;

  /**
   * Optional callback when circuit opens
   */
  onOpen?: () => void;

  /**
   * Optional callback when circuit closes
   */
  onClose?: () => void;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  nextAttemptTime: number;
  totalFailures: number;
  totalSuccesses: number;
  totalRejections: number; // Requests rejected while open
  openedAt?: number;
  closedAt?: number;
}

/**
 * Circuit Breaker Error
 * Thrown when circuit is open and request is rejected
 */
export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly state: CircuitState,
    public readonly nextAttemptTime: number,
    public readonly circuitName?: string
  ) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

// ============================================================================
// Circuit Breaker
// ============================================================================

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private nextAttemptTime = 0;

  // Metrics
  private totalFailures = 0;
  private totalSuccesses = 0;
  private totalRejections = 0;
  private openedAt?: number;
  private closedAt?: number;

  private readonly successThreshold: number;
  private readonly name: string;

  constructor(private config: CircuitBreakerConfig) {
    this.successThreshold = config.successThreshold || 2;
    this.name = config.name || "unnamed";

    logger.info("Circuit breaker initialized", {
      name: this.name,
      failureThreshold: config.failureThreshold,
      resetTimeout: config.resetTimeout,
      successThreshold: this.successThreshold,
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Execute function with circuit breaker protection
   *
   * @param fn - Async function to execute
   * @returns Result of function execution
   * @throws {CircuitBreakerError} If circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition to half-open
    if (this.state === "open") {
      const now = Date.now();

      if (now >= this.nextAttemptTime) {
        logger.info("Circuit breaker transitioning to half-open", {
          name: this.name,
          wasOpenFor: now - (this.openedAt || now),
        });
        this.state = "half-open";
        this.successCount = 0;
      } else {
        // Circuit still open - reject request immediately
        this.totalRejections++;

        const waitTime = Math.ceil((this.nextAttemptTime - now) / 1000);
        const error = new CircuitBreakerError(
          `Circuit breaker is OPEN for ${this.name}. Retry in ${waitTime}s.`,
          this.state,
          this.nextAttemptTime,
          this.name
        );

        logger.debug("Circuit breaker rejected request", {
          name: this.name,
          state: this.state,
          waitTime,
          totalRejections: this.totalRejections,
        });

        throw error;
      }
    }

    // Execute function
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      totalRejections: this.totalRejections,
      openedAt: this.openedAt,
      closedAt: this.closedAt,
    };
  }

  /**
   * Check if circuit is healthy (closed or half-open)
   */
  isHealthy(): boolean {
    return this.state !== "open";
  }

  /**
   * Manually reset circuit breaker
   * Use for testing or admin commands
   */
  reset(): void {
    const prevState = this.state;

    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.nextAttemptTime = 0;
    this.closedAt = Date.now();

    logger.info("Circuit breaker manually reset", {
      name: this.name,
      prevState,
      newState: this.state,
    });
  }

  /**
   * Force circuit to open (testing/debugging)
   */
  forceOpen(): void {
    this.openCircuit();
    logger.warn("Circuit breaker force opened (manual)", {
      name: this.name,
    });
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.failureCount = 0;
    this.totalSuccesses++;

    if (this.state === "half-open") {
      this.successCount++;

      logger.debug("Circuit breaker success in half-open", {
        name: this.name,
        successCount: this.successCount,
        threshold: this.successThreshold,
      });

      // Close circuit if success threshold reached
      if (this.successCount >= this.successThreshold) {
        this.closeCircuit();
      }
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: unknown): void {
    this.failureCount++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    logger.warn("Circuit breaker failure", {
      name: this.name,
      failureCount: this.failureCount,
      threshold: this.config.failureThreshold,
      state: this.state,
      error: error instanceof Error ? error.message : String(error),
    });

    if (this.state === "half-open") {
      // Any failure in half-open immediately opens circuit
      logger.warn("Circuit breaker re-opening from half-open", {
        name: this.name,
        successCount: this.successCount,
      });
      this.openCircuit();
    } else if (this.failureCount >= this.config.failureThreshold) {
      // Threshold exceeded - open circuit
      logger.error("Circuit breaker opening due to threshold", {
        name: this.name,
        failureCount: this.failureCount,
        threshold: this.config.failureThreshold,
      });
      this.openCircuit();
    }
  }

  /**
   * Open the circuit (enter fail-fast mode)
   */
  private openCircuit(): void {
    this.state = "open";
    this.openedAt = Date.now();
    this.nextAttemptTime = Date.now() + this.config.resetTimeout;
    this.successCount = 0;

    const resetInSeconds = this.config.resetTimeout / 1000;

    logger.error("Circuit breaker OPENED", {
      name: this.name,
      failureCount: this.failureCount,
      totalFailures: this.totalFailures,
      nextAttemptIn: `${resetInSeconds}s`,
      resetAt: new Date(this.nextAttemptTime).toISOString(),
    });

    // Call callback if provided
    if (this.config.onOpen) {
      try {
        this.config.onOpen();
      } catch (error) {
        logger.error("Circuit breaker onOpen callback failed", {
          name: this.name,
          error,
        });
      }
    }
  }

  /**
   * Close the circuit (return to normal operation)
   */
  private closeCircuit(): void {
    const prevState = this.state;
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.closedAt = Date.now();

    const downtime = this.openedAt ? Date.now() - this.openedAt : 0;

    logger.info("Circuit breaker CLOSED", {
      name: this.name,
      prevState,
      downtimeMs: downtime,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalRejections: this.totalRejections,
    });

    // Call callback if provided
    if (this.config.onClose) {
      try {
        this.config.onClose();
      } catch (error) {
        logger.error("Circuit breaker onClose callback failed", {
          name: this.name,
          error,
        });
      }
    }
  }
}

// ============================================================================
// Helper: Create pre-configured circuit breakers
// ============================================================================

/**
 * Create circuit breaker for RPC endpoints
 */
export function createRpcCircuitBreaker(name: string): CircuitBreaker {
  return new CircuitBreaker({
    name: `rpc:${name}`,
    failureThreshold: 5, // 5 consecutive failures
    resetTimeout: 30000, // 30 seconds
    successThreshold: 2, // 2 successes to close
  });
}

/**
 * Create circuit breaker for external APIs (Jupiter, GoPlus)
 */
export function createApiCircuitBreaker(name: string): CircuitBreaker {
  return new CircuitBreaker({
    name: `api:${name}`,
    failureThreshold: 3, // 3 consecutive failures
    resetTimeout: 60000, // 60 seconds
    successThreshold: 3, // 3 successes to close
  });
}

/**
 * Create circuit breaker for critical services (DB, Redis)
 */
export function createCriticalCircuitBreaker(name: string): CircuitBreaker {
  return new CircuitBreaker({
    name: `critical:${name}`,
    failureThreshold: 2, // 2 consecutive failures
    resetTimeout: 10000, // 10 seconds
    successThreshold: 5, // 5 successes to close (extra cautious)
  });
}
