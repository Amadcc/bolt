/**
 * Liquidity Lock Types
 *
 * Types for detecting and verifying liquidity locks on Solana.
 * Supports multiple lock providers (UNCX, Team Finance, GUACamole, etc.)
 */

import type { SolanaAddress, TokenMint } from "./common.js";

// ============================================================================
// Lock Provider Types
// ============================================================================

export type LockProvider =
  | "UNCX_AMM_V4"
  | "UNCX_AMM_V4_SMART"
  | "UNCX_CP_SWAP"
  | "UNCX_CLMM"
  | "GUACAMOLE"
  | "TEAM_FINANCE"
  | "BURNED"
  | "UNKNOWN";

/**
 * Known liquidity lock program IDs
 * Source: UNCX Network documentation (October 2024)
 */
export const LOCK_PROGRAM_IDS: Record<LockProvider, SolanaAddress | null> = {
  // UNCX Network (verified, production)
  UNCX_AMM_V4: "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo" as SolanaAddress,
  UNCX_AMM_V4_SMART: "UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN" as SolanaAddress,
  UNCX_CP_SWAP: "UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB" as SolanaAddress,
  UNCX_CLMM: "UNCXrB8cZXnmtYM1aSo1Wx3pQaeSZYuF2jCTesXvECs" as SolanaAddress,

  // GUACamole (not yet audited as of Jan 2025)
  // TODO: Add program ID when publicly available
  GUACAMOLE: null,

  // Team Finance (program ID not yet documented)
  // TODO: Add program ID when available
  TEAM_FINANCE: null,

  // Special cases
  BURNED: null, // LP tokens sent to burn address
  UNKNOWN: null, // Unknown lock provider
};

/**
 * Known burn addresses where LP tokens are sent to lock liquidity
 */
export const BURN_ADDRESSES: SolanaAddress[] = [
  "11111111111111111111111111111111" as SolanaAddress, // System program (invalid owner)
  "1nc1nerator11111111111111111111111111111111" as SolanaAddress, // Incinerator
];

// ============================================================================
// Lock Check Result Types
// ============================================================================

/**
 * Complete liquidity lock check result
 */
export interface LiquidityLockResult {
  /** Whether liquidity is locked */
  isLocked: boolean;

  /** Percentage of liquidity that is locked (0-100) */
  lockedPercentage: number;

  /** Total LP tokens in existence */
  totalLpTokens: bigint;

  /** LP tokens that are locked */
  lockedLpTokens: bigint;

  /** Individual locks found */
  locks: LockDetails[];

  /** When this check was performed */
  checkedAt: Date;

  /** Error message if check failed */
  error?: string;
}

/**
 * Details about a specific lock
 */
export interface LockDetails {
  /** Lock provider */
  provider: LockProvider;

  /** Amount of LP tokens locked */
  amount: bigint;

  /** Account holding the locked tokens */
  lockerAddress: SolanaAddress;

  /** When the lock expires (null = permanent/burned) */
  unlockTime: Date | null;

  /** USD value of locked liquidity (if available) */
  valueUsd?: number;

  /** Pool this lock belongs to */
  poolAddress?: SolanaAddress;
}

/**
 * GUACamole API response type
 * From: https://locker-info.guacamole.gg/vaults
 */
export interface GuacamoleVault {
  provider: "raydium" | "meteora"; // DEX provider
  lockedLiquidityUSD: number;
  lockedLiquidityLP: number;
  percentageUSD: number;
  mint: string; // LP token mint
  creator: string; // Creator wallet
  poolId: string; // Pool address
  baseMint: string; // Base token
  quoteMint: string; // Quote token
  lockerId: string; // Locker account address
  unlockTime: string; // ISO timestamp
}

// ============================================================================
// Lock Check Options
// ============================================================================

/**
 * Options for liquidity lock checker
 */
export interface LockCheckOptions {
  /** LP token mint to check */
  lpMint: TokenMint;

  /** Pool address (optional, helps narrow search) */
  poolAddress?: SolanaAddress;

  /** Include GUACamole API check */
  useGuacamoleApi?: boolean;

  /** Cache TTL in seconds (default: 300 = 5 minutes) */
  cacheTtl?: number;
}

// ============================================================================
// Service Configuration
// ============================================================================

/**
 * Configuration for liquidity lock service
 */
export interface LockServiceConfig {
  /** Enable GUACamole API integration */
  enableGuacamoleApi: boolean;

  /** GUACamole API endpoint */
  guacamoleApiUrl: string;

  /** Redis cache TTL for lock checks (seconds) */
  cacheTtl: number;

  /** Enable caching */
  enableCache: boolean;

  /** Circuit breaker config */
  circuitBreaker: {
    failureThreshold: number;
    resetTimeout: number;
  };
}
