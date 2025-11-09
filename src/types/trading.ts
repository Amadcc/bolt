/**
 * Trading Executor types
 */

import type { TokenMint, TransactionSignature } from "./common.js";

// ============================================================================
// Trading Executor Types
// ============================================================================

/**
 * Trade execution parameters
 */
export interface TradeParams {
  userId: string;
  inputMint: TokenMint;
  outputMint: TokenMint;
  amount: string;
  slippageBps?: number;
}

/**
 * Trade result
 */
export interface TradeResult {
  orderId: string;
  signature: TransactionSignature;
  inputAmount: bigint;
  outputAmount: bigint;
  inputMint: TokenMint;
  outputMint: TokenMint;
  priceImpactPct: number;
  commissionUsd: number;
  slot: number;
}

/**
 * Trading Executor errors
 */
export type TradingError =
  | { type: "WALLET_NOT_FOUND"; message: string }
  | { type: "INVALID_PASSWORD"; message: string }
  | { type: "SWAP_FAILED"; reason: string }
  | { type: "QUOTE_FAILED"; message: string }
  | { type: "DATABASE_ERROR"; message: string }
  | { type: "COMMISSION_CALCULATION_FAILED"; message: string }
  | { type: "UNKNOWN"; message: string };
