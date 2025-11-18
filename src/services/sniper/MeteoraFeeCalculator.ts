/**
 * Meteora Fee Calculator
 *
 * Calculates effective fees for Meteora DLMM pools with Anti-Sniper Suite.
 *
 * Components:
 * - Fee Scheduler: Time-based dynamic fees (99% → 1%)
 * - Rate Limiter: Size-based progressive fees (1% per SOL)
 * - Alpha Vault: Whitelist detection
 *
 * Performance Target: <1ms per calculation
 */

import type {
  MeteoraAntiSniperConfig,
  MeteoraEffectiveFees,
  MeteoraFeeScheduler,
  MeteoraRateLimiter,
} from "../../types/sniper.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Safety thresholds for sniping decisions
 */
const SAFETY_THRESHOLDS = {
  /** Maximum acceptable total fee (bps) */
  MAX_SAFE_FEE_BPS: 500, // 5%

  /** Maximum time to wait after launch (seconds) */
  MAX_WAIT_TIME: 300, // 5 minutes

  /** Minimum time to wait for fees to decay (seconds) */
  MIN_WAIT_TIME: 60, // 1 minute
} as const;

/**
 * Default Rate Limiter base fee (1% per SOL)
 */
const DEFAULT_RATE_LIMITER_BASE_FEE = 100; // bps

// ============================================================================
// Meteora Fee Calculator
// ============================================================================

/**
 * Calculator for Meteora DLMM anti-sniper fees (OPTIMIZED)
 */
export class MeteoraFeeCalculator {
  /**
   * Calculate effective fees for a Meteora pool at current time
   *
   * @param config - Anti-sniper configuration
   * @param amountSol - Buy amount in SOL
   * @param currentTime - Current UNIX timestamp (seconds)
   * @returns Calculated fees and safety assessment
   */
  static calculateFees(
    config: MeteoraAntiSniperConfig,
    amountSol: number,
    currentTime: number = Math.floor(Date.now() / 1000)
  ): MeteoraEffectiveFees {
    let feeSchedulerBps = 0;
    let rateLimiterBps = 0;
    let unsafeReason: string | undefined;

    // Calculate Fee Scheduler component
    if (config.hasFeeScheduler && config.feeScheduler) {
      feeSchedulerBps = this.calculateFeeSchedulerFee(
        config.feeScheduler,
        currentTime
      );
    }

    // Calculate Rate Limiter component
    if (config.hasRateLimiter && config.rateLimiter) {
      rateLimiterBps = this.calculateRateLimiterFee(
        config.rateLimiter,
        amountSol
      );
    }

    // Check Alpha Vault
    if (config.hasAlphaVault && config.alphaVault) {
      if (currentTime < config.alphaVault.endsAt) {
        unsafeReason = "Alpha Vault is active (whitelist only)";
      }
    }

    // Total fee
    const totalFeeBps = feeSchedulerBps + rateLimiterBps;
    const totalFeeDecimal = totalFeeBps / 10000;

    // Safety assessment
    const isSafeToSnipe = this.assessSafety(
      totalFeeBps,
      config,
      currentTime,
      unsafeReason
    );

    if (!isSafeToSnipe && !unsafeReason) {
      unsafeReason = this.getUnsafeReason(totalFeeBps, config, currentTime);
    }

    logger.debug("Meteora fees calculated", {
      feeSchedulerBps,
      rateLimiterBps,
      totalFeeBps,
      totalFeeDecimal,
      isSafeToSnipe,
      unsafeReason,
    });

    return {
      feeSchedulerBps,
      rateLimiterBps,
      totalFeeBps,
      totalFeeDecimal,
      isSafeToSnipe,
      unsafeReason,
    };
  }

  /**
   * Calculate Fee Scheduler component (OPTIMIZED)
   *
   * Formula:
   * currentFee = max(cliffFee - (elapsedPeriods * reductionFactor), baseFee)
   *
   * @param scheduler - Fee Scheduler config
   * @param currentTime - Current UNIX timestamp
   * @returns Fee in basis points
   */
  private static calculateFeeSchedulerFee(
    scheduler: MeteoraFeeScheduler,
    currentTime: number
  ): number {
    // Time since launch
    const timeSinceLaunch = currentTime - scheduler.launchTime;

    // If before launch, use cliff fee
    if (timeSinceLaunch < 0) {
      return scheduler.cliffFee;
    }

    // Calculate elapsed periods
    const elapsedPeriods = Math.floor(
      timeSinceLaunch / scheduler.periodFrequency
    );

    // Calculate current fee (with floor at base fee)
    const currentFee = Math.max(
      scheduler.cliffFee - elapsedPeriods * scheduler.feeReductionFactor,
      100 // Minimum 1% base fee
    );

    return currentFee;
  }

  /**
   * Calculate Rate Limiter component (OPTIMIZED)
   *
   * Formula:
   * fee = amountSol * baseFeePerSol
   *
   * Example: 10 SOL * 100 bps = 1000 bps (10%)
   *
   * @param rateLimiter - Rate Limiter config
   * @param amountSol - Buy amount in SOL
   * @returns Fee in basis points
   */
  private static calculateRateLimiterFee(
    rateLimiter: MeteoraRateLimiter,
    amountSol: number
  ): number {
    if (!rateLimiter.enabled) {
      return 0;
    }

    const baseFee = rateLimiter.baseFeePerSol || DEFAULT_RATE_LIMITER_BASE_FEE;

    // Linear scaling: 1 SOL = 1%, 10 SOL = 10%, etc.
    return Math.floor(amountSol * baseFee);
  }

  /**
   * Assess if pool is safe to snipe
   *
   * @param totalFeeBps - Total calculated fee
   * @param config - Anti-sniper config
   * @param currentTime - Current timestamp
   * @param existingReason - Existing unsafe reason
   * @returns True if safe to snipe
   */
  private static assessSafety(
    totalFeeBps: number,
    config: MeteoraAntiSniperConfig,
    currentTime: number,
    existingReason?: string
  ): boolean {
    // Already unsafe for other reasons
    if (existingReason) {
      return false;
    }

    // Check total fee threshold
    if (totalFeeBps > SAFETY_THRESHOLDS.MAX_SAFE_FEE_BPS) {
      return false;
    }

    // Check if too early (fees likely high)
    if (config.hasFeeScheduler && config.feeScheduler) {
      const timeSinceLaunch = currentTime - config.feeScheduler.launchTime;
      if (timeSinceLaunch < SAFETY_THRESHOLDS.MIN_WAIT_TIME) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get detailed unsafe reason
   *
   * @param totalFeeBps - Total fee
   * @param config - Anti-sniper config
   * @param currentTime - Current timestamp
   * @returns Unsafe reason string
   */
  private static getUnsafeReason(
    totalFeeBps: number,
    config: MeteoraAntiSniperConfig,
    currentTime: number
  ): string {
    if (totalFeeBps > SAFETY_THRESHOLDS.MAX_SAFE_FEE_BPS) {
      return `Excessive fees: ${(totalFeeBps / 100).toFixed(2)}% (max safe: ${SAFETY_THRESHOLDS.MAX_SAFE_FEE_BPS / 100}%)`;
    }

    if (config.feeScheduler) {
      const timeSinceLaunch = currentTime - config.feeScheduler.launchTime;
      if (timeSinceLaunch < SAFETY_THRESHOLDS.MIN_WAIT_TIME) {
        return `Too early: ${timeSinceLaunch}s since launch (min wait: ${SAFETY_THRESHOLDS.MIN_WAIT_TIME}s)`;
      }
    }

    return "Unknown safety issue";
  }

  /**
   * Calculate recommended wait time before sniping
   *
   * Returns seconds to wait for fees to decay to safe levels.
   *
   * @param config - Anti-sniper config
   * @param targetFeeBps - Target fee threshold (default: 500 = 5%)
   * @param currentTime - Current timestamp
   * @returns Seconds to wait (0 if already safe)
   */
  static calculateWaitTime(
    config: MeteoraAntiSniperConfig,
    targetFeeBps: number = SAFETY_THRESHOLDS.MAX_SAFE_FEE_BPS,
    currentTime: number = Math.floor(Date.now() / 1000)
  ): number {
    if (!config.hasFeeScheduler || !config.feeScheduler) {
      return 0; // No Fee Scheduler, safe immediately
    }

    const scheduler = config.feeScheduler;
    const timeSinceLaunch = currentTime - scheduler.launchTime;

    // Already past launch
    if (timeSinceLaunch >= 0) {
      // Calculate current fee
      const currentFee = this.calculateFeeSchedulerFee(scheduler, currentTime);

      // Already safe
      if (currentFee <= targetFeeBps) {
        return 0;
      }

      // Calculate periods needed to reach target
      const feeToReduce = currentFee - targetFeeBps;
      const periodsNeeded = Math.ceil(
        feeToReduce / scheduler.feeReductionFactor
      );

      // Account for time already passed
      const elapsedPeriods = Math.floor(
        timeSinceLaunch / scheduler.periodFrequency
      );
      const timeInCurrentPeriod =
        timeSinceLaunch - elapsedPeriods * scheduler.periodFrequency;
      const remainingInPeriod = scheduler.periodFrequency - timeInCurrentPeriod;

      return Math.max(0, remainingInPeriod + (periodsNeeded - elapsedPeriods - 1) * scheduler.periodFrequency);
    }

    // Before launch - wait for launch + target time
    return Math.abs(timeSinceLaunch) + SAFETY_THRESHOLDS.MIN_WAIT_TIME;
  }

  /**
   * Get safety thresholds (for configuration)
   */
  static getSafetyThresholds() {
    return { ...SAFETY_THRESHOLDS };
  }
}
