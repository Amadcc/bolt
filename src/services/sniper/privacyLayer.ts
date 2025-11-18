/**
 * Privacy Layer Service
 *
 * Protects against copy-trading and MEV attacks by:
 * - Adding timing randomization
 * - Varying priority fee patterns
 * - Rotating wallets
 * - Forcing Jito routing (private mempool)
 * - Obfuscating transaction patterns
 *
 * @see src/types/copyTradeProtection.ts for type definitions
 */

import { logger } from "../../utils/logger.js";
import { Err, Ok, type Result } from "../../types/common.js";
import type { WalletRotator } from "../wallet/walletRotator.js";
import type { FeeOptimizer } from "./feeOptimizer.js";
import { metrics } from "../../utils/metrics.js";
import crypto from "crypto";

import type {
  PrivacySettings,
  PrivacyLayerResult,
  PrivacyLayerError,
  PrivacyLayerOperationResult,
  PrivacyLayerState,
  RandomizedDelay,
  TimingConfig,
  PrivacySettingsValidation,
  PrivacyScore,
} from "../../types/copyTradeProtection.js";
import {
  asDelayMs,
  asPrivacyScore,
  PRIVACY_PRESETS,
  type PrivacyMode,
  type FeePatternStrategy,
  type PrivacyWalletStrategy,
  type ObfuscationPattern,
} from "../../types/copyTradeProtection.js";
import type { PriorityFeeMode } from "../../types/sniperOrder.js";
import type { WalletId } from "../../types/walletRotation.js";

// ============================================================================
// Privacy Layer Service
// ============================================================================

export class PrivacyLayer {
  private readonly walletRotator: WalletRotator;
  private readonly feeOptimizer: FeeOptimizer;
  private readonly state: Map<string, PrivacyLayerState>;

  constructor(walletRotator: WalletRotator, feeOptimizer: FeeOptimizer) {
    this.walletRotator = walletRotator;
    this.feeOptimizer = feeOptimizer;
    this.state = new Map();

    logger.info("PrivacyLayer initialized", {
      component: "PrivacyLayer",
    });
  }

  // ==========================================================================
  // Main Entry Point
  // ==========================================================================

  /**
   * Apply privacy layer to a sniper operation
   * Returns configuration for private, copy-trade-resistant execution
   */
  async applyPrivacyLayer(
    userId: string,
    settings: PrivacySettings
  ): Promise<PrivacyLayerOperationResult> {
    const startTime = Date.now();

    try {
      // Validate settings
      const validation = this.validateSettings(settings);
      if (!validation.valid) {
        logger.warn("Invalid privacy settings", {
          userId: this.redactUserId(userId),
          errors: validation.errors,
        });
        return Err({
          type: "INVALID_SETTINGS",
          message: validation.errors.join(", "),
        });
      }

      // Get or create state for this user
      const state = this.getOrCreateState(userId, settings);

      // Calculate randomized delay
      const delayResult = this.calculateRandomizedDelay(settings.timing);
      if (!delayResult.success) {
        return Err(delayResult.error);
      }

      // Select priority fee mode
      const feeModeResult = await this.selectPriorityFeeMode(
        userId,
        settings.feePattern,
        state
      );
      if (!feeModeResult.success) {
        return Err(feeModeResult.error);
      }

      // Select wallet
      const walletResult = await this.selectWallet(
        userId,
        settings.walletRotation,
        state
      );
      if (!walletResult.success) {
        return Err(walletResult.error);
      }

      // Calculate Jito tip
      const jitoTipResult = this.calculateJitoTip(settings.jito);
      if (!jitoTipResult.success) {
        return Err(jitoTipResult.error);
      }

      // Generate obfuscation
      const obfuscationResult = this.generateObfuscation(settings.obfuscation);
      if (!obfuscationResult.success) {
        return Err(obfuscationResult.error);
      }

      // Calculate privacy score
      const privacyScore = this.calculatePrivacyScore(
        settings,
        delayResult.value,
        feeModeResult.value,
        obfuscationResult.value.appliedPatterns
      );

      // Build result
      const result: PrivacyLayerResult = {
        delayBeforeExecution: delayResult.value,
        priorityFeeMode: feeModeResult.value,
        walletId: walletResult.value,
        useJito: settings.jito.forceJitoRouting,
        jitoTipLamports: jitoTipResult.value,
        memo: obfuscationResult.value.memo,
        privacyScore,
        appliedObfuscation: obfuscationResult.value.appliedPatterns,
      };

      // Update state
      state.lastFeeMode = feeModeResult.value;
      state.lastWalletId = walletResult.value;
      state.tradesSinceLastRotation++;
      state.privacyScore = privacyScore;
      this.state.set(userId, state);

      // Metrics
      const duration = Date.now() - startTime;
      metrics.privacyLayerDuration.observe(duration);
      metrics.privacyScore.set({ userId: this.redactUserId(userId) }, Number(privacyScore));
      metrics.privacyLayerApplied.inc({
        mode: settings.mode,
        userId: this.redactUserId(userId),
      });

      logger.info("Privacy layer applied", {
        userId: this.redactUserId(userId),
        mode: settings.mode,
        privacyScore,
        delayMs: result.delayBeforeExecution.delayMs,
        useJito: result.useJito,
        duration,
      });

      return Ok(result);
    } catch (error) {
      logger.error("Privacy layer application failed", {
        userId: this.redactUserId(userId),
        error,
      });
      return Err({
        type: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // Timing Randomization
  // ==========================================================================

  /**
   * Calculate randomized delay with jitter
   */
  private calculateRandomizedDelay(
    config: TimingConfig
  ): Result<RandomizedDelay, PrivacyLayerError> {
    try {
      if (!config.enabled) {
        return Ok({
          delayMs: asDelayMs(0),
          jitterMs: 0,
          baseDelayMs: asDelayMs(0),
        });
      }

      // Calculate jitter: ±jitterPercent of baseDelay
      const maxJitter = (config.baseDelayMs * config.jitterPercent) / 100;
      const jitterMs = (Math.random() * 2 - 1) * maxJitter; // Random between -maxJitter and +maxJitter

      // Apply jitter
      let delayMs = config.baseDelayMs + jitterMs;

      // Clamp to min/max
      delayMs = Math.max(config.minDelayMs, Math.min(config.maxDelayMs, delayMs));

      const result: RandomizedDelay = {
        delayMs: asDelayMs(Math.floor(delayMs)),
        jitterMs: Math.floor(jitterMs),
        baseDelayMs: config.baseDelayMs,
      };

      logger.debug("Calculated randomized delay", {
        baseDelay: config.baseDelayMs,
        jitter: result.jitterMs,
        finalDelay: result.delayMs,
      });

      return Ok(result);
    } catch (error) {
      return Err({
        type: "TIMING_CALCULATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // Priority Fee Pattern Selection
  // ==========================================================================

  /**
   * Select priority fee mode based on pattern strategy
   */
  private async selectPriorityFeeMode(
    userId: string,
    config: typeof PRIVACY_PRESETS.OFF.feePattern,
    state: PrivacyLayerState
  ): Promise<Result<PriorityFeeMode, PrivacyLayerError>> {
    try {
      let selectedMode: PriorityFeeMode;

      switch (config.strategy) {
        case "FIXED":
          // Always use first allowed mode
          selectedMode = config.allowedModes[0];
          break;

        case "RANDOM":
          // Random mode from allowed list
          selectedMode =
            config.allowedModes[
              Math.floor(Math.random() * config.allowedModes.length)
            ];
          break;

        case "GRADUAL_INCREASE":
          // Start with lowest, gradually increase
          const tradeIndex = state.tradesSinceLastRotation % config.allowedModes.length;
          selectedMode = config.allowedModes[tradeIndex];
          break;

        case "SPIKE_PATTERN":
          // 80% normal, 20% high spike
          const useSpike = Math.random() < 0.2;
          selectedMode = useSpike
            ? config.allowedModes[config.allowedModes.length - 1] // Highest
            : config.allowedModes[0]; // Lowest
          break;

        case "ADAPTIVE":
          // Use FeeOptimizer to get optimal mode
          const feeData = await this.feeOptimizer.optimizeFee({
            mode: "MEDIUM",
          });
          if (!feeData.success) {
            // Fallback to MEDIUM
            selectedMode = "MEDIUM";
          } else {
            // Map fee amount to mode
            const feeAmount = feeData.value.computeUnitPrice;
            selectedMode = this.mapFeeAmountToMode(feeAmount);
          }
          break;

        default:
          selectedMode = "MEDIUM";
      }

      logger.debug("Selected priority fee mode", {
        userId: this.redactUserId(userId),
        strategy: config.strategy,
        selectedMode,
        lastMode: state.lastFeeMode,
      });

      return Ok(selectedMode);
    } catch (error) {
      return Err({
        type: "FEE_PATTERN_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Map fee amount (microlamports) to priority fee mode
   */
  private mapFeeAmountToMode(feeAmount: number): PriorityFeeMode {
    if (feeAmount === 0) return "NONE";
    if (feeAmount <= 50000) return "LOW";
    if (feeAmount <= 100000) return "MEDIUM";
    if (feeAmount <= 500000) return "HIGH";
    if (feeAmount <= 800000) return "TURBO";
    return "ULTRA";
  }

  // ==========================================================================
  // Wallet Selection
  // ==========================================================================

  /**
   * Select wallet based on privacy strategy
   */
  private async selectWallet(
    userId: string,
    config: typeof PRIVACY_PRESETS.OFF.walletRotation,
    state: PrivacyLayerState
  ): Promise<Result<WalletId, PrivacyLayerError>> {
    try {
      let selectedWallet: WalletId;

      switch (config.strategy) {
        case "ROUND_ROBIN":
        case "RANDOM": {
          // Use WalletRotator
          const strategyMap = {
            ROUND_ROBIN: "ROUND_ROBIN" as const,
            RANDOM: "RANDOM" as const,
          };
          const rotatorStrategy = strategyMap[config.strategy];

          const walletResult = await this.walletRotator.selectWallet(
            userId,
            rotatorStrategy
          );

          if (!walletResult.success) {
            return Err({
              type: "NO_WALLETS_AVAILABLE",
              message: "Failed to select wallet for rotation",
            });
          }

          selectedWallet = walletResult.value.id;
          break;
        }

        case "FRESH_ONLY":
        case "FRESH_THRESHOLD": {
          // Check if we need a fresh wallet
          const needsFreshWallet =
            config.strategy === "FRESH_ONLY" ||
            (config.freshThreshold &&
              state.tradesSinceLastRotation >= config.freshThreshold);

          if (needsFreshWallet) {
            // TODO: Create fresh wallet via WalletManager
            // For now, fallback to rotation
            logger.warn("Fresh wallet creation not yet implemented, using rotation", {
              userId: this.redactUserId(userId),
              strategy: config.strategy,
            });

            const walletResult = await this.walletRotator.selectWallet(
              userId,
              "RANDOM"
            );

            if (!walletResult.success) {
              return Err({
                type: "WALLET_CREATION_FAILED",
                message: "Failed to create or select fresh wallet",
              });
            }

            selectedWallet = walletResult.value.id;

            // Reset trade counter
            state.tradesSinceLastRotation = 0;
          } else {
            // Use existing wallet rotation
            const walletResult = await this.walletRotator.selectWallet(
              userId,
              "ROUND_ROBIN"
            );

            if (!walletResult.success) {
              return Err({
                type: "NO_WALLETS_AVAILABLE",
                message: "Failed to select wallet for rotation",
              });
            }

            selectedWallet = walletResult.value.id;
          }
          break;
        }

        default: {
          // Fallback to primary wallet
          const walletResult = await this.walletRotator.selectWallet(
            userId,
            "PRIMARY_ONLY"
          );

          if (!walletResult.success) {
            return Err({
              type: "NO_WALLETS_AVAILABLE",
              message: "Failed to select primary wallet",
            });
          }

          selectedWallet = walletResult.value.id;
        }
      }

      logger.debug("Selected wallet", {
        userId: this.redactUserId(userId),
        strategy: config.strategy,
        walletId: this.redactWalletId(selectedWallet),
        tradesSinceRotation: state.tradesSinceLastRotation,
      });

      return Ok(selectedWallet);
    } catch (error) {
      return Err({
        type: "NO_WALLETS_AVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // Jito Tip Calculation
  // ==========================================================================

  /**
   * Calculate randomized Jito tip amount
   */
  private calculateJitoTip(
    config: typeof PRIVACY_PRESETS.OFF.jito
  ): Result<bigint | undefined, PrivacyLayerError> {
    try {
      if (!config.forceJitoRouting) {
        return Ok(undefined);
      }

      let tipLamports: bigint;

      if (config.randomizeTips) {
        // Random tip between min and max
        const range = Number(config.maxTipLamports - config.minTipLamports);
        const randomTip = Math.floor(Math.random() * range);
        tipLamports = config.minTipLamports + BigInt(randomTip);
      } else {
        // Use minimum tip
        tipLamports = config.minTipLamports;
      }

      logger.debug("Calculated Jito tip", {
        tipLamports,
        randomized: config.randomizeTips,
      });

      return Ok(tipLamports);
    } catch (error) {
      return Err({
        type: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // Transaction Obfuscation
  // ==========================================================================

  /**
   * Generate transaction obfuscation (memo, dummy instructions, etc)
   */
  private generateObfuscation(
    config: typeof PRIVACY_PRESETS.OFF.obfuscation
  ): Result<
    { memo?: string; appliedPatterns: readonly ObfuscationPattern[] },
    PrivacyLayerError
  > {
    try {
      const appliedPatterns: ObfuscationPattern[] = [];
      let memo: string | undefined;

      if (config.pattern === "NONE") {
        return Ok({ appliedPatterns });
      }

      // Random memo
      if (
        config.addRandomMemos &&
        (config.pattern === "MEMO_RANDOM" || config.pattern === "FULL")
      ) {
        memo = this.generateRandomMemo(config.maxMemoLength);
        appliedPatterns.push("MEMO_RANDOM");
      }

      // Dummy instructions
      if (
        config.addDummyInstructions &&
        (config.pattern === "DUMMY_INSTRUCTIONS" || config.pattern === "FULL")
      ) {
        // Note: Actual dummy instructions would be added in transaction builder
        // Here we just mark that they should be added
        appliedPatterns.push("DUMMY_INSTRUCTIONS");
      }

      // Amount splitting
      if (config.pattern === "SPLIT_AMOUNT" || config.pattern === "FULL") {
        // Note: Amount splitting would be handled by executor
        // Here we just mark that it should be done
        appliedPatterns.push("SPLIT_AMOUNT");
      }

      logger.debug("Generated obfuscation", {
        pattern: config.pattern,
        memoLength: memo?.length ?? 0,
        appliedPatterns,
      });

      return Ok({ memo, appliedPatterns });
    } catch (error) {
      return Err({
        type: "OBFUSCATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Generate random memo string
   */
  private generateRandomMemo(maxLength: number): string {
    const length = Math.floor(Math.random() * maxLength) + 1;
    return crypto.randomBytes(length).toString("hex").slice(0, length);
  }

  // ==========================================================================
  // Privacy Score Calculation
  // ==========================================================================

  /**
   * Calculate privacy score (0-100) based on applied protections
   */
  private calculatePrivacyScore(
    settings: PrivacySettings,
    delay: RandomizedDelay,
    _feeMode: PriorityFeeMode,
    obfuscation: readonly ObfuscationPattern[]
  ): PrivacyScore {
    let score = 0;

    // Timing randomization (0-30 points)
    if (settings.timing.enabled) {
      const delayScore = Math.min(30, (delay.delayMs / 5000) * 30);
      const jitterScore = (settings.timing.jitterPercent / 100) * 10;
      score += delayScore + jitterScore;
    }

    // Fee pattern variation (0-20 points)
    const feeStrategyScores: Record<FeePatternStrategy, number> = {
      FIXED: 0,
      RANDOM: 10,
      GRADUAL_INCREASE: 5,
      SPIKE_PATTERN: 15,
      ADAPTIVE: 20,
    };
    score += feeStrategyScores[settings.feePattern.strategy];

    // Wallet rotation (0-25 points)
    const walletStrategyScores: Record<PrivacyWalletStrategy, number> = {
      ROUND_ROBIN: 10,
      RANDOM: 15,
      FRESH_ONLY: 25,
      FRESH_THRESHOLD: 20,
    };
    score += walletStrategyScores[settings.walletRotation.strategy];

    // Jito routing (0-15 points)
    if (settings.jito.forceJitoRouting) {
      score += 10;
      if (settings.jito.randomizeTips) {
        score += 5;
      }
    }

    // Obfuscation (0-10 points)
    score += obfuscation.length * 2.5;

    return asPrivacyScore(Math.min(100, Math.floor(score)));
  }

  // ==========================================================================
  // Settings Validation
  // ==========================================================================

  /**
   * Validate privacy settings
   */
  validateSettings(settings: PrivacySettings): PrivacySettingsValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate timing config
    if (settings.timing.enabled) {
      if (settings.timing.baseDelayMs < 0 || settings.timing.baseDelayMs > 30000) {
        errors.push("Base delay must be between 0-30000ms");
      }
      if (settings.timing.jitterPercent < 0 || settings.timing.jitterPercent > 100) {
        errors.push("Jitter percent must be between 0-100%");
      }
      if (settings.timing.minDelayMs > settings.timing.maxDelayMs) {
        errors.push("Min delay cannot be greater than max delay");
      }
      if (settings.timing.baseDelayMs > 10000) {
        warnings.push("High base delay (>10s) may cause you to miss opportunities");
      }
    }

    // Validate fee pattern
    if (settings.feePattern.allowedModes.length === 0) {
      errors.push("At least one fee mode must be allowed");
    }

    // Validate wallet rotation
    if (
      settings.walletRotation.strategy === "FRESH_THRESHOLD" &&
      !settings.walletRotation.freshThreshold
    ) {
      errors.push("Fresh threshold required for FRESH_THRESHOLD strategy");
    }

    // Validate Jito config
    if (settings.jito.forceJitoRouting) {
      if (settings.jito.minTipLamports <= 0) {
        errors.push("Jito min tip must be positive");
      }
      if (settings.jito.maxTipLamports < settings.jito.minTipLamports) {
        errors.push("Jito max tip cannot be less than min tip");
      }
    }

    // Validate obfuscation
    if (settings.obfuscation.addRandomMemos && settings.obfuscation.maxMemoLength <= 0) {
      errors.push("Max memo length must be positive if random memos enabled");
    }
    if (
      settings.obfuscation.addDummyInstructions &&
      settings.obfuscation.maxDummyInstructions > 5
    ) {
      warnings.push("Too many dummy instructions may cause transaction size issues");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Get or create privacy layer state for user
   */
  private getOrCreateState(
    userId: string,
    settings: PrivacySettings
  ): PrivacyLayerState {
    let state = this.state.get(userId);

    if (!state) {
      state = {
        userId,
        settings,
        tradesSinceLastRotation: 0,
        privacyScore: asPrivacyScore(0),
      };
      this.state.set(userId, state);
    } else {
      // Update settings by creating new state
      state = {
        ...state,
        settings,
      };
      this.state.set(userId, state);
    }

    return state;
  }

  /**
   * Reset state for user (e.g., after changing privacy mode)
   */
  resetState(userId: string): void {
    this.state.delete(userId);
    logger.info("Privacy layer state reset", {
      userId: this.redactUserId(userId),
    });
  }

  /**
   * Get current privacy score for user
   */
  getPrivacyScore(userId: string): PrivacyScore {
    const state = this.state.get(userId);
    return state?.privacyScore ?? asPrivacyScore(0);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Redact user ID for logging (PII protection)
   */
  private redactUserId(userId: string): string {
    if (userId.length <= 8) {
      return "***";
    }
    return `${userId.slice(0, 4)}...${userId.slice(-4)}`;
  }

  /**
   * Redact wallet ID for logging (PII protection)
   */
  private redactWalletId(walletId: WalletId): string {
    const id = String(walletId);
    if (id.length <= 8) {
      return "***";
    }
    return `${id.slice(0, 4)}...${id.slice(-4)}`;
  }
}

// ============================================================================
// Preset Helper Functions
// ============================================================================

/**
 * Get privacy settings for a specific mode
 */
export function getPrivacyPreset(mode: PrivacyMode): PrivacySettings {
  return PRIVACY_PRESETS[mode];
}

/**
 * Create custom privacy settings based on a preset
 */
export function createCustomPrivacySettings(
  baseMode: PrivacyMode,
  overrides: Partial<PrivacySettings>
): PrivacySettings {
  const base = PRIVACY_PRESETS[baseMode];
  return {
    ...base,
    ...overrides,
  };
}
