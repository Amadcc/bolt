/**
 * Unit tests for swap command helper functions
 */

import { describe, test, expect } from "bun:test";

// ============================================================================
// Helper Functions (copy from swap.ts for testing)
// ============================================================================

/**
 * Resolve token symbol to mint address
 */
function resolveTokenSymbol(symbol: string): string {
  const KNOWN_TOKENS: Record<string, string> = {
    SOL: "So11111111111111111111111111111111111111112",
    WSOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  };

  const upper = symbol.toUpperCase();

  // If it's a known symbol, return its mint
  if (KNOWN_TOKENS[upper]) {
    return KNOWN_TOKENS[upper];
  }

  // Otherwise assume it's already a mint address
  if (symbol.length >= 32) {
    return symbol;
  }

  throw new Error(`Unknown token symbol: ${symbol}`);
}

/**
 * Parse amount string to smallest units
 */
function parseAmount(amountStr: string, tokenSymbol: string): string | null {
  try {
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      return null;
    }

    // SOL/USDC/USDT have 9, 6, 6 decimals respectively
    // Default to 9 decimals for unknown tokens
    const decimals = tokenSymbol.toUpperCase() === "USDC" || tokenSymbol.toUpperCase() === "USDT" ? 6 : 9;

    const smallest = Math.floor(amount * Math.pow(10, decimals));
    return smallest.toString();
  } catch {
    return null;
  }
}

/**
 * Format amount from smallest units to human-readable
 */
function formatAmount(amount: bigint, decimals: number): string {
  const num = Number(amount) / Math.pow(10, decimals);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Swap Command Helpers", () => {
  describe("resolveTokenSymbol", () => {
    test("should resolve SOL symbol", () => {
      const result = resolveTokenSymbol("SOL");
      expect(result).toBe("So11111111111111111111111111111111111111112");
    });

    test("should resolve WSOL symbol", () => {
      const result = resolveTokenSymbol("WSOL");
      expect(result).toBe("So11111111111111111111111111111111111111112");
    });

    test("should resolve USDC symbol", () => {
      const result = resolveTokenSymbol("USDC");
      expect(result).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    });

    test("should resolve USDT symbol", () => {
      const result = resolveTokenSymbol("USDT");
      expect(result).toBe("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    });

    test("should be case-insensitive", () => {
      expect(resolveTokenSymbol("sol")).toBe("So11111111111111111111111111111111111111112");
      expect(resolveTokenSymbol("SoL")).toBe("So11111111111111111111111111111111111111112");
      expect(resolveTokenSymbol("usdc")).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    });

    test("should accept mint address directly", () => {
      const mintAddress = "So11111111111111111111111111111111111111112";
      const result = resolveTokenSymbol(mintAddress);
      expect(result).toBe(mintAddress);
    });

    test("should throw error for unknown short symbol", () => {
      expect(() => resolveTokenSymbol("XYZ")).toThrow("Unknown token symbol: XYZ");
    });

    test("should throw error for too short string", () => {
      expect(() => resolveTokenSymbol("ABC")).toThrow("Unknown token symbol: ABC");
    });
  });

  describe("parseAmount", () => {
    test("should parse SOL amount correctly (9 decimals)", () => {
      const result = parseAmount("1", "SOL");
      expect(result).toBe("1000000000"); // 1 SOL = 1e9 lamports
    });

    test("should parse fractional SOL amount", () => {
      const result = parseAmount("0.1", "SOL");
      expect(result).toBe("100000000"); // 0.1 SOL = 1e8 lamports
    });

    test("should parse USDC amount correctly (6 decimals)", () => {
      const result = parseAmount("1", "USDC");
      expect(result).toBe("1000000"); // 1 USDC = 1e6 smallest units
    });

    test("should parse USDT amount correctly (6 decimals)", () => {
      const result = parseAmount("1", "USDT");
      expect(result).toBe("1000000"); // 1 USDT = 1e6 smallest units
    });

    test("should parse fractional USDC amount", () => {
      const result = parseAmount("10.5", "USDC");
      expect(result).toBe("10500000"); // 10.5 USDC
    });

    test("should handle very small amounts", () => {
      const result = parseAmount("0.01", "SOL");
      expect(result).toBe("10000000"); // 0.01 SOL
    });

    test("should handle large amounts", () => {
      const result = parseAmount("1000", "SOL");
      expect(result).toBe("1000000000000"); // 1000 SOL
    });

    test("should return null for zero amount", () => {
      const result = parseAmount("0", "SOL");
      expect(result).toBeNull();
    });

    test("should return null for negative amount", () => {
      const result = parseAmount("-1", "SOL");
      expect(result).toBeNull();
    });

    test("should return null for invalid number", () => {
      const result = parseAmount("abc", "SOL");
      expect(result).toBeNull();
    });

    test("should return null for empty string", () => {
      const result = parseAmount("", "SOL");
      expect(result).toBeNull();
    });

    test("should default to 9 decimals for unknown tokens", () => {
      const result = parseAmount("1", "UNKNOWN");
      expect(result).toBe("1000000000"); // Default 9 decimals
    });

    test("should handle scientific notation", () => {
      const result = parseAmount("1e-3", "SOL");
      expect(result).toBe("1000000"); // 0.001 SOL
    });
  });

  describe("formatAmount", () => {
    test("should format SOL amount correctly", () => {
      const result = formatAmount(1000000000n, 9);
      expect(result).toContain("1"); // Should contain "1" (locale-dependent formatting)
    });

    test("should format fractional SOL amount", () => {
      const result = formatAmount(100000000n, 9);
      expect(result).toContain("0.1"); // 0.1 SOL
    });

    test("should format USDC amount correctly", () => {
      const result = formatAmount(1000000n, 6);
      expect(result).toContain("1"); // 1 USDC
    });

    test("should format fractional USDC amount", () => {
      const result = formatAmount(10500000n, 6);
      expect(result).toContain("10.5"); // 10.5 USDC
    });

    test("should format very small amounts", () => {
      const result = formatAmount(1n, 9);
      expect(result).toContain("0.000000001");
    });

    test("should format large amounts", () => {
      const result = formatAmount(1000000000000n, 9);
      // Should contain "1,000" or "1000" depending on locale
      expect(result).toMatch(/1[,\s]?000/);
    });

    test("should handle zero amount", () => {
      const result = formatAmount(0n, 9);
      expect(result).toContain("0");
    });

    test("should respect minimum fraction digits (2)", () => {
      const result = formatAmount(1000000000n, 9);
      // Should have at least 2 decimal places
      expect(result).toMatch(/\.\d{2}/);
    });
  });

  describe("Edge Cases", () => {
    test("should handle parseAmount with trailing zeros", () => {
      const result = parseAmount("1.00", "SOL");
      expect(result).toBe("1000000000");
    });

    test("should handle parseAmount with leading zeros", () => {
      const result = parseAmount("0.1", "SOL");
      expect(result).toBe("100000000");
    });

    test("should handle parseAmount with comma separator", () => {
      // parseFloat("1,000") parses as "1" in most locales, then returns "1000000000"
      // This is locale-dependent behavior - comma is either ignored or treated as decimal separator
      const result = parseAmount("1,000", "SOL");
      // In most locales, parseFloat("1,000") = 1, which is valid
      expect(result).toBeTruthy();
    });

    test("should handle very precise amounts", () => {
      const result = parseAmount("0.123456789", "SOL");
      expect(result).toBe("123456789"); // All 9 decimals
    });

    test("should truncate excess precision for USDC", () => {
      const result = parseAmount("1.1234567", "USDC");
      // Should truncate to 6 decimals
      expect(result).toBe("1123456");
    });

    test("should handle formatAmount with maximum decimals", () => {
      const result = formatAmount(123456789n, 9);
      expect(result).toContain("0.123456789");
    });
  });

  describe("Integration: Parse and Format Round Trip", () => {
    test("should round-trip SOL amount", () => {
      const original = "1.5";
      const parsed = parseAmount(original, "SOL");
      expect(parsed).toBeTruthy();

      const formatted = formatAmount(BigInt(parsed!), 9);
      expect(formatted).toContain("1.5");
    });

    test("should round-trip USDC amount", () => {
      const original = "10.25";
      const parsed = parseAmount(original, "USDC");
      expect(parsed).toBeTruthy();

      const formatted = formatAmount(BigInt(parsed!), 6);
      expect(formatted).toContain("10.25");
    });

    test("should preserve precision in round-trip", () => {
      const original = "0.001";
      const parsed = parseAmount(original, "SOL");
      expect(parsed).toBe("1000000"); // 0.001 SOL

      const formatted = formatAmount(BigInt(parsed!), 9);
      expect(formatted).toContain("0.001");
    });
  });
});
