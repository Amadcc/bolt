/**
 * Sniper Filter Types
 *
 * Configurable risk filters for auto-sniper system.
 * Allows users to define criteria for automatic token purchases.
 *
 * Priority levels:
 * - Conservative: Strictest filters (lowest risk)
 * - Balanced: Moderate filters (medium risk)
 * - Aggressive: Minimal filters (highest risk)
 */

import type { RiskScore } from "./honeypot.js";

// ============================================================================
// Filter Configuration
// ============================================================================

/**
 * Complete sniper filter configuration
 * All parameters are optional - null/undefined means "no filter"
 */
export interface SniperFilters {
  // ===== Authority Checks =====
  /**
   * Require mint authority to be revoked (null = disabled minting)
   * Default: true (Conservative/Balanced), false (Aggressive)
   */
  requireMintDisabled?: boolean;

  /**
   * Require freeze authority to be revoked (null = can't freeze accounts)
   * Default: true (Conservative/Balanced), false (Aggressive)
   */
  requireFreezeDisabled?: boolean;

  // ===== Liquidity Filters =====
  /**
   * Minimum liquidity in SOL
   * Default: 10 SOL (Conservative), 5 SOL (Balanced), 1 SOL (Aggressive)
   */
  minLiquiditySol?: number;

  /**
   * Maximum liquidity in SOL (avoid very high liquidity = less upside potential)
   * Default: null (no max), 1000 SOL (Conservative)
   */
  maxLiquiditySol?: number | null;

  /**
   * Require liquidity to be locked
   * Default: true (Conservative), false (Balanced/Aggressive)
   */
  requireLiquidityLocked?: boolean;

  /**
   * Minimum liquidity lock percentage (if locked)
   * Default: 80% (Conservative), 50% (Balanced), null (Aggressive)
   */
  minLiquidityLockPct?: number | null;

  // ===== Holder Distribution Filters =====
  /**
   * Maximum top 10 holders percentage (prevent centralization)
   * Default: 50% (Conservative), 70% (Balanced), 90% (Aggressive)
   */
  maxTop10HoldersPct?: number;

  /**
   * Maximum single holder percentage (prevent whale control)
   * Default: 20% (Conservative), 40% (Balanced), 60% (Aggressive)
   */
  maxSingleHolderPct?: number;

  /**
   * Minimum number of holders (prevent new/fake tokens)
   * Default: 100 (Conservative), 20 (Balanced), 5 (Aggressive)
   */
  minHolders?: number;

  /**
   * Maximum developer holdings percentage
   * Default: 10% (Conservative), 20% (Balanced), 40% (Aggressive)
   */
  maxDeveloperPct?: number;

  // ===== Tax Filters =====
  /**
   * Maximum buy tax percentage
   * Default: 5% (Conservative), 10% (Balanced), 25% (Aggressive)
   */
  maxBuyTax?: number;

  /**
   * Maximum sell tax percentage
   * Default: 10% (Conservative), 20% (Balanced), 50% (Aggressive)
   */
  maxSellTax?: number;

  // ===== Pool Supply Filters =====
  /**
   * Minimum pool supply percentage (% of total supply in pool)
   * Prevents low liquidity scams where pool has tiny fraction of supply
   * Default: 50% (Conservative), 30% (Balanced), 10% (Aggressive)
   */
  minPoolSupplyPct?: number;

  /**
   * Maximum pool supply percentage (% of total supply in pool)
   * Too much supply in pool can indicate rug pull setup
   * Default: null (Conservative/Balanced), 95% (Aggressive)
   */
  maxPoolSupplyPct?: number | null;

  // ===== Social Verification Filters =====
  /**
   * Require Twitter link in token metadata
   * Default: true (Conservative), false (Balanced/Aggressive)
   */
  requireTwitter?: boolean;

  /**
   * Require website in token metadata
   * Default: true (Conservative), false (Balanced/Aggressive)
   */
  requireWebsite?: boolean;

  /**
   * Require Telegram link in token metadata
   * Default: false (all levels)
   */
  requireTelegram?: boolean;

  // ===== Honeypot Risk Filters =====
  /**
   * Maximum allowed risk score (0-100)
   * Tokens with higher risk score will be rejected
   * Default: 30 (Conservative), 50 (Balanced), 70 (Aggressive)
   */
  maxRiskScore?: number;

  /**
   * Minimum confidence in honeypot detection (0-100)
   * Reject tokens if detection confidence is too low
   * Default: 80% (Conservative), 60% (Balanced), 40% (Aggressive)
   */
  minConfidence?: number;

  /**
   * Require successful sell simulation
   * Default: true (all levels)
   */
  requireSellSimulation?: boolean;

  // ===== Metadata Filters =====
  /**
   * Require Metaplex metadata to exist
   * Default: true (Conservative/Balanced), false (Aggressive)
   */
  requireMetadata?: boolean;

  /**
   * Blacklisted token mints (never auto-buy)
   */
  blacklistedMints?: string[];

  /**
   * Whitelisted token mints (always pass filters, but still check honeypot)
   */
  whitelistedMints?: string[];
}

// ============================================================================
// Filter Presets
// ============================================================================

export type FilterPreset = "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE" | "CUSTOM";

/**
 * Conservative preset - Maximum safety, lowest risk
 * Target: Established tokens with strong fundamentals
 * Expected hit rate: ~5-10% of new tokens
 */
export const CONSERVATIVE_FILTERS: Required<Omit<SniperFilters, "blacklistedMints" | "whitelistedMints">> = {
  // Authority
  requireMintDisabled: true,
  requireFreezeDisabled: true,

  // Liquidity
  minLiquiditySol: 10,
  maxLiquiditySol: 1000,
  requireLiquidityLocked: true,
  minLiquidityLockPct: 80,

  // Holders
  maxTop10HoldersPct: 50,
  maxSingleHolderPct: 20,
  minHolders: 100,
  maxDeveloperPct: 10,

  // Tax
  maxBuyTax: 5,
  maxSellTax: 10,

  // Pool
  minPoolSupplyPct: 50,
  maxPoolSupplyPct: null,

  // Social
  requireTwitter: true,
  requireWebsite: true,
  requireTelegram: false,

  // Honeypot
  maxRiskScore: 30,
  minConfidence: 80,
  requireSellSimulation: true,

  // Metadata
  requireMetadata: true,
};

/**
 * Balanced preset - Moderate risk/reward
 * Target: Good projects with some risk tolerance
 * Expected hit rate: ~15-25% of new tokens
 */
export const BALANCED_FILTERS: Required<Omit<SniperFilters, "blacklistedMints" | "whitelistedMints">> = {
  // Authority
  requireMintDisabled: true,
  requireFreezeDisabled: true,

  // Liquidity
  minLiquiditySol: 5,
  maxLiquiditySol: null,
  requireLiquidityLocked: false,
  minLiquidityLockPct: 50,

  // Holders
  maxTop10HoldersPct: 70,
  maxSingleHolderPct: 40,
  minHolders: 20,
  maxDeveloperPct: 20,

  // Tax
  maxBuyTax: 10,
  maxSellTax: 20,

  // Pool
  minPoolSupplyPct: 30,
  maxPoolSupplyPct: null,

  // Social
  requireTwitter: false,
  requireWebsite: false,
  requireTelegram: false,

  // Honeypot
  maxRiskScore: 50,
  minConfidence: 60,
  requireSellSimulation: true,

  // Metadata
  requireMetadata: true,
};

/**
 * Aggressive preset - Highest risk/reward
 * Target: Early entries, moonshot potential
 * Expected hit rate: ~40-60% of new tokens
 */
export const AGGRESSIVE_FILTERS: Required<Omit<SniperFilters, "blacklistedMints" | "whitelistedMints">> = {
  // Authority
  requireMintDisabled: false,
  requireFreezeDisabled: false,

  // Liquidity
  minLiquiditySol: 1,
  maxLiquiditySol: null,
  requireLiquidityLocked: false,
  minLiquidityLockPct: null,

  // Holders
  maxTop10HoldersPct: 90,
  maxSingleHolderPct: 60,
  minHolders: 5,
  maxDeveloperPct: 40,

  // Tax
  maxBuyTax: 25,
  maxSellTax: 50,

  // Pool
  minPoolSupplyPct: 10,
  maxPoolSupplyPct: 95,

  // Social
  requireTwitter: false,
  requireWebsite: false,
  requireTelegram: false,

  // Honeypot
  maxRiskScore: 70,
  minConfidence: 40,
  requireSellSimulation: true,

  // Metadata
  requireMetadata: false,
};

/**
 * Get preset filters by name
 */
export function getPresetFilters(preset: FilterPreset): SniperFilters | null {
  switch (preset) {
    case "CONSERVATIVE":
      return CONSERVATIVE_FILTERS;
    case "BALANCED":
      return BALANCED_FILTERS;
    case "AGGRESSIVE":
      return AGGRESSIVE_FILTERS;
    case "CUSTOM":
      return null; // User must provide custom filters
    default:
      return null;
  }
}

// ============================================================================
// Filter Result Types
// ============================================================================

/**
 * Result of applying filters to a token
 */
export interface FilterCheckResult {
  /** Whether token passed all filters */
  passed: boolean;

  /** Which preset/custom filters were used */
  preset: FilterPreset;

  /** List of filter violations */
  violations: FilterViolation[];

  /** Token data that was checked */
  tokenData: TokenFilterData;

  /** Timestamp of check */
  checkedAt: Date;
}

/**
 * Individual filter violation
 */
export interface FilterViolation {
  /** Filter parameter that failed */
  filter: keyof SniperFilters;

  /** Expected value */
  expected: unknown;

  /** Actual value */
  actual: unknown;

  /** Severity of violation */
  severity: "low" | "medium" | "high";

  /** Human-readable message */
  message: string;
}

/**
 * Token data extracted for filter checking
 */
export interface TokenFilterData {
  tokenMint: string;

  // Authority
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;

  // Liquidity
  liquiditySol: number;
  liquidityLocked: boolean;
  liquidityLockPct: number | null;

  // Holders
  top10HoldersPct: number;
  singleHolderPct: number;
  totalHolders: number;
  developerHoldingsPct: number;

  // Tax
  buyTax: number;
  sellTax: number;

  // Pool
  poolSupplyPct: number;

  // Social
  hasTwitter: boolean;
  hasWebsite: boolean;
  hasTelegram: boolean;

  // Honeypot
  riskScore: RiskScore;
  confidence: number;
  canSell: boolean;

  // Metadata
  hasMetadata: boolean;
}

// ============================================================================
// User Filter Preferences
// ============================================================================

/**
 * User's saved filter preferences
 * Stored in database per user
 */
export interface UserFilterPreferences {
  userId: string;

  /** Selected preset or CUSTOM */
  preset: FilterPreset;

  /** Custom filters (if preset = CUSTOM) */
  customFilters: SniperFilters | null;

  /** Per-token overrides (mint → filters) */
  tokenOverrides: Record<string, Partial<SniperFilters>>;

  /** Whether auto-sniper is enabled */
  autoSniperEnabled: boolean;

  /** Last updated timestamp */
  updatedAt: Date;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Filter validation error
 */
export type FilterValidationError =
  | { type: "INVALID_RANGE"; field: string; min: number; max: number; value: number }
  | { type: "INVALID_PERCENTAGE"; field: string; value: number }
  | { type: "INVALID_MINT"; field: string; mint: string }
  | { type: "CONFLICTING_FILTERS"; field1: string; field2: string; reason: string }
  | { type: "MISSING_REQUIRED"; field: string }
  | { type: "UNKNOWN"; message: string };

/**
 * Result of filter validation
 */
export interface FilterValidationResult {
  valid: boolean;
  errors: FilterValidationError[];
  warnings: string[];
}
