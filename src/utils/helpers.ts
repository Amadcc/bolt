/**
 * Helper utilities for common operations
 */

import type { Lamports } from "../types/common.js";
import { asLamports } from "../types/common.js";

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    backoff: "linear" | "exponential";
    baseDelay: number;
    shouldRetry?: (error: Error) => boolean;
  }
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry this error
      if (options.shouldRetry && !options.shouldRetry(lastError)) {
        throw lastError;
      }

      if (attempt < options.maxRetries - 1) {
        const delay =
          options.backoff === "exponential"
            ? options.baseDelay * Math.pow(2, attempt)
            : options.baseDelay * (attempt + 1);

        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Truncate address for display
 */
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format lamports to SOL string
 */
export function formatLamports(lamports: Lamports, decimals = 9): string {
  const sol = Number(lamports) / 1e9;
  return sol.toFixed(decimals);
}

/**
 * Convert lamports to SOL
 */
export function lamportsToSol(lamports: Lamports): number {
  return Number(lamports) / 1e9;
}

/**
 * Convert SOL to lamports with precise decimal arithmetic (MEDIUM-3)
 * Uses BigNumber to avoid floating point precision errors
 */
export function solToLamports(sol: number): Lamports {
  if (sol < 0 || !Number.isFinite(sol)) {
    throw new TypeError("SOL amount must be non-negative finite number");
  }

  // MEDIUM-3: Use BigNumber for precise decimal arithmetic
  // Avoids floating point errors like: 0.1 + 0.2 !== 0.3
  const BigNumber = require("bignumber.js");
  const lamports = new BigNumber(sol)
    .multipliedBy(new BigNumber(10).pow(9))
    .integerValue(BigNumber.ROUND_DOWN);

  return asLamports(BigInt(lamports.toString()));
}

/**
 * Format USD cents to dollar string
 */
export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Generate cryptographically secure random bytes
 */
export function generateRandomBytes(length: number): Uint8Array {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint8Array(length));
  }
  // Fallback for Node.js
  const { randomBytes } = require("crypto");
  return new Uint8Array(randomBytes(length));
}

/**
 * Generate random hex string (for session tokens, etc)
 */
export function generateRandomHex(length: number): string {
  const bytes = generateRandomBytes(length);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Safe JSON parse with fallback
 */
export function safeJsonParse<T>(
  json: string,
  fallback: T
): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Check if value is null or undefined
 */
export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Assert value is not null/undefined
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message = "Value is null or undefined"
): asserts value is T {
  if (isNullish(value)) {
    throw new Error(message);
  }
}

/**
 * Clamp number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Delay execution until next tick (useful for avoiding tight loops)
 */
export async function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ============================================================================
// URL Validation (LOW-5: HTTPS Enforcement)
// ============================================================================

/**
 * Validate that URL uses HTTPS protocol (LOW-5)
 *
 * Security requirement: All external URLs must use HTTPS to prevent
 * man-in-the-middle attacks and ensure data confidentiality.
 *
 * Exceptions:
 * - localhost URLs (development)
 * - 127.0.0.1 URLs (development)
 * - redis:// protocol (internal service)
 *
 * @param url - URL to validate
 * @param options - Validation options
 * @returns true if URL is secure, false otherwise
 */
export function isSecureUrl(
  url: string,
  options: {
    allowLocalhost?: boolean;
    allowRedis?: boolean;
    context?: string; // For error messages
  } = {}
): { valid: boolean; error?: string } {
  const { allowLocalhost = true, allowRedis = false, context = "URL" } = options;

  try {
    const parsed = new URL(url);

    // Allow redis:// for internal services
    if (allowRedis && parsed.protocol === "redis:") {
      return { valid: true };
    }

    // Allow localhost in development
    if (allowLocalhost) {
      const isLocalhost =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1";

      if (isLocalhost) {
        return { valid: true };
      }
    }

    // Require HTTPS for all external URLs
    if (parsed.protocol !== "https:") {
      return {
        valid: false,
        error: `${context} must use HTTPS protocol. Got: ${parsed.protocol}//${parsed.hostname}`,
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Invalid ${context} format: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Validate HTTPS URL and throw if invalid (LOW-5)
 *
 * @param url - URL to validate
 * @param context - Context for error message
 * @throws {Error} If URL is not HTTPS
 */
export function requireHttpsUrl(url: string, context: string): void {
  const result = isSecureUrl(url, { allowLocalhost: false, context });
  if (!result.valid) {
    throw new Error(result.error || `${context} validation failed`);
  }
}

/**
 * Validate array of HTTPS URLs (LOW-5)
 *
 * @param urls - URLs to validate
 * @param context - Context for error messages
 * @returns Array of validation results
 */
export function validateHttpsUrls(
  urls: string[],
  context: string
): Array<{ url: string; valid: boolean; error?: string }> {
  return urls.map((url) => {
    const result = isSecureUrl(url, { allowLocalhost: false, context });
    return {
      url,
      ...result,
    };
  });
}
