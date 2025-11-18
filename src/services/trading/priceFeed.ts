/**
 * Price Feed Service
 * Fetches token prices from multiple sources with 2-tier caching and circuit breaker
 *
 * Features:
 * - 2-tier cache: In-memory LRU (1s TTL) → Redis (60s TTL) [SPRINT 2.3]
 * - DexScreener API integration (primary source)
 * - Jupiter price API fallback
 * - Circuit breaker pattern
 * - Rate limiting
 * - Prometheus metrics
 */

import { logger } from "../../utils/logger.js";
import { redis } from "../../utils/redis.js";
import {
  recordPriceFeedLatency,
  recordPriceFeedError,
  recordPriceCheck,
} from "../../utils/metrics.js";
import type { TokenMint } from "../../types/common.js";
import type { Result } from "../../types/common.js";
import {
  asTokenPrice,
  type PriceUpdate,
  type MonitorError,
} from "../../types/positionMonitor.js";
import { Ok, Err } from "../../types/common.js";
import { retryWithBackoff } from "../../utils/helpers.js";
import { LRUCache } from "lru-cache"; // SPRINT 2.3: 2-tier cache for price feed

// ============================================================================
// Constants
// ============================================================================

const DEXSCREENER_BASE_URL = "https://api.dexscreener.com/latest/dex";
const JUPITER_PRICE_API = "https://price.jup.ag/v4";

// Cache configuration
const PRICE_CACHE_PREFIX = "price:";
const DEFAULT_CACHE_TTL_MS = 60_000; // 1 minute
const MEMORY_CACHE_TTL_MS = 1_000; // 1 second (SPRINT 2.3: fast in-memory cache)
const MEMORY_CACHE_MAX_ENTRIES = 1_000; // Max 1000 tokens cached

// Rate limiting
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 300; // 300 req/min = 5 req/sec

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open circuit after 5 failures
const CIRCUIT_BREAKER_TIMEOUT_MS = 60_000; // Reset after 1 minute

// Request timeout
const REQUEST_TIMEOUT_MS = 5_000; // 5 seconds

// Retry configuration (exponential backoff: 100ms → 200ms → 400ms)
const RETRY_CONFIG_API = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 400,
  jitterFactor: 0.1,
};

// ============================================================================
// Circuit Breaker State
// ============================================================================

interface CircuitState {
  status: "CLOSED" | "HALF_OPEN" | "OPEN";
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
}

// ============================================================================
// Rate Limiter State
// ============================================================================

interface RateLimitState {
  requests: number[];
  windowStart: number;
}

// ============================================================================
// DexScreener Response Types
// ============================================================================

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string; // Price in SOL
  priceUsd?: string;
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  volume?: {
    h24: number;
  };
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

// ============================================================================
// Jupiter Price Response Types
// ============================================================================

interface JupiterPriceResponse {
  data: Record<string, { id: string; type: string; price: string }>;
  timeTaken: number;
}

// ============================================================================
// PriceFeedService Class
// ============================================================================

export class PriceFeedService {
  private circuitState: CircuitState = {
    status: "CLOSED",
    failureCount: 0,
    lastFailureTime: 0,
    successCount: 0,
  };

  private rateLimitState: RateLimitState = {
    requests: [],
    windowStart: Date.now(),
  };

  // SPRINT 2.3: In-memory LRU cache (1s TTL, 1000 max entries)
  // Provides ultra-fast cache hits before falling back to Redis
  private memoryCache: LRUCache<TokenMint, PriceUpdate>;

  private cacheTtlMs: number;

  constructor(cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
    this.cacheTtlMs = cacheTtlMs;

    // SPRINT 2.3: Initialize in-memory LRU cache
    this.memoryCache = new LRUCache<TokenMint, PriceUpdate>({
      max: MEMORY_CACHE_MAX_ENTRIES,
      ttl: MEMORY_CACHE_TTL_MS,
    });

    logger.info("PriceFeedService initialized", {
      cacheTtlMs,
      memoryCacheTtlMs: MEMORY_CACHE_TTL_MS,
      memoryCacheMaxEntries: MEMORY_CACHE_MAX_ENTRIES,
      circuitBreakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
      rateLimit: `${MAX_REQUESTS_PER_WINDOW} req/${RATE_LIMIT_WINDOW_MS}ms`,
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get token price with 2-tier caching and fallback chain
   * Memory Cache (1s) → Redis Cache (60s) → DexScreener → Jupiter → Error
   */
  async getPrice(
    tokenMint: TokenMint,
    forceRefresh: boolean = false
  ): Promise<Result<PriceUpdate, MonitorError>> {
    // SPRINT 2.3: 1. Check in-memory LRU cache first (ultra-fast, 1s TTL)
    if (!forceRefresh) {
      const memoryCached = this.memoryCache.get(tokenMint);
      if (memoryCached) {
        recordPriceCheck("memory_cache_hit");
        logger.debug("Memory cache hit", { tokenMint, price: memoryCached.price });
        return Ok(memoryCached);
      }
    }

    // SPRINT 2.3: 2. Check Redis cache (fast, 60s TTL)
    if (!forceRefresh) {
      const redisCached = await this.getCachedPrice(tokenMint);
      if (redisCached.success) {
        // Populate memory cache for next time
        this.memoryCache.set(tokenMint, redisCached.value);
        recordPriceCheck("redis_cache_hit");
        logger.debug("Redis cache hit, populated memory cache", {
          tokenMint,
          price: redisCached.value.price,
        });
        return redisCached;
      }
    }

    // 3. Check circuit breaker
    if (this.circuitState.status === "OPEN") {
      const timeSinceFailure = Date.now() - this.circuitState.lastFailureTime;
      if (timeSinceFailure < CIRCUIT_BREAKER_TIMEOUT_MS) {
        const resetAt = new Date(
          this.circuitState.lastFailureTime + CIRCUIT_BREAKER_TIMEOUT_MS
        );
        return Err({
          type: "CIRCUIT_OPEN",
          reason: "Price feed circuit breaker is open",
          resetAt,
        });
      }
      // Timeout elapsed, try half-open
      this.circuitState.status = "HALF_OPEN";
      this.circuitState.successCount = 0;
      logger.info("Circuit breaker transitioning to HALF_OPEN");
    }

    // 4. Check rate limit
    if (!this.checkRateLimit()) {
      recordPriceFeedError("rate_limiter", "rate_limit_exceeded");
      return Err({
        type: "PRICE_FETCH_FAILED",
        tokenMint,
        reason: "Rate limit exceeded",
        attemptsExhausted: false,
      });
    }

    // 5. Try DexScreener first
    const dexScreenerResult = await this.fetchFromDexScreener(tokenMint);
    if (dexScreenerResult.success) {
      this.recordSuccess();
      // SPRINT 2.3: Cache in BOTH Redis (60s) AND memory (1s)
      await this.setCachedPrice(tokenMint, dexScreenerResult.value);
      this.memoryCache.set(tokenMint, dexScreenerResult.value);
      recordPriceCheck("success");
      return Ok(dexScreenerResult.value);
    }

    // DexScreener failed - TypeScript doesn't narrow after early return, so assert
    const dexScreenerError = (
      dexScreenerResult as Extract<typeof dexScreenerResult, { success: false }>
    ).error;
    logger.warn("DexScreener fetch failed, trying Jupiter fallback", {
      tokenMint,
      error: dexScreenerError,
    });

    // 6. Fallback to Jupiter
    const jupiterResult = await this.fetchFromJupiter(tokenMint);
    if (jupiterResult.success) {
      this.recordSuccess();
      // SPRINT 2.3: Cache in BOTH Redis (60s) AND memory (1s)
      await this.setCachedPrice(tokenMint, jupiterResult.value);
      this.memoryCache.set(tokenMint, jupiterResult.value);
      recordPriceCheck("success");
      return Ok(jupiterResult.value);
    }

    // 7. All sources failed
    this.recordFailure();
    recordPriceCheck("api_failure");

    return Err({
      type: "PRICE_FETCH_FAILED",
      tokenMint,
      reason: "All price sources failed",
      attemptsExhausted: true,
    });
  }

  /**
   * Invalidate cached price for a token (both memory and Redis)
   */
  async invalidateCache(tokenMint: TokenMint): Promise<void> {
    // SPRINT 2.3: Invalidate BOTH memory AND Redis cache
    this.memoryCache.delete(tokenMint);

    const cacheKey = `${PRICE_CACHE_PREFIX}${tokenMint}`;
    try {
      await redis.del(cacheKey);
      logger.debug("Price cache invalidated (memory + Redis)", { tokenMint });
    } catch (error) {
      logger.error("Failed to invalidate Redis price cache", {
        tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get current circuit breaker status
   */
  getCircuitStatus(): CircuitState {
    return { ...this.circuitState };
  }

  // ==========================================================================
  // Private Methods - Caching
  // ==========================================================================

  private async getCachedPrice(
    tokenMint: TokenMint
  ): Promise<Result<PriceUpdate, MonitorError>> {
    const cacheKey = `${PRICE_CACHE_PREFIX}${tokenMint}`;
    try {
      const cached = await redis.get(cacheKey);
      if (!cached) {
        return Err({
          type: "PRICE_FETCH_FAILED",
          tokenMint,
          reason: "Cache miss",
          attemptsExhausted: false,
        });
      }

      const parsed = JSON.parse(cached) as {
        price: number;
        timestamp: string;
        source: string;
      };

      const priceUpdate: PriceUpdate = {
        tokenMint,
        price: asTokenPrice(parsed.price),
        timestamp: new Date(parsed.timestamp),
        source: "cache",
      };

      logger.debug("Price cache hit", { tokenMint, price: parsed.price });

      return Ok(priceUpdate);
    } catch (error) {
      logger.error("Failed to get cached price", {
        tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err({
        type: "PRICE_FETCH_FAILED",
        tokenMint,
        reason: "Cache read error",
        attemptsExhausted: false,
      });
    }
  }

  private async setCachedPrice(
    tokenMint: TokenMint,
    priceUpdate: PriceUpdate
  ): Promise<void> {
    const cacheKey = `${PRICE_CACHE_PREFIX}${tokenMint}`;
    try {
      const cacheData = {
        price: priceUpdate.price,
        timestamp: priceUpdate.timestamp.toISOString(),
        source: priceUpdate.source,
      };

      const ttlSeconds = Math.floor(this.cacheTtlMs / 1000);
      await redis.setex(cacheKey, ttlSeconds, JSON.stringify(cacheData));

      logger.debug("Price cached", {
        tokenMint,
        price: priceUpdate.price,
        ttlSeconds,
      });
    } catch (error) {
      logger.error("Failed to cache price", {
        tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // Private Methods - Price Fetching
  // ==========================================================================

  /**
   * Fetch price from DexScreener API with retry logic
   * Returns SOL price per token
   */
  private async fetchFromDexScreener(
    tokenMint: TokenMint
  ): Promise<Result<PriceUpdate, string>> {
    const startTime = Date.now();
    const url = `${DEXSCREENER_BASE_URL}/tokens/${tokenMint}`;

    // Wrap API call with retry logic
    const retryResult = await retryWithBackoff(
      async () => {
        logger.debug("Fetching price from DexScreener", { tokenMint, url });

        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS
        );

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "BoltSniperBot/1.0",
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as DexScreenerResponse;

        // Find pair with SOL as quote token
        const solPair = data.pairs?.find(
          (pair) =>
            pair.quoteToken.symbol === "SOL" ||
            pair.quoteToken.symbol === "WSOL"
        );

        if (!solPair || !solPair.priceNative) {
          throw new Error("No SOL pair found");
        }

        const price = parseFloat(solPair.priceNative);
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error(`Invalid price: ${price}`);
        }

        const priceUpdate: PriceUpdate = {
          tokenMint,
          price: asTokenPrice(price),
          timestamp: new Date(),
          source: "dexscreener",
          confidence: 1.0, // High confidence from DexScreener
        };

        return priceUpdate;
      },
      {
        ...RETRY_CONFIG_API,
        operationName: "dexscreener_fetch_price",
        onRetry: (error, attempt, delayMs) => {
          logger.warn("Retrying DexScreener fetch", {
            tokenMint,
            attempt,
            delayMs,
            error: error.message,
          });
        },
      }
    );

    // Handle retry result
    if (!retryResult.success) {
      const errorMsg = String(retryResult.error.originalError.message);
      recordPriceFeedError("dexscreener", errorMsg);
      recordPriceFeedLatency("dexscreener", Date.now() - startTime);

      logger.error("DexScreener fetch failed after retries", {
        tokenMint,
        attempts: retryResult.error.attempts,
        error: errorMsg,
        latencyMs: Date.now() - startTime,
      });

      return Err(errorMsg);
    }

    // Success
    recordPriceFeedLatency("dexscreener", Date.now() - startTime);

    logger.debug("DexScreener price fetched", {
      tokenMint,
      price: retryResult.value.value.price,
      attempts: retryResult.value.attempts,
      latencyMs: Date.now() - startTime,
    });

    return Ok(retryResult.value.value);
  }

  /**
   * Fetch price from Jupiter Price API with retry logic
   * Returns SOL price per token
   */
  private async fetchFromJupiter(
    tokenMint: TokenMint
  ): Promise<Result<PriceUpdate, string>> {
    const startTime = Date.now();
    const url = `${JUPITER_PRICE_API}/price?ids=${tokenMint}`;

    // Wrap API call with retry logic
    const retryResult = await retryWithBackoff(
      async () => {
        logger.debug("Fetching price from Jupiter", { tokenMint, url });

        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS
        );

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "BoltSniperBot/1.0",
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as JupiterPriceResponse;

        const priceData = data.data[tokenMint];
        if (!priceData || !priceData.price) {
          throw new Error("Price not found in Jupiter response");
        }

        const price = parseFloat(priceData.price);
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error(`Invalid price: ${price}`);
        }

        const priceUpdate: PriceUpdate = {
          tokenMint,
          price: asTokenPrice(price),
          timestamp: new Date(),
          source: "jupiter",
          confidence: 0.9, // Slightly lower confidence than DexScreener
        };

        return priceUpdate;
      },
      {
        ...RETRY_CONFIG_API,
        operationName: "jupiter_fetch_price",
        onRetry: (error, attempt, delayMs) => {
          logger.warn("Retrying Jupiter fetch", {
            tokenMint,
            attempt,
            delayMs,
            error: error.message,
          });
        },
      }
    );

    // Handle retry result
    if (!retryResult.success) {
      const errorMsg = String(retryResult.error.originalError.message);
      recordPriceFeedError("jupiter", errorMsg);
      recordPriceFeedLatency("jupiter", Date.now() - startTime);

      logger.error("Jupiter fetch failed after retries", {
        tokenMint,
        attempts: retryResult.error.attempts,
        error: errorMsg,
        latencyMs: Date.now() - startTime,
      });

      return Err(errorMsg);
    }

    // Success
    recordPriceFeedLatency("jupiter", Date.now() - startTime);

    logger.debug("Jupiter price fetched", {
      tokenMint,
      price: retryResult.value.value.price,
      attempts: retryResult.value.attempts,
      latencyMs: Date.now() - startTime,
    });

    return Ok(retryResult.value.value);
  }

  // ==========================================================================
  // Private Methods - Circuit Breaker
  // ==========================================================================

  private recordSuccess(): void {
    if (this.circuitState.status === "HALF_OPEN") {
      this.circuitState.successCount++;
      if (this.circuitState.successCount >= 2) {
        // After 2 successes in HALF_OPEN, close circuit
        this.circuitState.status = "CLOSED";
        this.circuitState.failureCount = 0;
        logger.info("Circuit breaker closed after successful requests");
      }
    } else if (this.circuitState.status === "CLOSED") {
      // Reset failure count on success
      this.circuitState.failureCount = 0;
    }
  }

  private recordFailure(): void {
    this.circuitState.failureCount++;
    this.circuitState.lastFailureTime = Date.now();

    if (
      this.circuitState.status === "CLOSED" &&
      this.circuitState.failureCount >= CIRCUIT_BREAKER_THRESHOLD
    ) {
      this.circuitState.status = "OPEN";
      logger.error("Circuit breaker opened due to repeated failures", {
        failureCount: this.circuitState.failureCount,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
      });
    } else if (this.circuitState.status === "HALF_OPEN") {
      // Failure in HALF_OPEN, reopen circuit
      this.circuitState.status = "OPEN";
      logger.warn("Circuit breaker reopened after failure in HALF_OPEN");
    }
  }

  // ==========================================================================
  // Private Methods - Rate Limiting
  // ==========================================================================

  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = this.rateLimitState.windowStart;

    // Reset window if expired
    if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.rateLimitState.requests = [];
      this.rateLimitState.windowStart = now;
    }

    // Remove expired requests from current window
    this.rateLimitState.requests = this.rateLimitState.requests.filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
    );

    // Check if limit exceeded
    if (this.rateLimitState.requests.length >= MAX_REQUESTS_PER_WINDOW) {
      logger.warn("Rate limit exceeded", {
        requests: this.rateLimitState.requests.length,
        limit: MAX_REQUESTS_PER_WINDOW,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });
      return false;
    }

    // Record this request
    this.rateLimitState.requests.push(now);
    return true;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let priceFeedServiceInstance: PriceFeedService | null = null;

/**
 * Get singleton PriceFeedService instance
 */
export function getPriceFeedService(
  cacheTtlMs?: number
): PriceFeedService {
  if (!priceFeedServiceInstance) {
    priceFeedServiceInstance = new PriceFeedService(cacheTtlMs);
  }
  return priceFeedServiceInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetPriceFeedService(): void {
  priceFeedServiceInstance = null;
}
