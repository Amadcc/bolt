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
    simulation?: SimulationLayerResult;
  };
}

export type HoneypotProviderName = "goplus" | "rugcheck" | "tokensniffer";

export interface APILayerResult {
  source: HoneypotProviderName;
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
 * RugCheck API response
 * https://api.rugcheck.xyz/swagger/index.html
 */
export interface RugCheckResponse {
  mint: string;
  tokenType: string;
  token: {
    name: string;
    symbol: string;
    decimals: number;
  };
  tokenMeta?: {
    name?: string;
    symbol?: string;
    uri?: string;
  };
  risks: Array<{
    name: string;
    value: string;
    description: string;
    score: number;
    level: "info" | "warn" | "danger";
  }>;
  score: number;                // 0-100, lower is safer
  rugged: boolean;
  result: "Good" | "Unknown" | "Danger";

  // Optional fields
  creator?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  totalMarketLiquidity?: number;
  markets?: unknown[];
  topHolders?: Array<{
    address: string;
    pct: number;
  }>;
}

/**
 * TokenSniffer API response
 * https://tokensniffer.readme.io/reference/get-token-results
 */
export interface TokenSnifferResponse {
  message: string;

  token?: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    chain_id: number;
    total_supply?: string;
  };

  tests?: {
    // Risk indicators
    is_honeypot?: { value: boolean };
    is_mintable?: { value: boolean };
    can_be_minted?: { value: boolean };
    owner_can_change_balance?: { value: boolean };
    hidden_owner?: { value: boolean };
    selfdestruct?: { value: boolean };
    external_call?: { value: boolean };

    // Trading tests
    buy_tax?: { value: number };
    sell_tax?: { value: number };
    transfer_tax?: { value: number };

    // Liquidity tests
    liquidity_amount?: { value: number };
    pair_liquidity?: { value: number };
  };

  exploits?: Array<{
    description: string;
    severity: "low" | "medium" | "high" | "critical";
  }>;

  score?: number;                // 0-100, higher is safer
  scam_probability?: number;     // 0-1 probability
}

// ============================================================================
// Error Types
// ============================================================================

export type HoneypotError =
  | { type: "API_ERROR"; source: string; message: string }
  | { type: "RATE_LIMITED"; retryAfter: number }
  | { type: "INVALID_TOKEN"; tokenMint: string }
  | { type: "CACHE_ERROR"; message: string }
  | { type: "CIRCUIT_BREAKER_OPEN"; provider: string; retryAfter: number }
  | { type: "ALL_PROVIDERS_FAILED"; attempts: number }
  | { type: "UNKNOWN"; message: string };

// ============================================================================
// Circuit Breaker Pattern
// ============================================================================

/**
 * Circuit breaker states for API provider resilience
 *
 * CLOSED: Normal operation, requests flow through
 * OPEN: Too many failures, requests blocked (fail fast)
 * HALF_OPEN: Testing if service recovered, limited requests
 */
export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Failures before opening circuit (default: 5)
  successThreshold: number;      // Successes to close from half-open (default: 2)
  timeout: number;               // Time to wait before half-open (ms, default: 60000)
  monitoringPeriod: number;      // Time window for failure tracking (ms, default: 120000)
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextAttemptTime: number | null;
}

// ============================================================================
// API Provider Interface
// ============================================================================

/**
 * Unified interface for all honeypot detection API providers
 * Ensures consistent behavior across GoPlus, RugCheck, TokenSniffer
 */
export interface APIProvider {
  readonly name: HoneypotProviderName;
  readonly priority: number;     // Lower number = higher priority

  /**
   * Check if provider is currently available
   * Returns false if circuit breaker is OPEN
   */
  isAvailable(): boolean;

  /**
   * Perform honeypot check for given token
   * Returns null if provider fails (logs internally)
   */
  check(tokenMint: string): Promise<APILayerResult | null>;

  /**
   * Get current circuit breaker metrics
   */
  getMetrics(): CircuitBreakerMetrics;

  /**
   * Reset circuit breaker (for testing/admin)
   */
  reset(): void;
}

export interface APIProviderConfig {
  enabled: boolean;
  priority: number;
  timeout: number;
  apiKey?: string;
  circuitBreaker?: CircuitBreakerConfig;
}

// ============================================================================
// Service Configuration
// ============================================================================

export interface HoneypotDetectorConfig {
  // API Provider settings
  providers: Record<HoneypotProviderName, APIProviderConfig>;

  // Fallback chain settings
  fallbackChain: {
    enabled: boolean;            // Default: true
    stopOnFirstSuccess: boolean; // Default: true, stop after first successful result
    maxProviders: number;        // Default: 3, max providers to try
  };

  // Risk thresholds
  highRiskThreshold: number;    // Default: 70
  mediumRiskThreshold: number;  // Default: 30

  // Cache settings
  cacheTTL: number;             // Default: 3600 (1 hour)
  cacheEnabled: boolean;

  // Feature flags
  enableOnChainChecks: boolean; // Default: true
  enableSimulation: boolean;    // Default: true, enable simulation layer (Day 4)
}

export type HoneypotDetectorOverrides =
  Partial<Omit<HoneypotDetectorConfig, "providers" | "fallbackChain">> & {
    providers?: Partial<
      Record<HoneypotProviderName, Partial<APIProviderConfig>>
    >;
    fallbackChain?: Partial<HoneypotDetectorConfig["fallbackChain"]>;
  };

// ============================================================================
// Cache Types
// ============================================================================

export interface CachedHoneypotResult {
  result: HoneypotCheckResult;
  cachedAt: number;             // Unix timestamp
  expiresAt: number;            // Unix timestamp
}

// ============================================================================
// Simulation Layer Types (Day 4)
// ============================================================================

/**
 * Simulation configuration for honeypot detection
 */
export interface SimulationConfig {
  /** Amount in lamports for buy simulation (default: 0.1 SOL) */
  buyAmount: bigint;
  /** Amount in tokens for sell simulation (calculated from buy quote) */
  sellAmount?: bigint;
  /** Max time for simulation in ms (default: 3000) */
  timeout: number;
  /** Slippage tolerance in basis points (default: 50 = 0.5%) */
  slippageBps: number;
  /** Skip holder analysis (for faster checks, default: false) */
  skipHolderAnalysis?: boolean;
}

/**
 * Simulation result from buy/sell transactions
 */
export interface SimulationResult {
  // Transaction simulation
  canBuy: boolean;
  canSell: boolean;
  buyTax: number;              // Percentage (0-100)
  sellTax: number;             // Percentage (0-100)
  buyPriceImpact: number;      // Percentage (0-100)
  sellPriceImpact: number;     // Percentage (0-100)

  // Honeypot detection
  isHoneypot: boolean;
  honeypotReason?: string;

  // Holder analysis
  top10HoldersPct: number;     // Top 10 holders % of supply
  developerHoldingsPct: number; // Developer/team holdings %
  totalHolders: number;        // Total number of holders

  // Liquidity lock (optional)
  hasLiquidityLock?: boolean;
  liquidityLockPct?: number;

  // Metadata
  simulationTimeMs: number;
}

/**
 * Simulation layer result (added to HoneypotCheckResult.layers)
 */
export interface SimulationLayerResult {
  canBuy: boolean;
  canSell: boolean;
  buyTax: number;
  sellTax: number;
  buyPriceImpact: number;
  sellPriceImpact: number;
  top10HoldersPct: number;
  developerHoldingsPct: number;
  totalHolders: number;
  score: number;               // 0-100 risk score from simulation
  flags: HoneypotFlag[];
  timeMs: number;
}
