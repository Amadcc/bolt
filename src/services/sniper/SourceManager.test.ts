/**
 * Integration tests for SourceManager
 *
 * Tests:
 * - Source initialization (config-based)
 * - Start/stop lifecycle
 * - Health & metrics aggregation
 * - Duplicate detection logic
 * - Priority scoring
 * - Meteora anti-sniper filtering
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { SourceManager } from "./SourceManager.js";
import type { ScoredPoolDetection } from "./SourceManager.js";
import type { RawPoolDetection } from "./sources/BaseSource.js";
import { Connection } from "@solana/web3.js";
import type { MeteoraAntiSniperConfig } from "../../types/sniper.js";
import { asTokenMint, asSolanaAddress } from "../../types/common.js";

const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

describe("SourceManager - Initialization", () => {
  test("should initialize all sources with default config", () => {
    const manager = new SourceManager(createMockConnection());
    const health = manager.getHealth();

    // Default: All sources enabled (including Meteora since anti-sniper is implemented)
    expect(health.raydium_v4).toBeDefined();
    expect(health.raydium_clmm).toBeDefined();
    expect(health.orca_whirlpool).toBeDefined();
    expect(health.pump_fun).toBeDefined();
    expect(health.meteora).toBeDefined(); // ✅ Now enabled by default!
  });

  test("should initialize only enabled sources", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableRaydiumV4: true,
      enableRaydiumCLMM: false,
      enableOrcaWhirlpool: false,
      enableMeteora: false,
      enablePumpFun: false,
    });

    const health = manager.getHealth();

    expect(health.raydium_v4).toBeDefined();
    expect(health.raydium_clmm).toBeUndefined();
    expect(health.orca_whirlpool).toBeUndefined();
    expect(health.meteora).toBeUndefined();
    expect(health.pump_fun).toBeUndefined();
  });

  test("should enable Meteora when configured", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableMeteora: true,
    });

    const health = manager.getHealth();
    expect(health.meteora).toBeDefined();
  });

  test("should merge partial config with defaults", () => {
    const manager = new SourceManager(createMockConnection(), {
      duplicateWindowMs: 10000, // Override default
    });

    const metrics = manager.getAggregatedMetrics();
    expect(metrics.totalSourcesCount).toBe(5); // Default enabled sources (including Meteora)
  });

  test("should merge Meteora filters with defaults", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableMeteora: true,
      meteoraFilters: {
        maxTotalFeeBps: 1000, // Override
        skipAlphaVault: false, // Override
      } as any,
    });

    const config = manager["config"];

    expect(config.meteoraFilters.maxTotalFeeBps).toBe(1000);
    expect(config.meteoraFilters.skipAlphaVault).toBe(false);
    expect(config.meteoraFilters.maxWaitTimeSec).toBe(300); // Default preserved
  });
});

describe("SourceManager - Start/Stop Lifecycle", () => {
  test("should return empty array when no sources enabled", async () => {
    const manager = new SourceManager(createMockConnection(), {
      enableRaydiumV4: false,
      enableRaydiumCLMM: false,
      enableOrcaWhirlpool: false,
      enableMeteora: false,
      enablePumpFun: false,
    });

    const onDetection = mock(() => {});
    const started = await manager.start(onDetection);

    expect(started).toEqual([]);
  });

  test("should stop all sources", async () => {
    const manager = new SourceManager(createMockConnection());
    const onDetection = mock(() => {});

    await manager.start(onDetection);
    await manager.stop();

    const metrics = manager.getAggregatedMetrics();
    expect(metrics.duplicateDetectionCacheSize).toBe(0);
  });
});

describe("SourceManager - Health & Metrics", () => {
  test("should return health for all sources", () => {
    const manager = new SourceManager(createMockConnection());
    const health = manager.getHealth();

    // Sources start in "connecting" state after initialization
    expect(health.raydium_v4.status).toBe("connecting");
    expect(health.raydium_clmm.status).toBe("connecting");
    expect(health.orca_whirlpool.status).toBe("connecting");
    expect(health.pump_fun.status).toBe("connecting");
  });

  test("should return metrics for all sources", () => {
    const manager = new SourceManager(createMockConnection());
    const metrics = manager.getMetrics();

    expect(metrics.raydium_v4.totalDetections).toBe(0);
    expect(metrics.raydium_clmm.totalDetections).toBe(0);
    expect(metrics.orca_whirlpool.totalDetections).toBe(0);
    expect(metrics.pump_fun.totalDetections).toBe(0);
  });

  test("should calculate aggregated metrics", () => {
    const manager = new SourceManager(createMockConnection());
    const aggregated = manager.getAggregatedMetrics();

    expect(aggregated.totalDetections).toBe(0);
    expect(aggregated.avgLatencyMs).toBe(0);
    expect(aggregated.healthySourcesCount).toBe(0); // Idle sources not counted as healthy
    expect(aggregated.totalSourcesCount).toBe(5); // Default enabled (including Meteora)
    expect(aggregated.duplicateDetectionCacheSize).toBe(0);
  });
});

describe("SourceManager - Duplicate Detection", () => {
  let manager: SourceManager;
  let detections: ScoredPoolDetection[] = [];

  beforeEach(() => {
    manager = new SourceManager(createMockConnection(), {
      duplicateWindowMs: 5000, // 5 seconds
    });
    detections = [];
  });

  afterEach(async () => {
    await manager.stop();
  });

  test("should detect first detection correctly", () => {
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const rawDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    manager["handleDetection"](rawDetection, onDetection);

    expect(detections.length).toBe(1);
    expect(detections[0].isFirstDetection).toBe(true);
    expect(detections[0].alsoDetectedOn).toEqual([]);
  });

  test("should detect duplicate from different DEX", () => {
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const tokenMint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

    // First detection on Raydium V4
    const detection1: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: tokenMint,
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    manager["handleDetection"](detection1, onDetection);

    // Second detection on Orca Whirlpool (duplicate)
    const detection2: RawPoolDetection = {
      poolAddress: asSolanaAddress("7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX"),
      tokenMintA: tokenMint,
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "orca_whirlpool",
      signature: "3nqH7W5hBFfR8KQwjPT8KjZFjCQ9YqYGJxJnJYy32NznZS3p9VQ9KQYY3Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y",
      slot: 123456790,
      blockTime: Math.floor(Date.now() / 1000),
    };

    manager["handleDetection"](detection2, onDetection);

    expect(detections.length).toBe(2);
    expect(detections[0].isFirstDetection).toBe(true);
    expect(detections[1].isFirstDetection).toBe(false);
    expect(detections[1].alsoDetectedOn).toContain("raydium_v4");
  });

  test("should clean up old detections", async () => {
    const manager = new SourceManager(createMockConnection(), {
      duplicateWindowMs: 100, // 100ms for fast test
    });

    const onDetection = mock(() => {});
    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    manager["handleDetection"](detection, onDetection);

    // Should have 1 entry
    expect(manager.getAggregatedMetrics().duplicateDetectionCacheSize).toBe(1);

    // Wait for cleanup (100ms window + 1s cleanup interval)
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Should be cleaned up
    manager["batchCleanupOldDetections"]();
    expect(manager.getAggregatedMetrics().duplicateDetectionCacheSize).toBe(0);

    await manager.stop();
  });
});

describe("SourceManager - Priority Scoring", () => {
  let manager: SourceManager;

  beforeEach(() => {
    manager = new SourceManager(createMockConnection());
  });

  afterEach(async () => {
    await manager.stop();
  });

  test("should give higher score to Raydium V4 (reputation)", () => {
    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const raydiumDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    manager["handleDetection"](raydiumDetection, onDetection);

    // Raydium V4: reputation 95 * 0.4 = 38, first 30, timing 30 = 98
    expect(detections[0].priorityScore).toBeGreaterThanOrEqual(95);
  });

  test("should give lower score to Pump.fun (lower reputation)", () => {
    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const pumpFunDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "pump_fun",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    manager["handleDetection"](pumpFunDetection, onDetection);

    // Pump.fun: reputation 60 * 0.4 = 24, first 30, timing 30 = 84
    expect(detections[0].priorityScore).toBeLessThan(90);
    expect(detections[0].priorityScore).toBeGreaterThan(80);
  });

  test("should give first detection higher score than duplicate", () => {
    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const tokenMint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

    const detection1: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: tokenMint,
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    const detection2: RawPoolDetection = {
      poolAddress: asSolanaAddress("7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX"),
      tokenMintA: tokenMint,
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "orca_whirlpool",
      signature: "3nqH7W5hBFfR8KQwjPT8KjZFjCQ9YqYGJxJnJYy32NznZS3p9VQ9KQYY3Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y",
      slot: 123456790,
      blockTime: Math.floor(Date.now() / 1000),
    };

    manager["handleDetection"](detection1, onDetection);
    manager["handleDetection"](detection2, onDetection);

    // First detection should have higher score (30 vs 15 bonus)
    expect(detections[0].priorityScore).toBeGreaterThan(detections[1].priorityScore);
  });
});

describe("SourceManager - Meteora Anti-Sniper Filtering", () => {
  test("should filter Meteora pools with unknown config (conservative)", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableMeteora: true,
      meteoraFilters: {
        allowUnknownConfig: false, // Conservative
      } as any,
    });

    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const meteoraDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "meteora",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
      // meteoraAntiSniper: undefined (unknown config)
    };

    manager["handleDetection"](meteoraDetection, onDetection);

    // Should be filtered (rejected)
    expect(detections.length).toBe(0);
  });

  test("should allow Meteora pools with unknown config if configured", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableMeteora: true,
      meteoraFilters: {
        allowUnknownConfig: true, // Allow unknown
      } as any,
    });

    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const meteoraDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "meteora",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
      // meteoraAntiSniper: undefined (unknown config)
    };

    manager["handleDetection"](meteoraDetection, onDetection);

    // Should pass
    expect(detections.length).toBe(1);
    expect(detections[0].isSafeToSnipe).toBe(true);
  });

  test("should filter Meteora pools with Fee Scheduler if configured", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableMeteora: true,
      meteoraFilters: {
        skipFeeScheduler: true, // Skip all Fee Scheduler pools
      } as any,
    });

    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const antiSniper: MeteoraAntiSniperConfig = {
      hasFeeScheduler: true,
      hasRateLimiter: false,
      hasAlphaVault: false,
      feeScheduler: {
        cliffFee: 9900, // 99%
        numberOfPeriods: 10,
        periodFrequency: 60,
        feeReductionFactor: 990,
        launchTime: Math.floor(Date.now() / 1000),
      },
    };

    const meteoraDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "meteora",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
      meteoraAntiSniper: antiSniper,
    };

    manager["handleDetection"](meteoraDetection, onDetection);

    // Should be filtered
    expect(detections.length).toBe(0);
  });

  test("should filter Meteora pools with high fees", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableMeteora: true,
      filterUnsafeMeteora: true,
      meteoraFilters: {
        maxTotalFeeBps: 500, // 5% max
      } as any,
    });

    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const antiSniper: MeteoraAntiSniperConfig = {
      hasFeeScheduler: true,
      hasRateLimiter: false,
      hasAlphaVault: false,
      feeScheduler: {
        cliffFee: 9900, // 99% cliff fee (way too high!)
        numberOfPeriods: 10,
        periodFrequency: 60,
        feeReductionFactor: 990,
        launchTime: Math.floor(Date.now() / 1000), // Just launched
      },
    };

    const meteoraDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "meteora",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
      meteoraAntiSniper: antiSniper,
    };

    manager["handleDetection"](meteoraDetection, onDetection);

    // Should be filtered (99% fee > 5% max)
    expect(detections.length).toBe(0);
  });

  test("should allow Meteora pools with safe fees", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableMeteora: true,
      filterUnsafeMeteora: true,
      meteoraFilters: {
        maxTotalFeeBps: 500, // 5% max
      } as any,
    });

    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const antiSniper: MeteoraAntiSniperConfig = {
      hasFeeScheduler: true,
      hasRateLimiter: false,
      hasAlphaVault: false,
      feeScheduler: {
        cliffFee: 100, // 1% (safe!)
        numberOfPeriods: 1,
        periodFrequency: 60,
        feeReductionFactor: 0,
        launchTime: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      },
    };

    const meteoraDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "meteora",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
      meteoraAntiSniper: antiSniper,
    };

    manager["handleDetection"](meteoraDetection, onDetection);

    // Should pass (1% fee < 5% max)
    expect(detections.length).toBe(1);
    expect(detections[0].isSafeToSnipe).toBe(true);
    expect(detections[0].meteoraFees).toBeDefined();
    expect(detections[0].meteoraFees!.totalFeeBps).toBeLessThanOrEqual(500);
  });

  test("should skip Alpha Vault pools by default", () => {
    const manager = new SourceManager(createMockConnection(), {
      enableMeteora: true,
      // skipAlphaVault: true by default
    });

    const detections: ScoredPoolDetection[] = [];
    const onDetection = (detection: ScoredPoolDetection) => {
      detections.push(detection);
    };

    const antiSniper: MeteoraAntiSniperConfig = {
      hasFeeScheduler: false,
      hasRateLimiter: false,
      hasAlphaVault: true, // Alpha Vault enabled
      alphaVault: {
        isActive: true,
        endsAt: Math.floor(Date.now() / 1000) + 86400, // Ends in 24 hours
      },
    };

    const meteoraDetection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "meteora",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
      meteoraAntiSniper: antiSniper,
    };

    manager["handleDetection"](meteoraDetection, onDetection);

    // Should be filtered (Alpha Vault = whitelist only)
    expect(detections.length).toBe(0);
  });
});
