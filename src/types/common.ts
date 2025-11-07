/**
 * Common types and utilities with type-safety guarantees
 * Following branded types pattern to prevent type confusion
 */

import { PublicKey } from "@solana/web3.js";

// ============================================================================
// Result<T> Pattern - No throwing in hot paths
// ============================================================================

export type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

export const Ok = <T>(value: T): Result<T, never> => ({
  success: true,
  value,
});

export const Err = <E>(error: E): Result<never, E> => ({
  success: false,
  error,
});

// ============================================================================
// Branded Types - Prevent mixing different value types
// ============================================================================

/**
 * Solana address - validated on-curve public key
 */
export type SolanaAddress = string & { readonly __brand: "SolanaAddress" };

/**
 * Token mint address
 */
export type TokenMint = string & { readonly __brand: "TokenMint" };

/**
 * Transaction signature
 */
export type TransactionSignature = string & {
  readonly __brand: "TxSignature";
};

/**
 * Encrypted private key (base64)
 */
export type EncryptedPrivateKey = string & {
  readonly __brand: "EncryptedPrivateKey";
};

/**
 * Session token for temporary auth
 */
export type SessionToken = string & { readonly __brand: "SessionToken" };

/**
 * Lamports (Solana's smallest unit)
 */
export type Lamports = bigint & { readonly __brand: "Lamports" };

/**
 * USD cents for monetary values
 */
export type UsdCents = number & { readonly __brand: "UsdCents" };

// ============================================================================
// Branded Type Constructors with Validation
// ============================================================================

export function asSolanaAddress(value: string): SolanaAddress {
  try {
    const pubkey = new PublicKey(value);
    if (!PublicKey.isOnCurve(pubkey.toBytes())) {
      throw new TypeError(`Address not on curve: ${value}`);
    }
    return value as SolanaAddress;
  } catch (error) {
    throw new TypeError(
      `Invalid Solana address: ${value} - ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function asTokenMint(value: string): TokenMint {
  try {
    const pubkey = new PublicKey(value);
    if (!PublicKey.isOnCurve(pubkey.toBytes())) {
      throw new TypeError(`Token mint not on curve: ${value}`);
    }
    return value as TokenMint;
  } catch (error) {
    throw new TypeError(
      `Invalid token mint: ${value} - ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function asTransactionSignature(value: string): TransactionSignature {
  // Basic validation: base58 string, ~87-88 chars
  if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(value)) {
    throw new TypeError(`Invalid transaction signature: ${value}`);
  }
  return value as TransactionSignature;
}

export function asEncryptedPrivateKey(value: string): EncryptedPrivateKey {
  // Must be non-empty string (actual validation in encryption service)
  if (!value || value.trim().length === 0) {
    throw new TypeError("Encrypted private key cannot be empty");
  }
  return value as EncryptedPrivateKey;
}

export function asSessionToken(value: string): SessionToken {
  // Must be non-empty string (actual validation in session service)
  if (!value || value.trim().length === 0) {
    throw new TypeError("Session token cannot be empty");
  }
  return value as SessionToken;
}

export function asLamports(value: bigint): Lamports {
  if (value < 0n) {
    throw new TypeError("Lamports cannot be negative");
  }
  return value as Lamports;
}

export function asUsdCents(value: number): UsdCents {
  if (value < 0 || !Number.isFinite(value)) {
    throw new TypeError("USD cents must be non-negative finite number");
  }
  return value as UsdCents;
}

// ============================================================================
// Conversion Utilities
// ============================================================================

export function solToLamports(sol: number): Lamports {
  if (sol < 0 || !Number.isFinite(sol)) {
    throw new TypeError("SOL amount must be non-negative finite number");
  }

  // MEDIUM-3: Use BigNumber for precise decimal arithmetic
  const BigNumber = require("bignumber.js");
  const lamports = new BigNumber(sol)
    .multipliedBy(new BigNumber(10).pow(9))
    .integerValue(BigNumber.ROUND_DOWN);

  return asLamports(BigInt(lamports.toString()));
}

// LOW-2: Re-export helper functions from utils/helpers.ts to avoid duplication
export {
  lamportsToSol,
  formatLamports,
  truncateAddress,
  sleep,
  retry,
} from "../utils/helpers.js";
