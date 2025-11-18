/**
 * Filter Validator Service
 *
 * Validates sniper filters and checks if tokens pass filter criteria.
 * Used for auto-sniper system to filter new token launches.
 */

import { logger } from "../../utils/logger.js";
import type { Result, TokenMint } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import type { HoneypotCheckResult } from "../../types/honeypot.js";
import type {
  SniperFilters,
  FilterValidationResult,
  FilterValidationError,
  FilterCheckResult,
  FilterViolation,
  TokenFilterData,
  FilterPreset,
} from "../../types/sniperFilters.js";
import { getPresetFilters } from "../../types/sniperFilters.js";
import { getLiquidityLockChecker } from "./liquidityLockChecker.js";
import { getSolanaConnection } from "../blockchain/solana.js";

// ============================================================================
// Filter Validator Class
// ============================================================================

export class FilterValidator {
  /**
   * Validate filter configuration
   * Checks for invalid ranges, conflicting filters, etc.
   */
  validate(filters: SniperFilters): FilterValidationResult {
    const errors: FilterValidationError[] = [];
    const warnings: string[] = [];

    // ===== Validate percentages (0-100) =====
    const percentageFields: Array<keyof SniperFilters> = [
      "minLiquidityLockPct",
      "maxTop10HoldersPct",
      "maxSingleHolderPct",
      "maxDeveloperPct",
      "maxBuyTax",
      "maxSellTax",
      "minPoolSupplyPct",
      "maxPoolSupplyPct",
      "maxRiskScore",
      "minConfidence",
    ];

    for (const field of percentageFields) {
      const value = filters[field];
      if (value !== undefined && value !== null) {
        if (typeof value !== "number" || value < 0 || value > 100) {
          errors.push({
            type: "INVALID_PERCENTAGE",
            field,
            value: value as number,
          });
        }
      }
    }

    // ===== Validate liquidity ranges =====
    if (filters.minLiquiditySol !== undefined && filters.minLiquiditySol < 0) {
      errors.push({
        type: "INVALID_RANGE",
        field: "minLiquiditySol",
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        value: filters.minLiquiditySol,
      });
    }

    if (
      filters.maxLiquiditySol !== undefined &&
      filters.maxLiquiditySol !== null &&
      filters.maxLiquiditySol < 0
    ) {
      errors.push({
        type: "INVALID_RANGE",
        field: "maxLiquiditySol",
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        value: filters.maxLiquiditySol,
      });
    }

    // Check min/max liquidity conflict
    if (
      filters.minLiquiditySol !== undefined &&
      filters.maxLiquiditySol !== undefined &&
      filters.maxLiquiditySol !== null &&
      filters.minLiquiditySol > filters.maxLiquiditySol
    ) {
      errors.push({
        type: "CONFLICTING_FILTERS",
        field1: "minLiquiditySol",
        field2: "maxLiquiditySol",
        reason: `minLiquiditySol (${filters.minLiquiditySol}) > maxLiquiditySol (${filters.maxLiquiditySol})`,
      });
    }

    // ===== Validate holder count =====
    if (filters.minHolders !== undefined && filters.minHolders < 0) {
      errors.push({
        type: "INVALID_RANGE",
        field: "minHolders",
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        value: filters.minHolders,
      });
    }

    // ===== Validate blacklisted/whitelisted mints =====
    if (filters.blacklistedMints) {
      for (const mint of filters.blacklistedMints) {
        if (!this.isValidMint(mint)) {
          errors.push({
            type: "INVALID_MINT",
            field: "blacklistedMints",
            mint,
          });
        }
      }
    }

    if (filters.whitelistedMints) {
      for (const mint of filters.whitelistedMints) {
        if (!this.isValidMint(mint)) {
          errors.push({
            type: "INVALID_MINT",
            field: "whitelistedMints",
            mint,
          });
        }
      }
    }

    // ===== Validate holder percentage conflicts =====
    if (
      filters.maxSingleHolderPct !== undefined &&
      filters.maxTop10HoldersPct !== undefined &&
      filters.maxSingleHolderPct > filters.maxTop10HoldersPct
    ) {
      warnings.push(
        `maxSingleHolderPct (${filters.maxSingleHolderPct}%) > maxTop10HoldersPct (${filters.maxTop10HoldersPct}%) - this is unusual but allowed`
      );
    }

    // ===== Warnings for extreme values =====
    if (filters.maxRiskScore !== undefined && filters.maxRiskScore > 80) {
      warnings.push(
        `maxRiskScore=${filters.maxRiskScore} is very high - you may buy honeypots`
      );
    }

    if (filters.minLiquiditySol !== undefined && filters.minLiquiditySol < 1) {
      warnings.push(
        `minLiquiditySol=${filters.minLiquiditySol} SOL is very low - high rug risk`
      );
    }

    if (filters.maxBuyTax !== undefined && filters.maxBuyTax > 20) {
      warnings.push(`maxBuyTax=${filters.maxBuyTax}% is very high - you may lose money on entry`);
    }

    if (filters.maxSellTax !== undefined && filters.maxSellTax > 30) {
      warnings.push(
        `maxSellTax=${filters.maxSellTax}% is very high - you may lose money on exit`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Check if token passes filter criteria
   * Returns detailed result with violations
   *
   * @param honeypotResult - Honeypot detection result
   * @param filters - Filter configuration
   * @param preset - Filter preset name
   * @param lpMint - Optional LP token mint for liquidity lock verification
   */
  async checkToken(
    honeypotResult: HoneypotCheckResult,
    filters: SniperFilters,
    preset: FilterPreset = "CUSTOM",
    lpMint?: TokenMint
  ): Promise<FilterCheckResult> {
    const violations: FilterViolation[] = [];

    // Extract token data from honeypot result
    const tokenData = await this.extractTokenData(honeypotResult, lpMint);

    // Check if token is whitelisted (skip all filters except honeypot)
    if (filters.whitelistedMints?.includes(tokenData.tokenMint)) {
      logger.info("Token is whitelisted, passing most filters", {
        tokenMint: tokenData.tokenMint,
      });

      // Still check honeypot risk for whitelisted tokens
      this.checkHoneypotFilters(tokenData, filters, violations);

      return {
        passed: violations.length === 0,
        preset,
        violations,
        tokenData,
        checkedAt: new Date(),
      };
    }

    // Check if token is blacklisted
    if (filters.blacklistedMints?.includes(tokenData.tokenMint)) {
      violations.push({
        filter: "blacklistedMints",
        expected: "not blacklisted",
        actual: "blacklisted",
        severity: "high",
        message: "Token is on blacklist",
      });

      return {
        passed: false,
        preset,
        violations,
        tokenData,
        checkedAt: new Date(),
      };
    }

    // Apply all filters
    this.checkAuthorityFilters(tokenData, filters, violations);
    this.checkLiquidityFilters(tokenData, filters, violations);
    this.checkHolderFilters(tokenData, filters, violations);
    this.checkTaxFilters(tokenData, filters, violations);
    this.checkPoolSupplyFilters(tokenData, filters, violations);
    this.checkSocialFilters(tokenData, filters, violations);
    this.checkHoneypotFilters(tokenData, filters, violations);
    this.checkMetadataFilters(tokenData, filters, violations);

    const passed = violations.length === 0;

    logger.info("Filter check completed", {
      tokenMint: tokenData.tokenMint,
      preset,
      passed,
      violationCount: violations.length,
      violations: violations.map((v) => v.filter),
    });

    return {
      passed,
      preset,
      violations,
      tokenData,
      checkedAt: new Date(),
    };
  }

  /**
   * Get merged filters (preset + custom overrides)
   */
  getMergedFilters(
    preset: FilterPreset,
    customOverrides: Partial<SniperFilters> = {}
  ): Result<SniperFilters, string> {
    const presetFilters = getPresetFilters(preset);

    if (preset === "CUSTOM") {
      if (Object.keys(customOverrides).length === 0) {
        return Err("CUSTOM preset requires custom filters");
      }
      return Ok(customOverrides as SniperFilters);
    }

    if (!presetFilters) {
      return Err(`Invalid preset: ${preset}`);
    }

    // Merge preset with custom overrides
    const merged: SniperFilters = {
      ...presetFilters,
      ...customOverrides,
    };

    return Ok(merged);
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Extract token data from honeypot check result
   */
  private async extractTokenData(
    honeypotResult: HoneypotCheckResult,
    lpMint?: TokenMint
  ): Promise<TokenFilterData> {
    const { layers } = honeypotResult;

    // Check liquidity lock if LP mint is provided
    // Default to locked=true if LP mint not provided (backward compatibility)
    let liquidityLocked = !lpMint; // true if no lpMint, false if lpMint provided
    let liquidityLockPct = !lpMint ? 100 : 0;

    if (lpMint) {
      try {
        const connection = await getSolanaConnection();
        const lockChecker = getLiquidityLockChecker(connection);
        const lockResult = await lockChecker.checkLock({
          lpMint,
          useGuacamoleApi: true,
          cacheTtl: 300, // 5 minutes
        });

        if (lockResult.success) {
          liquidityLocked = lockResult.value.isLocked;
          liquidityLockPct = lockResult.value.lockedPercentage;

          logger.debug("Liquidity lock check completed", {
            tokenMint: honeypotResult.tokenMint,
            lpMint,
            isLocked: liquidityLocked,
            lockedPercentage: liquidityLockPct,
            lockCount: lockResult.value.locks.length,
          });
        } else {
          logger.warn("Failed to check liquidity lock", {
            tokenMint: honeypotResult.tokenMint,
            lpMint,
            error: lockResult.error,
          });
        }
      } catch (error) {
        logger.error("Error checking liquidity lock", {
          tokenMint: honeypotResult.tokenMint,
          lpMint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      logger.debug("No LP mint provided, skipping liquidity lock check", {
        tokenMint: honeypotResult.tokenMint,
      });
    }

    return {
      tokenMint: honeypotResult.tokenMint,

      // Authority (from on-chain layer)
      hasMintAuthority: !!layers.onchain?.mintAuthority,
      hasFreezeAuthority: !!layers.onchain?.freezeAuthority,

      // Liquidity (from simulation layer or API)
      // Default to 100 SOL if not available (assume sufficient liquidity for now)
      liquiditySol: 100,
      // Real liquidity lock data from on-chain check
      liquidityLocked,
      liquidityLockPct,

      // Holders (from simulation layer)
      top10HoldersPct: layers.simulation?.top10HoldersPct ?? 0,
      singleHolderPct: layers.simulation?.developerHoldingsPct ?? 0,
      totalHolders: layers.simulation?.totalHolders ?? 0,
      developerHoldingsPct: layers.simulation?.developerHoldingsPct ?? 0,

      // Tax (from simulation layer)
      buyTax: layers.simulation?.buyTax ?? 0,
      sellTax: layers.simulation?.sellTax ?? 0,

      // Pool (placeholder - assume 50% for now)
      poolSupplyPct: 50,

      // Social (placeholder - need metadata parsing)
      // For MVP, assume tokens have social if they have metadata
      hasTwitter: layers.onchain?.hasMetadata ?? false,
      hasWebsite: layers.onchain?.hasMetadata ?? false,
      hasTelegram: false,

      // Honeypot
      riskScore: honeypotResult.riskScore,
      confidence: honeypotResult.confidence,
      canSell: layers.simulation?.canSell ?? true,

      // Metadata
      hasMetadata: layers.onchain?.hasMetadata ?? false,
    };
  }

  /**
   * Check authority filters
   */
  private checkAuthorityFilters(
    tokenData: TokenFilterData,
    filters: SniperFilters,
    violations: FilterViolation[]
  ): void {
    if (filters.requireMintDisabled && tokenData.hasMintAuthority) {
      violations.push({
        filter: "requireMintDisabled",
        expected: "mint authority revoked",
        actual: "mint authority present",
        severity: "high",
        message: "Token has mint authority (can mint unlimited tokens)",
      });
    }

    if (filters.requireFreezeDisabled && tokenData.hasFreezeAuthority) {
      violations.push({
        filter: "requireFreezeDisabled",
        expected: "freeze authority revoked",
        actual: "freeze authority present",
        severity: "high",
        message: "Token has freeze authority (can freeze wallets)",
      });
    }
  }

  /**
   * Check liquidity filters
   */
  private checkLiquidityFilters(
    tokenData: TokenFilterData,
    filters: SniperFilters,
    violations: FilterViolation[]
  ): void {
    if (
      filters.minLiquiditySol !== undefined &&
      tokenData.liquiditySol < filters.minLiquiditySol
    ) {
      violations.push({
        filter: "minLiquiditySol",
        expected: `>= ${filters.minLiquiditySol} SOL`,
        actual: `${tokenData.liquiditySol} SOL`,
        severity: "medium",
        message: `Liquidity too low (${tokenData.liquiditySol} SOL < ${filters.minLiquiditySol} SOL)`,
      });
    }

    if (
      filters.maxLiquiditySol !== undefined &&
      filters.maxLiquiditySol !== null &&
      tokenData.liquiditySol > filters.maxLiquiditySol
    ) {
      violations.push({
        filter: "maxLiquiditySol",
        expected: `<= ${filters.maxLiquiditySol} SOL`,
        actual: `${tokenData.liquiditySol} SOL`,
        severity: "low",
        message: `Liquidity too high (${tokenData.liquiditySol} SOL > ${filters.maxLiquiditySol} SOL)`,
      });
    }

    if (filters.requireLiquidityLocked && !tokenData.liquidityLocked) {
      violations.push({
        filter: "requireLiquidityLocked",
        expected: "liquidity locked",
        actual: "liquidity not locked",
        severity: "high",
        message: "Liquidity is not locked (rug pull risk)",
      });
    }

    if (
      filters.minLiquidityLockPct !== undefined &&
      filters.minLiquidityLockPct !== null &&
      tokenData.liquidityLockPct !== null &&
      tokenData.liquidityLockPct < filters.minLiquidityLockPct
    ) {
      violations.push({
        filter: "minLiquidityLockPct",
        expected: `>= ${filters.minLiquidityLockPct}%`,
        actual: `${tokenData.liquidityLockPct}%`,
        severity: "medium",
        message: `Liquidity lock percentage too low (${tokenData.liquidityLockPct}% < ${filters.minLiquidityLockPct}%)`,
      });
    }
  }

  /**
   * Check holder distribution filters
   */
  private checkHolderFilters(
    tokenData: TokenFilterData,
    filters: SniperFilters,
    violations: FilterViolation[]
  ): void {
    if (
      filters.maxTop10HoldersPct !== undefined &&
      tokenData.top10HoldersPct > filters.maxTop10HoldersPct
    ) {
      violations.push({
        filter: "maxTop10HoldersPct",
        expected: `<= ${filters.maxTop10HoldersPct}%`,
        actual: `${tokenData.top10HoldersPct}%`,
        severity: "medium",
        message: `Top 10 holders own too much (${tokenData.top10HoldersPct}% > ${filters.maxTop10HoldersPct}%)`,
      });
    }

    if (
      filters.maxSingleHolderPct !== undefined &&
      tokenData.singleHolderPct > filters.maxSingleHolderPct
    ) {
      violations.push({
        filter: "maxSingleHolderPct",
        expected: `<= ${filters.maxSingleHolderPct}%`,
        actual: `${tokenData.singleHolderPct}%`,
        severity: "high",
        message: `Single holder owns too much (${tokenData.singleHolderPct}% > ${filters.maxSingleHolderPct}%)`,
      });
    }

    if (filters.minHolders !== undefined && tokenData.totalHolders < filters.minHolders) {
      violations.push({
        filter: "minHolders",
        expected: `>= ${filters.minHolders}`,
        actual: `${tokenData.totalHolders}`,
        severity: "medium",
        message: `Not enough holders (${tokenData.totalHolders} < ${filters.minHolders})`,
      });
    }

    if (
      filters.maxDeveloperPct !== undefined &&
      tokenData.developerHoldingsPct > filters.maxDeveloperPct
    ) {
      violations.push({
        filter: "maxDeveloperPct",
        expected: `<= ${filters.maxDeveloperPct}%`,
        actual: `${tokenData.developerHoldingsPct}%`,
        severity: "medium",
        message: `Developer holds too much (${tokenData.developerHoldingsPct}% > ${filters.maxDeveloperPct}%)`,
      });
    }
  }

  /**
   * Check tax filters
   */
  private checkTaxFilters(
    tokenData: TokenFilterData,
    filters: SniperFilters,
    violations: FilterViolation[]
  ): void {
    if (filters.maxBuyTax !== undefined && tokenData.buyTax > filters.maxBuyTax) {
      violations.push({
        filter: "maxBuyTax",
        expected: `<= ${filters.maxBuyTax}%`,
        actual: `${tokenData.buyTax}%`,
        severity: "medium",
        message: `Buy tax too high (${tokenData.buyTax}% > ${filters.maxBuyTax}%)`,
      });
    }

    if (filters.maxSellTax !== undefined && tokenData.sellTax > filters.maxSellTax) {
      violations.push({
        filter: "maxSellTax",
        expected: `<= ${filters.maxSellTax}%`,
        actual: `${tokenData.sellTax}%`,
        severity: "high",
        message: `Sell tax too high (${tokenData.sellTax}% > ${filters.maxSellTax}%)`,
      });
    }
  }

  /**
   * Check pool supply filters
   */
  private checkPoolSupplyFilters(
    tokenData: TokenFilterData,
    filters: SniperFilters,
    violations: FilterViolation[]
  ): void {
    if (
      filters.minPoolSupplyPct !== undefined &&
      tokenData.poolSupplyPct < filters.minPoolSupplyPct
    ) {
      violations.push({
        filter: "minPoolSupplyPct",
        expected: `>= ${filters.minPoolSupplyPct}%`,
        actual: `${tokenData.poolSupplyPct}%`,
        severity: "medium",
        message: `Pool supply too low (${tokenData.poolSupplyPct}% < ${filters.minPoolSupplyPct}%)`,
      });
    }

    if (
      filters.maxPoolSupplyPct !== undefined &&
      filters.maxPoolSupplyPct !== null &&
      tokenData.poolSupplyPct > filters.maxPoolSupplyPct
    ) {
      violations.push({
        filter: "maxPoolSupplyPct",
        expected: `<= ${filters.maxPoolSupplyPct}%`,
        actual: `${tokenData.poolSupplyPct}%`,
        severity: "medium",
        message: `Pool supply too high (${tokenData.poolSupplyPct}% > ${filters.maxPoolSupplyPct}%)`,
      });
    }
  }

  /**
   * Check social verification filters
   */
  private checkSocialFilters(
    tokenData: TokenFilterData,
    filters: SniperFilters,
    violations: FilterViolation[]
  ): void {
    if (filters.requireTwitter && !tokenData.hasTwitter) {
      violations.push({
        filter: "requireTwitter",
        expected: "Twitter link present",
        actual: "no Twitter link",
        severity: "low",
        message: "Token missing Twitter link",
      });
    }

    if (filters.requireWebsite && !tokenData.hasWebsite) {
      violations.push({
        filter: "requireWebsite",
        expected: "Website link present",
        actual: "no website link",
        severity: "low",
        message: "Token missing website",
      });
    }

    if (filters.requireTelegram && !tokenData.hasTelegram) {
      violations.push({
        filter: "requireTelegram",
        expected: "Telegram link present",
        actual: "no Telegram link",
        severity: "low",
        message: "Token missing Telegram link",
      });
    }
  }

  /**
   * Check honeypot risk filters
   */
  private checkHoneypotFilters(
    tokenData: TokenFilterData,
    filters: SniperFilters,
    violations: FilterViolation[]
  ): void {
    if (filters.maxRiskScore !== undefined && tokenData.riskScore > filters.maxRiskScore) {
      violations.push({
        filter: "maxRiskScore",
        expected: `<= ${filters.maxRiskScore}`,
        actual: `${tokenData.riskScore}`,
        severity: "high",
        message: `Risk score too high (${tokenData.riskScore} > ${filters.maxRiskScore})`,
      });
    }

    if (filters.minConfidence !== undefined && tokenData.confidence < filters.minConfidence) {
      violations.push({
        filter: "minConfidence",
        expected: `>= ${filters.minConfidence}`,
        actual: `${tokenData.confidence}`,
        severity: "medium",
        message: `Detection confidence too low (${tokenData.confidence} < ${filters.minConfidence})`,
      });
    }

    if (filters.requireSellSimulation && !tokenData.canSell) {
      violations.push({
        filter: "requireSellSimulation",
        expected: "can sell successfully",
        actual: "sell simulation failed",
        severity: "high",
        message: "Token failed sell simulation (likely honeypot)",
      });
    }
  }

  /**
   * Check metadata filters
   */
  private checkMetadataFilters(
    tokenData: TokenFilterData,
    filters: SniperFilters,
    violations: FilterViolation[]
  ): void {
    if (filters.requireMetadata && !tokenData.hasMetadata) {
      violations.push({
        filter: "requireMetadata",
        expected: "Metaplex metadata present",
        actual: "no metadata",
        severity: "medium",
        message: "Token missing Metaplex metadata",
      });
    }
  }

  /**
   * Basic mint address validation
   */
  private isValidMint(mint: string): boolean {
    // Base58 validation (Solana addresses are 32-44 chars)
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let filterValidatorInstance: FilterValidator | null = null;

export function getFilterValidator(): FilterValidator {
  if (!filterValidatorInstance) {
    filterValidatorInstance = new FilterValidator();
  }
  return filterValidatorInstance;
}
