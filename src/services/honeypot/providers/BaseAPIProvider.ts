/**
 * Base API Provider Abstract Class
 *
 * Implements common functionality for all honeypot detection API providers:
 * - Circuit breaker pattern
 * - Retry logic with exponential backoff
 * - Metrics tracking
 * - Logging
 *
 * Each provider (GoPlus, RugCheck, TokenSniffer) extends this class.
 */

import axios, { type AxiosInstance, type AxiosError } from "axios";
import { CircuitBreaker } from "../circuitBreaker.js";
import { logger } from "../../../utils/logger.js";
import {
  recordHoneypotApiRequest,
  setCircuitBreakerState,
  recordCircuitBreakerTransition,
} from "../../../utils/metrics.js";
import type {
  APIProvider,
  APIProviderConfig,
  APILayerResult,
  CircuitBreakerMetrics,
  HoneypotFlag,
  HoneypotProviderName,
} from "../../../types/honeypot.js";

// ============================================================================
// Base API Provider
// ============================================================================

export abstract class BaseAPIProvider implements APIProvider {
  protected readonly axiosClient: AxiosInstance;
  protected readonly circuitBreaker: CircuitBreaker;
  protected requestCount = 0;
  protected lastReset = Date.now();

  constructor(
    public readonly name: HoneypotProviderName,
    public readonly priority: number,
    protected readonly config: APIProviderConfig
  ) {
    // Initialize axios client
    this.axiosClient = axios.create({
      timeout: config.timeout,
      headers: {
        Accept: "application/json",
        "User-Agent": "BoltSniperBot/1.0",
      },
    });

    // Add retry interceptor with exponential backoff
    this.axiosClient.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const requestConfig = error.config as any;

        if (!requestConfig || !requestConfig.retry) {
          requestConfig.retry = 0;
        }

        // Max 3 retries
        if (requestConfig.retry >= 3) {
          return Promise.reject(error);
        }

        requestConfig.retry += 1;

        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, requestConfig.retry - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));

        logger.debug("Retrying API request", {
          provider: this.name,
          url: requestConfig.url,
          attempt: requestConfig.retry,
          delay,
        });

        return this.axiosClient(requestConfig);
      }
    );

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker(
      `${name}-api`,
      config.circuitBreaker
    );

    // Track circuit breaker state changes
    this.setupCircuitBreakerMonitoring();

    logger.info("API provider initialized", {
      provider: this.name,
      priority: this.priority,
      enabled: this.config.enabled,
      timeout: this.config.timeout,
    });
  }

  /**
   * Check if provider is available (circuit breaker not OPEN)
   */
  isAvailable(): boolean {
    if (!this.config.enabled) {
      return false;
    }

    return this.circuitBreaker.isAvailable();
  }

  /**
   * Perform honeypot check (with circuit breaker protection)
   */
  async check(tokenMint: string): Promise<APILayerResult | null> {
    if (!this.isAvailable()) {
      const metrics = this.getMetrics();
      logger.debug("Provider unavailable", {
        provider: this.name,
        state: metrics.state,
        nextAttempt: metrics.nextAttemptTime,
      });

      recordHoneypotApiRequest(this.name, "circuit_open", 0);
      return null;
    }

    const startTime = Date.now();

    try {
      // Execute with circuit breaker
      const result = await this.circuitBreaker.execute(async () => {
        // Rate limiting
        await this.rateLimit();

        // Provider-specific implementation
        return await this.performCheck(tokenMint);
      });

      if (result === null) {
        // Circuit breaker rejected request
        recordHoneypotApiRequest(this.name, "circuit_open", 0);
        return null;
      }

      const duration = Date.now() - startTime;
      recordHoneypotApiRequest(this.name, "success", duration);

      logger.debug("API check successful", {
        provider: this.name,
        tokenMint: tokenMint.slice(0, 8),
        score: result.score,
        flags: result.flags,
        timeMs: duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Determine error type
      let status: "failure" | "timeout" = "failure";
      if (axios.isAxiosError(error)) {
        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
          status = "timeout";
        }
      }

      recordHoneypotApiRequest(this.name, status, duration);

      logger.error("API check failed", {
        provider: this.name,
        tokenMint: tokenMint.slice(0, 8),
        error,
        timeMs: duration,
      });

      return null;
    }
  }

  /**
   * Get circuit breaker metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return this.circuitBreaker.getMetrics();
  }

  /**
   * Reset circuit breaker (for testing/admin)
   */
  reset(): void {
    this.circuitBreaker.reset();
  }

  // ==========================================================================
  // Abstract Methods (Provider-Specific)
  // ==========================================================================

  /**
   * Provider-specific implementation of honeypot check
   * Must be implemented by each provider
   */
  protected abstract performCheck(tokenMint: string): Promise<APILayerResult>;

  /**
   * Parse provider response into standardized format
   */
  protected abstract parseResponse(
    data: unknown,
    tokenMint: string
  ): {
    score: number;
    flags: HoneypotFlag[];
    data: Record<string, unknown>;
  };

  // ==========================================================================
  // Protected Helper Methods
  // ==========================================================================

  /**
   * Rate limiting implementation
   * Default: 60 requests per minute (can be overridden)
   */
  protected async rateLimit(): Promise<void> {
    const maxRequestsPerMinute = this.getRateLimit();
    const now = Date.now();
    const elapsed = now - this.lastReset;

    // Reset counter every minute
    if (elapsed >= 60000) {
      this.requestCount = 0;
      this.lastReset = now;
      return;
    }

    // Check limit
    if (this.requestCount >= maxRequestsPerMinute) {
      const waitTime = 60000 - elapsed;
      logger.warn("Rate limit reached, waiting", {
        provider: this.name,
        waitMs: waitTime,
      });
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.requestCount = 0;
      this.lastReset = Date.now();
    }

    this.requestCount++;
  }

  /**
   * Get rate limit for provider (requests per minute)
   * Override in subclass if different limit needed
   */
  protected getRateLimit(): number {
    return 60; // Default: 60 req/min
  }

  /**
   * Setup circuit breaker monitoring (track state changes)
   */
  private setupCircuitBreakerMonitoring(): void {
    // Initial state
    const initialMetrics = this.circuitBreaker.getMetrics();
    setCircuitBreakerState(this.name, initialMetrics.state);

    // Poll for state changes (every 5 seconds)
    let lastState = initialMetrics.state;

    setInterval(() => {
      const metrics = this.circuitBreaker.getMetrics();
      if (metrics.state !== lastState) {
        recordCircuitBreakerTransition(this.name, lastState, metrics.state);
        setCircuitBreakerState(this.name, metrics.state);

        logger.info("Circuit breaker state changed", {
          provider: this.name,
          from: lastState,
          to: metrics.state,
        });

        lastState = metrics.state;
      }
    }, 5000);
  }
}
