/**
 * Sniper types for token detection and execution
 */

import type {
  Lamports,
  SolanaAddress,
  TokenMint,
  TransactionSignature,
} from "./common";

// ============================================================================
// DEX Types
// ============================================================================

export type DexType =
  | "raydium_v4"
  | "raydium_clmm"
  | "pumpfun"
  | "meteora"
  | "orca";

// ============================================================================
// Pool Detection Events
// ============================================================================

export interface PoolCreatedEvent {
  /** Transaction signature */
  signature: TransactionSignature;
  /** Slot number */
  slot: number;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** DEX that created the pool */
  dex: DexType;
  /** Pool/AMM address */
  poolAddress: SolanaAddress;
  /** Base token mint (new token) */
  baseMint: TokenMint;
  /** Quote token mint (SOL/USDC) */
  quoteMint: TokenMint;
  /** Initial liquidity in lamports */
  initialLiquidity: Lamports;
  /** Pool creator address */
  creator: SolanaAddress;
}

// ============================================================================
// Sniper Filters
// ============================================================================

export interface SniperFilters {
  // Liquidity bounds
  minLiquiditySOL: number;
  maxLiquiditySOL: number;

  // Authority requirements
  requireMintAuthorityRevoked: boolean;
  requireFreezeAuthorityRevoked: boolean;

  // Holdings limits
  maxDevHoldingPercent: number;
  minDevHoldingPercent: number;

  // Pool requirements
  minPoolSupplyPercent: number;

  // Social verification
  requireTwitter: boolean;
  requireWebsite: boolean;
  requireTelegram: boolean;

  // Risk threshold
  maxRiskScore: number;

  // DEX whitelist
  allowedDexs: DexType[];
}

// ============================================================================
// Security Check Results
// ============================================================================

export interface OnChainCheckResult {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  topHolderPercent: number;
  devHoldingPercent: number;
  totalSupply: bigint;
  decimals: number;
  poolSupplyPercent: number;
}

export interface SimulationResult {
  canBuy: boolean;
  canSell: boolean;
  buyTax: number;
  sellTax: number;
  estimatedOutput: Lamports;
  priceImpact: number;
}

// ============================================================================
// Execution Types
// ============================================================================

export type FeeMode = "normal" | "fast" | "turbo";

export interface ExecutionConfig {
  useJito: boolean;
  jitoTipLamports: Lamports;
  feeMode: FeeMode;
  maxRetries: number;
  confirmationTimeout: number;
}

export interface SnipeParams {
  mint: TokenMint;
  amountInLamports: Lamports;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  useJito: boolean;
}

export interface ExecutionResult {
  signature: TransactionSignature;
  executionTime: number;
  slot: number;
}

// ============================================================================
// Auto-Sell Configuration
// ============================================================================

export interface AutoSellConfig {
  enabled: boolean;
  takeProfitPercent: number;
  stopLossPercent: number;
  trailingStopPercent?: number;
}

// ============================================================================
// Sniper Configuration
// ============================================================================

export interface SniperConfig {
  enabled: boolean;
  amountSOL: number;
  filters: SniperFilters;
  execution: ExecutionConfig;
  autoSell?: AutoSellConfig;
}

// ============================================================================
// Snipe Result
// ============================================================================

export interface SnipeResult {
  mint: TokenMint;
  signature: TransactionSignature;
  amountSOL: number;
  riskScore: number;
  executionTime: number;
}

// ============================================================================
// Default Values
// ============================================================================

export const DEFAULT_SNIPER_FILTERS: SniperFilters = {
  minLiquiditySOL: 1,
  maxLiquiditySOL: 1000,
  requireMintAuthorityRevoked: true,
  requireFreezeAuthorityRevoked: true,
  maxDevHoldingPercent: 10,
  minDevHoldingPercent: 0,
  minPoolSupplyPercent: 50,
  requireTwitter: false,
  requireWebsite: false,
  requireTelegram: false,
  maxRiskScore: 50,
  allowedDexs: ["raydium_v4", "pumpfun"],
};

export const FEE_PRESETS: Record<FeeMode, number> = {
  normal: 100_000, // 0.0001 SOL
  fast: 1_500_000, // 0.0015 SOL
  turbo: 7_500_000, // 0.0075 SOL
};
