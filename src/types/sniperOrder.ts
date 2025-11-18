/**
 * Sniper Order Types
 *
 * Type-safe state machine for auto-sniper order execution.
 * Follows discriminated union pattern for compile-time state validation.
 *
 * Order Lifecycle:
 * 1. PENDING     - Order created, awaiting filter validation
 * 2. VALIDATED   - Filters passed, ready to build transaction
 * 3. SIMULATING  - Getting Jupiter quote
 * 4. SIGNING     - Building and signing transaction
 * 5. BROADCASTING - Sending transaction to network
 * 6. CONFIRMING  - Monitoring transaction confirmation
 * 7. CONFIRMED   - Transaction confirmed successfully
 * 8. FAILED      - Order failed at any stage
 */

import type { TransactionSignature, TokenMint, Lamports } from "./common.js";
import type { FilterCheckResult } from "./sniperFilters.js";

// ============================================================================
// Order State Machine
// ============================================================================

/**
 * Discriminated union for order states
 * Ensures type-safe state transitions at compile time
 */
export type SniperOrderState =
  | {
      status: "PENDING";
      createdAt: Date;
    }
  | {
      status: "VALIDATED";
      filterResult: FilterCheckResult;
      validatedAt: Date;
    }
  | {
      status: "SIMULATING";
      startedAt: Date;
    }
  | {
      status: "SIGNING";
      quoteId: string;
      expectedOutputAmount: bigint;
      priceImpactPct: number;
      startedAt: Date;
    }
  | {
      status: "BROADCASTING";
      signature: TransactionSignature;
      sentAt: Date;
    }
  | {
      status: "CONFIRMING";
      signature: TransactionSignature;
      sentAt: Date;
      confirmations: number;
    }
  | {
      status: "CONFIRMED";
      signature: TransactionSignature;
      slot: number;
      inputAmount: bigint;
      outputAmount: bigint;
      priceImpactPct: number;
      executionTimeMs: number;
      confirmedAt: Date;
    }
  | {
      status: "FAILED";
      error: SniperOrderError;
      failedAt: Date;
      retryCount: number;
    };

// ============================================================================
// Error Types
// ============================================================================

export type SniperOrderError =
  | { type: "FILTER_REJECTED"; reason: string; violations: string[] }
  | { type: "NO_ROUTE"; reason: string }
  | { type: "INSUFFICIENT_BALANCE"; required: bigint; available: bigint }
  | { type: "SLIPPAGE_EXCEEDED"; expected: bigint; actual: bigint }
  | { type: "TRANSACTION_TIMEOUT"; signature?: TransactionSignature }
  | { type: "TRANSACTION_FAILED"; signature: TransactionSignature; reason: string }
  | { type: "NETWORK_ERROR"; reason: string }
  | { type: "MAX_RETRIES_EXCEEDED"; attempts: number }
  | { type: "UNKNOWN"; message: string };

// ============================================================================
// Order Configuration
// ============================================================================

/**
 * Configuration for sniper order execution
 */
export interface SniperOrderConfig {
  /** Token to buy */
  tokenMint: TokenMint;

  /** Amount to spend in lamports (SOL) */
  amountIn: Lamports;

  /** Maximum slippage in basis points (e.g., 500 = 5%) */
  slippageBps: number;

  /** Priority fee mode */
  priorityFee: PriorityFeeMode;

  /** Use Jito MEV protection */
  useJito: boolean;

  /** Maximum retry attempts (default: 3) */
  maxRetries: number;

  /** Timeout per attempt in ms (default: 30000) */
  timeoutMs: number;

  /** Take-profit percentage (null = manual) */
  takeProfitPct?: number | null;

  /** Stop-loss percentage (null = manual) */
  stopLossPct?: number | null;
}

/**
 * Priority fee modes for transaction execution
 */
export type PriorityFeeMode =
  | "NONE" // No priority fee (0 microlamports)
  | "LOW" // Low priority (10k microlamports ~0.00001 SOL)
  | "MEDIUM" // Medium priority (50k microlamports ~0.00005 SOL)
  | "HIGH" // High priority (200k microlamports ~0.0002 SOL)
  | "TURBO" // Very high priority (500k microlamports ~0.0005 SOL)
  | "ULTRA"; // Maximum priority (1M microlamports ~0.001 SOL)

/**
 * Priority fee amounts in microlamports
 */
export const PRIORITY_FEE_AMOUNTS: Record<PriorityFeeMode, number> = {
  NONE: 0,
  LOW: 10_000,
  MEDIUM: 50_000,
  HIGH: 200_000,
  TURBO: 500_000,
  ULTRA: 1_000_000,
};

// ============================================================================
// Complete Order Type
// ============================================================================

/**
 * Complete sniper order with state and configuration
 */
export interface SniperOrder {
  /** Order ID (UUID) */
  id: string;

  /** User ID who created the order */
  userId: string;

  /** Order configuration */
  config: SniperOrderConfig;

  /** Current order state */
  state: SniperOrderState;

  /** Order created timestamp */
  createdAt: Date;

  /** Order last updated timestamp */
  updatedAt: Date;
}

// ============================================================================
// Order Events (for tracking/logging)
// ============================================================================

export type SniperOrderEvent =
  | { type: "ORDER_CREATED"; orderId: string; config: SniperOrderConfig }
  | { type: "FILTER_VALIDATION_STARTED"; orderId: string }
  | { type: "FILTER_VALIDATION_PASSED"; orderId: string; result: FilterCheckResult }
  | { type: "FILTER_VALIDATION_FAILED"; orderId: string; violations: string[] }
  | { type: "QUOTE_REQUEST_STARTED"; orderId: string }
  | { type: "QUOTE_RECEIVED"; orderId: string; quoteId: string; outputAmount: bigint }
  | { type: "TRANSACTION_SIGNING_STARTED"; orderId: string }
  | { type: "TRANSACTION_SIGNED"; orderId: string }
  | { type: "TRANSACTION_BROADCASTING"; orderId: string; signature: TransactionSignature }
  | { type: "TRANSACTION_BROADCASTED"; orderId: string; signature: TransactionSignature }
  | {
      type: "TRANSACTION_CONFIRMED";
      orderId: string;
      signature: TransactionSignature;
      slot: number;
    }
  | {
      type: "TRANSACTION_FAILED";
      orderId: string;
      signature?: TransactionSignature;
      error: SniperOrderError;
    }
  | { type: "RETRY_ATTEMPT"; orderId: string; attemptNumber: number; maxRetries: number }
  | { type: "ORDER_COMPLETED"; orderId: string; executionTimeMs: number }
  | { type: "ORDER_FAILED"; orderId: string; error: SniperOrderError };

// ============================================================================
// State Transition Validation
// ============================================================================

/**
 * Valid state transitions for order state machine
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["VALIDATED", "FAILED"],
  VALIDATED: ["SIMULATING", "FAILED"],
  SIMULATING: ["SIGNING", "FAILED"],
  SIGNING: ["BROADCASTING", "FAILED"],
  BROADCASTING: ["CONFIRMING", "FAILED"],
  CONFIRMING: ["CONFIRMED", "FAILED", "CONFIRMING"], // Can stay in CONFIRMING for multiple checks
  CONFIRMED: [], // Terminal state
  FAILED: [], // Terminal state
};

/**
 * Check if state transition is valid
 */
export function isValidTransition(
  current: SniperOrderState["status"],
  next: SniperOrderState["status"]
): boolean {
  const allowed = VALID_TRANSITIONS[current];
  return allowed ? allowed.includes(next) : false;
}

/**
 * Validate state transition and throw if invalid
 */
export function validateTransition(
  current: SniperOrderState["status"],
  next: SniperOrderState["status"]
): void {
  if (!isValidTransition(current, next)) {
    throw new Error(
      `Invalid state transition: ${current} -> ${next}. ` +
        `Allowed transitions from ${current}: ${VALID_TRANSITIONS[current]?.join(", ") || "none"}`
    );
  }
}

// ============================================================================
// Order Statistics
// ============================================================================

/**
 * Aggregated statistics for sniper orders
 */
export interface SniperOrderStats {
  /** Total orders created */
  totalOrders: number;

  /** Orders by status */
  byStatus: Record<SniperOrderState["status"], number>;

  /** Success rate (confirmed / total) */
  successRate: number;

  /** Average execution time (ms) for confirmed orders */
  avgExecutionTimeMs: number;

  /** Total volume traded (in lamports) */
  totalVolumeLamports: bigint;

  /** Total profit/loss (in lamports) */
  totalPnlLamports: bigint;

  /** Most common failure reasons */
  topFailureReasons: Array<{ reason: string; count: number }>;
}

// ============================================================================
// Position Tracking
// ============================================================================

/**
 * Position created from successful sniper order
 */
export interface SniperPosition {
  /** Position ID (UUID) */
  id: string;

  /** User ID */
  userId: string;

  /** Order ID that created this position */
  orderId: string;

  /** Token mint */
  tokenMint: TokenMint;

  /** Entry transaction signature */
  entrySignature: TransactionSignature;

  /** Amount spent (in lamports) */
  amountIn: Lamports;

  /** Tokens received */
  amountOut: bigint;

  /** Entry price impact */
  entryPriceImpactPct: number;

  /** Current token balance */
  currentBalance: bigint;

  /** Take-profit percentage (null = not set) */
  takeProfitPct: number | null;

  /** Stop-loss percentage (null = not set) */
  stopLossPct: number | null;

  /** Trailing stop-loss enabled */
  trailingStopLoss: boolean;

  /** Highest price seen (for trailing stop) */
  highestPriceSeen: number | null;

  /** Position status */
  status: "OPEN" | "CLOSED_PROFIT" | "CLOSED_LOSS" | "CLOSED_MANUAL";

  /** Exit transaction signature (if closed) */
  exitSignature: TransactionSignature | null;

  /** Realized P&L in lamports (if closed) */
  realizedPnlLamports: Lamports | null;

  /** Position opened timestamp */
  openedAt: Date;

  /** Position closed timestamp */
  closedAt: Date | null;
}
