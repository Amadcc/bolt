/**
 * Liquidity Lock Checker Tests
 *
 * Tests for on-chain liquidity lock detection.
 * Supports UNCX, GUACamole, Team Finance, and burn addresses.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { LiquidityLockChecker } from "../../../src/services/sniper/liquidityLockChecker.js";
import type { LockCheckOptions } from "../../../src/types/liquidityLock.js";
import { asTokenMint } from "../../../src/types/common.js";

// ============================================================================
// Mocks
// ============================================================================

// Mock connection
const createMockConnection = () => {
  return {
    getTokenSupply: vi.fn(),
    getTokenLargestAccounts: vi.fn(),
    getParsedAccountInfo: vi.fn(),
    getTokenAccountBalance: vi.fn(),
  } as unknown as Connection;
};

// ============================================================================
// Test Helpers
// ============================================================================

const MOCK_LP_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UNCX_PROGRAM_ID = "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo";
const BURN_ADDRESS = "11111111111111111111111111111111";

function createLockCheckOptions(
  overrides: Partial<LockCheckOptions> = {}
): LockCheckOptions {
  return {
    lpMint: asTokenMint(MOCK_LP_MINT),
    useGuacamoleApi: false, // Disable API by default in tests
    cacheTtl: 0, // Disable cache in tests
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("LiquidityLockChecker", () => {
  let mockConnection: Connection;
  let checker: LiquidityLockChecker;

  beforeEach(() => {
    mockConnection = createMockConnection();
    checker = new LiquidityLockChecker(mockConnection, {
      enableCache: false, // Disable cache for testing
      enableGuacamoleApi: false, // Disable API for testing
    });
  });

  // ==========================================================================
  // Total Supply Tests
  // ==========================================================================

  describe("getTotalSupply", () => {
    test("should fetch total LP token supply", async () => {
      const mockSupply = "1000000000"; // 1B tokens

      // Mock RPC response
      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn(async (fn) => fn());

      mockConnection.getTokenSupply = vi.fn().mockResolvedValue({
        value: {
          amount: mockSupply,
          decimals: 6,
          uiAmount: 1000,
        },
      });

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.totalLpTokens).toBe(BigInt(mockSupply));
      }
    });

    test("should handle RPC errors gracefully", async () => {
      // Mock circuit breaker to throw error
      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn().mockRejectedValue(new Error("RPC error"));

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("RPC error");
      }
    });
  });

  // ==========================================================================
  // Lock Program Detection Tests
  // ==========================================================================

  describe("checkLockPrograms", () => {
    test("should detect UNCX AMM V4 locked LP tokens", async () => {
      const mockSupply = "1000000000";
      const lockedAmount = "800000000"; // 80% locked

      // Mock circuit breaker
      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn(async (fn) => fn());

      // Mock total supply
      mockConnection.getTokenSupply = vi.fn().mockResolvedValue({
        value: { amount: mockSupply, decimals: 6, uiAmount: 1000 },
      });

      // Mock largest accounts
      mockConnection.getTokenLargestAccounts = vi.fn().mockResolvedValue({
        value: [
          {
            address: new PublicKey("11111111111111111111111111111112"),
            amount: lockedAmount,
          },
        ],
      });

      // Mock account info - owned by UNCX program
      mockConnection.getParsedAccountInfo = vi.fn().mockResolvedValue({
        value: {
          data: {
            program: "spl-token",
            parsed: {
              info: {
                owner: UNCX_PROGRAM_ID,
                tokenAmount: {
                  amount: lockedAmount,
                  decimals: 6,
                },
              },
            },
          },
        },
      });

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.isLocked).toBe(true);
        expect(result.value.lockedPercentage).toBe(80);
        expect(result.value.locks).toHaveLength(1);
        expect(result.value.locks[0].provider).toBe("UNCX_AMM_V4");
        expect(result.value.locks[0].amount).toBe(BigInt(lockedAmount));
      }
    });

    test("should detect no locks when LP tokens are not locked", async () => {
      const mockSupply = "1000000000";

      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn(async (fn) => fn());

      mockConnection.getTokenSupply = vi.fn().mockResolvedValue({
        value: { amount: mockSupply, decimals: 6, uiAmount: 1000 },
      });

      // No locked accounts - empty array
      mockConnection.getTokenLargestAccounts = vi.fn().mockResolvedValue({
        value: [],
      });

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.isLocked).toBe(false);
        expect(result.value.lockedPercentage).toBe(0);
        expect(result.value.locks).toHaveLength(0);
      }
    });

    test("should handle multiple lock programs", async () => {
      const mockSupply = "1000000000";
      const uncxLocked = "400000000"; // 40%
      const guacLocked = "300000000"; // 30%

      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn(async (fn) => fn());

      mockConnection.getTokenSupply = vi.fn().mockResolvedValue({
        value: { amount: mockSupply, decimals: 6, uiAmount: 1000 },
      });

      mockConnection.getTokenLargestAccounts = vi.fn().mockResolvedValue({
        value: [
          {
            address: new PublicKey("11111111111111111111111111111112"),
            amount: uncxLocked,
          },
          {
            address: new PublicKey("11111111111111111111111111111113"),
            amount: guacLocked,
          },
        ],
      });

      // Mock different owners
      let callCount = 0;
      mockConnection.getParsedAccountInfo = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          value: {
            data: {
              program: "spl-token",
              parsed: {
                info: {
                  owner: callCount === 1 ? UNCX_PROGRAM_ID : "UNKNOWN_PROGRAM",
                  tokenAmount: {
                    amount: callCount === 1 ? uncxLocked : guacLocked,
                    decimals: 6,
                  },
                },
              },
            },
          },
        });
      });

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.isLocked).toBe(true);
        // Only UNCX should be detected (UNKNOWN_PROGRAM filtered out)
        expect(result.value.lockedPercentage).toBe(40);
        expect(result.value.locks).toHaveLength(1);
      }
    });
  });

  // ==========================================================================
  // Burn Address Detection Tests
  // ==========================================================================

  describe("checkBurnAddresses", () => {
    test("should detect burned LP tokens", async () => {
      const mockSupply = "1000000000";
      const burnedAmount = "900000000"; // 90% burned

      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn(async (fn) => fn());

      mockConnection.getTokenSupply = vi.fn().mockResolvedValue({
        value: { amount: mockSupply, decimals: 6, uiAmount: 1000 },
      });

      // No lock programs
      mockConnection.getTokenLargestAccounts = vi.fn().mockResolvedValue({
        value: [],
      });

      // Burned tokens in burn address
      mockConnection.getTokenAccountBalance = vi.fn().mockResolvedValue({
        value: {
          amount: burnedAmount,
          decimals: 6,
          uiAmount: 900,
        },
      });

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.isLocked).toBe(true);
        expect(result.value.lockedPercentage).toBe(90);
        expect(result.value.locks.length).toBeGreaterThan(0);

        const burnedLock = result.value.locks.find((l) => l.provider === "BURNED");
        expect(burnedLock).toBeDefined();
        if (burnedLock) {
          expect(burnedLock.amount).toBe(BigInt(burnedAmount));
          expect(burnedLock.unlockTime).toBeNull(); // Permanently locked
        }
      }
    });

    test("should handle no burned tokens", async () => {
      const mockSupply = "1000000000";

      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn(async (fn) => fn());

      mockConnection.getTokenSupply = vi.fn().mockResolvedValue({
        value: { amount: mockSupply, decimals: 6, uiAmount: 1000 },
      });

      mockConnection.getTokenLargestAccounts = vi.fn().mockResolvedValue({
        value: [],
      });

      // No balance in burn address - throw error
      mockConnection.getTokenAccountBalance = vi
        .fn()
        .mockRejectedValue(new Error("Account not found"));

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.isLocked).toBe(false);
        expect(result.value.lockedPercentage).toBe(0);
      }
    });
  });

  // ==========================================================================
  // Combined Detection Tests
  // ==========================================================================

  describe("checkLock - combined", () => {
    test("should combine locks from multiple sources", async () => {
      const mockSupply = "1000000000";
      const programLocked = "400000000"; // 40%
      const burnedAmount = "300000000"; // 30%

      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn(async (fn) => fn());

      mockConnection.getTokenSupply = vi.fn().mockResolvedValue({
        value: { amount: mockSupply, decimals: 6, uiAmount: 1000 },
      });

      mockConnection.getTokenLargestAccounts = vi.fn().mockResolvedValue({
        value: [
          {
            address: new PublicKey("11111111111111111111111111111112"),
            amount: programLocked,
          },
        ],
      });

      mockConnection.getParsedAccountInfo = vi.fn().mockResolvedValue({
        value: {
          data: {
            program: "spl-token",
            parsed: {
              info: {
                owner: UNCX_PROGRAM_ID,
                tokenAmount: { amount: programLocked, decimals: 6 },
              },
            },
          },
        },
      });

      mockConnection.getTokenAccountBalance = vi.fn().mockResolvedValue({
        value: {
          amount: burnedAmount,
          decimals: 6,
          uiAmount: 300,
        },
      });

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.isLocked).toBe(true);
        // 40% (program) + 30% (burned) = 70%
        expect(result.value.lockedPercentage).toBe(70);
        expect(result.value.locks.length).toBeGreaterThanOrEqual(2);

        const uncxLock = result.value.locks.find((l) => l.provider === "UNCX_AMM_V4");
        const burnedLock = result.value.locks.find((l) => l.provider === "BURNED");

        expect(uncxLock).toBeDefined();
        expect(burnedLock).toBeDefined();
      }
    });

    test("should cache results when caching enabled", async () => {
      const checkerWithCache = new LiquidityLockChecker(mockConnection, {
        enableCache: true,
        cacheTtl: 60,
        enableGuacamoleApi: false,
      });

      const mockSupply = "1000000000";

      const mockCircuitBreaker = checkerWithCache["circuitBreaker"];
      mockCircuitBreaker.execute = vi.fn(async (fn) => fn());

      mockConnection.getTokenSupply = vi.fn().mockResolvedValue({
        value: { amount: mockSupply, decimals: 6, uiAmount: 1000 },
      });

      mockConnection.getTokenLargestAccounts = vi.fn().mockResolvedValue({
        value: [],
      });

      const options = createLockCheckOptions();

      // First call - should fetch from RPC
      const result1 = await checkerWithCache.checkLock(options);
      expect(result1.success).toBe(true);

      // Second call - should use cache (RPC not called again)
      const rpcCallCount = (mockConnection.getTokenSupply as any).mock.calls.length;
      const result2 = await checkerWithCache.checkLock(options);
      expect(result2.success).toBe(true);

      // RPC should not be called again due to cache
      expect((mockConnection.getTokenSupply as any).mock.calls.length).toBe(
        rpcCallCount
      );
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe("error handling", () => {
    test("should handle circuit breaker open state", async () => {
      const mockCircuitBreaker = checker["circuitBreaker"];
      mockCircuitBreaker.execute = vi
        .fn()
        .mockRejectedValue(new Error("Circuit breaker OPEN"));

      const options = createLockCheckOptions();
      const result = await checker.checkLock(options);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Circuit breaker OPEN");
      }
    });

    test("should handle invalid LP mint gracefully", async () => {
      // asTokenMint throws for invalid values, which is correct behavior
      expect(() => asTokenMint("invalid")).toThrow("Invalid token mint");
    });
  });
});
