/**
 * Price Feed Service Tests
 * Tests for DexScreener, Jupiter fallback, caching, and circuit breaker
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { PriceFeedService } from "../../../src/services/trading/priceFeed.js";
import { asTokenMint } from "../../../src/types/common.js";

describe("PriceFeedService", () => {
  let service: PriceFeedService;
  let originalFetch: typeof global.fetch;

  // Generate unique valid token mint for each test to avoid cache conflicts
  const getTestToken = () => {
    const keypair = Keypair.generate();
    return asTokenMint(keypair.publicKey.toBase58());
  };

  beforeEach(() => {
    // Save original fetch
    originalFetch = global.fetch;

    // Mock global fetch
    global.fetch = vi.fn();

    // Create new service instance
    service = new PriceFeedService(60_000);
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe("DexScreener API", () => {
    test("should fetch price from DexScreener successfully", async () => {
      const testToken = getTestToken();

      // Mock DexScreener response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemaVersion: "1.0.0",
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "test",
              baseToken: { address: testToken, name: "Test", symbol: "TEST" },
              quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Solana", symbol: "SOL" },
              priceNative: "0.001",
            },
          ],
        }),
      });

      const result = await service.getPrice(testToken);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.price).toBe(0.001);
        expect(result.value.source).toBe("dexscreener");
      }
      expect(global.fetch).toHaveBeenCalled();
    });

    test("should handle DexScreener API errors and fallback to Jupiter", async () => {
      const testToken = getTestToken();

      // DexScreener fails
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      // Jupiter fallback succeeds
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            [testToken]: {
              id: testToken,
              type: "token",
              price: "0.002",
            },
          },
          timeTaken: 100,
        }),
      });

      const result = await service.getPrice(testToken);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.source).toBe("jupiter");
        expect(result.value.price).toBe(0.002);
      }
    });

    test("should handle no SOL pair and fallback to Jupiter", async () => {
      const testToken = getTestToken();

      // DexScreener returns USDC pair (not SOL)
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemaVersion: "1.0.0",
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "test",
              baseToken: { address: testToken, name: "Test", symbol: "TEST" },
              quoteToken: { address: "USDC", name: "USD Coin", symbol: "USDC" },
              priceNative: "1.0",
            },
          ],
        }),
      });

      // Jupiter fallback
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            [testToken]: {
              id: testToken,
              type: "token",
              price: "0.001",
            },
          },
          timeTaken: 100,
        }),
      });

      const result = await service.getPrice(testToken);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.source).toBe("jupiter");
      }
    });

    test("should reject invalid negative prices", async () => {
      const testToken = getTestToken();

      // DexScreener returns invalid price
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemaVersion: "1.0.0",
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "test",
              baseToken: { address: testToken, name: "Test", symbol: "TEST" },
              quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Solana", symbol: "SOL" },
              priceNative: "-1", // Invalid
            },
          ],
        }),
      });

      // Jupiter fallback
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            [testToken]: {
              id: testToken,
              type: "token",
              price: "0.001",
            },
          },
          timeTaken: 100,
        }),
      });

      const result = await service.getPrice(testToken);

      // Should use Jupiter due to invalid DexScreener price
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.source).toBe("jupiter");
      }
    });
  });

  describe("Jupiter Fallback", () => {
    test("should fetch from Jupiter when DexScreener unavailable", async () => {
      const testToken = getTestToken();

      // DexScreener fails
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      // Jupiter succeeds
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            [testToken]: {
              id: testToken,
              type: "token",
              price: "0.00456",
            },
          },
          timeTaken: 150,
        }),
      });

      const result = await service.getPrice(testToken);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.price).toBeCloseTo(0.00456, 6);
        expect(result.value.source).toBe("jupiter");
        expect(result.value.confidence).toBe(0.9);
      }
    });

    test("should fail when both DexScreener and Jupiter fail", async () => {
      const testToken = getTestToken();

      // Both sources fail
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await service.getPrice(testToken);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("PRICE_FETCH_FAILED");
      }
    });
  });

  describe("Circuit Breaker", () => {
    test("should open circuit after threshold failures", async () => {
      const testToken = getTestToken();

      // Mock repeated failures
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      // Cause 5 failures (threshold)
      for (let i = 0; i < 5; i++) {
        await service.getPrice(testToken);
      }

      const status = service.getCircuitStatus();
      expect(status.status).toBe("OPEN");
      expect(status.failureCount).toBeGreaterThanOrEqual(5);
    });

    test("should reject requests immediately when circuit is open", async () => {
      const testToken = getTestToken();

      // Mock failures to open circuit
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      // Cause 5 failures
      for (let i = 0; i < 5; i++) {
        await service.getPrice(testToken);
      }

      expect(service.getCircuitStatus().status).toBe("OPEN");

      // Next request should be rejected without calling fetch
      const fetchCallsBefore = (global.fetch as any).mock.calls.length;
      const result = await service.getPrice(testToken);
      const fetchCallsAfter = (global.fetch as any).mock.calls.length;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("CIRCUIT_OPEN");
      }
      // Circuit should fast-fail without additional fetch calls
      expect(fetchCallsAfter).toBe(fetchCallsBefore);
    });
  });
});
