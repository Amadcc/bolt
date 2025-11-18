/**
 * DAY 11: Multi-Wallet Support - Type System Tests
 *
 * Comprehensive tests for wallet rotation types, branded types, and helper functions.
 */

import { describe, test, expect } from "bun:test";
import type {
  WalletId,
  WalletLabel,
  WalletCount,
  UsageCount,
  RotationStrategy,
  WalletInfo,
  WalletWithStats,
} from "../../src/types/walletRotation";
import {
  asWalletId,
  asWalletLabel,
  asWalletCount,
  asUsageCount,
  isMaxWalletsReached,
  getRemainingWalletSlots,
  generateDefaultLabel,
  isValidRotationStrategy,
  getRotationStrategyName,
  getMinutesSinceLastUsed,
  getDaysSinceCreated,
  getDaysSinceLastUsed,
  sortByLeastUsed,
  filterActiveWallets,
  findPrimaryWallet,
  hasUniquelabel,
  MAX_WALLETS_PER_USER,
} from "../../src/types/walletRotation";
import { asSolanaAddress } from "../../src/types/common";

// ============================================================================
// BRANDED TYPE CONSTRUCTORS
// ============================================================================

describe("Branded Type Constructors", () => {
  describe("asWalletId", () => {
    test("should accept valid UUID v4", () => {
      const validUuid = "550e8400-e29b-41d4-a716-446655440000";
      expect(asWalletId(validUuid)).toBe(validUuid);
    });

    test("should reject invalid UUID", () => {
      expect(() => asWalletId("not-a-uuid")).toThrow("Invalid wallet ID");
    });

    test("should reject non-v4 UUID", () => {
      const uuidV1 = "550e8400-e29b-11d4-a716-446655440000"; // v1 UUID
      expect(() => asWalletId(uuidV1)).toThrow("Invalid wallet ID");
    });
  });

  describe("asWalletLabel", () => {
    test("should accept valid label", () => {
      expect(asWalletLabel("Main Wallet")).toBe("Main Wallet");
      expect(asWalletLabel("Trading-1")).toBe("Trading-1");
      expect(asWalletLabel("Sniper_Bot_2")).toBe("Sniper_Bot_2");
    });

    test("should trim whitespace", () => {
      expect(asWalletLabel("  Wallet 1  ")).toBe("Wallet 1");
    });

    test("should reject empty label", () => {
      expect(() => asWalletLabel("")).toThrow("cannot be empty");
      expect(() => asWalletLabel("   ")).toThrow("cannot be empty");
    });

    test("should reject label too long", () => {
      const longLabel = "a".repeat(51);
      expect(() => asWalletLabel(longLabel)).toThrow("too long");
    });

    test("should reject invalid characters", () => {
      expect(() => asWalletLabel("Wallet@1")).toThrow("Invalid wallet label");
      expect(() => asWalletLabel("Wallet#1")).toThrow("Invalid wallet label");
      expect(() => asWalletLabel("Wallet$1")).toThrow("Invalid wallet label");
    });
  });

  describe("asWalletCount", () => {
    test("should accept valid count", () => {
      expect(asWalletCount(0)).toBe(0);
      expect(asWalletCount(5)).toBe(5);
      expect(asWalletCount(10)).toBe(10);
    });

    test("should reject negative count", () => {
      expect(() => asWalletCount(-1)).toThrow("cannot be negative");
    });

    test("should reject non-integer", () => {
      expect(() => asWalletCount(1.5)).toThrow("must be an integer");
    });

    test("should reject count above max", () => {
      expect(() => asWalletCount(11)).toThrow("exceeds maximum");
    });
  });

  describe("asUsageCount", () => {
    test("should accept valid usage count", () => {
      expect(asUsageCount(0)).toBe(0);
      expect(asUsageCount(100)).toBe(100);
    });

    test("should reject negative count", () => {
      expect(() => asUsageCount(-1)).toThrow("cannot be negative");
    });

    test("should reject non-integer", () => {
      expect(() => asUsageCount(1.5)).toThrow("must be an integer");
    });
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

describe("Helper Functions", () => {
  describe("isMaxWalletsReached", () => {
    test("should return false for counts below max", () => {
      expect(isMaxWalletsReached(asWalletCount(0))).toBe(false);
      expect(isMaxWalletsReached(asWalletCount(5))).toBe(false);
      expect(isMaxWalletsReached(asWalletCount(9))).toBe(false);
    });

    test("should return true for max count", () => {
      expect(isMaxWalletsReached(asWalletCount(10))).toBe(true);
    });
  });

  describe("getRemainingWalletSlots", () => {
    test("should calculate remaining slots correctly", () => {
      expect(getRemainingWalletSlots(asWalletCount(0))).toBe(10);
      expect(getRemainingWalletSlots(asWalletCount(3))).toBe(7);
      expect(getRemainingWalletSlots(asWalletCount(10))).toBe(0);
    });
  });

  describe("generateDefaultLabel", () => {
    test("should generate Main for first wallet", () => {
      expect(generateDefaultLabel(asWalletCount(0))).toBe("Main");
    });

    test("should generate numbered labels for subsequent wallets", () => {
      expect(generateDefaultLabel(asWalletCount(1))).toBe("Wallet 2");
      expect(generateDefaultLabel(asWalletCount(4))).toBe("Wallet 5");
    });
  });

  describe("isValidRotationStrategy", () => {
    test("should validate all rotation strategy types", () => {
      const roundRobin: RotationStrategy = { type: "ROUND_ROBIN" };
      const leastUsed: RotationStrategy = { type: "LEAST_USED" };
      const random: RotationStrategy = { type: "RANDOM" };
      const specific: RotationStrategy = {
        type: "SPECIFIC",
        walletId: asWalletId("550e8400-e29b-41d4-a716-446655440000"),
      };
      const primary: RotationStrategy = { type: "PRIMARY_ONLY" };

      expect(isValidRotationStrategy(roundRobin)).toBe(true);
      expect(isValidRotationStrategy(leastUsed)).toBe(true);
      expect(isValidRotationStrategy(random)).toBe(true);
      expect(isValidRotationStrategy(specific)).toBe(true);
      expect(isValidRotationStrategy(primary)).toBe(true);
    });
  });

  describe("getRotationStrategyName", () => {
    test("should return human-readable names", () => {
      expect(
        getRotationStrategyName({ type: "ROUND_ROBIN" })
      ).toBe("Round Robin (Sequential)");
      expect(
        getRotationStrategyName({ type: "LEAST_USED" })
      ).toBe("Least Used (Balanced)");
      expect(getRotationStrategyName({ type: "RANDOM" })).toBe("Random");
      expect(
        getRotationStrategyName({
          type: "SPECIFIC",
          walletId: asWalletId("550e8400-e29b-41d4-a716-446655440000"),
        })
      ).toBe("Specific Wallet");
      expect(
        getRotationStrategyName({ type: "PRIMARY_ONLY" })
      ).toBe("Primary Wallet Only");
    });
  });

  describe("getMinutesSinceLastUsed", () => {
    test("should return null for never used", () => {
      expect(getMinutesSinceLastUsed(null)).toBe(null);
    });

    test("should calculate minutes correctly", () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const result = getMinutesSinceLastUsed(fiveMinutesAgo);
      expect(result).toBeGreaterThanOrEqual(4);
      expect(result).toBeLessThanOrEqual(6);
    });
  });

  describe("getDaysSinceCreated", () => {
    test("should calculate days for today", () => {
      const today = new Date();
      expect(getDaysSinceCreated(today)).toBe(0);
    });

    test("should calculate days for past date", () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      expect(getDaysSinceCreated(threeDaysAgo)).toBe(3);
    });
  });

  describe("getDaysSinceLastUsed", () => {
    test("should return null for never used", () => {
      expect(getDaysSinceLastUsed(null)).toBe(null);
    });

    test("should calculate days for past date", () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      expect(getDaysSinceLastUsed(twoDaysAgo)).toBe(2);
    });
  });
});

// ============================================================================
// WALLET OPERATIONS
// ============================================================================

describe("Wallet Operations", () => {
  // Helper to create test wallets
  function createTestWallet(overrides: Partial<WalletInfo> = {}): WalletInfo {
    return {
      id: asWalletId("550e8400-e29b-41d4-a716-446655440000"),
      userId: "user123",
      publicKey: asSolanaAddress(
        "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK"
      ),
      chain: "solana",
      label: asWalletLabel("Test Wallet"),
      isPrimary: false,
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  describe("sortByLeastUsed", () => {
    test("should prioritize never-used wallets", () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

      const wallets: WalletWithStats[] = [
        {
          ...createTestWallet({
            label: asWalletLabel("Used"),
            lastUsedAt: tenMinutesAgo,
          }),
          usageCount: asUsageCount(5),
          lastUsedMinutesAgo: 10,
        },
        {
          ...createTestWallet({
            id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
            label: asWalletLabel("Never Used"),
            lastUsedAt: null,
          }),
          usageCount: asUsageCount(0),
          lastUsedMinutesAgo: null,
        },
      ];

      const sorted = sortByLeastUsed(wallets);
      expect(sorted[0].label).toBe("Never Used");
    });

    test("should sort by usage count", () => {
      const now = new Date();
      const wallets: WalletWithStats[] = [
        {
          ...createTestWallet({
            label: asWalletLabel("Heavy"),
            lastUsedAt: now,
          }),
          usageCount: asUsageCount(10),
          lastUsedMinutesAgo: 5,
        },
        {
          ...createTestWallet({
            id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
            label: asWalletLabel("Light"),
            lastUsedAt: now,
          }),
          usageCount: asUsageCount(2),
          lastUsedMinutesAgo: 5,
        },
      ];

      const sorted = sortByLeastUsed(wallets);
      expect(sorted[0].label).toBe("Light");
    });

    test("should sort by oldest last used when usage equal", () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const wallets: WalletWithStats[] = [
        {
          ...createTestWallet({
            label: asWalletLabel("Recent"),
            lastUsedAt: fiveMinutesAgo,
          }),
          usageCount: asUsageCount(5),
          lastUsedMinutesAgo: 5,
        },
        {
          ...createTestWallet({
            id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
            label: asWalletLabel("Old"),
            lastUsedAt: oneHourAgo,
          }),
          usageCount: asUsageCount(5),
          lastUsedMinutesAgo: 60,
        },
      ];

      const sorted = sortByLeastUsed(wallets);
      expect(sorted[0].label).toBe("Old");
    });
  });

  describe("filterActiveWallets", () => {
    test("should filter only active wallets", () => {
      const wallets: WalletInfo[] = [
        createTestWallet({ label: asWalletLabel("Active 1"), isActive: true }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
          label: asWalletLabel("Inactive"),
          isActive: false,
        }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440002"),
          label: asWalletLabel("Active 2"),
          isActive: true,
        }),
      ];

      const active = filterActiveWallets(wallets);
      expect(active).toHaveLength(2);
      expect(active[0].label).toBe("Active 1");
      expect(active[1].label).toBe("Active 2");
    });
  });

  describe("findPrimaryWallet", () => {
    test("should find primary wallet", () => {
      const wallets: WalletInfo[] = [
        createTestWallet({ label: asWalletLabel("Wallet 1"), isPrimary: false }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
          label: asWalletLabel("Primary"),
          isPrimary: true,
        }),
      ];

      const primary = findPrimaryWallet(wallets);
      expect(primary).not.toBe(null);
      expect(primary!.label).toBe("Primary");
    });

    test("should return null if no primary", () => {
      const wallets: WalletInfo[] = [
        createTestWallet({ label: asWalletLabel("Wallet 1"), isPrimary: false }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
          label: asWalletLabel("Wallet 2"),
          isPrimary: false,
        }),
      ];

      const primary = findPrimaryWallet(wallets);
      expect(primary).toBe(null);
    });

    test("should return oldest if multiple primary (error state)", () => {
      const old = new Date(Date.now() - 1000 * 60 * 60);
      const newer = new Date();

      const wallets: WalletInfo[] = [
        createTestWallet({
          label: asWalletLabel("Newer Primary"),
          isPrimary: true,
          createdAt: newer,
        }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
          label: asWalletLabel("Older Primary"),
          isPrimary: true,
          createdAt: old,
        }),
      ];

      const primary = findPrimaryWallet(wallets);
      expect(primary).not.toBe(null);
      expect(primary!.label).toBe("Older Primary");
    });
  });

  describe("hasUniquelabel", () => {
    test("should return true if label is unique", () => {
      const wallets: WalletInfo[] = [
        createTestWallet({ label: asWalletLabel("Wallet 1") }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
          label: asWalletLabel("Wallet 2"),
        }),
      ];

      expect(
        hasUniquelabel(wallets, asWalletLabel("Wallet 3"))
      ).toBe(true);
    });

    test("should return false if label is duplicate", () => {
      const wallets: WalletInfo[] = [
        createTestWallet({ label: asWalletLabel("Wallet 1") }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
          label: asWalletLabel("Wallet 2"),
        }),
      ];

      expect(
        hasUniquelabel(wallets, asWalletLabel("Wallet 1"))
      ).toBe(false);
    });

    test("should allow same label when excluding wallet ID", () => {
      const walletId = asWalletId("550e8400-e29b-41d4-a716-446655440000");
      const wallets: WalletInfo[] = [
        createTestWallet({ id: walletId, label: asWalletLabel("Wallet 1") }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
          label: asWalletLabel("Wallet 2"),
        }),
      ];

      // Updating wallet's own label should be allowed
      expect(
        hasUniquelabel(wallets, asWalletLabel("Wallet 1"), walletId)
      ).toBe(true);
    });

    test("should handle null labels", () => {
      const wallets: WalletInfo[] = [
        createTestWallet({ label: null }),
        createTestWallet({
          id: asWalletId("550e8400-e29b-41d4-a716-446655440001"),
          label: asWalletLabel("Wallet 2"),
        }),
      ];

      expect(
        hasUniquelabel(wallets, asWalletLabel("Wallet 1"))
      ).toBe(true);
    });
  });
});

// ============================================================================
// CONSTANTS
// ============================================================================

describe("Constants", () => {
  test("MAX_WALLETS_PER_USER should be 10", () => {
    expect(MAX_WALLETS_PER_USER).toBe(10);
  });
});
