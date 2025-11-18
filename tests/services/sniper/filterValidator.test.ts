/**
 * Filter Validator Tests
 *
 * Comprehensive tests for sniper filter validation and token checking.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { FilterValidator } from "../../../src/services/sniper/filterValidator.js";
import type { SniperFilters } from "../../../src/types/sniperFilters.js";
import type { HoneypotCheckResult } from "../../../src/types/honeypot.js";
import { asRiskScore } from "../../../src/types/honeypot.js";
import {
  CONSERVATIVE_FILTERS,
  BALANCED_FILTERS,
  AGGRESSIVE_FILTERS,
} from "../../../src/types/sniperFilters.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockHoneypotResult(
  overrides: Partial<HoneypotCheckResult> = {}
): HoneypotCheckResult {
  return {
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    isHoneypot: false,
    riskScore: asRiskScore(25),
    confidence: 85,
    flags: [],
    checkedAt: new Date(),
    analysisTimeMs: 1000,
    layers: {
      onchain: {
        mintAuthority: null,
        freezeAuthority: null,
        supply: BigInt(1000000000),
        decimals: 6,
        hasMetadata: true,
        score: 0,
        flags: [],
        timeMs: 200,
      },
      simulation: {
        canBuy: true,
        canSell: true,
        buyTax: 2,
        sellTax: 5,
        buyPriceImpact: 0.5,
        sellPriceImpact: 0.6,
        top10HoldersPct: 40,
        developerHoldingsPct: 15,
        totalHolders: 150,
        score: 10,
        flags: [],
        timeMs: 800,
      },
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("FilterValidator", () => {
  let validator: FilterValidator;

  beforeEach(() => {
    validator = new FilterValidator();
  });

  // ==========================================================================
  // Validation Tests
  // ==========================================================================

  describe("validate", () => {
    test("should validate valid conservative filters", async () => {
      const result = validator.validate(CONSERVATIVE_FILTERS);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should validate valid balanced filters", async () => {
      const result = validator.validate(BALANCED_FILTERS);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should validate valid aggressive filters", async () => {
      const result = validator.validate(AGGRESSIVE_FILTERS);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should reject invalid percentage values", async () => {
      const filters: SniperFilters = {
        maxBuyTax: 150, // Invalid: > 100
        maxSellTax: -10, // Invalid: < 0
      };

      const result = validator.validate(filters);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.type === "INVALID_PERCENTAGE")).toBe(true);
    });

    test("should reject negative liquidity values", async () => {
      const filters: SniperFilters = {
        minLiquiditySol: -5,
      };

      const result = validator.validate(filters);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === "INVALID_RANGE")).toBe(true);
    });

    test("should detect conflicting min/max liquidity", async () => {
      const filters: SniperFilters = {
        minLiquiditySol: 100,
        maxLiquiditySol: 50, // Max < Min
      };

      const result = validator.validate(filters);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === "CONFLICTING_FILTERS")).toBe(true);
    });

    test("should reject invalid mint addresses", async () => {
      const filters: SniperFilters = {
        blacklistedMints: ["invalid-mint-address"],
      };

      const result = validator.validate(filters);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === "INVALID_MINT")).toBe(true);
    });

    test("should warn on extreme values", async () => {
      const filters: SniperFilters = {
        maxRiskScore: 85, // Very high
        minLiquiditySol: 0.5, // Very low
      };

      const result = validator.validate(filters);

      expect(result.valid).toBe(true); // No errors, just warnings
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    test("should accept null values for optional max filters", async () => {
      const filters: SniperFilters = {
        maxLiquiditySol: null,
        maxPoolSupplyPct: null,
        minLiquidityLockPct: null,
      };

      const result = validator.validate(filters);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Token Checking Tests
  // ==========================================================================

  describe("checkToken", () => {
    test("should pass safe token with conservative filters", async () => {
      const honeypotResult = createMockHoneypotResult({
        riskScore: asRiskScore(20),
        confidence: 90,
        layers: {
          onchain: {
            mintAuthority: null, // Disabled
            freezeAuthority: null, // Disabled
            supply: BigInt(1000000000),
            decimals: 6,
            hasMetadata: true,
            score: 0,
            flags: [],
            timeMs: 200,
          },
          simulation: {
            canBuy: true,
            canSell: true,
            buyTax: 3,
            sellTax: 5,
            buyPriceImpact: 0.5,
            sellPriceImpact: 0.6,
            top10HoldersPct: 45, // Below 50% limit
            developerHoldingsPct: 8, // Below 10% limit
            totalHolders: 150, // Above 100 minimum
            score: 10,
            flags: [],
            timeMs: 800,
          },
        },
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    test("should reject token with mint authority (conservative)", async () => {
      const honeypotResult = createMockHoneypotResult({
        layers: {
          onchain: {
            mintAuthority: "SomeMintAuthority111111111111111111111111",
            freezeAuthority: null,
            supply: BigInt(1000000000),
            decimals: 6,
            hasMetadata: true,
            score: 40,
            flags: ["MINT_AUTHORITY"],
            timeMs: 200,
          },
        },
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.filter === "requireMintDisabled")).toBe(true);
      expect(result.violations.some((v) => v.severity === "high")).toBe(true);
    });

    test("should reject token with freeze authority (conservative)", async () => {
      const honeypotResult = createMockHoneypotResult({
        layers: {
          onchain: {
            mintAuthority: null,
            freezeAuthority: "SomeFreezeAuthority11111111111111111111",
            supply: BigInt(1000000000),
            decimals: 6,
            hasMetadata: true,
            score: 30,
            flags: ["FREEZE_AUTHORITY"],
            timeMs: 200,
          },
        },
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.filter === "requireFreezeDisabled")).toBe(true);
    });

    test("should reject high risk score token", async () => {
      const honeypotResult = createMockHoneypotResult({
        riskScore: asRiskScore(80), // High risk
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.filter === "maxRiskScore")).toBe(true);
    });

    test("should reject token failing sell simulation", async () => {
      const honeypotResult = createMockHoneypotResult({
        layers: {
          simulation: {
            canBuy: true,
            canSell: false, // Honeypot indicator
            buyTax: 2,
            sellTax: 100, // Can't sell
            buyPriceImpact: 0.5,
            sellPriceImpact: 0,
            top10HoldersPct: 40,
            developerHoldingsPct: 15,
            totalHolders: 150,
            score: 70,
            flags: ["SELL_SIMULATION_FAILED"],
            timeMs: 800,
          },
        },
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.filter === "requireSellSimulation")).toBe(true);
    });

    test("should reject centralized token (high holder concentration)", async () => {
      const honeypotResult = createMockHoneypotResult({
        layers: {
          simulation: {
            canBuy: true,
            canSell: true,
            buyTax: 2,
            sellTax: 5,
            buyPriceImpact: 0.5,
            sellPriceImpact: 0.6,
            top10HoldersPct: 85, // Too high for conservative
            developerHoldingsPct: 50, // Too high
            totalHolders: 50, // Too few
            score: 40,
            flags: ["CENTRALIZED"],
            timeMs: 800,
          },
        },
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.filter === "maxTop10HoldersPct")).toBe(true);
      expect(result.violations.some((v) => v.filter === "maxDeveloperPct")).toBe(true);
      expect(result.violations.some((v) => v.filter === "minHolders")).toBe(true);
    });

    test("should reject high tax token", async () => {
      const honeypotResult = createMockHoneypotResult({
        layers: {
          simulation: {
            canBuy: true,
            canSell: true,
            buyTax: 15, // Too high for conservative (max 5%)
            sellTax: 25, // Too high for conservative (max 10%)
            buyPriceImpact: 0.5,
            sellPriceImpact: 0.6,
            top10HoldersPct: 40,
            developerHoldingsPct: 15,
            totalHolders: 150,
            score: 30,
            flags: ["HIGH_SELL_TAX"],
            timeMs: 800,
          },
        },
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.filter === "maxBuyTax")).toBe(true);
      expect(result.violations.some((v) => v.filter === "maxSellTax")).toBe(true);
    });

    test("should accept risky token with aggressive filters", async () => {
      const honeypotResult = createMockHoneypotResult({
        riskScore: asRiskScore(65),
        layers: {
          onchain: {
            mintAuthority: "SomeMintAuthority111111111111111111111111",
            freezeAuthority: "SomeFreezeAuthority11111111111111111111",
            supply: BigInt(1000000000),
            decimals: 6,
            hasMetadata: false,
            score: 70,
            flags: ["MINT_AUTHORITY", "FREEZE_AUTHORITY"],
            timeMs: 200,
          },
          simulation: {
            canBuy: true,
            canSell: true,
            buyTax: 20,
            sellTax: 40,
            buyPriceImpact: 2,
            sellPriceImpact: 2.5,
            top10HoldersPct: 85,
            developerHoldingsPct: 35,
            totalHolders: 10,
            score: 50,
            flags: ["CENTRALIZED"],
            timeMs: 800,
          },
        },
      });

      const result = await validator.checkToken(honeypotResult, AGGRESSIVE_FILTERS, "AGGRESSIVE");

      expect(result.passed).toBe(true); // Aggressive accepts more risk
      expect(result.violations).toHaveLength(0);
    });

    test("should handle blacklisted tokens", async () => {
      const honeypotResult = createMockHoneypotResult();

      const filters: SniperFilters = {
        ...BALANCED_FILTERS,
        blacklistedMints: [honeypotResult.tokenMint],
      };

      const result = await validator.checkToken(honeypotResult, filters, "CUSTOM");

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.filter === "blacklistedMints")).toBe(true);
      expect(result.violations.some((v) => v.severity === "high")).toBe(true);
    });

    test("should bypass most filters for whitelisted tokens", async () => {
      const honeypotResult = createMockHoneypotResult({
        riskScore: asRiskScore(20), // Still check honeypot
        layers: {
          onchain: {
            mintAuthority: "SomeMintAuthority111111111111111111111111", // Would fail
            freezeAuthority: "SomeFreezeAuthority11111111111111111111", // Would fail
            supply: BigInt(1000000000),
            decimals: 6,
            hasMetadata: false,
            score: 70,
            flags: ["MINT_AUTHORITY", "FREEZE_AUTHORITY"],
            timeMs: 200,
          },
        },
      });

      const filters: SniperFilters = {
        ...CONSERVATIVE_FILTERS,
        whitelistedMints: [honeypotResult.tokenMint],
      };

      const result = await validator.checkToken(honeypotResult, filters, "CUSTOM");

      expect(result.passed).toBe(true); // Passes despite having authority
      expect(result.violations).toHaveLength(0);
    });

    test("should still check honeypot for whitelisted tokens", async () => {
      const honeypotResult = createMockHoneypotResult({
        riskScore: asRiskScore(85), // Very high risk
      });

      const filters: SniperFilters = {
        ...CONSERVATIVE_FILTERS,
        whitelistedMints: [honeypotResult.tokenMint],
      };

      const result = await validator.checkToken(honeypotResult, filters, "CUSTOM");

      expect(result.passed).toBe(false); // Fails due to high risk
      expect(result.violations.some((v) => v.filter === "maxRiskScore")).toBe(true);
    });

    test("should reject token with low confidence", async () => {
      const honeypotResult = createMockHoneypotResult({
        confidence: 40, // Too low for conservative (requires 80%)
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.filter === "minConfidence")).toBe(true);
    });

    test("should extract token data correctly", async () => {
      const honeypotResult = createMockHoneypotResult();

      const result = await validator.checkToken(honeypotResult, BALANCED_FILTERS, "BALANCED");

      expect(result.tokenData.tokenMint).toBe(honeypotResult.tokenMint);
      expect(result.tokenData.hasMintAuthority).toBe(false);
      expect(result.tokenData.hasFreezeAuthority).toBe(false);
      expect(result.tokenData.riskScore).toBe(honeypotResult.riskScore);
      expect(result.tokenData.canSell).toBe(true);
    });
  });

  // ==========================================================================
  // Preset Merging Tests
  // ==========================================================================

  describe("getMergedFilters", () => {
    test("should return conservative preset without overrides", async () => {
      const result = validator.getMergedFilters("CONSERVATIVE");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.maxRiskScore).toBe(30);
        expect(result.value.minHolders).toBe(100);
      }
    });

    test("should merge conservative preset with custom overrides", async () => {
      const result = validator.getMergedFilters("CONSERVATIVE", {
        maxRiskScore: 40, // Override from 30 to 40
        minHolders: 50, // Override from 100 to 50
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.maxRiskScore).toBe(40);
        expect(result.value.minHolders).toBe(50);
        expect(result.value.requireMintDisabled).toBe(true); // Unchanged
      }
    });

    test("should require custom filters for CUSTOM preset", async () => {
      const result = validator.getMergedFilters("CUSTOM");

      expect(result.success).toBe(false);
    });

    test("should accept custom filters for CUSTOM preset", async () => {
      const customFilters: SniperFilters = {
        maxRiskScore: 35,
        requireMintDisabled: true,
      };

      const result = validator.getMergedFilters("CUSTOM", customFilters);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.maxRiskScore).toBe(35);
      }
    });

    test("should return balanced preset correctly", async () => {
      const result = validator.getMergedFilters("BALANCED");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.maxRiskScore).toBe(50);
        expect(result.value.minLiquiditySol).toBe(5);
      }
    });

    test("should return aggressive preset correctly", async () => {
      const result = validator.getMergedFilters("AGGRESSIVE");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.maxRiskScore).toBe(70);
        expect(result.value.requireMintDisabled).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe("edge cases", () => {
    test("should handle missing simulation layer gracefully", async () => {
      const honeypotResult = createMockHoneypotResult({
        layers: {
          onchain: {
            mintAuthority: null,
            freezeAuthority: null,
            supply: BigInt(1000000000),
            decimals: 6,
            hasMetadata: true,
            score: 0,
            flags: [],
            timeMs: 200,
          },
          // No simulation layer
        },
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      // Should not crash, but will have default values (0) for simulation data
      expect(result.tokenData.buyTax).toBe(0);
      expect(result.tokenData.sellTax).toBe(0);
      expect(result.tokenData.canSell).toBe(true); // Default to true if no simulation
    });

    test("should handle missing onchain layer gracefully", async () => {
      const honeypotResult = createMockHoneypotResult({
        layers: {
          // No onchain layer
          simulation: {
            canBuy: true,
            canSell: true,
            buyTax: 2,
            sellTax: 5,
            buyPriceImpact: 0.5,
            sellPriceImpact: 0.6,
            top10HoldersPct: 40,
            developerHoldingsPct: 15,
            totalHolders: 150,
            score: 10,
            flags: [],
            timeMs: 800,
          },
        },
      });

      const result = await validator.checkToken(honeypotResult, CONSERVATIVE_FILTERS, "CONSERVATIVE");

      // Should not crash, will have default values for onchain data
      expect(result.tokenData.hasMintAuthority).toBe(false);
      expect(result.tokenData.hasFreezeAuthority).toBe(false);
    });

    test("should handle empty filters object", async () => {
      const honeypotResult = createMockHoneypotResult();
      const emptyFilters: SniperFilters = {};

      const result = await validator.checkToken(honeypotResult, emptyFilters, "CUSTOM");

      // With no filters, everything should pass
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });
});
