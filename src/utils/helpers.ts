/**
 * Helper utilities for common operations
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { Lamports } from "../types/common.js";
import { asLamports } from "../types/common.js";

type CryptoLike = {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};

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
 * Convert SOL to lamports
 */
export function solToLamports(sol: number): Lamports {
  if (sol < 0 || !Number.isFinite(sol)) {
    throw new TypeError("SOL amount must be non-negative finite number");
  }
  return asLamports(BigInt(Math.floor(sol * 1e9)));
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
  const globalCrypto = (globalThis as { crypto?: CryptoLike }).crypto;

  if (globalCrypto && typeof globalCrypto.getRandomValues === "function") {
    return globalCrypto.getRandomValues(new Uint8Array(length));
  }

  // Fallback for Node.js
  return new Uint8Array(nodeRandomBytes(length));
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
