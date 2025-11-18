/**
 * Jito Bundle Types
 *
 * Types for Jito MEV protection through transaction bundles.
 * Bundles provide atomic execution and protection against sandwich attacks.
 */

import type { TransactionSignature } from "./common.js";

// ============================================================================
// Configuration
// ============================================================================

export interface JitoConfig {
  /** Jito Block Engine RPC endpoints (with automatic failover) */
  blockEngineUrls: string[];
  /** Timeout for bundle submission (ms) */
  timeout: number;
  /** Timeout for bundle confirmation (ms) */
  confirmationTimeout: number;
  /** Tip amount in lamports */
  tipLamports: bigint;
  /** Enable Jito bundles */
  enabled: boolean;
  /** DAY 8: Enable anti-sandwich protection with jitodontfront account */
  useAntiSandwich?: boolean;
}

// ============================================================================
// Bundle Status
// ============================================================================

export type BundleStatus =
  | "Pending"
  | "Invalid"
  | "Failed"
  | "Landed"
  | "Timeout";

export interface BundleResult {
  /** Bundle UUID returned by Jito */
  bundleId: string;
  /** Status of the bundle */
  status: BundleStatus;
  /** Transaction signatures if bundle landed */
  signatures?: TransactionSignature[];
  /** Slot number if bundle landed */
  slot?: number;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// API Responses
// ============================================================================

export interface JitoRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

export interface BundleStatusResponse {
  bundle_id: string;
  transactions: string[];
  slot: number;
  confirmation_status: "processed" | "confirmed" | "finalized";
  err: string | null;
}

export interface InflightBundleStatusResponse {
  bundle_id: string;
  status: "Invalid" | "Pending" | "Failed" | "Landed";
  landed_slot?: number;
}

// ============================================================================
// Tip Calculation
// ============================================================================

export type TipLevel = "base" | "competitive" | "high";

export interface TipConfiguration {
  /** Base tip: 0.0001 SOL (100,000 lamports) */
  base: bigint;
  /** Competitive tip: 0.001 SOL (1,000,000 lamports) */
  competitive: bigint;
  /** High priority tip: 0.01 SOL (10,000,000 lamports) */
  high: bigint;
}

// ============================================================================
// DAY 8: Smart Routing Types
// ============================================================================

/**
 * Execution mode for Jito smart routing
 *
 * - MEV_TURBO: Jito-only (fastest, best MEV protection, single submission)
 * - MEV_SECURE: Jito + RPC race (redundancy, whichever confirms first)
 */
export type ExecutionMode = "MEV_TURBO" | "MEV_SECURE";

/**
 * Smart routing options for bundle submission
 */
export interface SmartRoutingOptions {
  /** Execution mode (TURBO = Jito only, SECURE = race condition) */
  mode: ExecutionMode;
  /** Trade size in SOL for dynamic tip calculation */
  tradeSizeSol: number;
  /** Enable anti-sandwich protection with jitodontfront */
  antiSandwich?: boolean;
  /** Bundle confirmation timeout (ms) - default 5s for snipers */
  bundleTimeout?: number;
}

/**
 * Result from smart routing execution
 */
export interface SmartRoutingResult {
  /** Which method confirmed first: "jito" or "rpc" */
  method: "jito" | "rpc";
  /** Transaction signature */
  signature: TransactionSignature;
  /** Confirmation slot */
  slot: number;
  /** Bundle ID if Jito was used */
  bundleId?: string;
  /** Total time from submission to confirmation (ms) */
  confirmationTimeMs: number;
}

// ============================================================================
// Errors
// ============================================================================

export type JitoErrorType =
  | "BUNDLE_SUBMISSION_FAILED"
  | "BUNDLE_INVALID"
  | "BUNDLE_TIMEOUT"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "UNKNOWN";

export interface JitoError {
  type: JitoErrorType;
  message: string;
  bundleId?: string;
}
