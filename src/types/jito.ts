/**
 * Jito Bundle Types
 *
 * Types for Jito MEV protection through transaction bundles.
 * Bundles provide atomic execution and protection against sandwich attacks.
 */

import type { VersionedTransaction } from "@solana/web3.js";
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
