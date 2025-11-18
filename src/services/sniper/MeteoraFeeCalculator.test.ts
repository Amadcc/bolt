/**
 * Unit tests for Meteora Fee Calculator
 *
 * Tests anti-sniper fee calculation logic:
 * - Fee Scheduler (time-based dynamic fees)
 * - Rate Limiter (size-based progressive fees)
 * - Alpha Vault detection
 * - Safety assessment
 * - Wait time calculation
 */

import { describe, test, expect } from "bun:test";
import { MeteoraFeeCalculator } from "./MeteoraFeeCalculator.js";
import type {
  MeteoraAntiSniperConfig,
  MeteoraFeeScheduler,
  MeteoraRateLimiter,
} from "../../types/sniper.js";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create mock Fee Scheduler config
 */
function createMockFeeScheduler(
  overrides: Partial<MeteoraFeeScheduler> = {}
): MeteoraFeeScheduler {
  return {
    cliffFee: 9900, // 99%
    numberOfPeriods: 10,
    periodFrequency: 30, // 30 seconds
    feeReductionFactor: 1000, // 10% per period
    launchTime: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/**
 * Create mock Rate Limiter config
 */
function createMockRateLimiter(
  overrides: Partial<MeteoraRateLimiter> = {}
): MeteoraRateLimiter {
  return {
    enabled: true,
    baseFeePerSol: 100, // 1% per SOL
    ...overrides,
  };
}

/**
 * Create mock anti-sniper config
 */
function createMockAntiSniperConfig(
  overrides: Partial<MeteoraAntiSniperConfig> = {}
): MeteoraAntiSniperConfig {
  return {
    hasFeeScheduler: true,
    hasRateLimiter: true,
    hasAlphaVault: false,
    feeScheduler: createMockFeeScheduler(),
    rateLimiter: createMockRateLimiter(),
    ...overrides,
  };
}

// ============================================================================
// Test: Fee Scheduler Calculation
// ============================================================================

describe("MeteoraFeeCalculator - Fee Scheduler", () => {
  test("should calculate cliff fee at launch (t=0)", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const scheduler = createMockFeeScheduler({ launchTime });

    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: scheduler,
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1, // 1 SOL
      launchTime // At launch
    );

    expect(result.feeSchedulerBps).toBe(9900); // 99%
    expect(result.rateLimiterBps).toBe(0);
    expect(result.totalFeeBps).toBe(9900);
  });

  test("should calculate reduced fee after 1 period (t=30s)", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const scheduler = createMockFeeScheduler({
      launchTime,
      cliffFee: 9900,
      periodFrequency: 30,
      feeReductionFactor: 1000,
    });

    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: scheduler,
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1,
      launchTime + 30 // 1 period later
    );

    // 9900 - (1 * 1000) = 8900 (89%)
    expect(result.feeSchedulerBps).toBe(8900);
    expect(result.totalFeeBps).toBe(8900);
  });

  test("should calculate reduced fee after 3 periods (t=90s)", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const scheduler = createMockFeeScheduler({
      launchTime,
      cliffFee: 9900,
      periodFrequency: 30,
      feeReductionFactor: 1000,
    });

    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: scheduler,
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1,
      launchTime + 90 // 3 periods later
    );

    // 9900 - (3 * 1000) = 6900 (69%)
    expect(result.feeSchedulerBps).toBe(6900);
  });

  test("should floor fee at base fee (1%)", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const scheduler = createMockFeeScheduler({
      launchTime,
      cliffFee: 9900,
      periodFrequency: 30,
      feeReductionFactor: 1000,
    });

    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: scheduler,
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1,
      launchTime + 1000 // Way past all periods
    );

    // Should floor at 100 bps (1%)
    expect(result.feeSchedulerBps).toBe(100);
  });

  test("should return cliff fee before launch (t<0)", () => {
    const launchTime = Math.floor(Date.now() / 1000) + 60; // Launch in 1 minute
    const scheduler = createMockFeeScheduler({ launchTime });

    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: scheduler,
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1,
      launchTime - 30 // Before launch
    );

    expect(result.feeSchedulerBps).toBe(9900); // Cliff fee
  });
});

// ============================================================================
// Test: Rate Limiter Calculation
// ============================================================================

describe("MeteoraFeeCalculator - Rate Limiter", () => {
  test("should calculate 1% per SOL (1 SOL)", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: true,
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 1);

    expect(result.feeSchedulerBps).toBe(0);
    expect(result.rateLimiterBps).toBe(100); // 1%
    expect(result.totalFeeBps).toBe(100);
  });

  test("should calculate 5% for 5 SOL", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: true,
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 5);

    expect(result.rateLimiterBps).toBe(500); // 5%
    expect(result.totalFeeBps).toBe(500);
  });

  test("should calculate 10% for 10 SOL", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: true,
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 10);

    expect(result.rateLimiterBps).toBe(1000); // 10%
    expect(result.totalFeeBps).toBe(1000);
  });

  test("should return 0 when Rate Limiter disabled", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: true,
      rateLimiter: { enabled: false, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 10);

    expect(result.rateLimiterBps).toBe(0);
    expect(result.totalFeeBps).toBe(0);
  });

  test("should handle fractional SOL amounts", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: true,
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 2.5);

    expect(result.rateLimiterBps).toBe(250); // 2.5%
  });
});

// ============================================================================
// Test: Combined Fees (Fee Scheduler + Rate Limiter)
// ============================================================================

describe("MeteoraFeeCalculator - Combined Fees", () => {
  test("should add Fee Scheduler + Rate Limiter at launch", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: true,
      feeScheduler: createMockFeeScheduler({ launchTime }),
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      5, // 5 SOL
      launchTime
    );

    // Fee Scheduler: 9900 bps (99%)
    // Rate Limiter: 500 bps (5%)
    // Total: 10400 bps (104% - UNPROFITABLE!)
    expect(result.feeSchedulerBps).toBe(9900);
    expect(result.rateLimiterBps).toBe(500);
    expect(result.totalFeeBps).toBe(10400);
    expect(result.totalFeeDecimal).toBeCloseTo(1.04);
  });

  test("should calculate worst-case scenario (105% total fees)", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: true,
      feeScheduler: createMockFeeScheduler({
        launchTime,
        cliffFee: 9900,
      }),
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      10, // 10 SOL
      launchTime
    );

    // Fee Scheduler: 9900 bps (99%)
    // Rate Limiter: 1000 bps (10%)
    // Total: 10900 bps (109% - EXTREMELY UNPROFITABLE!)
    expect(result.totalFeeBps).toBe(10900);
    expect(result.isSafeToSnipe).toBe(false);
  });

  test("should calculate reasonable fees after decay (t=300s, 1 SOL)", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: true,
      feeScheduler: createMockFeeScheduler({
        launchTime,
        cliffFee: 9900,
        periodFrequency: 30,
        feeReductionFactor: 1000,
      }),
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1,
      launchTime + 300 // 10 periods later
    );

    // Fee Scheduler: 100 bps (1% - floored)
    // Rate Limiter: 100 bps (1%)
    // Total: 200 bps (2%)
    expect(result.feeSchedulerBps).toBe(100);
    expect(result.rateLimiterBps).toBe(100);
    expect(result.totalFeeBps).toBe(200);
    expect(result.isSafeToSnipe).toBe(true);
  });
});

// ============================================================================
// Test: Alpha Vault Detection
// ============================================================================

describe("MeteoraFeeCalculator - Alpha Vault", () => {
  test("should mark unsafe when Alpha Vault is active", () => {
    const currentTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: false,
      hasAlphaVault: true,
      alphaVault: {
        isActive: true,
        endsAt: currentTime + 300, // Active for 5 more minutes
        reservedSupplyPct: 20,
      },
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 1, currentTime);

    expect(result.isSafeToSnipe).toBe(false);
    expect(result.unsafeReason).toBe("Alpha Vault is active (whitelist only)");
  });

  test("should mark safe when Alpha Vault has ended", () => {
    const currentTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: false,
      hasAlphaVault: true,
      alphaVault: {
        isActive: true,
        endsAt: currentTime - 60, // Ended 1 minute ago
        reservedSupplyPct: 20,
      },
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 1, currentTime);

    expect(result.isSafeToSnipe).toBe(true);
    expect(result.unsafeReason).toBeUndefined();
  });
});

// ============================================================================
// Test: Safety Assessment
// ============================================================================

describe("MeteoraFeeCalculator - Safety Assessment", () => {
  test("should mark unsafe when fees exceed 5%", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: createMockFeeScheduler({ launchTime }),
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 1, launchTime);

    expect(result.totalFeeBps).toBeGreaterThan(500); // >5%
    expect(result.isSafeToSnipe).toBe(false);
  });

  test("should mark safe when fees are under 5%", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: true,
      feeScheduler: createMockFeeScheduler({
        launchTime,
        cliffFee: 300, // 3%
        periodFrequency: 30,
        feeReductionFactor: 0,
      }),
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1,
      launchTime + 60
    );

    // Fee Scheduler: 300 bps (3%)
    // Rate Limiter: 100 bps (1%)
    // Total: 400 bps (4%)
    expect(result.totalFeeBps).toBe(400);
    expect(result.isSafeToSnipe).toBe(true);
  });

  test("should mark unsafe if too early (< 60s)", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: createMockFeeScheduler({ launchTime }),
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1,
      launchTime + 30 // Only 30s after launch
    );

    expect(result.isSafeToSnipe).toBe(false);
  });

  test("should mark safe after minimum wait time (60s)", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: true,
      feeScheduler: createMockFeeScheduler({
        launchTime,
        cliffFee: 400, // 4%
        periodFrequency: 30,
        feeReductionFactor: 0,
      }),
      rateLimiter: { enabled: true, baseFeePerSol: 50 },
    });

    const result = MeteoraFeeCalculator.calculateFees(
      config,
      1,
      launchTime + 60 // 60s after launch
    );

    // Fee Scheduler: 400 bps (4%)
    // Rate Limiter: 50 bps (0.5%)
    // Total: 450 bps (4.5%)
    expect(result.totalFeeBps).toBe(450);
    expect(result.isSafeToSnipe).toBe(true);
  });
});

// ============================================================================
// Test: Wait Time Calculation
// ============================================================================

describe("MeteoraFeeCalculator - Wait Time Calculation", () => {
  test("should return 0 when already safe", () => {
    const launchTime = Math.floor(Date.now() / 1000) - 300; // Launched 5 min ago
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: createMockFeeScheduler({ launchTime }),
    });

    const waitTime = MeteoraFeeCalculator.calculateWaitTime(
      config,
      500, // Target 5%
      Math.floor(Date.now() / 1000)
    );

    expect(waitTime).toBe(0); // Already safe
  });

  test("should return 0 when no Fee Scheduler", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: true,
    });

    const waitTime = MeteoraFeeCalculator.calculateWaitTime(config);

    expect(waitTime).toBe(0);
  });

  test("should calculate wait time for fee decay", () => {
    const launchTime = Math.floor(Date.now() / 1000);
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: createMockFeeScheduler({
        launchTime,
        cliffFee: 9900,
        periodFrequency: 30,
        feeReductionFactor: 1000,
      }),
    });

    const waitTime = MeteoraFeeCalculator.calculateWaitTime(
      config,
      500, // Target 5%
      launchTime + 10 // 10s after launch
    );

    // Need to reduce from 9900 bps to 500 bps = 9400 bps
    // 9400 / 1000 = 9.4 periods ≈ 10 periods
    // 10 periods * 30s = 300s
    // Already waited 10s, so need ~270-290s more
    expect(waitTime).toBeGreaterThan(0);
    expect(waitTime).toBeLessThanOrEqual(300);
  });
});

// ============================================================================
// Test: Edge Cases
// ============================================================================

describe("MeteoraFeeCalculator - Edge Cases", () => {
  test("should handle zero SOL amount", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: true,
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 0);

    expect(result.rateLimiterBps).toBe(0);
    expect(result.totalFeeBps).toBe(0);
  });

  test("should handle very large SOL amounts", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: false,
      hasRateLimiter: true,
      rateLimiter: { enabled: true, baseFeePerSol: 100 },
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 100);

    // 100 SOL * 100 bps = 10000 bps (100% fee!)
    expect(result.rateLimiterBps).toBe(10000);
    expect(result.isSafeToSnipe).toBe(false);
  });

  test("should handle config with no anti-sniper features", () => {
    const config: MeteoraAntiSniperConfig = {
      hasFeeScheduler: false,
      hasRateLimiter: false,
      hasAlphaVault: false,
    };

    const result = MeteoraFeeCalculator.calculateFees(config, 5);

    expect(result.feeSchedulerBps).toBe(0);
    expect(result.rateLimiterBps).toBe(0);
    expect(result.totalFeeBps).toBe(0);
    expect(result.isSafeToSnipe).toBe(true);
  });

  test("should return correct decimal representation", () => {
    const config = createMockAntiSniperConfig({
      hasFeeScheduler: true,
      hasRateLimiter: false,
      feeScheduler: createMockFeeScheduler({
        launchTime: Math.floor(Date.now() / 1000),
        cliffFee: 500, // 5%
        periodFrequency: 30,
        feeReductionFactor: 0,
      }),
    });

    const result = MeteoraFeeCalculator.calculateFees(config, 1);

    expect(result.totalFeeBps).toBe(500);
    expect(result.totalFeeDecimal).toBe(0.05); // 5%
  });
});

// ============================================================================
// Test: Safety Thresholds Getter
// ============================================================================

describe("MeteoraFeeCalculator - Safety Thresholds", () => {
  test("should return safety thresholds", () => {
    const thresholds = MeteoraFeeCalculator.getSafetyThresholds();

    expect(thresholds.MAX_SAFE_FEE_BPS).toBe(500); // 5%
    expect(thresholds.MAX_WAIT_TIME).toBe(300); // 5 minutes
    expect(thresholds.MIN_WAIT_TIME).toBe(60); // 1 minute
  });
});
