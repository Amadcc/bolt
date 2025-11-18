/**
 * Position Monitor Type Tests
 * Tests for branded types and helper functions
 */

import { describe, test, expect } from "vitest";
import {
  asTokenPrice,
  asPercentage,
  calculateTakeProfitPrice,
  calculateStopLossPrice,
  calculateTrailingStopPrice,
  calculatePriceChangePct,
  calculatePnlLamports,
  calculatePnlPercentage,
  type TokenPrice,
  type Percentage,
} from "../../src/types/positionMonitor.js";
import { asLamports, type Lamports } from "../../src/types/common.js";

describe("Branded Type Constructors", () => {
  describe("asTokenPrice", () => {
    test("should accept valid positive prices", () => {
      expect(asTokenPrice(0.001)).toBe(0.001);
      expect(asTokenPrice(1.5)).toBe(1.5);
      expect(asTokenPrice(1000)).toBe(1000);
    });

    test("should reject zero price", () => {
      expect(() => asTokenPrice(0)).toThrow("Token price must be positive");
    });

    test("should reject negative price", () => {
      expect(() => asTokenPrice(-1)).toThrow("Token price must be positive");
    });

    test("should reject non-finite price", () => {
      expect(() => asTokenPrice(NaN)).toThrow("Token price must be positive");
      expect(() => asTokenPrice(Infinity)).toThrow("Token price must be positive");
    });
  });

  describe("asPercentage", () => {
    test("should accept valid percentages", () => {
      expect(asPercentage(0)).toBe(0);
      expect(asPercentage(50)).toBe(50);
      expect(asPercentage(100)).toBe(100);
    });

    test("should reject negative percentage", () => {
      expect(() => asPercentage(-1)).toThrow("Percentage must be between 0 and 100");
    });

    test("should reject percentage > 100", () => {
      expect(() => asPercentage(101)).toThrow("Percentage must be between 0 and 100");
    });

    test("should reject non-finite percentage", () => {
      expect(() => asPercentage(NaN)).toThrow("Percentage must be between 0 and 100");
      expect(() => asPercentage(Infinity)).toThrow("Percentage must be between 0 and 100");
    });
  });
});

describe("Price Calculation Functions", () => {
  describe("calculateTakeProfitPrice", () => {
    test("should calculate 20% take-profit correctly", () => {
      const entryPrice = asTokenPrice(1.0);
      const takeProfitPct = asPercentage(20);
      const result = calculateTakeProfitPrice(entryPrice, takeProfitPct);

      expect(result).toBe(1.2);
    });

    test("should calculate 50% take-profit correctly", () => {
      const entryPrice = asTokenPrice(0.001);
      const takeProfitPct = asPercentage(50);
      const result = calculateTakeProfitPrice(entryPrice, takeProfitPct);

      expect(result).toBeCloseTo(0.0015, 6);
    });

    test("should calculate 100% take-profit correctly", () => {
      const entryPrice = asTokenPrice(2.5);
      const takeProfitPct = asPercentage(100);
      const result = calculateTakeProfitPrice(entryPrice, takeProfitPct);

      expect(result).toBe(5.0);
    });

    test("should handle small percentages", () => {
      const entryPrice = asTokenPrice(1.0);
      const takeProfitPct = asPercentage(0.1);
      const result = calculateTakeProfitPrice(entryPrice, takeProfitPct);

      expect(result).toBeCloseTo(1.001, 6);
    });
  });

  describe("calculateStopLossPrice", () => {
    test("should calculate 10% stop-loss correctly", () => {
      const entryPrice = asTokenPrice(1.0);
      const stopLossPct = asPercentage(10);
      const result = calculateStopLossPrice(entryPrice, stopLossPct);

      expect(result).toBe(0.9);
    });

    test("should calculate 25% stop-loss correctly", () => {
      const entryPrice = asTokenPrice(0.002);
      const stopLossPct = asPercentage(25);
      const result = calculateStopLossPrice(entryPrice, stopLossPct);

      expect(result).toBeCloseTo(0.0015, 6);
    });

    test("should calculate 50% stop-loss correctly", () => {
      const entryPrice = asTokenPrice(4.0);
      const stopLossPct = asPercentage(50);
      const result = calculateStopLossPrice(entryPrice, stopLossPct);

      expect(result).toBe(2.0);
    });

    test("should handle small percentages", () => {
      const entryPrice = asTokenPrice(1.0);
      const stopLossPct = asPercentage(0.1);
      const result = calculateStopLossPrice(entryPrice, stopLossPct);

      expect(result).toBeCloseTo(0.999, 6);
    });
  });

  describe("calculateTrailingStopPrice", () => {
    test("should calculate trailing stop from highest price", () => {
      const highestPrice = asTokenPrice(1.5);
      const trailingPct = asPercentage(10);
      const result = calculateTrailingStopPrice(highestPrice, trailingPct);

      expect(result).toBeCloseTo(1.35, 6);
    });

    test("should calculate 20% trailing stop", () => {
      const highestPrice = asTokenPrice(2.0);
      const trailingPct = asPercentage(20);
      const result = calculateTrailingStopPrice(highestPrice, trailingPct);

      expect(result).toBe(1.6);
    });

    test("should handle small trailing percentages", () => {
      const highestPrice = asTokenPrice(1.0);
      const trailingPct = asPercentage(5);
      const result = calculateTrailingStopPrice(highestPrice, trailingPct);

      expect(result).toBeCloseTo(0.95, 6);
    });
  });

  describe("calculatePriceChangePct", () => {
    test("should calculate positive price change", () => {
      const entryPrice = asTokenPrice(1.0);
      const currentPrice = asTokenPrice(1.2);
      const result = calculatePriceChangePct(entryPrice, currentPrice);

      expect(result).toBeCloseTo(20, 1);
    });

    test("should calculate negative price change", () => {
      const entryPrice = asTokenPrice(1.0);
      const currentPrice = asTokenPrice(0.8);
      const result = calculatePriceChangePct(entryPrice, currentPrice);

      expect(result).toBeCloseTo(-20, 1);
    });

    test("should calculate zero price change", () => {
      const entryPrice = asTokenPrice(1.0);
      const currentPrice = asTokenPrice(1.0);
      const result = calculatePriceChangePct(entryPrice, currentPrice);

      expect(result).toBe(0);
    });

    test("should calculate large positive change", () => {
      const entryPrice = asTokenPrice(0.001);
      const currentPrice = asTokenPrice(0.005);
      const result = calculatePriceChangePct(entryPrice, currentPrice);

      expect(result).toBeCloseTo(400, 1);
    });

    test("should calculate large negative change", () => {
      const entryPrice = asTokenPrice(1.0);
      const currentPrice = asTokenPrice(0.1);
      const result = calculatePriceChangePct(entryPrice, currentPrice);

      expect(result).toBeCloseTo(-90, 1);
    });
  });
});

describe("P&L Calculation Functions", () => {
  describe("calculatePnlLamports", () => {
    test("should calculate positive P&L", () => {
      const amountIn = asLamports(100_000_000n); // 0.1 SOL
      const amountOut = asLamports(120_000_000n); // 0.12 SOL
      const result = calculatePnlLamports(amountIn, amountOut);

      expect(result).toBe(20_000_000n);
    });

    test("should calculate negative P&L", () => {
      const amountIn = asLamports(100_000_000n); // 0.1 SOL
      const amountOut = asLamports(80_000_000n); // 0.08 SOL
      const result = calculatePnlLamports(amountIn, amountOut);

      expect(result).toBe(-20_000_000n);
    });

    test("should calculate zero P&L", () => {
      const amountIn = asLamports(100_000_000n);
      const amountOut = asLamports(100_000_000n);
      const result = calculatePnlLamports(amountIn, amountOut);

      expect(result).toBe(0n);
    });

    test("should handle large amounts", () => {
      const amountIn = asLamports(10_000_000_000n); // 10 SOL
      const amountOut = asLamports(15_000_000_000n); // 15 SOL
      const result = calculatePnlLamports(amountIn, amountOut);

      expect(result).toBe(5_000_000_000n);
    });
  });

  describe("calculatePnlPercentage", () => {
    test("should calculate positive P&L percentage", () => {
      const amountIn = asLamports(100_000_000n);
      const amountOut = asLamports(120_000_000n);
      const result = calculatePnlPercentage(amountIn, amountOut);

      expect(result).toBeCloseTo(20, 1);
    });

    test("should calculate negative P&L percentage", () => {
      const amountIn = asLamports(100_000_000n);
      const amountOut = asLamports(75_000_000n);
      const result = calculatePnlPercentage(amountIn, amountOut);

      expect(result).toBeCloseTo(-25, 1);
    });

    test("should calculate zero P&L percentage", () => {
      const amountIn = asLamports(100_000_000n);
      const amountOut = asLamports(100_000_000n);
      const result = calculatePnlPercentage(amountIn, amountOut);

      expect(result).toBe(0);
    });

    test("should handle zero input (edge case)", () => {
      const amountIn = asLamports(0n);
      const amountOut = asLamports(100_000_000n);
      const result = calculatePnlPercentage(amountIn, amountOut);

      expect(result).toBe(0);
    });

    test("should calculate large percentage gains", () => {
      const amountIn = asLamports(100_000_000n);
      const amountOut = asLamports(500_000_000n); // 5x
      const result = calculatePnlPercentage(amountIn, amountOut);

      expect(result).toBeCloseTo(400, 1);
    });

    test("should calculate large percentage losses", () => {
      const amountIn = asLamports(100_000_000n);
      const amountOut = asLamports(10_000_000n); // 90% loss
      const result = calculatePnlPercentage(amountIn, amountOut);

      expect(result).toBeCloseTo(-90, 1);
    });
  });
});

describe("Integration: Full TP/SL Scenario", () => {
  test("should calculate correct TP/SL prices for typical trade", () => {
    // Entry: 0.001 SOL per token
    const entryPrice = asTokenPrice(0.001);
    const takeProfitPct = asPercentage(20);
    const stopLossPct = asPercentage(10);

    const tpPrice = calculateTakeProfitPrice(entryPrice, takeProfitPct);
    const slPrice = calculateStopLossPrice(entryPrice, stopLossPct);

    expect(tpPrice).toBeCloseTo(0.0012, 6);
    expect(slPrice).toBeCloseTo(0.0009, 6);

    // Verify TP triggers
    const currentPriceTP = asTokenPrice(0.00125);
    expect(currentPriceTP).toBeGreaterThan(tpPrice);

    // Verify SL triggers
    const currentPriceSL = asTokenPrice(0.00085);
    expect(currentPriceSL).toBeLessThan(slPrice);
  });

  test("should calculate correct trailing stop progression", () => {
    const entryPrice = asTokenPrice(0.001);
    const trailingPct = asPercentage(10);

    // Price increases to 0.0015 (50% up)
    let highestPrice = asTokenPrice(0.0015);
    let trailingStop = calculateTrailingStopPrice(highestPrice, trailingPct);
    expect(trailingStop).toBeCloseTo(0.00135, 6);

    // Price increases to 0.002 (100% up)
    highestPrice = asTokenPrice(0.002);
    trailingStop = calculateTrailingStopPrice(highestPrice, trailingPct);
    expect(trailingStop).toBeCloseTo(0.0018, 6);

    // Price drops to 0.0017 (still 70% up from entry)
    const currentPrice = asTokenPrice(0.0017);
    expect(currentPrice).toBeLessThan(trailingStop); // Should trigger!

    // Calculate final P&L
    const amountIn = asLamports(100_000_000n); // 0.1 SOL input
    // At entry: bought 100,000 tokens (0.1 SOL / 0.001 per token)
    // At exit: sell 100,000 tokens at 0.0017 per token = 0.17 SOL
    const amountOut = asLamports(170_000_000n); // 0.17 SOL output
    const pnlPct = calculatePnlPercentage(amountIn, amountOut);

    expect(pnlPct).toBeCloseTo(70, 0); // Should be 70% profit
  });
});
