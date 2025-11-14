/**
 * Jupiter v6 Ultra API type definitions
 * @see https://dev.jup.ag/api-reference/ultra
 */

import type { TokenMint, TransactionSignature } from "./common.js";

// ============================================================================
// Quote Request (/order endpoint)
// ============================================================================

export interface JupiterQuoteRequest {
  /** Input token mint address */
  inputMint: TokenMint;
  /** Output token mint address */
  outputMint: TokenMint;
  /** Swap amount (in smallest units) */
  amount: string;
  /** Account executing the swap */
  taker?: string;
  /** Slippage tolerance in basis points (default: 50 = 0.5%) */
  slippageBps?: number;
  /** Account covering gas-related fees */
  payer?: string;
  /** Close authority for created ATAs */
  closeAuthority?: string;
  /** Account for referral fee distribution */
  referralAccount?: string;
  /** Referral fee (50-255 basis points) */
  referralFee?: number;
  /** Platform fee in basis points (for revenue collection) */
  platformFeeBps?: number;
  /** Account to receive platform fees */
  feeAccount?: string;
  /** Exclude specific routers */
  excludeRouters?: ("iris" | "jupiterz" | "dflow" | "okx")[];
  /** Exclude specific DEXes (comma-separated, Iris router only) */
  excludeDexes?: string;
}

// ============================================================================
// Quote Response (/order endpoint)
// ============================================================================

export interface JupiterQuoteResponse {
  /** Swap mode */
  mode: string;
  /** Input token mint */
  inputMint: string;
  /** Output token mint */
  outputMint: string;
  /** Input amount (smallest units) */
  inAmount: string;
  /** Output amount (smallest units) */
  outAmount: string;
  /** Input USD value */
  inUsdValue: number;
  /** Output USD value */
  outUsdValue: number;
  /** Price impact (0-1 range) */
  priceImpact: number;
  /** Swap USD value */
  swapUsdValue: number;
  /** Minimum output amount after slippage */
  otherAmountThreshold: string;
  /** Swap mode */
  swapMode: "ExactIn" | "ExactOut";
  /** Slippage in basis points */
  slippageBps: number;
  /** @deprecated Use priceImpact instead */
  priceImpactPct: string;
  /** Route plan details */
  routePlan: RouteInfo[];
  /** Fee token mint */
  feeMint: string;
  /** Fee in basis points */
  feeBps: number;
  /** Platform fee details */
  platformFee: {
    amount: string;
    feeBps: number;
  };
  /** Signature fee in lamports */
  signatureFeeLamports: number;
  /** Signature fee payer */
  signatureFeePayer: string | null;
  /** Prioritization fee in lamports */
  prioritizationFeeLamports: number;
  /** Prioritization fee payer */
  prioritizationFeePayer: string | null;
  /** Rent fee in lamports */
  rentFeeLamports: number;
  /** Rent fee payer */
  rentFeePayer: string | null;
  /** Base64-encoded unsigned transaction (null if error) */
  transaction: string | null;
  /** Whether transaction is gasless */
  gasless: boolean;
  /** Request ID (required for /execute) */
  requestId: string;
  /** Router used */
  router: "iris" | "jupiterz" | "dflow" | "okx";
  /** @deprecated Swap type */
  swapType: string;
  /** Taker account */
  taker: string | null;
  /** Maker account */
  maker: string | null;
  /** Quote ID */
  quoteId: string;
  /** Quote expiration timestamp */
  expireAt: string;
  /** Total processing time in ms */
  totalTime: number;
  /** Error code (1=Insufficient funds, 2=Top up, 3=Minimum amount) */
  errorCode?: number;
  /** Error message for display */
  errorMessage?: string;
}

export interface RouteInfo {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
  bps: number;
}

// ============================================================================
// Execute Request (/execute endpoint)
// ============================================================================

export interface JupiterExecuteRequest {
  /** Base64-encoded signed transaction */
  signedTransaction: string;
  /** Request ID from /order response */
  requestId: string;
}

// ============================================================================
// Execute Response (/execute endpoint)
// ============================================================================

export interface JupiterExecuteResponse {
  /** Execution status */
  status: "Success" | "Failed";
  /** Status code */
  code: number;
  /** Transaction signature */
  signature: string;
  /** Slot number */
  slot: string;
  /** Error message (if failed) */
  error?: string;
  /** Total input amount */
  totalInputAmount: string;
  /** Total output amount */
  totalOutputAmount: string;
  /** Actual input amount result */
  inputAmountResult: string;
  /** Actual output amount result */
  outputAmountResult: string;
  /** Swap events from the transaction */
  swapEvents: SwapEvent[];
}

export interface SwapEvent {
  inputMint: string;
  inputAmount: string;
  outputMint: string;
  outputAmount: string;
}

// ============================================================================
// Error Responses
// ============================================================================

export interface JupiterErrorResponse {
  error: string;
  code?: number;
}

// ============================================================================
// Service-Level Types (for our abstraction)
// ============================================================================

export interface JupiterSwapParams {
  inputMint: TokenMint;
  outputMint: TokenMint;
  amount: string;
  userPublicKey: string;
  slippageBps?: number;
  referralAccount?: string;
  platformFeeBps?: number;
  feeAccount?: string;

  // ========== 2025 PERFORMANCE OPTIMIZATIONS ==========

  /**
   * Restrict intermediate tokens to high-liquidity pairs only
   * Prevents routing through low-liquidity pools that cause failures
   *
   * @default true (recommended for sniping)
   * @see https://www.quicknode.com/docs/solana/jupiter-transactions
   */
  restrictIntermediateTokens?: boolean;

  /**
   * Automatically optimize compute unit limit based on swap complexity
   * Prevents over-allocation of compute units (saves SOL)
   *
   * @default true
   * @see https://www.quicknode.com/docs/solana/jupiter-transactions
   */
  dynamicComputeUnitLimit?: boolean;

  /**
   * Skip preflight simulation for faster execution
   * Recommended for high-speed trading (sniping)
   *
   * WARNING: Transaction may fail on-chain if there are issues
   *
   * @default true for sniper bots
   * @see https://www.quicknode.com/docs/solana/jupiter-transactions
   */
  skipPreflight?: boolean;

  /**
   * Dynamic slippage optimization
   * Automatically adjusts slippage based on market conditions
   *
   * Example: { minBps: 10, maxBps: 300 } = 0.1% - 3%
   */
  dynamicSlippage?: {
    minBps: number;
    maxBps: number;
  };
}

export interface JupiterSwapResult {
  signature: TransactionSignature;
  inputAmount: bigint;
  outputAmount: bigint;
  priceImpactPct: number;
  slot: number;
}

export type JupiterError =
  | { type: "NO_ROUTE"; message: string }
  | { type: "INSUFFICIENT_BALANCE"; message: string }
  | { type: "MINIMUM_AMOUNT"; message: string }
  | { type: "SLIPPAGE_EXCEEDED"; message: string }
  | { type: "TRANSACTION_FAILED"; signature?: string; reason: string }
  | { type: "API_ERROR"; statusCode: number; message: string }
  | { type: "NETWORK_ERROR"; message: string }
  | { type: "TIMEOUT"; message: string }
  | { type: "UNKNOWN"; message: string };

// ============================================================================
// API Configuration
// ============================================================================

export interface JupiterConfig {
  /** API base URL (free or paid tier) */
  baseUrl: string;
  /** Request timeout in ms */
  timeout: number;
  /** Max retries for transient failures */
  maxRetries: number;
  /** Default slippage in basis points */
  defaultSlippageBps: number;
}

export const JUPITER_FREE_API = "https://lite-api.jup.ag";
export const JUPITER_PAID_API = "https://api.jup.ag";

export const DEFAULT_JUPITER_CONFIG: JupiterConfig = {
  baseUrl: JUPITER_FREE_API,
  timeout: 10000, // 10 seconds
  maxRetries: 3,
  defaultSlippageBps: 50, // 0.5%
};
