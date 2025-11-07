/**
 * Honeypot Detection Types
 *
 * Multi-layer honeypot detection system with 80-85% accuracy (MVP)
 * Production target: 95%+ with ML
 */

// ============================================================================
// Risk Assessment
// ============================================================================

/**
 * Risk score: 0-100
 * - 0-30: Low risk (safe to trade)
 * - 31-69: Medium risk (caution advised)
 * - 70-100: High risk (honeypot likely)
 */
export type RiskScore = number & { readonly __brand: "RiskScore" };

export function asRiskScore(value: number): RiskScore {
  if (value < 0 || value > 100) {
    throw new TypeError(`Risk score must be 0-100, got ${value}`);
  }
  return value as RiskScore;
}

// ============================================================================
// Detection Flags
// ============================================================================

export type HoneypotFlag =
  // Authority flags (Solana-specific)
  | "MINT_AUTHORITY"           // Can mint new tokens
  | "FREEZE_AUTHORITY"          // Can freeze accounts
  | "OWNER_CHANGE_POSSIBLE"     // Can change ownership

  // Trading flags
  | "HIGH_SELL_TAX"             // Sell tax > 50%
  | "NO_SELL_ROUTE"             // Cannot find sell route
  | "SELL_SIMULATION_FAILED"    // Sell simulation failed

  // Liquidity flags
  | "LOW_LIQUIDITY"             // < $1000 liquidity
  | "UNLOCKED_LIQUIDITY"        // LP tokens not locked
  | "LP_NOT_BURNED"             // LP tokens not burned

  // Holder flags
  | "CENTRALIZED"               // Top 10 holders > 80%
  | "SINGLE_HOLDER_MAJORITY"    // One holder > 50%

  // Social flags
  | "NO_SOCIAL"                 // No website/twitter
  | "NO_SOURCE_CODE"            // Contract not verified

  // Other
  | "UNKNOWN"                   // Unknown issue
  | "API_ERROR";                // External API error

// ============================================================================
// Detection Results
// ============================================================================

export interface HoneypotCheckResult {
  tokenMint: string;
  isHoneypot: boolean;
  riskScore: RiskScore;
  confidence: number;          // 0-100 confidence in result
  flags: HoneypotFlag[];
  checkedAt: Date;
  analysisTimeMs: number;

  // Layer-specific results
  layers: {
    api?: APILayerResult;
    onchain?: OnChainLayerResult;
  };
}

export interface APILayerResult {
  source: "goplus" | "honeypot.is" | "rugcheck";
  score: number;
  flags: HoneypotFlag[];
  data: Record<string, unknown>;
  timeMs: number;
}

export interface OnChainLayerResult {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  hasMetadata: boolean;
  score: number;
  flags: HoneypotFlag[];
  timeMs: number;
}

// ============================================================================
// API Response Types (External)
// ============================================================================

/**
 * GoPlus API response
 * https://docs.gopluslabs.io/reference/token-security-solana
 */
export interface GoPlusResponse {
  code: number;
  message: string;
  result: {
    [tokenAddress: string]: {
      // Authority checks
      owner_address: string;
      creator_address: string;
      is_mintable: "0" | "1";
      can_take_back_ownership: "0" | "1";

      // Trading checks
      buy_tax: string;              // e.g., "0.05" = 5%
      sell_tax: string;
      is_honeypot: "0" | "1";
      transfer_pausable: "0" | "1";

      // Holder info
      holder_count: string;
      total_supply: string;
      holder_list?: Array<{
        address: string;
        balance: string;
        percent: string;
      }>;

      // Liquidity
      lp_holder_count?: string;
      lp_total_supply?: string;
      is_true_token?: "0" | "1";
    };
  };
}

/**
 * Honeypot.is API response
 * https://honeypot.is/docs
 */
export interface HoneypotIsResponse {
  token: {
    name: string;
    symbol: string;
    decimals: number;
    address: string;
    totalHolders: number;
  };

  withToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
  };

  summary: {
    risk: string;               // "low", "medium", "high"
    riskLevel: number;          // 0-100
  };

  simulationSuccess: boolean;
  simulationResult?: {
    buyTax: number;
    sellTax: number;
    transferTax: number;
  };

  honeypotResult: {
    isHoneypot: boolean;
  };
}

// ============================================================================
// Error Types
// ============================================================================

export type HoneypotError =
  | { type: "API_ERROR"; source: string; message: string }
  | { type: "RATE_LIMITED"; retryAfter: number }
  | { type: "INVALID_TOKEN"; tokenMint: string }
  | { type: "CACHE_ERROR"; message: string }
  | { type: "UNKNOWN"; message: string };

// ============================================================================
// Service Configuration
// ============================================================================

export interface HoneypotDetectorConfig {
  // API settings
  goPlusApiKey?: string;
  goPlusTimeout: number;        // Default: 5000ms

  // Risk thresholds
  highRiskThreshold: number;    // Default: 70
  mediumRiskThreshold: number;  // Default: 30

  // Cache settings (MEDIUM-2: Smart caching strategy)
  cacheTTL: number;             // Default: 3600 (1 hour) for medium/high risk
  safeCacheTTL?: number;        // Default: 86400 (24 hours) for safe tokens
  cacheEnabled: boolean;

  // Async mode (MEDIUM-2: Non-blocking checks)
  asyncMode?: boolean;          // If true, check in background and allow trade with warning

  // Token whitelist (MEDIUM-2: Skip checks for known-safe tokens)
  whitelistedTokens?: string[]; // Token mints to skip checking (e.g., SOL, USDC)

  // Feature flags
  enableGoPlusAPI: boolean;     // Default: true
  enableOnChainChecks: boolean; // Default: true
}

// ============================================================================
// Cache Types
// ============================================================================

export interface CachedHoneypotResult {
  result: HoneypotCheckResult;
  cachedAt: number;             // Unix timestamp
  expiresAt: number;            // Unix timestamp
}
