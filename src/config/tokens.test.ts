/**
 * Unit tests for Token Address Validation
 * Tests resolveTokenSymbol() with Base58 and on-curve validation
 */

import { describe, test, expect } from "bun:test";
import { resolveTokenSymbol } from "./tokens.js";

describe("resolveTokenSymbol - Token Address Validation", () => {
  describe("Known Symbols", () => {
    test("should resolve SOL symbol", () => {
      const result = resolveTokenSymbol("SOL");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value as string).toBe("So11111111111111111111111111111111111111112");
      }
    });

    test("should resolve USDC symbol", () => {
      const result = resolveTokenSymbol("USDC");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value as string).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      }
    });

    test("should resolve BONK symbol", () => {
      const result = resolveTokenSymbol("BONK");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value as string).toBe("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
      }
    });

    test("should be case-insensitive for symbols", () => {
      const lowerResult = resolveTokenSymbol("sol");
      const mixedResult = resolveTokenSymbol("SoL");
      const upperResult = resolveTokenSymbol("SOL");

      expect(lowerResult.success).toBe(true);
      expect(mixedResult.success).toBe(true);
      expect(upperResult.success).toBe(true);

      if (lowerResult.success && mixedResult.success && upperResult.success) {
        expect(lowerResult.value as string).toBe("So11111111111111111111111111111111111111112");
        expect(mixedResult.value as string).toBe("So11111111111111111111111111111111111111112");
        expect(upperResult.value as string).toBe("So11111111111111111111111111111111111111112");
      }
    });
  });

  describe("Valid Addresses (Base58 + On-Curve)", () => {
    test("should accept valid SOL mint address directly", () => {
      const address = "So11111111111111111111111111111111111111112";
      const result = resolveTokenSymbol(address);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value as string).toBe(address);
      }
    });

    test("should accept valid USDC mint address directly", () => {
      const address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const result = resolveTokenSymbol(address);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value as string).toBe(address);
      }
    });

    test("should accept valid BONK mint address directly", () => {
      const address = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
      const result = resolveTokenSymbol(address);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value as string).toBe(address);
      }
    });

    test("should accept valid JUP mint address directly", () => {
      const address = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
      const result = resolveTokenSymbol(address);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value as string).toBe(address);
      }
    });
  });

  describe("Invalid Addresses", () => {
    test("should reject address with invalid Base58 characters (contains 0 and O)", () => {
      // Base58 doesn't include 0, O, I, l
      const badAddress = "0OIl1111111111111111111111111111111111111";
      const result = resolveTokenSymbol(badAddress);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("bad Base58");
      }
    });

    test("should reject too short address", () => {
      const shortAddress = "ABC123";
      const result = resolveTokenSymbol(shortAddress);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Unknown token symbol");
        expect(result.error).toContain("ABC123");
      }
    });

    test("should reject empty string", () => {
      const result = resolveTokenSymbol("");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Unknown token symbol");
      }
    });

    test("should reject invalid Base58 string (correct length)", () => {
      // Valid length but invalid Base58 characters
      const invalidBase58 = "0000000000000000000000000000000000000000000";
      const result = resolveTokenSymbol(invalidBase58);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("bad Base58");
      }
    });

    test("should include first 8 chars of invalid address in error message", () => {
      const badAddress = "InvalidAddress1234567890123456789012345";
      const result = resolveTokenSymbol(badAddress);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("InvalidA");
      }
    });
  });

  describe("Unknown Symbols", () => {
    test("should return error for unknown short symbol", () => {
      const result = resolveTokenSymbol("UNKNOWN");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Unknown token symbol: UNKNOWN");
        expect(result.error).toContain("Available tokens");
      }
    });

    test("should return error for unknown abbreviation", () => {
      const result = resolveTokenSymbol("XYZ");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Unknown token symbol: XYZ");
      }
    });
  });

  describe("Edge Cases", () => {
    test("should handle very long invalid string", () => {
      const longString = "a".repeat(100);
      const result = resolveTokenSymbol(longString);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("bad Base58");
      }
    });

    test("should handle address with special characters", () => {
      const specialChars = "!@#$%^&*()_+{}|:<>?~`";
      const result = resolveTokenSymbol(specialChars);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Unknown token symbol|bad Base58/);
      }
    });

    test("should handle numeric-only string", () => {
      const numeric = "1234567890123456789012345678901234567890123";
      const result = resolveTokenSymbol(numeric);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("bad Base58");
      }
    });
  });
});
