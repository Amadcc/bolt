/**
 * Privacy Layer Tests
 *
 * Comprehensive test suite for copy-trade protection system.
 * Tests all privacy features: timing, fees, wallets, Jito, obfuscation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PrivacyLayer } from "../../../src/services/sniper/privacyLayer.js";
import {
  PRIVACY_PRESETS,
  asDelayMs,
  asPrivacyScore,
  type PrivacySettings,
} from "../../../src/types/copyTradeProtection.js";
import { Ok, Err } from "../../../src/types/common.js";
import type { WalletRotator } from "../../../src/services/wallet/walletRotator.js";
import type { FeeOptimizer } from "../../../src/services/sniper/feeOptimizer.js";
import { asWalletId } from "../../../src/types/walletRotation.js";

// ============================================================================
// Mocks
// ============================================================================

const mockWalletRotator: WalletRotator = {
  selectWallet: vi.fn().mockResolvedValue(
    Ok({
      id: asWalletId("550e8400-e29b-41d4-a716-446655440000"),
      userId: "test-user",
      publicKey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" as any,
      chain: "solana",
      label: null,
      isPrimary: true,
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  ),
} as any;

const mockFeeOptimizer: FeeOptimizer = {
  optimizeFee: vi.fn().mockResolvedValue(
    Ok({
      computeUnitPrice: 100000,
      computeUnitLimit: 200000,
      mode: "MEDIUM" as const,
      priorityFee: 20000000n as any,
      totalFee: 20000000n as any,
      wasCapped: false,
      wasBoosted: false,
      networkCongestion: 0.5,
    })
  ),
} as any;

// ============================================================================
// Test Suite
// ============================================================================

describe("PrivacyLayer", () => {
  let privacyLayer: PrivacyLayer;

  beforeEach(() => {
    vi.clearAllMocks();
    privacyLayer = new PrivacyLayer(mockWalletRotator, mockFeeOptimizer);
  });

  // ==========================================================================
  // Settings Validation Tests
  // ==========================================================================

  describe("validateSettings", () => {
    it("should accept valid BASIC preset", () => {
      const validation = privacyLayer.validateSettings(PRIVACY_PRESETS.BASIC);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should accept valid ADVANCED preset", () => {
      const validation = privacyLayer.validateSettings(PRIVACY_PRESETS.ADVANCED);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should reject negative base delay", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        timing: {
          ...PRIVACY_PRESETS.BASIC.timing,
          baseDelayMs: asDelayMs(-100),
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Base delay must be between 0-30000ms");
    });

    it("should reject invalid jitter percent", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        timing: {
          ...PRIVACY_PRESETS.BASIC.timing,
          jitterPercent: 150 as any,
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Jitter percent must be between 0-100%");
    });

    it("should reject min delay > max delay", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        timing: {
          ...PRIVACY_PRESETS.BASIC.timing,
          minDelayMs: asDelayMs(5000),
          maxDelayMs: asDelayMs(1000),
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Min delay cannot be greater than max delay");
    });

    it("should warn on high base delay", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        timing: {
          ...PRIVACY_PRESETS.BASIC.timing,
          baseDelayMs: asDelayMs(15000),
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(true);
      expect(validation.warnings.length).toBeGreaterThan(0);
      expect(validation.warnings[0]).toContain("High base delay");
    });

    it("should reject empty allowed fee modes", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        feePattern: {
          ...PRIVACY_PRESETS.BASIC.feePattern,
          allowedModes: [] as any,
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("At least one fee mode must be allowed");
    });

    it("should reject missing fresh threshold", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        walletRotation: {
          ...PRIVACY_PRESETS.BASIC.walletRotation,
          strategy: "FRESH_THRESHOLD",
          freshThreshold: undefined,
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(
        "Fresh threshold required for FRESH_THRESHOLD strategy"
      );
    });

    it("should reject negative Jito min tip", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        jito: {
          ...PRIVACY_PRESETS.BASIC.jito,
          minTipLamports: -1000n,
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Jito min tip must be positive");
    });

    it("should reject Jito max tip < min tip", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        jito: {
          ...PRIVACY_PRESETS.BASIC.jito,
          minTipLamports: 100000n,
          maxTipLamports: 50000n,
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Jito max tip cannot be less than min tip");
    });

    it("should reject negative max memo length", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        obfuscation: {
          ...PRIVACY_PRESETS.BASIC.obfuscation,
          addRandomMemos: true,
          maxMemoLength: -10,
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(
        "Max memo length must be positive if random memos enabled"
      );
    });

    it("should warn on too many dummy instructions", () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        obfuscation: {
          ...PRIVACY_PRESETS.BASIC.obfuscation,
          addDummyInstructions: true,
          maxDummyInstructions: 10,
        },
      };
      const validation = privacyLayer.validateSettings(settings);
      expect(validation.valid).toBe(true);
      expect(validation.warnings.length).toBeGreaterThan(0);
      expect(validation.warnings[0]).toContain("Too many dummy instructions");
    });
  });

  // ==========================================================================
  // Privacy Layer Application Tests
  // ==========================================================================

  describe("applyPrivacyLayer", () => {
    it("should apply OFF mode successfully", async () => {
      const result = await privacyLayer.applyPrivacyLayer(
        "test-user",
        PRIVACY_PRESETS.OFF
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.value.delayBeforeExecution.delayMs).toBe(0);
      expect(result.value.useJito).toBe(false);
      expect(result.value.appliedObfuscation).toHaveLength(0);
      expect(Number(result.value.privacyScore)).toBeLessThan(20);
    });

    it("should apply BASIC mode successfully", async () => {
      const result = await privacyLayer.applyPrivacyLayer(
        "test-user",
        PRIVACY_PRESETS.BASIC
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Should have timing delay
      expect(result.value.delayBeforeExecution.delayMs).toBeGreaterThan(0);

      // Should use Jito
      expect(result.value.useJito).toBe(true);
      expect(result.value.jitoTipLamports).toBeGreaterThan(0n);

      // Should have moderate privacy score
      expect(Number(result.value.privacyScore)).toBeGreaterThan(30);
      expect(Number(result.value.privacyScore)).toBeLessThan(70);
    });

    it("should apply ADVANCED mode successfully", async () => {
      const result = await privacyLayer.applyPrivacyLayer(
        "test-user",
        PRIVACY_PRESETS.ADVANCED
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Should have higher timing delay
      expect(result.value.delayBeforeExecution.delayMs).toBeGreaterThan(500);

      // Should use Jito with randomized tips
      expect(result.value.useJito).toBe(true);
      expect(result.value.jitoTipLamports).toBeGreaterThan(0n);

      // Should have obfuscation
      expect(result.value.appliedObfuscation.length).toBeGreaterThan(0);
      expect(result.value.memo).toBeDefined();

      // Should have high privacy score
      expect(Number(result.value.privacyScore)).toBeGreaterThan(60);
    });

    it("should reject invalid settings", async () => {
      const invalidSettings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        timing: {
          ...PRIVACY_PRESETS.BASIC.timing,
          baseDelayMs: -100 as any,
        },
      };

      const result = await privacyLayer.applyPrivacyLayer(
        "test-user",
        invalidSettings
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.type).toBe("INVALID_SETTINGS");
    });

    it("should call WalletRotator with correct strategy", async () => {
      await privacyLayer.applyPrivacyLayer("test-user", PRIVACY_PRESETS.BASIC);

      expect(mockWalletRotator.selectWallet).toHaveBeenCalledWith(
        "test-user",
        "RANDOM"
      );
    });

    it("should call FeeOptimizer for ADAPTIVE strategy", async () => {
      const adaptiveSettings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        feePattern: {
          ...PRIVACY_PRESETS.BASIC.feePattern,
          strategy: "ADAPTIVE",
        },
      };

      await privacyLayer.applyPrivacyLayer("test-user", adaptiveSettings);

      expect(mockFeeOptimizer.optimizeFee).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Privacy Score Tests
  // ==========================================================================

  describe("getPrivacyScore", () => {
    it("should return 0 for new user", () => {
      const score = privacyLayer.getPrivacyScore("new-user");
      expect(score).toBe(0);
    });

    it("should return updated score after applying privacy layer", async () => {
      await privacyLayer.applyPrivacyLayer("test-user", PRIVACY_PRESETS.BASIC);
      const score = privacyLayer.getPrivacyScore("test-user");
      expect(Number(score)).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // State Management Tests
  // ==========================================================================

  describe("resetState", () => {
    it("should reset user state", async () => {
      // Apply privacy layer to create state
      await privacyLayer.applyPrivacyLayer("test-user", PRIVACY_PRESETS.BASIC);
      let score = privacyLayer.getPrivacyScore("test-user");
      expect(Number(score)).toBeGreaterThan(0);

      // Reset state
      privacyLayer.resetState("test-user");
      score = privacyLayer.getPrivacyScore("test-user");
      expect(score).toBe(0);
    });
  });

  // ==========================================================================
  // Timing Tests (Unit Tests for Private Methods via Public API)
  // ==========================================================================

  describe("Timing Randomization", () => {
    it("should add random delay within jitter range", async () => {
      // Run multiple times to test randomization
      const delays: number[] = [];

      for (let i = 0; i < 10; i++) {
        const result = await privacyLayer.applyPrivacyLayer(
          `test-user-${i}`,
          PRIVACY_PRESETS.BASIC
        );
        expect(result.success).toBe(true);
        if (!result.success) continue;
        delays.push(result.value.delayBeforeExecution.delayMs);
      }

      // Check that we got different delays (randomization working)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);

      // Check that all delays are within expected range
      const baseDelay = PRIVACY_PRESETS.BASIC.timing.baseDelayMs;
      const jitterPct = PRIVACY_PRESETS.BASIC.timing.jitterPercent;
      const maxJitter = (baseDelay * jitterPct) / 100;
      const expectedMin = baseDelay - maxJitter;
      const expectedMax = baseDelay + maxJitter;

      delays.forEach((delay) => {
        expect(delay).toBeGreaterThanOrEqual(expectedMin - 1); // -1 for rounding
        expect(delay).toBeLessThanOrEqual(expectedMax + 1); // +1 for rounding
      });
    });

    it("should respect min/max delay bounds", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        timing: {
          enabled: true,
          baseDelayMs: asDelayMs(5000),
          jitterPercent: 100 as any, // ±100% jitter
          minDelayMs: asDelayMs(2000),
          maxDelayMs: asDelayMs(6000),
        },
      };

      for (let i = 0; i < 20; i++) {
        const result = await privacyLayer.applyPrivacyLayer(
          `test-user-${i}`,
          settings
        );
        expect(result.success).toBe(true);
        if (!result.success) continue;

        const delay = result.value.delayBeforeExecution.delayMs;
        expect(delay).toBeGreaterThanOrEqual(2000);
        expect(delay).toBeLessThanOrEqual(6000);
      }
    });
  });

  // ==========================================================================
  // Fee Pattern Tests
  // ==========================================================================

  describe("Fee Pattern Selection", () => {
    it("should use FIXED strategy correctly", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        feePattern: {
          strategy: "FIXED",
          allowedModes: ["HIGH"],
          addMicroJitter: false,
          microJitterPercent: 0 as any,
        },
      };

      const result = await privacyLayer.applyPrivacyLayer("test-user", settings);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.priorityFeeMode).toBe("HIGH");
    });

    it("should randomize fee modes with RANDOM strategy", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        feePattern: {
          strategy: "RANDOM",
          allowedModes: ["LOW", "MEDIUM", "HIGH"],
          addMicroJitter: false,
          microJitterPercent: 0 as any,
        },
      };

      const modes = new Set<string>();
      for (let i = 0; i < 15; i++) {
        const result = await privacyLayer.applyPrivacyLayer(
          `test-user-${i}`,
          settings
        );
        expect(result.success).toBe(true);
        if (!result.success) continue;
        modes.add(result.value.priorityFeeMode);
      }

      // Should see multiple different modes
      expect(modes.size).toBeGreaterThan(1);
    });

    it("should gradually increase fees with GRADUAL_INCREASE strategy", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        feePattern: {
          strategy: "GRADUAL_INCREASE",
          allowedModes: ["LOW", "MEDIUM", "HIGH"],
          addMicroJitter: false,
          microJitterPercent: 0 as any,
        },
      };

      const modes: string[] = [];
      for (let i = 0; i < 6; i++) {
        const result = await privacyLayer.applyPrivacyLayer(
          "test-user",
          settings
        );
        expect(result.success).toBe(true);
        if (!result.success) continue;
        modes.push(result.value.priorityFeeMode);
      }

      // Should cycle through modes: LOW, MEDIUM, HIGH, LOW, MEDIUM, HIGH
      expect(modes[0]).toBe("LOW");
      expect(modes[1]).toBe("MEDIUM");
      expect(modes[2]).toBe("HIGH");
      expect(modes[3]).toBe("LOW");
    });
  });

  // ==========================================================================
  // Jito Tip Tests
  // ==========================================================================

  describe("Jito Tip Calculation", () => {
    it("should return undefined when Jito routing disabled", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.OFF,
        jito: {
          ...PRIVACY_PRESETS.OFF.jito,
          forceJitoRouting: false,
        },
      };

      const result = await privacyLayer.applyPrivacyLayer("test-user", settings);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.jitoTipLamports).toBeUndefined();
    });

    it("should return tip when Jito routing enabled", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        jito: {
          ...PRIVACY_PRESETS.BASIC.jito,
          forceJitoRouting: true,
          minTipLamports: 10000n,
          maxTipLamports: 50000n,
          randomizeTips: false,
        },
      };

      const result = await privacyLayer.applyPrivacyLayer("test-user", settings);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.jitoTipLamports).toBe(10000n);
    });

    it("should randomize tips when enabled", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        jito: {
          ...PRIVACY_PRESETS.BASIC.jito,
          forceJitoRouting: true,
          minTipLamports: 10000n,
          maxTipLamports: 100000n,
          randomizeTips: true,
        },
      };

      const tips = new Set<bigint>();
      for (let i = 0; i < 10; i++) {
        const result = await privacyLayer.applyPrivacyLayer(
          `test-user-${i}`,
          settings
        );
        expect(result.success).toBe(true);
        if (!result.success) continue;
        if (result.value.jitoTipLamports) {
          tips.add(result.value.jitoTipLamports);
        }
      }

      // Should see variation in tips
      expect(tips.size).toBeGreaterThan(1);

      // All tips should be within range
      tips.forEach((tip) => {
        expect(tip).toBeGreaterThanOrEqual(10000n);
        expect(tip).toBeLessThanOrEqual(100000n);
      });
    });
  });

  // ==========================================================================
  // Obfuscation Tests
  // ==========================================================================

  describe("Transaction Obfuscation", () => {
    it("should not apply obfuscation when pattern is NONE", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.OFF,
        obfuscation: {
          pattern: "NONE",
          strength: 0 as any,
          addRandomMemos: false,
          maxMemoLength: 0,
          addDummyInstructions: false,
          maxDummyInstructions: 0,
        },
      };

      const result = await privacyLayer.applyPrivacyLayer("test-user", settings);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.appliedObfuscation).toHaveLength(0);
      expect(result.value.memo).toBeUndefined();
    });

    it("should add random memo with MEMO_RANDOM pattern", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        obfuscation: {
          pattern: "MEMO_RANDOM",
          strength: 30 as any,
          addRandomMemos: true,
          maxMemoLength: 32,
          addDummyInstructions: false,
          maxDummyInstructions: 0,
        },
      };

      const result = await privacyLayer.applyPrivacyLayer("test-user", settings);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.appliedObfuscation).toContain("MEMO_RANDOM");
      expect(result.value.memo).toBeDefined();
      expect(result.value.memo!.length).toBeGreaterThan(0);
      expect(result.value.memo!.length).toBeLessThanOrEqual(32);
    });

    it("should mark dummy instructions with DUMMY_INSTRUCTIONS pattern", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.BASIC,
        obfuscation: {
          pattern: "DUMMY_INSTRUCTIONS",
          strength: 30 as any,
          addRandomMemos: false,
          maxMemoLength: 0,
          addDummyInstructions: true,
          maxDummyInstructions: 2,
        },
      };

      const result = await privacyLayer.applyPrivacyLayer("test-user", settings);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.appliedObfuscation).toContain("DUMMY_INSTRUCTIONS");
    });

    it("should apply all obfuscation with FULL pattern", async () => {
      const settings: PrivacySettings = {
        ...PRIVACY_PRESETS.ADVANCED,
        obfuscation: {
          pattern: "FULL",
          strength: 80 as any,
          addRandomMemos: true,
          maxMemoLength: 64,
          addDummyInstructions: false,
          maxDummyInstructions: 0,
        },
      };

      const result = await privacyLayer.applyPrivacyLayer("test-user", settings);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.appliedObfuscation.length).toBeGreaterThan(0);
      expect(result.value.memo).toBeDefined();
    });

    it("should generate different memos each time", async () => {
      const memos = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const result = await privacyLayer.applyPrivacyLayer(
          `test-user-${i}`,
          PRIVACY_PRESETS.ADVANCED
        );
        expect(result.success).toBe(true);
        if (!result.success) continue;
        if (result.value.memo) {
          memos.add(result.value.memo);
        }
      }

      // Should see unique memos
      expect(memos.size).toBeGreaterThan(5);
    });
  });
});
