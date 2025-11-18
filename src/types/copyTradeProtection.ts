/**
 * Copy-Trade Protection Types
 *
 * Type-safe system for preventing copy-trading and MEV attacks
 * by adding timing randomization, fee pattern variation, and transaction obfuscation.
 */

import type { Result } from "./common.js";
import type { WalletId } from "./walletRotation.js";
import type { PriorityFeeMode } from "./sniperOrder.js";

// ============================================================================
// Branded Types
// ============================================================================

/**
 * Delay in milliseconds (0-30000ms = 0-30s)
 */
export type DelayMs = number & { readonly __brand: "DelayMs" };

/**
 * Jitter percentage (0-100%)
 * Example: 20% jitter on 5000ms delay = random delay between 4000-6000ms
 */
export type JitterPercent = number & { readonly __brand: "JitterPercent" };

/**
 * Privacy score (0-100)
 * Higher = more private, harder to copy-trade
 * 0-30: Low privacy (easily copied)
 * 31-70: Medium privacy (somewhat protected)
 * 71-100: High privacy (very difficult to copy)
 */
export type PrivacyScore = number & { readonly __brand: "PrivacyScore" };

/**
 * Obfuscation strength (0-100)
 * How aggressively to obfuscate transaction patterns
 */
export type ObfuscationStrength = number & { readonly __brand: "ObfuscationStrength" };

// ============================================================================
// Constructors & Validators
// ============================================================================

export function asDelayMs(value: number): DelayMs {
  if (!Number.isFinite(value) || value < 0 || value > 30000) {
    throw new TypeError(`Invalid delay: ${value}ms (must be 0-30000)`);
  }
  return value as DelayMs;
}

export function asJitterPercent(value: number): JitterPercent {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`Invalid jitter: ${value}% (must be 0-100)`);
  }
  return value as JitterPercent;
}

export function asPrivacyScore(value: number): PrivacyScore {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`Invalid privacy score: ${value} (must be 0-100)`);
  }
  return value as PrivacyScore;
}

export function asObfuscationStrength(value: number): ObfuscationStrength {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(`Invalid obfuscation strength: ${value} (must be 0-100)`);
  }
  return value as ObfuscationStrength;
}

// ============================================================================
// Privacy Mode
// ============================================================================

/**
 * Privacy protection level
 *
 * OFF: No protection (fastest execution, easily copied)
 * BASIC: Timing randomization + Jito routing (good balance)
 * ADVANCED: Full obfuscation + wallet rotation + fresh wallets (maximum privacy)
 */
export type PrivacyMode = "OFF" | "BASIC" | "ADVANCED";

export const PRIVACY_MODES: readonly PrivacyMode[] = ["OFF", "BASIC", "ADVANCED"] as const;

export function isPrivacyMode(value: string): value is PrivacyMode {
  return PRIVACY_MODES.includes(value as PrivacyMode);
}

// ============================================================================
// Timing Randomization
// ============================================================================

/**
 * Timing randomization configuration
 * Adds unpredictable delays to make copy-trading difficult
 */
export interface TimingConfig {
  /**
   * Enable timing randomization
   */
  readonly enabled: boolean;

  /**
   * Base delay to add (milliseconds)
   * Will be randomized by ±jitterPercent
   */
  readonly baseDelayMs: DelayMs;

  /**
   * Jitter percentage to apply to base delay
   * Example: 20% jitter on 5000ms = random 4000-6000ms
   */
  readonly jitterPercent: JitterPercent;

  /**
   * Minimum delay (safety floor)
   */
  readonly minDelayMs: DelayMs;

  /**
   * Maximum delay (safety ceiling)
   */
  readonly maxDelayMs: DelayMs;
}

/**
 * Result of calculating a randomized delay
 */
export interface RandomizedDelay {
  /**
   * Actual delay to use (ms)
   */
  readonly delayMs: DelayMs;

  /**
   * Jitter applied (ms)
   */
  readonly jitterMs: number;

  /**
   * Original base delay
   */
  readonly baseDelayMs: DelayMs;
}

// ============================================================================
// Fee Pattern Obfuscation
// ============================================================================

/**
 * Fee pattern variation strategy
 * Makes priority fees appear more human-like
 */
export type FeePatternStrategy =
  | "FIXED"           // Always use same fee mode (predictable)
  | "RANDOM"          // Random fee mode each time
  | "GRADUAL_INCREASE" // Start low, gradually increase
  | "SPIKE_PATTERN"   // Occasional high fees mixed with normal
  | "ADAPTIVE";       // Adapt to network conditions

export const FEE_PATTERN_STRATEGIES: readonly FeePatternStrategy[] = [
  "FIXED",
  "RANDOM",
  "GRADUAL_INCREASE",
  "SPIKE_PATTERN",
  "ADAPTIVE",
] as const;

export function isFeePatternStrategy(value: string): value is FeePatternStrategy {
  return FEE_PATTERN_STRATEGIES.includes(value as FeePatternStrategy);
}

/**
 * Fee pattern configuration
 */
export interface FeePatternConfig {
  /**
   * Strategy for varying fee patterns
   */
  readonly strategy: FeePatternStrategy;

  /**
   * Allowed fee modes for this strategy
   * Example: ["MEDIUM", "HIGH", "TURBO"]
   */
  readonly allowedModes: readonly PriorityFeeMode[];

  /**
   * Add random micro-adjustments to fees (±1-10%)
   * Makes exact fee amounts less predictable
   */
  readonly addMicroJitter: boolean;

  /**
   * Maximum jitter percentage for micro-adjustments
   */
  readonly microJitterPercent: JitterPercent;
}

// ============================================================================
// Wallet Rotation Strategy
// ============================================================================

/**
 * Wallet rotation strategy for privacy
 * Extends base rotation strategies with privacy-focused options
 */
export type PrivacyWalletStrategy =
  | "ROUND_ROBIN"     // Rotate through all wallets (basic privacy)
  | "RANDOM"          // Random wallet each time (medium privacy)
  | "FRESH_ONLY"      // Always create new wallet (maximum privacy, gas intensive)
  | "FRESH_THRESHOLD"; // Create new wallet if usage > threshold

export const PRIVACY_WALLET_STRATEGIES: readonly PrivacyWalletStrategy[] = [
  "ROUND_ROBIN",
  "RANDOM",
  "FRESH_ONLY",
  "FRESH_THRESHOLD",
] as const;

export function isPrivacyWalletStrategy(value: string): value is PrivacyWalletStrategy {
  return PRIVACY_WALLET_STRATEGIES.includes(value as PrivacyWalletStrategy);
}

/**
 * Privacy-focused wallet configuration
 */
export interface PrivacyWalletConfig {
  /**
   * Wallet rotation strategy
   */
  readonly strategy: PrivacyWalletStrategy;

  /**
   * If FRESH_THRESHOLD: max trades before creating new wallet
   */
  readonly freshThreshold?: number;

  /**
   * Automatically fund fresh wallets with SOL for gas
   */
  readonly autoFundFreshWallets: boolean;

  /**
   * SOL amount to fund fresh wallets (in lamports)
   */
  readonly freshWalletFundingAmount: bigint;

  /**
   * Wallet IDs to use for rotation (if not FRESH_ONLY)
   */
  readonly walletIds: readonly WalletId[];
}

// ============================================================================
// Jito MEV Protection
// ============================================================================

/**
 * Jito routing configuration for privacy
 */
export interface JitoPrivacyConfig {
  /**
   * Force all transactions through Jito (private mempool)
   * Prevents public mempool sniping
   */
  readonly forceJitoRouting: boolean;

  /**
   * Use Jito's anti-sandwich protection
   */
  readonly useAntiSandwich: boolean;

  /**
   * Minimum tip amount (lamports)
   */
  readonly minTipLamports: bigint;

  /**
   * Maximum tip amount (lamports)
   */
  readonly maxTipLamports: bigint;

  /**
   * Add randomization to tip amounts
   */
  readonly randomizeTips: boolean;
}

// ============================================================================
// Transaction Obfuscation
// ============================================================================

/**
 * Transaction obfuscation pattern
 * Makes transactions less recognizable
 */
export type ObfuscationPattern =
  | "NONE"              // No obfuscation
  | "MEMO_RANDOM"       // Add random memo
  | "DUMMY_INSTRUCTIONS" // Add dummy instructions (no-ops)
  | "SPLIT_AMOUNT"      // Split trade into multiple smaller trades
  | "FULL";             // All obfuscation techniques

export const OBFUSCATION_PATTERNS: readonly ObfuscationPattern[] = [
  "NONE",
  "MEMO_RANDOM",
  "DUMMY_INSTRUCTIONS",
  "SPLIT_AMOUNT",
  "FULL",
] as const;

export function isObfuscationPattern(value: string): value is ObfuscationPattern {
  return OBFUSCATION_PATTERNS.includes(value as ObfuscationPattern);
}

/**
 * Transaction obfuscation configuration
 */
export interface ObfuscationConfig {
  /**
   * Obfuscation pattern to use
   */
  readonly pattern: ObfuscationPattern;

  /**
   * Obfuscation strength (0-100)
   */
  readonly strength: ObfuscationStrength;

  /**
   * Add random memos to transactions
   */
  readonly addRandomMemos: boolean;

  /**
   * Maximum memo length (bytes)
   */
  readonly maxMemoLength: number;

  /**
   * Add dummy instructions (careful: increases transaction size)
   */
  readonly addDummyInstructions: boolean;

  /**
   * Maximum dummy instructions to add
   */
  readonly maxDummyInstructions: number;
}

// ============================================================================
// Privacy Settings (User Configuration)
// ============================================================================

/**
 * User's complete privacy settings
 * Stored in database and applied to all sniper operations
 */
export interface PrivacySettings {
  /**
   * Privacy protection level
   */
  readonly mode: PrivacyMode;

  /**
   * Timing randomization config
   */
  readonly timing: TimingConfig;

  /**
   * Fee pattern variation config
   */
  readonly feePattern: FeePatternConfig;

  /**
   * Wallet rotation config
   */
  readonly walletRotation: PrivacyWalletConfig;

  /**
   * Jito MEV protection config
   */
  readonly jito: JitoPrivacyConfig;

  /**
   * Transaction obfuscation config
   */
  readonly obfuscation: ObfuscationConfig;
}

// ============================================================================
// Privacy Presets
// ============================================================================

/**
 * Pre-configured privacy settings for different use cases
 */
export const PRIVACY_PRESETS: Record<PrivacyMode, PrivacySettings> = {
  OFF: {
    mode: "OFF",
    timing: {
      enabled: false,
      baseDelayMs: asDelayMs(0),
      jitterPercent: asJitterPercent(0),
      minDelayMs: asDelayMs(0),
      maxDelayMs: asDelayMs(0),
    },
    feePattern: {
      strategy: "FIXED",
      allowedModes: ["MEDIUM"],
      addMicroJitter: false,
      microJitterPercent: asJitterPercent(0),
    },
    walletRotation: {
      strategy: "ROUND_ROBIN",
      autoFundFreshWallets: false,
      freshWalletFundingAmount: 0n,
      walletIds: [],
    },
    jito: {
      forceJitoRouting: false,
      useAntiSandwich: false,
      minTipLamports: 10000n,
      maxTipLamports: 50000n,
      randomizeTips: false,
    },
    obfuscation: {
      pattern: "NONE",
      strength: asObfuscationStrength(0),
      addRandomMemos: false,
      maxMemoLength: 0,
      addDummyInstructions: false,
      maxDummyInstructions: 0,
    },
  },

  BASIC: {
    mode: "BASIC",
    timing: {
      enabled: true,
      baseDelayMs: asDelayMs(2000), // 2s base delay
      jitterPercent: asJitterPercent(50), // ±50% = 1-3s
      minDelayMs: asDelayMs(500),
      maxDelayMs: asDelayMs(5000),
    },
    feePattern: {
      strategy: "RANDOM",
      allowedModes: ["MEDIUM", "HIGH"],
      addMicroJitter: true,
      microJitterPercent: asJitterPercent(5),
    },
    walletRotation: {
      strategy: "RANDOM",
      autoFundFreshWallets: false,
      freshWalletFundingAmount: 0n,
      walletIds: [],
    },
    jito: {
      forceJitoRouting: true,
      useAntiSandwich: true,
      minTipLamports: 20000n,
      maxTipLamports: 100000n,
      randomizeTips: true,
    },
    obfuscation: {
      pattern: "MEMO_RANDOM",
      strength: asObfuscationStrength(30),
      addRandomMemos: true,
      maxMemoLength: 32,
      addDummyInstructions: false,
      maxDummyInstructions: 0,
    },
  },

  ADVANCED: {
    mode: "ADVANCED",
    timing: {
      enabled: true,
      baseDelayMs: asDelayMs(3000), // 3s base delay
      jitterPercent: asJitterPercent(80), // ±80% = 0.6-5.4s
      minDelayMs: asDelayMs(1000),
      maxDelayMs: asDelayMs(8000),
    },
    feePattern: {
      strategy: "ADAPTIVE",
      allowedModes: ["MEDIUM", "HIGH", "TURBO"],
      addMicroJitter: true,
      microJitterPercent: asJitterPercent(10),
    },
    walletRotation: {
      strategy: "FRESH_THRESHOLD",
      freshThreshold: 5, // New wallet every 5 trades
      autoFundFreshWallets: true,
      freshWalletFundingAmount: 100_000_000n, // 0.1 SOL
      walletIds: [],
    },
    jito: {
      forceJitoRouting: true,
      useAntiSandwich: true,
      minTipLamports: 50000n,
      maxTipLamports: 200000n,
      randomizeTips: true,
    },
    obfuscation: {
      pattern: "FULL",
      strength: asObfuscationStrength(80),
      addRandomMemos: true,
      maxMemoLength: 64,
      addDummyInstructions: false, // Disabled to avoid tx size issues
      maxDummyInstructions: 0,
    },
  },
};

// ============================================================================
// Privacy Layer State
// ============================================================================

/**
 * State tracked by privacy layer for a user
 */
export interface PrivacyLayerState {
  /**
   * User ID
   */
  readonly userId: string;

  /**
   * Current privacy settings
   */
  readonly settings: PrivacySettings;

  /**
   * Last fee mode used (for pattern tracking)
   */
  lastFeeMode?: PriorityFeeMode;

  /**
   * Trade count since last wallet rotation
   */
  tradesSinceLastRotation: number;

  /**
   * Last wallet used
   */
  lastWalletId?: WalletId;

  /**
   * Privacy score (0-100)
   */
  privacyScore: PrivacyScore;
}

// ============================================================================
// Privacy Layer Results
// ============================================================================

/**
 * Result of applying privacy layer to a transaction
 */
export interface PrivacyLayerResult {
  /**
   * Randomized delay before executing (ms)
   */
  readonly delayBeforeExecution: RandomizedDelay;

  /**
   * Priority fee mode to use
   */
  readonly priorityFeeMode: PriorityFeeMode;

  /**
   * Wallet to use for this trade
   */
  readonly walletId: WalletId;

  /**
   * Whether to route through Jito
   */
  readonly useJito: boolean;

  /**
   * Jito tip amount (if using Jito)
   */
  readonly jitoTipLamports?: bigint;

  /**
   * Transaction memo (if obfuscation enabled)
   */
  readonly memo?: string;

  /**
   * Privacy score for this operation (0-100)
   */
  readonly privacyScore: PrivacyScore;

  /**
   * Applied obfuscation techniques
   */
  readonly appliedObfuscation: readonly ObfuscationPattern[];
}

// ============================================================================
// Privacy Layer Errors
// ============================================================================

/**
 * Privacy layer error types
 */
export type PrivacyLayerError =
  | { readonly type: "INVALID_SETTINGS"; readonly message: string }
  | { readonly type: "NO_WALLETS_AVAILABLE"; readonly message: string }
  | { readonly type: "WALLET_CREATION_FAILED"; readonly message: string }
  | { readonly type: "WALLET_FUNDING_FAILED"; readonly message: string }
  | { readonly type: "TIMING_CALCULATION_FAILED"; readonly message: string }
  | { readonly type: "FEE_PATTERN_FAILED"; readonly message: string }
  | { readonly type: "OBFUSCATION_FAILED"; readonly message: string }
  | { readonly type: "UNKNOWN"; readonly message: string };

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Privacy layer operation result
 */
export type PrivacyLayerOperationResult<T = PrivacyLayerResult> = Result<
  T,
  PrivacyLayerError
>;

/**
 * Privacy settings validation result
 */
export interface PrivacySettingsValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}
