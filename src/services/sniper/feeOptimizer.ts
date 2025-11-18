/**
 * Priority Fee Optimizer
 *
 * Dynamically optimizes priority fees based on real-time network conditions.
 *
 * Features:
 * - Fetches recent prioritization fees from RPC
 * - Calculates fee percentiles (p50, p75, p90, p95)
 * - Adjusts fees based on network congestion
 * - Caches fee market data (10s TTL)
 * - Implements user max fee caps
 * - Boosts fees for hyped launches
 *
 * Performance Target: <100ms fee calculation (with caching)
 *
 * Usage:
 * ```typescript
 * const optimizer = getFeeOptimizer();
 * const result = await optimizer.optimizeFee({
 *   mode: "TURBO",
 *   maxFeeMicrolamports: 500_000,
 *   hypeBoost: 1.5,
 * });
 * ```
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { Result, Lamports } from "../../types/common.js";
import type { PriorityFeeMode } from "../../types/sniperOrder.js";
import { logger } from "../../utils/logger.js";
import { redis } from "../../utils/redis.js";
import { Ok, Err, asLamports } from "../../types/common.js";
import {
  recordFeeOptimization,
  updateNetworkCongestion,
  updateFeeMarketPercentiles,
} from "../../utils/metrics.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Fee market data from RPC analysis
 */
export interface FeeMarketData {
  /** Recent prioritization fees in microlamports */
  recentFees: number[];

  /** 50th percentile (median) */
  p50: number;

  /** 75th percentile */
  p75: number;

  /** 90th percentile */
  p90: number;

  /** 95th percentile */
  p95: number;

  /** Network congestion level (0-1, where 1 = max congestion) */
  congestionLevel: number;

  /** Timestamp when fetched */
  fetchedAt: Date;

  /** Number of samples analyzed */
  sampleCount: number;
}

/**
 * Parameters for fee optimization
 */
export interface FeeOptimizationParams {
  /** Priority mode requested by user */
  mode: PriorityFeeMode;

  /** Maximum fee user is willing to pay (microlamports) */
  maxFeeMicrolamports?: number;

  /** Boost multiplier for hyped launches (1.0 = no boost, 2.0 = 2x) */
  hypeBoost?: number;

  /** Account addresses to analyze fees for (optional, for DEX-specific data) */
  accountAddresses?: string[];
}

/**
 * Result of fee optimization
 */
export interface FeeOptimizationResult {
  /** Recommended compute unit price (microlamports per CU) */
  computeUnitPrice: number;

  /** Compute unit limit for transaction */
  computeUnitLimit: number;

  /** Priority mode used */
  mode: PriorityFeeMode;

  /** Total priority fee in lamports (computeUnitPrice * computeUnitLimit / 1M) */
  totalPriorityFeeLamports: Lamports;

  /** Market data used for calculation */
  marketData: FeeMarketData;

  /** Whether fee was capped by user max */
  wasCapped: boolean;

  /** Whether fee was boosted for hype */
  wasBoosted: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const CACHE_TTL_SECONDS = 10; // 10s cache for fee market data
const CACHE_KEY_PREFIX = "fee_market:";
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000; // 200k CU (sufficient for most swaps)
const MIN_SAMPLE_SIZE = 10; // Minimum samples for reliable analysis

// Congestion thresholds (microlamports)
const CONGESTION_THRESHOLD_P75 = 100_000; // If p75 > this, network is congested
const CONGESTION_THRESHOLD_P90 = 200_000; // If p90 > this, network is heavily congested

// Fee multipliers based on congestion level
const CONGESTION_MULTIPLIERS = {
  LOW: 1.0, // p75 < 100k
  MEDIUM: 1.5, // p75 >= 100k
  HIGH: 2.0, // p90 >= 200k
};

// ============================================================================
// Fee Optimizer Service
// ============================================================================

/**
 * Priority Fee Optimizer
 *
 * Analyzes real-time network conditions to calculate optimal priority fees.
 */
export class FeeOptimizer {
  constructor(private connection: Connection) {
    logger.info("FeeOptimizer initialized");
  }

  /**
   * Calculate optimal priority fee based on current network conditions
   *
   * @param params - Optimization parameters (mode, caps, boosts)
   * @returns Fee optimization result or error
   */
  async optimizeFee(
    params: FeeOptimizationParams
  ): Promise<Result<FeeOptimizationResult, string>> {
    try {
      const startTime = Date.now();

      // Fetch market data (cached)
      const marketDataResult = await this.getFeeMarketData(
        params.accountAddresses
      );
      if (!marketDataResult.success) {
        return Err(marketDataResult.error);
      }

      const marketData = marketDataResult.value;

      // Calculate base fee from market data
      const baseFee = this.calculateBaseFee(params.mode, marketData);

      // Apply congestion multiplier
      const congestionMultiplier = this.getCongestionMultiplier(marketData);
      let adjustedFee = Math.floor(baseFee * congestionMultiplier);

      // Apply hype boost if specified
      let wasBoosted = false;
      if (params.hypeBoost && params.hypeBoost > 1.0) {
        adjustedFee = Math.floor(adjustedFee * params.hypeBoost);
        wasBoosted = true;
      }

      // Apply user max fee cap
      let wasCapped = false;
      if (
        params.maxFeeMicrolamports &&
        adjustedFee > params.maxFeeMicrolamports
      ) {
        adjustedFee = params.maxFeeMicrolamports;
        wasCapped = true;
      }

      // Calculate total priority fee in lamports
      // Formula: (microlamports_per_CU * compute_units) / 1_000_000
      const totalPriorityFeeLamports = asLamports(
        BigInt(Math.floor((adjustedFee * DEFAULT_COMPUTE_UNIT_LIMIT) / 1_000_000))
      );

      const duration = Date.now() - startTime;

      // Record metrics
      recordFeeOptimization(duration, "success");
      updateNetworkCongestion(marketData.congestionLevel);
      updateFeeMarketPercentiles({
        p50: marketData.p50,
        p75: marketData.p75,
        p90: marketData.p90,
        p95: marketData.p95,
      });

      logger.debug("Fee optimization completed", {
        mode: params.mode,
        baseFee,
        adjustedFee,
        congestionMultiplier,
        wasCapped,
        wasBoosted,
        durationMs: duration,
      });

      return Ok({
        computeUnitPrice: adjustedFee,
        computeUnitLimit: DEFAULT_COMPUTE_UNIT_LIMIT,
        mode: params.mode,
        totalPriorityFeeLamports,
        marketData,
        wasCapped,
        wasBoosted,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Fee optimization failed", { error: errorMsg });
      recordFeeOptimization(0, "failure");
      return Err(errorMsg);
    }
  }

  /**
   * Fetch current fee market data (with caching)
   *
   * @param accountAddresses - Optional account addresses for DEX-specific data
   * @returns Fee market data or error
   */
  private async getFeeMarketData(
    accountAddresses?: string[]
  ): Promise<Result<FeeMarketData, string>> {
    try {
      const cacheKey = `${CACHE_KEY_PREFIX}${accountAddresses?.join(",") ?? "global"}`;

      // Try cache first
      const cached = await redis.get(cacheKey);
      if (cached) {
        const marketData = JSON.parse(cached) as FeeMarketData;
        marketData.fetchedAt = new Date(marketData.fetchedAt);

        logger.debug("Fee market data from cache", {
          p50: marketData.p50,
          p90: marketData.p90,
        });

        return Ok(marketData);
      }

      // Fetch from RPC
      const fetchResult =
        await this.fetchRecentPrioritizationFees(accountAddresses);
      if (!fetchResult.success) {
        return Err(fetchResult.error);
      }

      const marketData = fetchResult.value;

      // Cache for 10 seconds
      await redis.setex(
        cacheKey,
        CACHE_TTL_SECONDS,
        JSON.stringify(marketData)
      );

      logger.debug("Fee market data fetched", {
        p50: marketData.p50,
        p90: marketData.p90,
        samples: marketData.sampleCount,
      });

      return Ok(marketData);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to get fee market data", { error: errorMsg });
      return Err(errorMsg);
    }
  }

  /**
   * Fetch recent prioritization fees from Solana RPC
   *
   * Uses getRecentPrioritizationFees RPC method to analyze last 150 slots.
   *
   * @param accountAddresses - Optional addresses to filter by
   * @returns Fee market data or error
   */
  private async fetchRecentPrioritizationFees(
    accountAddresses?: string[]
  ): Promise<Result<FeeMarketData, string>> {
    try {
      // Convert string addresses to PublicKey if provided
      const pubkeys = accountAddresses?.map((addr) => new PublicKey(addr));

      // Get recent prioritization fees (last 150 slots by default)
      const fees = await this.connection.getRecentPrioritizationFees({
        lockedWritableAccounts: pubkeys,
      });

      if (!fees || fees.length < MIN_SAMPLE_SIZE) {
        return Err(
          `Insufficient fee samples: ${fees?.length ?? 0} < ${MIN_SAMPLE_SIZE}`
        );
      }

      // Extract prioritization fees (in microlamports)
      const feeValues = fees
        .map((f) => f.prioritizationFee)
        .filter((f) => f > 0); // Filter out zero fees

      if (feeValues.length < MIN_SAMPLE_SIZE) {
        return Err(
          `Insufficient non-zero fees: ${feeValues.length} < ${MIN_SAMPLE_SIZE}`
        );
      }

      // Sort for percentile calculation
      const sorted = feeValues.sort((a, b) => a - b);

      // Calculate percentiles
      const p50 = this.calculatePercentile(sorted, 50);
      const p75 = this.calculatePercentile(sorted, 75);
      const p90 = this.calculatePercentile(sorted, 90);
      const p95 = this.calculatePercentile(sorted, 95);

      // Calculate congestion level (0-1)
      const congestionLevel = this.calculateCongestionLevel(p75, p90);

      return Ok({
        recentFees: sorted,
        p50,
        p75,
        p90,
        p95,
        congestionLevel,
        fetchedAt: new Date(),
        sampleCount: sorted.length,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to fetch prioritization fees", { error: errorMsg });
      return Err(errorMsg);
    }
  }

  /**
   * Calculate percentile from sorted array
   *
   * @param sorted - Sorted array of numbers
   * @param percentile - Percentile to calculate (0-100)
   * @returns Percentile value
   */
  private calculatePercentile(sorted: number[], percentile: number): number {
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
  }

  /**
   * Calculate network congestion level
   *
   * @param p75 - 75th percentile fee
   * @param p90 - 90th percentile fee
   * @returns Congestion level (0 = no congestion, 1 = max congestion)
   */
  private calculateCongestionLevel(p75: number, p90: number): number {
    // If p90 >= 200k microlamports, heavily congested (1.0)
    if (p90 >= CONGESTION_THRESHOLD_P90) {
      return 1.0;
    }

    // If p75 >= 100k, moderately congested (0.5-0.8)
    if (p75 >= CONGESTION_THRESHOLD_P75) {
      const ratio = p75 / CONGESTION_THRESHOLD_P90;
      return Math.min(0.5 + ratio * 0.3, 0.8);
    }

    // Low congestion (0-0.5)
    const ratio = p75 / CONGESTION_THRESHOLD_P75;
    return Math.min(ratio * 0.5, 0.5);
  }

  /**
   * Calculate base fee from mode and market data
   *
   * Maps priority modes to market percentiles with minimum fallbacks.
   *
   * @param mode - Priority fee mode
   * @param market - Current market data
   * @returns Base fee in microlamports
   */
  private calculateBaseFee(
    mode: PriorityFeeMode,
    market: FeeMarketData
  ): number {
    switch (mode) {
      case "NONE":
        return 0;

      case "LOW":
        // Use p50 or minimum 10k
        return Math.max(market.p50, 10_000);

      case "MEDIUM":
        // Use p75 or minimum 50k
        return Math.max(market.p75, 50_000);

      case "HIGH":
        // Use p90 or minimum 200k
        return Math.max(market.p90, 200_000);

      case "TURBO":
        // Use p95 or minimum 500k
        return Math.max(market.p95, 500_000);

      case "ULTRA":
        // Use max(p95 * 1.5, 1M) for guaranteed priority
        return Math.max(market.p95 * 1.5, 1_000_000);

      default:
        logger.warn("Unknown priority fee mode, defaulting to MEDIUM", {
          mode,
        });
        return Math.max(market.p75, 50_000);
    }
  }

  /**
   * Get congestion multiplier based on network state
   *
   * @param market - Current market data
   * @returns Congestion multiplier (1.0-2.0)
   */
  private getCongestionMultiplier(market: FeeMarketData): number {
    if (market.p90 >= CONGESTION_THRESHOLD_P90) {
      return CONGESTION_MULTIPLIERS.HIGH;
    }
    if (market.p75 >= CONGESTION_THRESHOLD_P75) {
      return CONGESTION_MULTIPLIERS.MEDIUM;
    }
    return CONGESTION_MULTIPLIERS.LOW;
  }

  /**
   * Get current market statistics (for monitoring/debugging)
   *
   * @returns Current fee market data or error
   */
  async getMarketStats(): Promise<Result<FeeMarketData, string>> {
    return this.getFeeMarketData();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultFeeOptimizer: FeeOptimizer | null = null;

/**
 * Initialize default fee optimizer singleton
 *
 * @param connection - Solana RPC connection
 * @returns Fee optimizer instance
 */
export function initializeFeeOptimizer(
  connection: Connection
): FeeOptimizer {
  if (defaultFeeOptimizer) {
    logger.warn("FeeOptimizer already initialized, returning existing instance");
    return defaultFeeOptimizer;
  }

  defaultFeeOptimizer = new FeeOptimizer(connection);
  logger.info("Default FeeOptimizer initialized");

  return defaultFeeOptimizer;
}

/**
 * Get default fee optimizer instance
 *
 * @returns Fee optimizer instance
 * @throws Error if not initialized
 */
export function getFeeOptimizer(): FeeOptimizer {
  if (!defaultFeeOptimizer) {
    throw new Error(
      "FeeOptimizer not initialized. Call initializeFeeOptimizer() first."
    );
  }
  return defaultFeeOptimizer;
}
