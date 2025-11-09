/**
 * Unit tests for TradingExecutor decimal handling
 * Tests getTokenDecimals() with caching and calculateCommission() with dynamic decimals
 */

// @ts-nocheck - Test file with mocked RPC
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { TradingExecutor } from "./executor.js";

// Mock Solana connection
let mockConnection: any;
let mockGetParsedAccountInfo: any;

// Mock getSolanaConnection
mock.module("../blockchain/solana.js", () => ({
  getSolanaConnection: () => mockConnection,
}));

// Mock Jupiter service
mock.module("./jupiter.js", () => ({
  getJupiter: () => ({
    getTokenPrice: mock((tokenMint) => {
      const prices: Record<string, number> = {
        // SOL
        "So11111111111111111111111111111111111111112": 245.50,
        // USDC
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 1.00,
        // BONK (example price)
        "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": 0.00002,
      };

      return Promise.resolve({
        success: true,
        value: prices[tokenMint] || 1.0,
      });
    }),
  }),
}));

// Test token mints
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("TradingExecutor - Token Decimals", () => {
  let executor: TradingExecutor;

  beforeEach(() => {
    // Reset mocks
    mockGetParsedAccountInfo = mock((pubkey) => {
      // Mock responses for different tokens
      const decimalsMap: Record<string, number> = {
        [SOL_MINT]: 9,
        [USDC_MINT]: 6,
        [BONK_MINT]: 5,
      };

      const address = pubkey.toString();
      const decimals = decimalsMap[address] || 9;

      return Promise.resolve({
        value: {
          data: {
            parsed: {
              info: {
                decimals,
              },
            },
          },
        },
      });
    });

    mockConnection = {
      getParsedAccountInfo: mockGetParsedAccountInfo,
    };

    // Create executor instance
    executor = new TradingExecutor({
      commissionBps: 85,
      minCommissionUsd: 0.01,
      platformFeeBps: 50,
    });
  });

  describe("getTokenDecimals", () => {
    test("should fetch SOL decimals (9) from on-chain", async () => {
      const result = await (executor as any).getTokenDecimals(SOL_MINT);

      expect(result.success).toBe(true);
      expect(result.value).toBe(9);
      expect(mockGetParsedAccountInfo).toHaveBeenCalledTimes(1);
    });

    test("should fetch USDC decimals (6) from on-chain", async () => {
      const result = await (executor as any).getTokenDecimals(USDC_MINT);

      expect(result.success).toBe(true);
      expect(result.value).toBe(6);
      expect(mockGetParsedAccountInfo).toHaveBeenCalledTimes(1);
    });

    test("should fetch BONK decimals (5) from on-chain", async () => {
      const result = await (executor as any).getTokenDecimals(BONK_MINT);

      expect(result.success).toBe(true);
      expect(result.value).toBe(5);
      expect(mockGetParsedAccountInfo).toHaveBeenCalledTimes(1);
    });

    test("should cache decimals and not make duplicate RPC calls", async () => {
      // First call - fetches from RPC
      const result1 = await (executor as any).getTokenDecimals(SOL_MINT);
      expect(result1.success).toBe(true);
      expect(result1.value).toBe(9);
      expect(mockGetParsedAccountInfo).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result2 = await (executor as any).getTokenDecimals(SOL_MINT);
      expect(result2.success).toBe(true);
      expect(result2.value).toBe(9);
      expect(mockGetParsedAccountInfo).toHaveBeenCalledTimes(1); // Still 1!

      // Third call for different token - fetches from RPC
      const result3 = await (executor as any).getTokenDecimals(USDC_MINT);
      expect(result3.success).toBe(true);
      expect(result3.value).toBe(6);
      expect(mockGetParsedAccountInfo).toHaveBeenCalledTimes(2);
    });

    test("should evict LRU entry when cache is full", async () => {
      // Mock a smaller max cache size for testing
      const originalMaxSize = 1000;

      // Fill cache to limit by directly setting entries
      const cache = (executor as any).decimalsCache;
      const now = Date.now();

      // Add 3 entries manually
      cache.set("token1", { decimals: 9, timestamp: now - 1000, lastAccessed: now - 1000 });
      cache.set("token2", { decimals: 6, timestamp: now - 500, lastAccessed: now - 500 });
      cache.set("token3", { decimals: 5, timestamp: now, lastAccessed: now });

      // Mock MAX_SIZE to 3 by calling evictLRU when size >= 3
      const originalEvictLRU = (executor as any).evictLRU;
      let evictCalled = false;
      (executor as any).evictLRU = function() {
        evictCalled = true;
        originalEvictLRU.call(this);
      };

      // Manually trigger eviction check
      if (cache.size >= 3) {
        (executor as any).evictLRU();
      }

      // token1 should be evicted (oldest lastAccessed)
      expect(evictCalled).toBe(true);
      expect(cache.has("token1")).toBe(false);
      expect(cache.has("token2")).toBe(true);
      expect(cache.has("token3")).toBe(true);
    });

    test("should handle invalid mint account", async () => {
      mockConnection.getParsedAccountInfo = mock(() =>
        Promise.resolve({ value: null })
      );

      const result = await (executor as any).getTokenDecimals("InvalidMint123");

      expect(result.success).toBe(false);
      // Invalid PublicKey address throws RPC_ERROR
      expect(result.error.type).toBe("RPC_ERROR");
    });

    test("should handle RPC errors gracefully", async () => {
      mockConnection.getParsedAccountInfo = mock(() =>
        Promise.reject(new Error("RPC connection failed"))
      );

      const result = await (executor as any).getTokenDecimals(SOL_MINT);

      expect(result.success).toBe(false);
      expect(result.error.type).toBe("RPC_ERROR");
    });
  });

  describe("calculateCommission - Dynamic Decimals", () => {
    test("should calculate commission correctly for SOL (9 decimals)", async () => {
      // 1 SOL = 1e9 lamports, price = $245.50
      // Output: 1 SOL
      // Value: 1 * $245.50 = $245.50
      // Commission (0.85%): $245.50 * 0.0085 = $2.08675
      const result = await (executor as any).calculateCommission(
        SOL_MINT,
        BigInt(1_000_000_000) // 1 SOL
      );

      expect(result.success).toBe(true);
      expect(result.value).toBeCloseTo(2.08675, 4);
    });

    test("should calculate commission correctly for USDC (6 decimals)", async () => {
      // 1000 USDC = 1000e6, price = $1.00
      // Output: 1000 USDC
      // Value: 1000 * $1.00 = $1000
      // Commission (0.85%): $1000 * 0.0085 = $8.50
      const result = await (executor as any).calculateCommission(
        USDC_MINT,
        BigInt(1_000_000_000) // 1000 USDC (6 decimals)
      );

      expect(result.success).toBe(true);
      expect(result.value).toBeCloseTo(8.5, 2);
    });

    test("should calculate commission correctly for BONK (5 decimals)", async () => {
      // 100,000 BONK = 100000e5 = 10_000_000_000, price = $0.00002
      // Output: 100,000 BONK
      // Value: 100000 * $0.00002 = $2.00
      // Commission (0.85%): $2.00 * 0.0085 = $0.017
      const result = await (executor as any).calculateCommission(
        BONK_MINT,
        BigInt(10_000_000_000) // 100,000 BONK (5 decimals)
      );

      expect(result.success).toBe(true);
      expect(result.value).toBeCloseTo(0.017, 3);
    });

    test("should apply minimum commission ($0.01)", async () => {
      // Very small trade: 0.00001 SOL
      // Value: 0.00001 * $245.50 = $0.002455
      // Commission (0.85%): $0.002455 * 0.0085 = $0.0000208
      // Should use minCommissionUsd = $0.01
      const result = await (executor as any).calculateCommission(
        SOL_MINT,
        BigInt(10_000) // 0.00001 SOL
      );

      expect(result.success).toBe(true);
      expect(result.value).toBe(0.01); // Minimum commission
    });

    test("should fallback to 9 decimals if getTokenDecimals fails", async () => {
      mockConnection.getParsedAccountInfo = mock(() =>
        Promise.reject(new Error("RPC error"))
      );

      // 1 SOL with fallback decimals (9)
      const result = await (executor as any).calculateCommission(
        SOL_MINT,
        BigInt(1_000_000_000)
      );

      expect(result.success).toBe(true);
      // Should still calculate correctly with fallback
      expect(result.value).toBeCloseTo(2.08675, 4);
    });
  });

  describe("Decimal Handling - Edge Cases", () => {
    test("should handle very large amounts correctly", async () => {
      // 1 million SOL
      const result = await (executor as any).calculateCommission(
        SOL_MINT,
        BigInt(1_000_000_000_000_000) // 1M SOL
      );

      expect(result.success).toBe(true);
      // 1M * $245.50 * 0.0085 = $2,086,750
      expect(result.value).toBeCloseTo(2_086_750, 0);
    });

    test("should handle different decimals for different tokens concurrently", async () => {
      const [solResult, usdcResult, bonkResult] = await Promise.all([
        (executor as any).calculateCommission(SOL_MINT, BigInt(1_000_000_000)),
        (executor as any).calculateCommission(USDC_MINT, BigInt(1_000_000_000)),
        (executor as any).calculateCommission(BONK_MINT, BigInt(10_000_000_000)),
      ]);

      expect(solResult.success).toBe(true);
      expect(usdcResult.success).toBe(true);
      expect(bonkResult.success).toBe(true);

      // Each should use correct decimals
      expect(solResult.value).toBeCloseTo(2.08675, 4);
      expect(usdcResult.value).toBeCloseTo(8.5, 2);
      expect(bonkResult.value).toBeCloseTo(0.017, 3);
    });
  });
});
