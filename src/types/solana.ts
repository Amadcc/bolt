/**
 * Solana-specific types and state machines
 */

import type {
  SolanaAddress,
  TokenMint,
  TransactionSignature,
  Lamports,
} from "./common.js";

// ============================================================================
// Order State Machine (Discriminated Union)
// ============================================================================

export type OrderState =
  | { status: "pending"; createdAt: Date }
  | { status: "simulating"; startedAt: Date }
  | { status: "signing"; transactionData: Uint8Array }
  | { status: "broadcasting"; signature: TransactionSignature }
  | {
      status: "confirming";
      signature: TransactionSignature;
      sentAt: Date;
    }
  | {
      status: "confirmed";
      signature: TransactionSignature;
      slot: number;
      confirmedAt: Date;
    }
  | { status: "failed"; error: string; failedAt: Date };

/**
 * Type-safe state transitions
 */
export function canTransitionOrder(
  current: OrderState["status"],
  next: OrderState["status"]
): boolean {
  const allowed: Record<string, string[]> = {
    pending: ["simulating", "failed"],
    simulating: ["signing", "failed"],
    signing: ["broadcasting", "failed"],
    broadcasting: ["confirming", "failed"],
    confirming: ["confirmed", "failed"],
    confirmed: [],
    failed: [],
  };

  return allowed[current]?.includes(next) ?? false;
}

// ============================================================================
// Wallet Types
// ============================================================================

export interface WalletInfo {
  publicKey: SolanaAddress;
  chain: "solana";
  isActive: boolean;
}

export interface WalletBalance {
  sol: Lamports;
  tokens: TokenBalance[];
}

export interface TokenBalance {
  mint: TokenMint;
  amount: bigint;
  decimals: number;
  uiAmount: number;
}

// ============================================================================
// Swap/Trade Types
// ============================================================================

export type SwapSide = "buy" | "sell";

export interface SwapParams {
  inputMint: TokenMint;
  outputMint: TokenMint;
  amount: Lamports;
  slippageBps: number;
  userPublicKey: SolanaAddress;
}

export interface SwapQuote {
  inputMint: TokenMint;
  outputMint: TokenMint;
  inAmount: bigint;
  outAmount: bigint;
  otherAmountThreshold: bigint;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: number;
  routePlan: unknown[];
}

export interface SwapResult {
  signature: TransactionSignature;
  inputAmount: bigint;
  outputAmount: bigint;
  priceImpactPct: number;
}

// ============================================================================
// Error Types (Discriminated Unions)
// ============================================================================

export type SwapError =
  | { type: "NO_ROUTE"; message: string }
  | { type: "INSUFFICIENT_BALANCE"; required: bigint; available: bigint }
  | { type: "SLIPPAGE_EXCEEDED"; expected: bigint; actual: bigint }
  | { type: "RATE_LIMITED"; retryAfter: number }
  | { type: "TRANSACTION_FAILED"; signature?: TransactionSignature; reason: string }
  | { type: "TIMEOUT"; message: string }
  | { type: "UNKNOWN"; message: string };

export type WalletError =
  | { type: "WALLET_NOT_FOUND"; userId: string }
  | { type: "INVALID_PASSWORD"; message: string }
  | { type: "ENCRYPTION_FAILED"; message: string }
  | { type: "DECRYPTION_FAILED"; message: string }
  | { type: "SESSION_EXPIRED"; message: string }
  | { type: "UNKNOWN"; message: string };

// ============================================================================
// Honeypot Detection Types
// ============================================================================

export interface HoneypotCheckResult {
  tokenMint: TokenMint;
  isHoneypot: boolean;
  riskScore: number; // 0-100
  checks: {
    mintAuthority: boolean;
    freezeAuthority: boolean;
    liquidityLocked: boolean;
    topHoldersConcentration: number;
    contractVerified: boolean;
  };
  checkedAt: Date;
}

export type HoneypotRiskLevel = "low" | "medium" | "high" | "critical";

export function getHoneypotRiskLevel(score: number): HoneypotRiskLevel {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}
