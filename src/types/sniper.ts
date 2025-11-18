/**
 * Sniper Bot Types - Token Detection and Auto-Execution
 *
 * Type-safe definitions for:
 * - Pool detection (WebSocket monitoring)
 * - Auto-sniper execution
 * - Position management (TP/SL)
 * - Multi-wallet support
 */

import type { TokenMint, SolanaAddress, TransactionSignature, Lamports } from "./common.js";

// ============================================================================
// Pool Detection Types
// ============================================================================

/**
 * Pool source (DEX where pool was detected)
 */
export type PoolSource =
  | "raydium_v4"        // Raydium AMM V4 (most popular)
  | "raydium_clmm"      // Raydium Concentrated Liquidity
  | "orca_whirlpool"    // Orca Whirlpool (CLMM)
  | "meteora"           // Meteora DLMM (has anti-sniper!)
  | "pump_fun";         // Pump.fun (bonding curve)

// ============================================================================
// Meteora Anti-Sniper Types
// ============================================================================

/**
 * Meteora Fee Scheduler configuration
 *
 * Time-based dynamic fees that decay from cliff to base.
 */
export interface MeteoraFeeScheduler {
  /** Starting fee in bps (0-9900 = 0-99%) */
  cliffFee: number;

  /** Number of reduction periods */
  numberOfPeriods: number;

  /** Seconds between each period */
  periodFrequency: number;

  /** Basis points to reduce per period */
  feeReductionFactor: number;

  /** Launch timestamp (UNIX seconds) */
  launchTime: number;
}

/**
 * Meteora Rate Limiter configuration
 *
 * Size-based progressive fees (1% per SOL).
 */
export interface MeteoraRateLimiter {
  /** Enabled status */
  enabled: boolean;

  /** Base fee in bps per SOL (typically 100 = 1%) */
  baseFeePerSol: number;
}

/**
 * Meteora Alpha Vault configuration
 *
 * Whitelist early access before public launch.
 */
export interface MeteoraAlphaVault {
  /** Active status */
  isActive: boolean;

  /** End timestamp (UNIX seconds) */
  endsAt: number;

  /** Reserved supply percentage (0-100) */
  reservedSupplyPct: number;
}

/**
 * Complete Meteora pool anti-sniper configuration
 */
export interface MeteoraAntiSniperConfig {
  /** Pool has Fee Scheduler */
  hasFeeScheduler: boolean;

  /** Pool has Rate Limiter */
  hasRateLimiter: boolean;

  /** Pool has Alpha Vault */
  hasAlphaVault: boolean;

  /** Fee Scheduler config (if enabled) */
  feeScheduler?: MeteoraFeeScheduler;

  /** Rate Limiter config (if enabled) */
  rateLimiter?: MeteoraRateLimiter;

  /** Alpha Vault config (if enabled) */
  alphaVault?: MeteoraAlphaVault;
}

/**
 * Calculated effective fees for Meteora pool
 */
export interface MeteoraEffectiveFees {
  /** Fee Scheduler component (bps) */
  feeSchedulerBps: number;

  /** Rate Limiter component (bps) */
  rateLimiterBps: number;

  /** Total effective fee (bps) */
  totalFeeBps: number;

  /** Total effective fee (decimal, e.g. 0.05 = 5%) */
  totalFeeDecimal: number;

  /** Is this pool safe to snipe? */
  isSafeToSnipe: boolean;

  /** Reason if not safe */
  unsafeReason?: string;
}

/**
 * Token pool detection event
 *
 * Emitted when new liquidity pool is detected via WebSocket.
 */
export interface TokenPoolDetection {
  /** Token mint address (new token) */
  tokenMint: TokenMint;

  /** Quote mint (usually SOL or USDC) */
  quoteMint: TokenMint;

  /** Pool address */
  poolAddress: SolanaAddress;

  /** DEX source */
  source: PoolSource;

  /** Pool liquidity in quote token (lamports) */
  liquidity: Lamports;

  /** Transaction signature where pool was created */
  signature: TransactionSignature;

  /** Slot when pool was created */
  slot: number;

  /** Detection timestamp (ISO 8601) */
  detectedAt: Date;

  /** Token metadata (if available) */
  metadata?: {
    name: string;
    symbol: string;
    uri: string;
  };
}

/**
 * Pool detection error types
 */
export type PoolDetectionError =
  | { type: "WEBSOCKET_DISCONNECTED"; endpoint: string; reconnectIn: number }
  | { type: "PARSE_ERROR"; rawLog: string; reason: string }
  | { type: "CIRCUIT_OPEN"; endpoint: string; nextAttemptTime: number }
  | { type: "RATE_LIMITED"; endpoint: string; retryAfter: number }
  | { type: "UNKNOWN"; message: string };

// ============================================================================
// Detector Configuration
// ============================================================================

/**
 * WebSocket endpoint configuration
 */
export interface WebSocketEndpoint {
  /** WebSocket URL (wss://) */
  url: string;

  /** Endpoint name (e.g., "Helius", "Quicknode") */
  name: string;

  /** Priority (1 = highest, used for failover) */
  priority: number;

  /** Maximum reconnection attempts before circuit opens */
  maxReconnectAttempts: number;

  /** Reconnect delay (ms) */
  reconnectDelay: number;
}

/**
 * Token detector configuration
 */
export interface DetectorConfig {
  /** WebSocket endpoints for pool monitoring */
  endpoints: WebSocketEndpoint[];

  /** Program IDs to monitor */
  programs: {
    raydiumV4: SolanaAddress;
    raydiumCLMM: SolanaAddress;
    orcaWhirlpool: SolanaAddress;
    meteora: SolanaAddress;
    pumpFun: SolanaAddress;
  };

  /** Circuit breaker config per endpoint */
  circuitBreaker: {
    /** Failures before circuit opens */
    failureThreshold: number;

    /** Successes before circuit closes (from HALF_OPEN) */
    successThreshold: number;

    /** Time before attempting HALF_OPEN (ms) */
    timeout: number;

    /** Monitoring period for failure tracking (ms) */
    monitoringPeriod: number;
  };

  /** Health check interval (ms) */
  healthCheckInterval: number;

  /** Enable Redis pub/sub for broadcasting events */
  enableRedisPubSub: boolean;

  /** Redis channel name for pool events */
  redisChannel: string;
}

/**
 * Detector state (discriminated union)
 */
export type DetectorState =
  | { status: "initializing"; startedAt: Date }
  | { status: "running"; connectedEndpoints: number; startedAt: Date }
  | { status: "degraded"; connectedEndpoints: number; failedEndpoints: string[] }
  | { status: "stopped"; reason: string; stoppedAt: Date }
  | { status: "failed"; error: string; failedAt: Date };

// ============================================================================
// Sniper Execution Types
// ============================================================================

/**
 * Sniper order states (discriminated union)
 */
export type SniperOrderState =
  | { status: "detecting"; detectedAt: Date }
  | { status: "checking_honeypot"; startedAt: Date }
  | { status: "building_tx"; quote: unknown }
  | { status: "signing"; transactionData: Uint8Array }
  | { status: "broadcasting"; signature: TransactionSignature; sentAt: Date }
  | { status: "confirming"; signature: TransactionSignature; sentAt: Date }
  | { status: "confirmed"; signature: TransactionSignature; slot: number; confirmedAt: Date }
  | { status: "rejected"; reason: RejectionReason; rejectedAt: Date }
  | { status: "failed"; error: string; failedAt: Date };

/**
 * Reasons for rejecting sniper order
 */
export type RejectionReason =
  | "HONEYPOT_DETECTED"
  | "INSUFFICIENT_LIQUIDITY"
  | "HIGH_SLIPPAGE"
  | "MINT_AUTHORITY_NOT_REVOKED"
  | "FREEZE_AUTHORITY_NOT_REVOKED"
  | "FAILS_FILTERS"
  | "SIMULATION_FAILED";

/**
 * Sniper filters configuration
 */
export interface SniperFilters {
  /** Minimum liquidity in SOL */
  minLiquiditySol: number;

  /** Maximum liquidity in SOL (avoid whales) */
  maxLiquiditySol: number | null;

  /** Require mint authority revoked */
  requireMintAuthorityRevoked: boolean;

  /** Require freeze authority revoked */
  requireFreezeAuthorityRevoked: boolean;

  /** Maximum buy tax (bps, 10000 = 100%) */
  maxBuyTaxBps: number;

  /** Maximum sell tax (bps) */
  maxSellTaxBps: number;

  /** Maximum developer holdings (%) */
  maxDevHoldingsPct: number;

  /** Minimum pool supply percentage */
  minPoolSupplyPct: number;

  /** Require Twitter verified */
  requireTwitter: boolean;

  /** Require website */
  requireWebsite: boolean;

  /** Require Telegram */
  requireTelegram: boolean;

  /** Maximum honeypot risk score (0-100) */
  maxRiskScore: number;
}

/**
 * Sniper order
 */
export interface SniperOrder {
  id: string;
  userId: string;
  tokenMint: TokenMint;
  poolAddress: SolanaAddress;
  source: PoolSource;
  amountSol: number;
  slippageBps: number;
  priorityFeeMode: "FAST" | "TURBO" | "ULTRA";
  state: SniperOrderState;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Position Management Types
// ============================================================================

/**
 * Position state (discriminated union)
 */
export type PositionState =
  | { status: "open"; openedAt: Date }
  | { status: "closing"; reason: "TP" | "SL" | "TRAILING_SL" | "MANUAL" | "RUG"; startedAt: Date }
  | { status: "closed"; closedAt: Date; realizedPnl: number }
  | { status: "failed"; error: string; failedAt: Date };

/**
 * Position with TP/SL management
 */
export interface Position {
  id: string;
  userId: string;
  tokenMint: TokenMint;
  entryPrice: number;
  currentPrice: number;
  amountTokens: bigint;
  amountSolInvested: number;
  unrealizedPnlPct: number;
  realizedPnlPct: number | null;

  /** Take-profit levels (percent gains) */
  takeProfitLevels: Array<{
    triggerPct: number;    // e.g., 50 = +50%
    sellPct: number;        // e.g., 50 = sell 50% of position
    triggered: boolean;
  }>;

  /** Stop-loss level (percent loss) */
  stopLossPct: number | null;  // e.g., 20 = -20%

  /** Trailing stop-loss */
  trailingStopLoss: {
    enabled: boolean;
    activationPct: number;  // e.g., 50 = activate after +50%
    trailPct: number;        // e.g., 20 = trail by 20%
    highWaterMark: number | null;  // Highest price seen
  } | null;

  state: PositionState;
  openedAt: Date;
  closedAt: Date | null;
}

// ============================================================================
// Rug Detection Types
// ============================================================================

/**
 * Rug detection event
 */
export interface RugDetection {
  tokenMint: TokenMint;
  type: RugType;
  severity: "low" | "medium" | "high" | "critical";
  details: string;
  detectedAt: Date;
}

/**
 * Types of rug pulls
 */
export type RugType =
  | "LIQUIDITY_REMOVED"        // >50% liquidity removed
  | "AUTHORITY_CHANGED"        // Mint/freeze authority re-enabled
  | "SUPPLY_INCREASED"         // Unexpected minting
  | "TOP_HOLDER_DUMP"          // Top holder sold >30%
  | "METADATA_CHANGED"         // Token metadata changed
  | "FREEZE_ACTIVATED";        // Accounts frozen

// ============================================================================
// Multi-Wallet Types
// ============================================================================

/**
 * Wallet rotation strategy
 */
export type WalletRotationStrategy =
  | "round_robin"     // Rotate sequentially
  | "random"          // Random selection
  | "lowest_balance"  // Use wallet with lowest balance
  | "manual";         // User selects manually

/**
 * Privacy mode configuration
 */
export interface PrivacyConfig {
  /** Enable transaction timing randomization */
  randomizeTiming: boolean;

  /** Timing variance in seconds (±) */
  timingVarianceSec: number;

  /** Use variable priority fees (appear human) */
  variablePriorityFees: boolean;

  /** Force Jito routing for private mempool */
  forceJito: boolean;

  /** Use fresh wallets for sensitive trades */
  useFreshWallets: boolean;

  /** Wallet rotation strategy */
  rotationStrategy: WalletRotationStrategy;
}

// ============================================================================
// Metrics and Analytics Types
// ============================================================================

/**
 * Sniper performance metrics
 */
export interface SniperMetrics {
  /** Total snipes attempted */
  totalAttempts: number;

  /** Successful snipes */
  successfulSnipes: number;

  /** Failed snipes */
  failedSnipes: number;

  /** Rejected (honeypot/filters) */
  rejectedSnipes: number;

  /** Win rate (%) */
  winRate: number;

  /** Average profit per trade (%) */
  avgProfitPct: number;

  /** Total realized profit (SOL) */
  totalRealizedProfitSol: number;

  /** Average detection latency (ms) */
  avgDetectionLatencyMs: number;

  /** Average execution time (ms) */
  avgExecutionTimeMs: number;

  /** Last updated */
  updatedAt: Date;
}

/**
 * Detection performance metrics
 */
export interface DetectionMetrics {
  /** Total pools detected */
  totalDetections: number;

  /** Detections per source */
  detectionsBySource: Record<PoolSource, number>;

  /** Average detection latency (pool created → event emitted) */
  avgLatencyMs: number;

  /** WebSocket uptime per endpoint */
  endpointUptime: Record<string, number>;

  /** Circuit breaker trips */
  circuitBreakerTrips: Record<string, number>;

  /** Last 24h detections */
  last24hDetections: number;
}
