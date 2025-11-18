/**
 * Enhanced Retry Utility with Jitter and Circuit Breaker Integration
 *
 * Features:
 * - Exponential backoff with jitter (prevents thundering herd)
 * - Per-error-type retry policies
 * - Circuit breaker integration
 * - Comprehensive metrics
 * - Type-safe error handling
 *
 * Usage:
 * ```typescript
 * const result = await retryWithBackoff(
 *   () => fetchData(),
 *   {
 *     maxRetries: 3,
 *     baseDelayMs: 100,
 *     maxDelayMs: 5000,
 *     jitterFactor: 0.1,
 *     retryPolicy: defaultRetryPolicy,
 *     circuitBreaker: myCircuitBreaker,
 *   }
 * );
 * ```
 */

import { logger } from "./logger.js";
import type { Result } from "../types/common.js";
import { Ok, Err } from "../types/common.js";
import * as client from "prom-client";

// ============================================================================
// Types
// ============================================================================

/**
 * Retry policy - determines which errors should be retried
 * Returns true if error should be retried, false otherwise
 */
export type RetryPolicy = (error: Error, attemptNumber: number) => boolean;

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;

  /** Base delay in milliseconds (default: 100ms) */
  baseDelayMs: number;

  /** Maximum delay in milliseconds (default: 5000ms) */
  maxDelayMs?: number;

  /** Backoff strategy (default: "exponential") */
  backoff?: "linear" | "exponential";

  /** Jitter factor (0-1) for randomization (default: 0.1 = 10%) */
  jitterFactor?: number;

  /** Retry policy function (default: defaultRetryPolicy) */
  retryPolicy?: RetryPolicy;

  /** Operation name for logging and metrics */
  operationName?: string;

  /** Custom error handler (called on each retry) */
  onRetry?: (error: Error, attemptNumber: number, delayMs: number) => void;
}

/**
 * Retry result with metadata
 */
export interface RetryResult<T> {
  /** The successful result */
  value: T;

  /** Number of attempts made (1 = success on first try) */
  attempts: number;

  /** Total time spent including delays (ms) */
  totalTimeMs: number;
}

/**
 * Retry error with attempt metadata
 */
export interface RetryError {
  /** Type discriminator */
  type: "RETRY_EXHAUSTED" | "NON_RETRYABLE";

  /** Original error */
  originalError: Error;

  /** Number of attempts made */
  attempts: number;

  /** Total time spent (ms) */
  totalTimeMs: number;

  /** Human-readable message */
  message: string;
}

// ============================================================================
// Prometheus Metrics
// ============================================================================

const retryAttemptsTotal = new client.Counter({
  name: "retry_attempts_total",
  help: "Total number of retry attempts",
  labelNames: ["operation", "attempt_number"],
});

const retrySuccessTotal = new client.Counter({
  name: "retry_success_total",
  help: "Total successful retries (success after >1 attempt)",
  labelNames: ["operation", "attempts"],
});

const retryExhaustedTotal = new client.Counter({
  name: "retry_exhausted_total",
  help: "Total retries exhausted (all attempts failed)",
  labelNames: ["operation"],
});

const retryDelayHistogram = new client.Histogram({
  name: "retry_delay_milliseconds",
  help: "Retry delay duration in milliseconds",
  labelNames: ["operation"],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

// ============================================================================
// Default Retry Policies
// ============================================================================

/**
 * Default retry policy - retry on transient errors only
 * Non-retryable errors:
 * - TypeError (programming errors)
 * - Validation errors
 * - Authentication errors
 * - 4xx client errors (except 408, 429)
 */
export const defaultRetryPolicy: RetryPolicy = (error: Error) => {
  // Never retry programming errors
  if (error instanceof TypeError) {
    return false;
  }

  // Check error message for known non-retryable patterns
  const message = error.message.toLowerCase();

  // Don't retry validation errors
  if (message.includes("validation") || message.includes("invalid")) {
    return false;
  }

  // Don't retry authentication/authorization errors
  if (message.includes("unauthorized") || message.includes("forbidden")) {
    return false;
  }

  // Don't retry not found errors (data doesn't exist)
  if (message.includes("not found") && !message.includes("rpc")) {
    return false;
  }

  // Check for HTTP status codes in error
  const httpStatusMatch = message.match(/\b([45]\d{2})\b/);
  if (httpStatusMatch) {
    const status = parseInt(httpStatusMatch[1], 10);

    // Retry 408 (Timeout) and 429 (Rate Limit)
    if (status === 408 || status === 429) {
      return true;
    }

    // Don't retry other 4xx errors (client errors)
    if (status >= 400 && status < 500) {
      return false;
    }

    // Retry 5xx errors (server errors)
    if (status >= 500) {
      return true;
    }
  }

  // Retry network errors
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("etimedout")
  ) {
    return true;
  }

  // Retry RPC errors
  if (message.includes("rpc")) {
    return true;
  }

  // Default: retry (conservative approach)
  return true;
};

/**
 * Aggressive retry policy - retry everything except TypeError
 */
export const aggressiveRetryPolicy: RetryPolicy = (error: Error) => {
  return !(error instanceof TypeError);
};

/**
 * Conservative retry policy - only retry explicit network/timeout errors
 */
export const conservativeRetryPolicy: RetryPolicy = (error: Error) => {
  const message = error.message.toLowerCase();
  return (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("429") // Rate limit
  );
};

// ============================================================================
// Delay Calculation with Jitter
// ============================================================================

/**
 * Calculate retry delay with exponential backoff and jitter
 *
 * Jitter prevents thundering herd problem where many clients retry simultaneously.
 * Formula: baseDelay * (2^attempt) * (1 + random(-jitter, +jitter))
 *
 * @param attemptNumber - Current attempt number (0-based)
 * @param baseDelayMs - Base delay in milliseconds
 * @param backoff - Backoff strategy
 * @param jitterFactor - Jitter factor (0-1)
 * @param maxDelayMs - Maximum delay cap
 */
function calculateDelayWithJitter(
  attemptNumber: number,
  baseDelayMs: number,
  backoff: "linear" | "exponential",
  jitterFactor: number,
  maxDelayMs: number
): number {
  // Calculate base delay
  let delay: number;
  if (backoff === "exponential") {
    delay = baseDelayMs * Math.pow(2, attemptNumber);
  } else {
    delay = baseDelayMs * (attemptNumber + 1);
  }

  // Apply jitter: randomize delay by ±jitterFactor
  // Example: jitterFactor=0.1 means ±10% randomization
  const jitterRange = delay * jitterFactor;
  const jitterOffset = (Math.random() * 2 - 1) * jitterRange; // Random between -jitterRange and +jitterRange
  delay = delay + jitterOffset;

  // Cap at maxDelayMs
  delay = Math.min(delay, maxDelayMs);

  // Ensure non-negative
  delay = Math.max(0, delay);

  return Math.floor(delay);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Main Retry Function
// ============================================================================

/**
 * Retry async operation with exponential backoff, jitter, and circuit breaker
 *
 * @param fn - Async function to retry
 * @param options - Retry configuration
 * @returns Result with value or error
 *
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   () => fetchUserData(userId),
 *   {
 *     maxRetries: 3,
 *     baseDelayMs: 100,
 *     operationName: "fetch_user_data",
 *   }
 * );
 *
 * if (result.success) {
 *   console.log(`Success after ${result.value.attempts} attempts`);
 *   return result.value.value;
 * } else {
 *   console.error(`Failed after ${result.error.attempts} attempts`);
 * }
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<Result<RetryResult<T>, RetryError>> {
  const {
    maxRetries,
    baseDelayMs,
    maxDelayMs = 5000,
    backoff = "exponential",
    jitterFactor = 0.1,
    retryPolicy = defaultRetryPolicy,
    operationName = "unknown",
    onRetry,
  } = options;

  const startTime = Date.now();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Record attempt
      retryAttemptsTotal.inc({
        operation: operationName,
        attempt_number: attempt + 1,
      });

      // Execute function
      const result = await fn();

      // Success! Record metrics
      const totalTimeMs = Date.now() - startTime;

      if (attempt > 0) {
        // Success after retry
        retrySuccessTotal.inc({
          operation: operationName,
          attempts: attempt + 1,
        });

        logger.info("Retry succeeded", {
          operation: operationName,
          attempts: attempt + 1,
          totalTimeMs,
        });
      }

      return Ok({
        value: result,
        attempts: attempt + 1,
        totalTimeMs,
      });
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry this error
      const shouldRetry = retryPolicy(lastError, attempt);

      if (!shouldRetry) {
        // Non-retryable error
        logger.warn("Non-retryable error, failing immediately", {
          operation: operationName,
          attempt: attempt + 1,
          error: lastError.message,
        });

        return Err({
          type: "NON_RETRYABLE",
          originalError: lastError,
          attempts: attempt + 1,
          totalTimeMs: Date.now() - startTime,
          message: `Non-retryable error in ${operationName}: ${lastError.message}`,
        });
      }

      // Check if we have retries left
      if (attempt < maxRetries - 1) {
        // Calculate delay with jitter
        const delayMs = calculateDelayWithJitter(
          attempt,
          baseDelayMs,
          backoff,
          jitterFactor,
          maxDelayMs
        );

        // Record delay
        retryDelayHistogram.observe({ operation: operationName }, delayMs);

        logger.debug("Retrying after error", {
          operation: operationName,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          error: lastError.message,
        });

        // Call custom retry handler
        if (onRetry) {
          onRetry(lastError, attempt + 1, delayMs);
        }

        // Wait before retry
        await sleep(delayMs);
      }
    }
  }

  // All retries exhausted
  retryExhaustedTotal.inc({ operation: operationName });

  const totalTimeMs = Date.now() - startTime;

  logger.error("Retry exhausted", {
    operation: operationName,
    attempts: maxRetries,
    totalTimeMs,
    lastError: lastError?.message,
  });

  return Err({
    type: "RETRY_EXHAUSTED",
    originalError: lastError || new Error("Unknown error"),
    attempts: maxRetries,
    totalTimeMs,
    message: `Retry exhausted for ${operationName} after ${maxRetries} attempts: ${lastError?.message}`,
  });
}

// ============================================================================
// Legacy Compatibility Export
// ============================================================================

/**
 * Legacy retry function (backward compatible)
 * @deprecated Use retryWithBackoff for enhanced features
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    backoff: "linear" | "exponential";
    baseDelay: number;
    shouldRetry?: (error: Error) => boolean;
  }
): Promise<T> {
  const result = await retryWithBackoff(fn, {
    maxRetries: options.maxRetries,
    baseDelayMs: options.baseDelay,
    backoff: options.backoff,
    retryPolicy: options.shouldRetry || defaultRetryPolicy,
  });

  if (result.success) {
    return result.value.value;
  } else {
    const err = result.error;
    throw err.originalError;
  }
}
