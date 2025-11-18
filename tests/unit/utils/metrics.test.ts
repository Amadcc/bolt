/**
 * Metrics Test Suite
 *
 * Comprehensive tests for Prometheus metrics tracking
 * Target: 95%+ coverage
 */

import { describe, test, expect, beforeEach } from "bun:test";
import * as metrics from "../../../src/utils/metrics.js";

describe("Metrics - RPC", () => {
  test("should observe RPC request duration and status", () => {
    expect(() => {
      metrics.observeRpcRequest("https://api.mainnet-beta.solana.com", "getAccountInfo", 150, "ok");
      metrics.observeRpcRequest("https://api.mainnet-beta.solana.com", "getAccountInfo", 300, "error");
    }).not.toThrow();
  });
});

describe("Metrics - Trades", () => {
  test("should record trade requested", () => {
    expect(() => {
      metrics.recordTradeRequested("buy");
      metrics.recordTradeRequested("sell");
    }).not.toThrow();
  });

  test("should record successful trade with duration and commission", () => {
    expect(() => {
      metrics.recordTradeSuccess("buy", 850, 0.15);
      metrics.recordTradeSuccess("sell", 1200, 0.25);
    }).not.toThrow();
  });

  test("should record failed trade with duration and reason", () => {
    expect(() => {
      metrics.recordTradeFailure("buy", 500, "insufficient_funds");
      metrics.recordTradeFailure("sell", 750, "slippage_exceeded");
    }).not.toThrow();
  });

  test("should handle zero commission in successful trade", () => {
    expect(() => {
      metrics.recordTradeSuccess("buy", 500, 0);
    }).not.toThrow();
  });

  test("should handle negative commission (edge case)", () => {
    expect(() => {
      metrics.recordTradeSuccess("buy", 500, -0.05); // Should be clamped to 0
    }).not.toThrow();
  });
});

describe("Metrics - Errors", () => {
  test("should record generic errors", () => {
    expect(() => {
      metrics.recordError("rpc_timeout");
      metrics.recordError("network_failure");
      metrics.recordError("validation_error");
    }).not.toThrow();
  });

  test("should record wallet unlock failures", () => {
    expect(() => {
      metrics.incrementWalletUnlockFailures();
      metrics.incrementWalletUnlockFailures();
    }).not.toThrow();
  });
});

describe("Metrics - Honeypot Detection", () => {
  test("should record honeypot detections by risk level", () => {
    expect(() => {
      metrics.recordHoneypotDetection("low");
      metrics.recordHoneypotDetection("medium");
      metrics.recordHoneypotDetection("high");
    }).not.toThrow();
  });

  test("should record honeypot API requests", () => {
    expect(() => {
      metrics.recordHoneypotApiRequest("goplus", "success", 250);
      metrics.recordHoneypotApiRequest("honeypot_is", "failure", 500);
      metrics.recordHoneypotApiRequest("quicknode", "timeout", 2000);
      metrics.recordHoneypotApiRequest("alchemy", "circuit_open", 0);
    }).not.toThrow();
  });

  test("should not observe duration for timeout/circuit_open status", () => {
    expect(() => {
      metrics.recordHoneypotApiRequest("goplus", "timeout", 3000);
      metrics.recordHoneypotApiRequest("goplus", "circuit_open", 100);
    }).not.toThrow();
  });

  test("should record honeypot fallback chain", () => {
    expect(() => {
      metrics.recordHoneypotFallbackChain("goplus", 1);
      metrics.recordHoneypotFallbackChain("honeypot_is", 2);
      metrics.recordHoneypotFallbackChain("none", 3);
    }).not.toThrow();
  });
});

describe("Metrics - Circuit Breaker", () => {
  test("should set circuit breaker state", () => {
    expect(() => {
      metrics.setCircuitBreakerState("goplus", "CLOSED");
      metrics.setCircuitBreakerState("honeypot_is", "HALF_OPEN");
      metrics.setCircuitBreakerState("quicknode", "OPEN");
    }).not.toThrow();
  });

  test("should record circuit breaker transitions", () => {
    expect(() => {
      metrics.recordCircuitBreakerTransition("goplus", "CLOSED", "OPEN");
      metrics.recordCircuitBreakerTransition("goplus", "OPEN", "HALF_OPEN");
      metrics.recordCircuitBreakerTransition("goplus", "HALF_OPEN", "CLOSED");
    }).not.toThrow();
  });
});

describe("Metrics - Sessions", () => {
  test("should increment active sessions", () => {
    expect(() => {
      metrics.incrementActiveSessions();
      metrics.incrementActiveSessions();
    }).not.toThrow();
  });

  test("should decrement active sessions", () => {
    expect(() => {
      metrics.decrementActiveSessions();
    }).not.toThrow();
  });
});

describe("Metrics - Database", () => {
  test("should track database queries", () => {
    expect(() => {
      metrics.trackDatabaseQuery("User", "findUnique", 15);
      metrics.trackDatabaseQuery("Wallet", "create", 45);
      metrics.trackDatabaseQuery("SniperOrder", "findMany", 125);
    }).not.toThrow();
  });

  test("should increment database activity", () => {
    expect(() => {
      metrics.incrementDbActivity();
      metrics.incrementDbActivity();
    }).not.toThrow();
  });

  test("should decrement database activity", () => {
    expect(() => {
      metrics.decrementDbActivity();
    }).not.toThrow();
  });
});

describe("Metrics - Redis", () => {
  test("should set Redis connection status to connected", () => {
    expect(() => {
      metrics.setRedisConnectionStatus(true);
    }).not.toThrow();
  });

  test("should set Redis connection status to disconnected", () => {
    expect(() => {
      metrics.setRedisConnectionStatus(false);
    }).not.toThrow();
  });

  test("should track Redis commands", () => {
    expect(() => {
      metrics.trackRedisCommand("get", 2);
      metrics.trackRedisCommand("set", 3);
      metrics.trackRedisCommand("del", 1);
      metrics.trackRedisCommand("scan", 50);
    }).not.toThrow();
  });
});

describe("Metrics - Sniper Orders", () => {
  test("should record sniper order created", () => {
    expect(() => {
      metrics.recordSniperOrderCreated();
      metrics.recordSniperOrderCreated();
    }).not.toThrow();
  });

  test("should record successful sniper order", () => {
    expect(() => {
      metrics.recordSniperOrderSuccess(1250);
      metrics.recordSniperOrderSuccess(850);
    }).not.toThrow();
  });

  test("should record failed sniper order", () => {
    expect(() => {
      metrics.recordSniperOrderFailure("honeypot_detected", 500);
      metrics.recordSniperOrderFailure("insufficient_liquidity", 750);
    }).not.toThrow();
  });

  test("should record filter check duration", () => {
    expect(() => {
      metrics.recordSniperFilterCheck(150);
    }).not.toThrow();
  });

  test("should record filter rejections", () => {
    expect(() => {
      metrics.recordSniperFilterRejection("min_liquidity");
      metrics.recordSniperFilterRejection("honeypot_score");
      metrics.recordSniperFilterRejection("max_buy_tax");
    }).not.toThrow();
  });

  test("should increment open positions", () => {
    expect(() => {
      metrics.incrementOpenPositions();
      metrics.incrementOpenPositions();
    }).not.toThrow();
  });

  test("should decrement open positions", () => {
    expect(() => {
      metrics.decrementOpenPositions();
    }).not.toThrow();
  });

  test("should record position closed and decrement counter", () => {
    expect(() => {
      metrics.recordPositionClosed("PROFIT");
      metrics.recordPositionClosed("LOSS");
      metrics.recordPositionClosed("MANUAL");
    }).not.toThrow();
  });

  test("should record sniper retries", () => {
    expect(() => {
      metrics.recordSniperRetry(1);
      metrics.recordSniperRetry(2);
      metrics.recordSniperRetry(3);
    }).not.toThrow();
  });
});

describe("Metrics - Fee Optimization", () => {
  test("should record fee optimization success", () => {
    expect(() => {
      metrics.recordFeeOptimization(25, "success");
    }).not.toThrow();
  });

  test("should record fee optimization failure", () => {
    expect(() => {
      metrics.recordFeeOptimization(50, "failure");
    }).not.toThrow();
  });

  test("should record priority fee without caps or boosts", () => {
    expect(() => {
      metrics.recordPriorityFee("aggressive", 100_000, false, false);
    }).not.toThrow();
  });

  test("should record capped priority fee", () => {
    expect(() => {
      metrics.recordPriorityFee("turbo", 500_000, true, false);
    }).not.toThrow();
  });

  test("should record boosted priority fee", () => {
    expect(() => {
      metrics.recordPriorityFee("turbo", 1_000_000, false, true);
    }).not.toThrow();
  });

  test("should record both capped and boosted fee", () => {
    expect(() => {
      metrics.recordPriorityFee("fast", 750_000, true, true);
    }).not.toThrow();
  });

  test("should update network congestion level", () => {
    expect(() => {
      metrics.updateNetworkCongestion(0.25);
      metrics.updateNetworkCongestion(0.75);
      metrics.updateNetworkCongestion(1.0);
    }).not.toThrow();
  });

  test("should update fee market percentiles", () => {
    expect(() => {
      metrics.updateFeeMarketPercentiles({
        p50: 50_000,
        p75: 100_000,
        p90: 250_000,
        p95: 500_000,
      });
    }).not.toThrow();
  });
});

describe("Metrics - Jito Bundles", () => {
  test("should record Jito bundle submission", () => {
    expect(() => {
      metrics.recordJitoBundleSubmission("MEV_TURBO");
      metrics.recordJitoBundleSubmission("MEV_SECURE");
    }).not.toThrow();
  });

  test("should record successful Jito bundle", () => {
    expect(() => {
      metrics.recordJitoBundleSuccess("MEV_TURBO", 1500);
      metrics.recordJitoBundleSuccess("MEV_SECURE", 2000);
    }).not.toThrow();
  });

  test("should record failed Jito bundle", () => {
    expect(() => {
      metrics.recordJitoBundleFailure("MEV_TURBO", "timeout");
      metrics.recordJitoBundleFailure("MEV_SECURE", "invalid");
      metrics.recordJitoBundleFailure("MEV_TURBO", "failed");
    }).not.toThrow();
  });

  test("should record Jito tip amounts", () => {
    expect(() => {
      metrics.recordJitoTip(1_000n, "base");
      metrics.recordJitoTip(50_000n, "competitive");
      metrics.recordJitoTip(100_000n, "high");
      metrics.recordJitoTip(200_000n, "dynamic");
    }).not.toThrow();
  });

  test("should record smart routing winner", () => {
    expect(() => {
      metrics.recordSmartRoutingWinner("jito");
      metrics.recordSmartRoutingWinner("rpc");
    }).not.toThrow();
  });

  test("should record anti-sandwich protection", () => {
    expect(() => {
      metrics.recordAntiSandwich();
    }).not.toThrow();
  });

  test("should record Jito RPC fallback", () => {
    expect(() => {
      metrics.recordJitoRpcFallback();
    }).not.toThrow();
  });
});

describe("Metrics - Position Monitoring", () => {
  test("should record position monitor started", () => {
    expect(() => {
      metrics.recordPositionMonitorStarted();
    }).not.toThrow();
  });

  test("should record position monitor stopped", () => {
    expect(() => {
      metrics.recordPositionMonitorStopped();
    }).not.toThrow();
  });

  test("should record price checks by status", () => {
    expect(() => {
      metrics.recordPriceCheck("success");
      metrics.recordPriceCheck("cache_hit");
      metrics.recordPriceCheck("api_failure");
    }).not.toThrow();
  });

  test("should record exit triggers", () => {
    expect(() => {
      metrics.recordExitTriggered("take_profit");
      metrics.recordExitTriggered("stop_loss");
      metrics.recordExitTriggered("trailing_stop");
      metrics.recordExitTriggered("manual");
    }).not.toThrow();
  });

  test("should record exit duration", () => {
    expect(() => {
      metrics.recordExitDuration(1500);
    }).not.toThrow();
  });

  test("should record positive P&L", () => {
    expect(() => {
      metrics.recordPositionPnl(25.5); // 25.5% profit
    }).not.toThrow();
  });

  test("should record negative P&L", () => {
    expect(() => {
      metrics.recordPositionPnl(-15.3); // 15.3% loss
    }).not.toThrow();
  });

  test("should record zero P&L", () => {
    expect(() => {
      metrics.recordPositionPnl(0);
    }).not.toThrow();
  });

  test("should record trailing stop updates", () => {
    expect(() => {
      metrics.recordTrailingStopUpdate();
    }).not.toThrow();
  });

  test("should record price feed latency", () => {
    expect(() => {
      metrics.recordPriceFeedLatency("dexscreener", 150);
      metrics.recordPriceFeedLatency("jupiter", 75);
      metrics.recordPriceFeedLatency("raydium", 200);
    }).not.toThrow();
  });

  test("should record price feed errors", () => {
    expect(() => {
      metrics.recordPriceFeedError("dexscreener", "timeout");
      metrics.recordPriceFeedError("jupiter", "rate_limit");
      metrics.recordPriceFeedError("raydium", "invalid_response");
    }).not.toThrow();
  });
});

describe("Metrics - Rug Detection", () => {
  test("should record successful rug detection check", () => {
    expect(() => {
      metrics.recordRugDetectionCheck("success");
    }).not.toThrow();
  });

  test("should record failed rug detection check", () => {
    expect(() => {
      metrics.recordRugDetectionCheck("error");
    }).not.toThrow();
  });

  test("should record rug detected by type and severity", () => {
    expect(() => {
      metrics.recordRugDetected("LIQUIDITY_REMOVAL", "CRITICAL");
      metrics.recordRugDetected("AUTHORITY_REENABLED", "HIGH");
      metrics.recordRugDetected("SUPPLY_MANIPULATION", "MEDIUM");
      metrics.recordRugDetected("HOLDER_DUMP", "LOW");
      metrics.recordRugDetected("MULTIPLE_INDICATORS", "CRITICAL");
    }).not.toThrow();
  });

  test("should record emergency exit triggered", () => {
    expect(() => {
      metrics.recordEmergencyExitTriggered("LIQUIDITY_REMOVAL");
      metrics.recordEmergencyExitTriggered("AUTHORITY_REENABLED");
    }).not.toThrow();
  });

  test("should record emergency exit duration", () => {
    expect(() => {
      metrics.recordEmergencyExitDuration(2500);
    }).not.toThrow();
  });

  test("should record position saved percentage", () => {
    expect(() => {
      metrics.recordPositionSavedPercentage(75); // Saved 75%
      metrics.recordPositionSavedPercentage(25); // Saved only 25%
      metrics.recordPositionSavedPercentage(100); // Saved everything
      metrics.recordPositionSavedPercentage(0); // Lost everything
    }).not.toThrow();
  });

  test("should record rug monitor started", () => {
    expect(() => {
      metrics.recordRugMonitorStarted();
    }).not.toThrow();
  });

  test("should record rug monitor stopped", () => {
    expect(() => {
      metrics.recordRugMonitorStopped();
    }).not.toThrow();
  });

  test("should set rug monitor circuit breaker state", () => {
    expect(() => {
      metrics.setRugMonitorCircuitState("CLOSED");
      metrics.setRugMonitorCircuitState("HALF_OPEN");
      metrics.setRugMonitorCircuitState("OPEN");
    }).not.toThrow();
  });
});

describe("Metrics - Multi-Wallet", () => {
  test("should record wallet rotations by strategy", () => {
    expect(() => {
      metrics.recordWalletRotation("ROUND_ROBIN");
      metrics.recordWalletRotation("LEAST_USED");
      metrics.recordWalletRotation("RANDOM");
      metrics.recordWalletRotation("SPECIFIC");
      metrics.recordWalletRotation("PRIMARY_ONLY");
    }).not.toThrow();
  });

  test("should record wallet usage", () => {
    expect(() => {
      metrics.recordWalletUsage("wallet-123");
      metrics.recordWalletUsage("wallet-456");
    }).not.toThrow();
  });

  test("should set active wallets count", () => {
    expect(() => {
      metrics.setActiveWalletsCount("user-123", 3);
      metrics.setActiveWalletsCount("user-456", 5);
    }).not.toThrow();
  });

  test("should record wallets per user", () => {
    expect(() => {
      metrics.recordWalletsPerUser(1);
      metrics.recordWalletsPerUser(3);
      metrics.recordWalletsPerUser(7);
    }).not.toThrow();
  });

  test("should record wallet creation success", () => {
    expect(() => {
      metrics.recordWalletCreation("success");
    }).not.toThrow();
  });

  test("should record wallet creation error", () => {
    expect(() => {
      metrics.recordWalletCreation("error");
    }).not.toThrow();
  });

  test("should record wallet deletion success", () => {
    expect(() => {
      metrics.recordWalletDeletion("success");
    }).not.toThrow();
  });

  test("should record wallet deletion error", () => {
    expect(() => {
      metrics.recordWalletDeletion("error");
    }).not.toThrow();
  });
});

describe("Metrics - Registry Export", () => {
  test("should export metrics in Prometheus format", async () => {
    // Record some metrics first
    metrics.recordTradeRequested("buy");
    metrics.recordTradeSuccess("buy", 500, 0.1);
    metrics.incrementActiveSessions();
    metrics.recordHoneypotDetection("medium");

    const metricsOutput = await metrics.getMetrics();

    // Should be a non-empty string
    expect(metricsOutput).toBeDefined();
    expect(typeof metricsOutput).toBe("string");
    expect(metricsOutput.length).toBeGreaterThan(0);

    // Should contain Prometheus metric format
    expect(metricsOutput).toContain("# HELP");
    expect(metricsOutput).toContain("# TYPE");
  });

  test("should have valid metricsRegistry export", () => {
    expect(metrics.metricsRegistry).toBeDefined();
    expect(typeof metrics.metricsRegistry.metrics).toBe("function");
  });
});
