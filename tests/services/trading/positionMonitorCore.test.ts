/**
 * Position Monitor Core Logic Tests
 * Tests trigger evaluation logic without external dependencies
 */

import { describe, test, expect } from "vitest";
import {
  asTokenPrice,
  asPercentage,
  calculateTakeProfitPrice,
  calculateStopLossPrice,
  calculateTrailingStopPrice,
  type PositionMonitorState,
  type ExitTrigger,
  type TokenPrice,
} from "../../../src/types/positionMonitor.js";
import { asTokenMint } from "../../../src/types/common.js";

/**
 * Simulate trigger evaluation logic from PositionMonitor
 */
function evaluateExitTrigger(
  monitor: Pick<
    PositionMonitorState,
    | "entryPrice"
    | "takeProfitPrice"
    | "stopLossPrice"
    | "trailingStopLoss"
    | "highestPriceSeen"
  >,
  currentPrice: TokenPrice
): ExitTrigger | null {
  // 1. Check take-profit
  if (monitor.takeProfitPrice && currentPrice >= monitor.takeProfitPrice) {
    const targetPct = ((monitor.takeProfitPrice - monitor.entryPrice) / monitor.entryPrice * 100) as number;
    return {
      type: "TAKE_PROFIT",
      triggerPrice: monitor.takeProfitPrice,
      currentPrice,
      targetPct: asPercentage(targetPct),
    };
  }

  // 2. Check trailing stop-loss
  if (
    monitor.trailingStopLoss &&
    monitor.highestPriceSeen &&
    monitor.stopLossPrice
  ) {
    const trailingPct = Math.abs(
      ((monitor.stopLossPrice - monitor.entryPrice) / monitor.entryPrice) * 100
    );
    const trailingStopPrice = calculateTrailingStopPrice(
      monitor.highestPriceSeen,
      asPercentage(trailingPct)
    );

    if (currentPrice <= trailingStopPrice) {
      return {
        type: "TRAILING_STOP",
        triggerPrice: trailingStopPrice,
        currentPrice,
        highestPrice: monitor.highestPriceSeen,
        trailingPct: asPercentage(trailingPct),
      };
    }
  }

  // 3. Check regular stop-loss
  if (monitor.stopLossPrice && currentPrice <= monitor.stopLossPrice) {
    const targetPct = Math.abs(
      ((monitor.stopLossPrice - monitor.entryPrice) / monitor.entryPrice) * 100
    );
    return {
      type: "STOP_LOSS",
      triggerPrice: monitor.stopLossPrice,
      currentPrice,
      targetPct: asPercentage(targetPct),
    };
  }

  return null;
}

describe("Position Monitor Trigger Evaluation", () => {
  const entryPrice = asTokenPrice(0.001);
  const takeProfitPct = asPercentage(20);
  const stopLossPct = asPercentage(10);

  const takeProfitPrice = calculateTakeProfitPrice(entryPrice, takeProfitPct);
  const stopLossPrice = calculateStopLossPrice(entryPrice, stopLossPct);

  describe("Take-Profit Triggers", () => {
    test("should trigger TP when price reaches target", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.0012); // 20% up

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).not.toBeNull();
      expect(trigger?.type).toBe("TAKE_PROFIT");
      if (trigger?.type === "TAKE_PROFIT") {
        expect(trigger.currentPrice).toBe(currentPrice);
        expect(trigger.triggerPrice).toBeCloseTo(0.0012, 6);
      }
    });

    test("should trigger TP when price exceeds target", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.0015); // 50% up

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).not.toBeNull();
      expect(trigger?.type).toBe("TAKE_PROFIT");
    });

    test("should not trigger TP when price below target", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.0011); // 10% up

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).toBeNull();
    });
  });

  describe("Stop-Loss Triggers", () => {
    test("should trigger SL when price reaches stop", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.0009); // 10% down

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).not.toBeNull();
      expect(trigger?.type).toBe("STOP_LOSS");
      if (trigger?.type === "STOP_LOSS") {
        expect(trigger.currentPrice).toBe(currentPrice);
        expect(trigger.triggerPrice).toBeCloseTo(0.0009, 6);
      }
    });

    test("should trigger SL when price drops below stop", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.0008); // 20% down

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).not.toBeNull();
      expect(trigger?.type).toBe("STOP_LOSS");
    });

    test("should not trigger SL when price above stop", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.00095); // 5% down

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).toBeNull();
    });
  });

  describe("Trailing Stop-Loss Triggers", () => {
    test("should trigger trailing stop when price drops from peak", () => {
      const highestPrice = asTokenPrice(0.0015); // 50% up from entry
      const trailingStop = calculateTrailingStopPrice(highestPrice, stopLossPct);

      const monitor = {
        entryPrice,
        takeProfitPrice: asTokenPrice(0.002), // Set higher TP so it doesn't trigger first
        stopLossPrice,
        trailingStopLoss: true,
        highestPriceSeen: highestPrice,
      };

      const currentPrice = asTokenPrice(0.0013); // Dropped below trailing stop

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).not.toBeNull();
      expect(trigger?.type).toBe("TRAILING_STOP");
      if (trigger?.type === "TRAILING_STOP") {
        expect(trigger.highestPrice).toBe(highestPrice);
        expect(trigger.triggerPrice).toBeCloseTo(trailingStop, 6);
      }
    });

    test("should not trigger trailing stop when price above trailing level", () => {
      const highestPrice = asTokenPrice(0.0015);

      const monitor = {
        entryPrice,
        takeProfitPrice: asTokenPrice(0.002), // Set higher TP
        stopLossPrice,
        trailingStopLoss: true,
        highestPriceSeen: highestPrice,
      };

      const currentPrice = asTokenPrice(0.0014); // Still above trailing stop

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).toBeNull();
    });
  });

  describe("Trigger Priority", () => {
    test("should prioritize TP over SL when both conditions met", () => {
      // Price meets both TP (upward) and somehow also SL
      // TP should win as it's checked first
      const monitor = {
        entryPrice,
        takeProfitPrice: asTokenPrice(0.0012), // 20% up
        stopLossPrice: asTokenPrice(0.0009), // 10% down
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.0013); // Hits TP

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      // TP is checked first, so it should trigger
      expect(trigger?.type).toBe("TAKE_PROFIT");
    });

    test("should prioritize trailing stop over regular SL", () => {
      const highestPrice = asTokenPrice(0.002); // 100% up
      const trailingStop = calculateTrailingStopPrice(highestPrice, stopLossPct);
      // trailingStop = 0.0018 (10% below 0.002)

      const monitor = {
        entryPrice,
        takeProfitPrice: asTokenPrice(0.003), // Set TP very high
        stopLossPrice, // 0.0009
        trailingStopLoss: true,
        highestPriceSeen: highestPrice,
      };

      const currentPrice = asTokenPrice(0.0017);
      // Below trailing stop (0.0018) but above regular SL (0.0009)

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger?.type).toBe("TRAILING_STOP");
    });
  });

  describe("Edge Cases", () => {
    test("should handle exact price match for TP", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = takeProfitPrice; // Exactly at TP

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger?.type).toBe("TAKE_PROFIT");
    });

    test("should handle exact price match for SL", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = stopLossPrice; // Exactly at SL

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger?.type).toBe("STOP_LOSS");
    });

    test("should handle no TP/SL configured", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice: null,
        stopLossPrice: null,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.002);

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger).toBeNull();
    });

    test("should handle only TP configured", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice,
        stopLossPrice: null,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.0012);

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger?.type).toBe("TAKE_PROFIT");
    });

    test("should handle only SL configured", () => {
      const monitor = {
        entryPrice,
        takeProfitPrice: null,
        stopLossPrice,
        trailingStopLoss: false,
        highestPriceSeen: null,
      };

      const currentPrice = asTokenPrice(0.0009);

      const trigger = evaluateExitTrigger(monitor, currentPrice);

      expect(trigger?.type).toBe("STOP_LOSS");
    });
  });
});
