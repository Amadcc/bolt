/**
 * Position Monitor Types
 * Tracks open sniper positions and executes exit strategies (TP/SL)
 */

import type { TokenMint, TransactionSignature, Lamports } from "./common.js";

// ============================================================================
// Branded Types
// ============================================================================

/**
 * Price in SOL per token - high precision
 * Used for entry/exit prices and trigger calculations
 */
export type TokenPrice = number & { readonly __brand: "TokenPrice" };

/**
 * Percentage value (0-100)
 * Used for take-profit and stop-loss thresholds
 */
export type Percentage = number & { readonly __brand: "Percentage" };

/**
 * Constructor for TokenPrice with validation
 * @throws {TypeError} If price is not positive finite number
 */
export function asTokenPrice(value: number): TokenPrice {
  if (value <= 0 || !Number.isFinite(value)) {
    throw new TypeError(
      `Token price must be positive finite number, got: ${value}`
    );
  }
  return value as TokenPrice;
}

/**
 * Constructor for Percentage with validation
 * @throws {TypeError} If percentage is not in range [0, 100]
 */
export function asPercentage(value: number): Percentage {
  if (value < 0 || value > 100 || !Number.isFinite(value)) {
    throw new TypeError(
      `Percentage must be between 0 and 100, got: ${value}`
    );
  }
  return value as Percentage;
}

// ============================================================================
// Monitor Status State Machine
// ============================================================================

/**
 * Position monitor lifecycle states
 * - ACTIVE: Actively checking price and evaluating triggers
 * - PAUSED: Monitoring paused (e.g., stale price, temporary issues)
 * - EXITING: Exit trade in progress
 * - COMPLETED: Position successfully closed
 * - FAILED: Exit attempts exhausted or unrecoverable error
 */
export type MonitorStatus = "ACTIVE" | "PAUSED" | "EXITING" | "COMPLETED" | "FAILED";

/**
 * Complete position monitor state
 * Maps to PositionMonitor Prisma model
 */
export interface PositionMonitorState {
  id: string;
  positionId: string;
  tokenMint: TokenMint;
  userId: string;
  entryPrice: TokenPrice;
  currentPrice: TokenPrice | null;
  lastPriceUpdate: Date | null;
  takeProfitPrice: TokenPrice | null;
  stopLossPrice: TokenPrice | null;
  trailingStopLoss: boolean;
  highestPriceSeen: TokenPrice | null;
  priceCheckCount: number;
  exitAttempts: number;
  lastCheckAt: Date;
  status: MonitorStatus;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Exit Trigger (Discriminated Union)
// ============================================================================

/**
 * Exit trigger types - discriminated union for type-safe trigger handling
 * Each trigger type includes relevant context for logging and metrics
 */
export type ExitTrigger =
  | {
      type: "TAKE_PROFIT";
      triggerPrice: TokenPrice;
      currentPrice: TokenPrice;
      targetPct: Percentage;
    }
  | {
      type: "STOP_LOSS";
      triggerPrice: TokenPrice;
      currentPrice: TokenPrice;
      targetPct: Percentage;
    }
  | {
      type: "TRAILING_STOP";
      triggerPrice: TokenPrice;
      currentPrice: TokenPrice;
      highestPrice: TokenPrice;
      trailingPct: Percentage;
    }
  | {
      type: "MANUAL";
      reason: string;
      requestedBy: string; // userId who requested manual close
    };

// ============================================================================
// Exit Result
// ============================================================================

/**
 * Result of successful position exit
 * Contains all data needed for P&L calculation and reporting
 */
export interface ExitResult {
  positionId: string;
  signature: TransactionSignature;
  trigger: ExitTrigger;
  entryPrice: TokenPrice;
  exitPrice: TokenPrice;
  amountIn: Lamports; // Original SOL input
  amountOut: Lamports; // SOL received from exit
  realizedPnlLamports: Lamports; // Net P&L in lamports (can be negative)
  pnlPercentage: number; // Percentage gain/loss (can be negative)
  executionTimeMs: number; // Time from trigger to confirmation
  exitedAt: Date;
}

// ============================================================================
// Price Update
// ============================================================================

/**
 * Price data from external source
 * Includes metadata for cache management and source tracking
 */
export interface PriceUpdate {
  tokenMint: TokenMint;
  price: TokenPrice;
  timestamp: Date;
  source: "dexscreener" | "jupiter" | "raydium" | "cache";
  /** Confidence score (0-1) - used for fallback decisions */
  confidence?: number;
}

// ============================================================================
// Monitor Configuration
// ============================================================================

/**
 * Global configuration for position monitoring system
 * All durations in milliseconds
 */
export interface MonitorConfig {
  /** Interval between position checks (default: 5000ms = 5s) */
  checkIntervalMs: number;

  /** Price cache TTL - how long to trust cached prices (default: 60000ms = 1min) */
  priceCacheTtl: number;

  /** Maximum concurrent price checks to prevent API rate limits */
  maxConcurrentChecks: number;

  /** Maximum exit attempts before marking position as FAILED */
  maxExitAttempts: number;

  /** Slippage tolerance for exit trades in basis points (default: 100 = 1%) */
  exitSlippageBps: number;

  /** Priority fee mode for exit trades */
  exitPriorityFee: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "TURBO" | "ULTRA";

  /** Use Jito bundles for exit trades (MEV protection) */
  useJitoForExits: boolean;

  /** Jito execution mode for exits */
  jitoExecutionMode?: "MEV_TURBO" | "MEV_SECURE";

  /** Enable circuit breaker to pause monitoring on repeated failures */
  enableCircuitBreaker: boolean;

  /** Circuit breaker: failure threshold before opening */
  circuitBreakerThreshold: number;

  /** Circuit breaker: reset timeout in ms */
  circuitBreakerTimeoutMs: number;
}

// ============================================================================
// Position Monitor Options
// ============================================================================

/**
 * Options for starting position monitoring
 * Allows per-position configuration overrides
 */
export interface StartMonitorOptions {
  /** Override global slippage for this position */
  slippageBps?: number;

  /** Override global priority fee mode */
  priorityFee?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "TURBO" | "ULTRA";

  /** Override global Jito usage */
  useJito?: boolean;

  /** Force immediate price check (skip cache) */
  forceRefresh?: boolean;
}

// ============================================================================
// Error Types (Discriminated Union)
// ============================================================================

/**
 * Position monitor error types - discriminated union for type-safe error handling
 */
export type MonitorError =
  | {
      type: "POSITION_NOT_FOUND";
      positionId: string;
      message: string;
    }
  | {
      type: "PRICE_FETCH_FAILED";
      tokenMint: TokenMint;
      reason: string;
      attemptsExhausted: boolean;
    }
  | {
      type: "EXIT_FAILED";
      positionId: string;
      reason: string;
      attempts: number;
      maxAttempts: number;
      lastError?: string;
    }
  | {
      type: "INVALID_PRICE";
      price: number;
      reason: string;
    }
  | {
      type: "CIRCUIT_OPEN";
      reason: string;
      resetAt: Date;
    }
  | {
      type: "ALREADY_MONITORING";
      positionId: string;
      message: string;
    }
  | {
      type: "INVALID_CONFIGURATION";
      field: string;
      value: unknown;
      reason: string;
    }
  | {
      type: "DATABASE_ERROR";
      operation: string;
      reason: string;
    }
  | {
      type: "UNKNOWN";
      message: string;
      originalError?: Error;
    };

// ============================================================================
// Helper Type Guards
// ============================================================================

/**
 * Type guard to check if trigger is take-profit
 */
export function isTakeProfitTrigger(
  trigger: ExitTrigger
): trigger is Extract<ExitTrigger, { type: "TAKE_PROFIT" }> {
  return trigger.type === "TAKE_PROFIT";
}

/**
 * Type guard to check if trigger is stop-loss
 */
export function isStopLossTrigger(
  trigger: ExitTrigger
): trigger is Extract<ExitTrigger, { type: "STOP_LOSS" }> {
  return trigger.type === "STOP_LOSS";
}

/**
 * Type guard to check if trigger is trailing stop
 */
export function isTrailingStopTrigger(
  trigger: ExitTrigger
): trigger is Extract<ExitTrigger, { type: "TRAILING_STOP" }> {
  return trigger.type === "TRAILING_STOP";
}

/**
 * Type guard to check if trigger is manual
 */
export function isManualTrigger(
  trigger: ExitTrigger
): trigger is Extract<ExitTrigger, { type: "MANUAL" }> {
  return trigger.type === "MANUAL";
}

// ============================================================================
// Price Calculation Helpers
// ============================================================================

/**
 * Calculate take-profit trigger price from entry price and percentage
 */
export function calculateTakeProfitPrice(
  entryPrice: TokenPrice,
  takeProfitPct: Percentage
): TokenPrice {
  const multiplier = 1 + takeProfitPct / 100;
  return asTokenPrice(entryPrice * multiplier);
}

/**
 * Calculate stop-loss trigger price from entry price and percentage
 */
export function calculateStopLossPrice(
  entryPrice: TokenPrice,
  stopLossPct: Percentage
): TokenPrice {
  const multiplier = 1 - stopLossPct / 100;
  return asTokenPrice(entryPrice * multiplier);
}

/**
 * Calculate trailing stop price from highest price seen and trailing percentage
 */
export function calculateTrailingStopPrice(
  highestPrice: TokenPrice,
  trailingPct: Percentage
): TokenPrice {
  const multiplier = 1 - trailingPct / 100;
  return asTokenPrice(highestPrice * multiplier);
}

/**
 * Calculate percentage change between two prices
 * Returns positive for gains, negative for losses
 */
export function calculatePriceChangePct(
  entryPrice: TokenPrice,
  currentPrice: TokenPrice
): number {
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

/**
 * Calculate P&L in lamports
 * Returns positive for profit, negative for loss
 */
export function calculatePnlLamports(
  amountIn: Lamports,
  amountOut: Lamports
): Lamports {
  // Convert bigints to number for subtraction, then back to bigint
  const pnl = Number(amountOut) - Number(amountIn);
  return BigInt(Math.floor(pnl)) as Lamports;
}

/**
 * Calculate P&L percentage
 * Returns positive for profit, negative for loss
 */
export function calculatePnlPercentage(
  amountIn: Lamports,
  amountOut: Lamports
): number {
  if (amountIn === BigInt(0)) return 0;
  const inNum = Number(amountIn);
  const outNum = Number(amountOut);
  return ((outNum - inNum) / inNum) * 100;
}
