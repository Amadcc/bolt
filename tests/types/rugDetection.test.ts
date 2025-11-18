/**
 * Rug Detection Type System Tests
 * Tests for branded types, helper functions, and discriminated unions
 */

import { describe, test, expect } from "vitest";
import {
  asLiquidityAmount,
  asSupplyAmount,
  asHolderPercentage,
  asChangePercentage,
  asMonitorInterval,
  calculateLiquidityChange,
  calculateSupplyChange,
  calculateHolderChange,
  calculateHolderPercentage,
  determineRugSeverity,
  determineExitRecommendation,
  calculateRugConfidence,
  createRugDetection,
  type LiquiditySnapshot,
  type SupplySnapshot,
  type RugEvidence,
  type RugType,
} from "../../src/types/rugDetection.js";
import { asLamports } from "../../src/types/common.js";

describe("Branded Type Constructors", () => {
  describe("asLiquidityAmount", () => {
    test("should accept valid positive amounts", () => {
      expect(asLiquidityAmount(1_000_000n)).toBe(1_000_000n);
      expect(asLiquidityAmount(0n)).toBe(0n);
    });

    test("should reject negative amounts", () => {
      expect(() => asLiquidityAmount(-1n)).toThrow(
        "Liquidity amount cannot be negative"
      );
    });
  });

  describe("asSupplyAmount", () => {
    test("should accept valid positive amounts", () => {
      expect(asSupplyAmount(1_000_000n)).toBe(1_000_000n);
      expect(asSupplyAmount(1n)).toBe(1n);
    });

    test("should reject zero supply", () => {
      expect(() => asSupplyAmount(0n)).toThrow("Supply amount must be positive");
    });

    test("should reject negative supply", () => {
      expect(() => asSupplyAmount(-1n)).toThrow("Supply amount must be positive");
    });
  });

  describe("asHolderPercentage", () => {
    test("should accept valid percentages", () => {
      expect(asHolderPercentage(0)).toBe(0);
      expect(asHolderPercentage(50)).toBe(50);
      expect(asHolderPercentage(100)).toBe(100);
    });

    test("should reject negative percentage", () => {
      expect(() => asHolderPercentage(-1)).toThrow(
        "Holder percentage must be between 0 and 100"
      );
    });

    test("should reject percentage > 100", () => {
      expect(() => asHolderPercentage(101)).toThrow(
        "Holder percentage must be between 0 and 100"
      );
    });

    test("should reject non-finite percentage", () => {
      expect(() => asHolderPercentage(NaN)).toThrow(
        "Holder percentage must be between 0 and 100"
      );
      expect(() => asHolderPercentage(Infinity)).toThrow(
        "Holder percentage must be between 0 and 100"
      );
    });
  });

  describe("asChangePercentage", () => {
    test("should accept valid percentages (including negative)", () => {
      expect(asChangePercentage(0)).toBe(0);
      expect(asChangePercentage(50)).toBe(50);
      expect(asChangePercentage(-50)).toBe(-50);
      expect(asChangePercentage(200)).toBe(200); // Can be > 100
    });

    test("should reject non-finite percentage", () => {
      expect(() => asChangePercentage(NaN)).toThrow(
        "Change percentage must be finite"
      );
      expect(() => asChangePercentage(Infinity)).toThrow(
        "Change percentage must be finite"
      );
    });
  });

  describe("asMonitorInterval", () => {
    test("should accept valid intervals", () => {
      expect(asMonitorInterval(1000)).toBe(1000);
      expect(asMonitorInterval(5000)).toBe(5000);
    });

    test("should reject zero or negative intervals", () => {
      expect(() => asMonitorInterval(0)).toThrow(
        "Monitor interval must be positive"
      );
      expect(() => asMonitorInterval(-1000)).toThrow(
        "Monitor interval must be positive"
      );
    });

    test("should reject non-finite intervals", () => {
      expect(() => asMonitorInterval(NaN)).toThrow(
        "Monitor interval must be positive"
      );
      expect(() => asMonitorInterval(Infinity)).toThrow(
        "Monitor interval must be positive"
      );
    });
  });
});

describe("Change Calculation Functions", () => {
  describe("calculateLiquidityChange", () => {
    test("should calculate positive liquidity change", () => {
      const previous: LiquiditySnapshot = {
        poolAddress: "test",
        tokenReserve: asLiquidityAmount(1_000_000n),
        solReserve: asLiquidityAmount(10_000_000_000n),
        totalValueLamports: asLamports(20_000_000_000n),
        timestamp: new Date(),
      };

      const current: LiquiditySnapshot = {
        ...previous,
        totalValueLamports: asLamports(24_000_000_000n), // 20% increase
        timestamp: new Date(),
      };

      const change = calculateLiquidityChange(previous, current);
      expect(change).toBeCloseTo(20, 1);
    });

    test("should calculate negative liquidity change (rug)", () => {
      const previous: LiquiditySnapshot = {
        poolAddress: "test",
        tokenReserve: asLiquidityAmount(1_000_000n),
        solReserve: asLiquidityAmount(10_000_000_000n),
        totalValueLamports: asLamports(20_000_000_000n),
        timestamp: new Date(),
      };

      const current: LiquiditySnapshot = {
        ...previous,
        totalValueLamports: asLamports(10_000_000_000n), // 50% drop
        timestamp: new Date(),
      };

      const change = calculateLiquidityChange(previous, current);
      expect(change).toBeCloseTo(-50, 1);
    });

    test("should calculate zero change", () => {
      const previous: LiquiditySnapshot = {
        poolAddress: "test",
        tokenReserve: asLiquidityAmount(1_000_000n),
        solReserve: asLiquidityAmount(10_000_000_000n),
        totalValueLamports: asLamports(20_000_000_000n),
        timestamp: new Date(),
      };

      const current: LiquiditySnapshot = {
        ...previous,
        timestamp: new Date(),
      };

      const change = calculateLiquidityChange(previous, current);
      expect(change).toBe(0);
    });

    test("should handle zero baseline (edge case)", () => {
      const previous: LiquiditySnapshot = {
        poolAddress: "test",
        tokenReserve: asLiquidityAmount(0n),
        solReserve: asLiquidityAmount(0n),
        totalValueLamports: asLamports(0n),
        timestamp: new Date(),
      };

      const current: LiquiditySnapshot = {
        ...previous,
        totalValueLamports: asLamports(10_000_000_000n),
        timestamp: new Date(),
      };

      const change = calculateLiquidityChange(previous, current);
      expect(change).toBe(0); // No previous value to compare
    });
  });

  describe("calculateSupplyChange", () => {
    test("should calculate supply increase", () => {
      const previous: SupplySnapshot = {
        totalSupply: asSupplyAmount(1_000_000_000n),
        circulatingSupply: asSupplyAmount(1_000_000_000n),
        timestamp: new Date(),
      };

      const current: SupplySnapshot = {
        totalSupply: asSupplyAmount(1_100_000_000n), // 10% increase
        circulatingSupply: asSupplyAmount(1_100_000_000n),
        timestamp: new Date(),
      };

      const change = calculateSupplyChange(previous, current);
      expect(change).toBeCloseTo(10, 1);
    });

    test("should calculate supply decrease (burn)", () => {
      const previous: SupplySnapshot = {
        totalSupply: asSupplyAmount(1_000_000_000n),
        circulatingSupply: asSupplyAmount(1_000_000_000n),
        timestamp: new Date(),
      };

      const current: SupplySnapshot = {
        totalSupply: asSupplyAmount(900_000_000n), // 10% decrease
        circulatingSupply: asSupplyAmount(900_000_000n),
        timestamp: new Date(),
      };

      const change = calculateSupplyChange(previous, current);
      expect(change).toBeCloseTo(-10, 1);
    });

    test("should calculate large supply increase (rug)", () => {
      const previous: SupplySnapshot = {
        totalSupply: asSupplyAmount(1_000_000_000n),
        circulatingSupply: asSupplyAmount(1_000_000_000n),
        timestamp: new Date(),
      };

      const current: SupplySnapshot = {
        totalSupply: asSupplyAmount(2_000_000_000n), // 100% increase
        circulatingSupply: asSupplyAmount(2_000_000_000n),
        timestamp: new Date(),
      };

      const change = calculateSupplyChange(previous, current);
      expect(change).toBeCloseTo(100, 1);
    });
  });

  describe("calculateHolderChange", () => {
    test("should calculate holder balance increase", () => {
      const previous = asSupplyAmount(100_000_000n);
      const current = asSupplyAmount(150_000_000n); // 50% increase

      const change = calculateHolderChange(previous, current);
      expect(change).toBeCloseTo(50, 1);
    });

    test("should calculate holder balance decrease (dump)", () => {
      const previous = asSupplyAmount(100_000_000n);
      const current = asSupplyAmount(50_000_000n); // 50% decrease

      const change = calculateHolderChange(previous, current);
      expect(change).toBeCloseTo(-50, 1);
    });

    test("should calculate complete holder exit", () => {
      const previous = asSupplyAmount(100_000_000n);
      const current = asSupplyAmount(1n); // Near 100% decrease

      const change = calculateHolderChange(previous, current);
      expect(change).toBeCloseTo(-100, 0);
    });

    test("should handle very small baseline (new holder)", () => {
      const previous = asSupplyAmount(1n); // Very small amount
      const current = asSupplyAmount(100_000_000n);

      const change = calculateHolderChange(previous, current);
      expect(change).toBeGreaterThan(0); // Large positive change
    });
  });

  describe("calculateHolderPercentage", () => {
    test("should calculate holder percentage correctly", () => {
      const holderBalance = asSupplyAmount(250_000_000n);
      const totalSupply = asSupplyAmount(1_000_000_000n);

      const percentage = calculateHolderPercentage(holderBalance, totalSupply);
      expect(percentage).toBeCloseTo(25, 1);
    });

    test("should calculate 100% holder (single holder)", () => {
      const holderBalance = asSupplyAmount(1_000_000_000n);
      const totalSupply = asSupplyAmount(1_000_000_000n);

      const percentage = calculateHolderPercentage(holderBalance, totalSupply);
      expect(percentage).toBeCloseTo(100, 1);
    });

    test("should calculate small holder percentage", () => {
      const holderBalance = asSupplyAmount(1_000_000n);
      const totalSupply = asSupplyAmount(1_000_000_000n);

      const percentage = calculateHolderPercentage(holderBalance, totalSupply);
      expect(percentage).toBeCloseTo(0.1, 2);
    });

    test("should handle very small supply (edge case)", () => {
      const holderBalance = asSupplyAmount(1n);
      const totalSupply = asSupplyAmount(1n); // Holder owns everything

      const percentage = calculateHolderPercentage(holderBalance, totalSupply);
      expect(percentage).toBeCloseTo(100, 1);
    });
  });
});

describe("Rug Detection Logic", () => {
  describe("determineRugSeverity", () => {
    test("should determine CRITICAL severity for >90% liquidity drop", () => {
      const evidence: RugEvidence = {
        type: "LIQUIDITY_REMOVAL",
        previousSnapshot: {
          poolAddress: "test",
          tokenReserve: asLiquidityAmount(1_000_000n),
          solReserve: asLiquidityAmount(10_000_000_000n),
          totalValueLamports: asLamports(20_000_000_000n),
          timestamp: new Date(),
        },
        currentSnapshot: {
          poolAddress: "test",
          tokenReserve: asLiquidityAmount(100_000n),
          solReserve: asLiquidityAmount(1_000_000_000n),
          totalValueLamports: asLamports(2_000_000_000n),
          timestamp: new Date(),
        },
        dropPercentage: asChangePercentage(-90),
        removedValueLamports: asLamports(18_000_000_000n),
      };

      const severity = determineRugSeverity("LIQUIDITY_REMOVAL", evidence);
      expect(severity).toBe("CRITICAL");
    });

    test("should determine HIGH severity for 75-90% liquidity drop", () => {
      const evidence: RugEvidence = {
        type: "LIQUIDITY_REMOVAL",
        previousSnapshot: {
          poolAddress: "test",
          tokenReserve: asLiquidityAmount(1_000_000n),
          solReserve: asLiquidityAmount(10_000_000_000n),
          totalValueLamports: asLamports(20_000_000_000n),
          timestamp: new Date(),
        },
        currentSnapshot: {
          poolAddress: "test",
          tokenReserve: asLiquidityAmount(200_000n),
          solReserve: asLiquidityAmount(2_000_000_000n),
          totalValueLamports: asLamports(4_000_000_000n),
          timestamp: new Date(),
        },
        dropPercentage: asChangePercentage(-80),
        removedValueLamports: asLamports(16_000_000_000n),
      };

      const severity = determineRugSeverity("LIQUIDITY_REMOVAL", evidence);
      expect(severity).toBe("HIGH");
    });

    test("should determine CRITICAL severity for authority re-enablement", () => {
      const evidence: RugEvidence = {
        type: "AUTHORITY_REENABLED",
        previousState: {
          mintAuthority: null,
          freezeAuthority: null,
          checkedAt: new Date(),
        },
        currentState: {
          mintAuthority: "test-authority",
          freezeAuthority: null,
          checkedAt: new Date(),
        },
        changedAuthorities: ["mint"],
        reenabledBy: "test-signature",
      };

      const severity = determineRugSeverity("AUTHORITY_REENABLED", evidence);
      expect(severity).toBe("CRITICAL");
    });

    test("should determine CRITICAL severity for >50% supply increase", () => {
      const evidence: RugEvidence = {
        type: "SUPPLY_MANIPULATION",
        previousSnapshot: {
          totalSupply: asSupplyAmount(1_000_000_000n),
          circulatingSupply: asSupplyAmount(1_000_000_000n),
          timestamp: new Date(),
        },
        currentSnapshot: {
          totalSupply: asSupplyAmount(1_600_000_000n),
          circulatingSupply: asSupplyAmount(1_600_000_000n),
          timestamp: new Date(),
        },
        supplyIncrease: asSupplyAmount(600_000_000n),
        increasePercentage: asChangePercentage(60),
        mintedBy: "test-signature",
      };

      const severity = determineRugSeverity("SUPPLY_MANIPULATION", evidence);
      expect(severity).toBe("CRITICAL");
    });

    test("should determine CRITICAL severity for >20% holder dump", () => {
      const evidence: RugEvidence = {
        type: "HOLDER_DUMP",
        holder: {
          address: "test-holder",
          balance: asSupplyAmount(250_000_000n),
          percentageOfSupply: asHolderPercentage(25),
        },
        activity: {
          holder: {
            address: "test-holder",
            balance: asSupplyAmount(250_000_000n),
            percentageOfSupply: asHolderPercentage(25),
          },
          previousBalance: asSupplyAmount(250_000_000n),
          currentBalance: asSupplyAmount(1n), // Near-complete exit
          changePercentage: asChangePercentage(-100),
          timestamp: new Date(),
        },
        soldAmount: asSupplyAmount(250_000_000n),
        sellPercentage: asChangePercentage(-100),
        affectedMarketPct: asHolderPercentage(25), // >20% of market
      };

      const severity = determineRugSeverity("HOLDER_DUMP", evidence);
      expect(severity).toBe("CRITICAL");
    });
  });

  describe("determineExitRecommendation", () => {
    test("should recommend EXIT_EMERGENCY for CRITICAL with high confidence", () => {
      const recommendation = determineExitRecommendation("CRITICAL", 95);
      expect(recommendation).toBe("EXIT_EMERGENCY");
    });

    test("should recommend EXIT_FULL for CRITICAL with medium confidence", () => {
      const recommendation = determineExitRecommendation("CRITICAL", 80);
      expect(recommendation).toBe("EXIT_FULL");
    });

    test("should recommend EXIT_FULL for HIGH with high confidence", () => {
      const recommendation = determineExitRecommendation("HIGH", 85);
      expect(recommendation).toBe("EXIT_FULL");
    });

    test("should recommend EXIT_PARTIAL for HIGH with medium confidence", () => {
      const recommendation = determineExitRecommendation("HIGH", 70);
      expect(recommendation).toBe("EXIT_PARTIAL");
    });

    test("should recommend HOLD for MEDIUM with low confidence", () => {
      const recommendation = determineExitRecommendation("MEDIUM", 50);
      expect(recommendation).toBe("HOLD");
    });

    test("should recommend HOLD for LOW severity", () => {
      const recommendation = determineExitRecommendation("LOW", 90);
      expect(recommendation).toBe("HOLD");
    });
  });

  describe("calculateRugConfidence", () => {
    test("should calculate high confidence for large liquidity drop", () => {
      const evidence: RugEvidence = {
        type: "LIQUIDITY_REMOVAL",
        previousSnapshot: {
          poolAddress: "test",
          tokenReserve: asLiquidityAmount(1_000_000n),
          solReserve: asLiquidityAmount(10_000_000_000n),
          totalValueLamports: asLamports(20_000_000_000n),
          timestamp: new Date(),
        },
        currentSnapshot: {
          poolAddress: "test",
          tokenReserve: asLiquidityAmount(0n),
          solReserve: asLiquidityAmount(0n),
          totalValueLamports: asLamports(0n),
          timestamp: new Date(),
        },
        dropPercentage: asChangePercentage(-100),
        removedValueLamports: asLamports(20_000_000_000n),
      };

      const confidence = calculateRugConfidence("LIQUIDITY_REMOVAL", evidence);
      expect(confidence).toBeGreaterThan(90);
    });

    test("should calculate 95% confidence for authority re-enablement", () => {
      const evidence: RugEvidence = {
        type: "AUTHORITY_REENABLED",
        previousState: {
          mintAuthority: null,
          freezeAuthority: null,
          checkedAt: new Date(),
        },
        currentState: {
          mintAuthority: "test-authority",
          freezeAuthority: "test-authority",
          checkedAt: new Date(),
        },
        changedAuthorities: ["mint", "freeze"],
        reenabledBy: "test-signature",
      };

      const confidence = calculateRugConfidence("AUTHORITY_REENABLED", evidence);
      expect(confidence).toBe(95);
    });

    test("should calculate 98% confidence for multiple indicators", () => {
      const evidence: RugEvidence = {
        type: "MULTIPLE_INDICATORS",
        detections: [],
        combinedSeverity: "CRITICAL",
      };

      const confidence = calculateRugConfidence("MULTIPLE_INDICATORS", evidence);
      expect(confidence).toBe(98);
    });
  });

  describe("createRugDetection", () => {
    test("should create complete rug detection object", () => {
      const evidence: RugEvidence = {
        type: "LIQUIDITY_REMOVAL",
        previousSnapshot: {
          poolAddress: "test",
          tokenReserve: asLiquidityAmount(1_000_000n),
          solReserve: asLiquidityAmount(10_000_000_000n),
          totalValueLamports: asLamports(20_000_000_000n),
          timestamp: new Date(),
        },
        currentSnapshot: {
          poolAddress: "test",
          tokenReserve: asLiquidityAmount(100_000n),
          solReserve: asLiquidityAmount(1_000_000_000n),
          totalValueLamports: asLamports(2_000_000_000n),
          timestamp: new Date(),
        },
        dropPercentage: asChangePercentage(-90),
        removedValueLamports: asLamports(18_000_000_000n),
      };

      const detection = createRugDetection("LIQUIDITY_REMOVAL", evidence);

      expect(detection.rugType).toBe("LIQUIDITY_REMOVAL");
      expect(detection.severity).toBe("CRITICAL");
      expect(detection.confidence).toBeGreaterThan(90);
      expect(detection.recommendation).toBe("EXIT_EMERGENCY");
      expect(detection.evidence).toEqual(evidence);
      expect(detection.detectedAt).toBeInstanceOf(Date);
    });

    test("should create rug detection with calculated fields", () => {
      const evidence: RugEvidence = {
        type: "HOLDER_DUMP",
        holder: {
          address: "test-holder",
          balance: asSupplyAmount(150_000_000n),
          percentageOfSupply: asHolderPercentage(15),
        },
        activity: {
          holder: {
            address: "test-holder",
            balance: asSupplyAmount(150_000_000n),
            percentageOfSupply: asHolderPercentage(15),
          },
          previousBalance: asSupplyAmount(150_000_000n),
          currentBalance: asSupplyAmount(50_000_000n),
          changePercentage: asChangePercentage(-67),
          timestamp: new Date(),
        },
        soldAmount: asSupplyAmount(100_000_000n),
        sellPercentage: asChangePercentage(-67),
        affectedMarketPct: asHolderPercentage(10), // 10% of market dumped
      };

      const detection = createRugDetection("HOLDER_DUMP", evidence);

      expect(detection.rugType).toBe("HOLDER_DUMP");
      expect(detection.severity).toBe("HIGH"); // 10% of market = HIGH severity
      expect(detection.confidence).toBeGreaterThanOrEqual(50);
      expect(detection.recommendation).toBe("EXIT_FULL"); // HIGH severity + high confidence
    });
  });
});
