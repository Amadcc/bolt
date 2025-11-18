/**
 * DAY 11: Multi-Wallet Support - Type System
 *
 * Comprehensive type definitions for wallet rotation and management.
 * Features:
 * - Branded types for compile-time safety (WalletId, WalletLabel, etc.)
 * - Discriminated unions for rotation strategies and errors
 * - Zero `as any` usage
 * - Full Result<T> pattern integration
 */

import type { SolanaAddress } from "./common";

// ============================================================================
// BRANDED TYPES
// ============================================================================

/**
 * Wallet unique identifier (UUID)
 * Branded to prevent mixing with other string IDs
 */
export type WalletId = string & { readonly __brand: "WalletId" };

/**
 * User-friendly wallet label (e.g., "Main", "Trading", "Sniper 1")
 * Branded to ensure labels are validated before use
 */
export type WalletLabel = string & { readonly __brand: "WalletLabel" };

/**
 * Wallet count (0-10 per user)
 * Branded to prevent using arbitrary numbers
 */
export type WalletCount = number & { readonly __brand: "WalletCount" };

/**
 * Usage count for tracking wallet rotations
 * Branded for type safety
 */
export type UsageCount = number & { readonly __brand: "UsageCount" };

// ============================================================================
// BRANDED TYPE CONSTRUCTORS
// ============================================================================

export function asWalletId(value: string): WalletId {
  // UUID v4 validation
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(value)) {
    throw new TypeError(`Invalid wallet ID: ${value}`);
  }
  return value as WalletId;
}

export function asWalletLabel(value: string): WalletLabel {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new TypeError("Wallet label cannot be empty");
  }

  if (trimmed.length > 50) {
    throw new TypeError(
      `Wallet label too long (max 50 chars): ${trimmed.length}`
    );
  }

  // Allow alphanumeric, spaces, hyphens, underscores
  const labelRegex = /^[a-zA-Z0-9\s\-_]+$/;
  if (!labelRegex.test(trimmed)) {
    throw new TypeError(
      `Invalid wallet label (use only letters, numbers, spaces, hyphens, underscores): ${trimmed}`
    );
  }

  return trimmed as WalletLabel;
}

export function asWalletCount(value: number): WalletCount {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Wallet count must be an integer: ${value}`);
  }

  if (value < 0) {
    throw new TypeError(`Wallet count cannot be negative: ${value}`);
  }

  if (value > MAX_WALLETS_PER_USER) {
    throw new TypeError(
      `Wallet count exceeds maximum (${MAX_WALLETS_PER_USER}): ${value}`
    );
  }

  return value as WalletCount;
}

export function asUsageCount(value: number): UsageCount {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Usage count must be an integer: ${value}`);
  }

  if (value < 0) {
    throw new TypeError(`Usage count cannot be negative: ${value}`);
  }

  return value as UsageCount;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const MAX_WALLETS_PER_USER = 10;
export const DEFAULT_WALLET_LABEL = "Main";

// ============================================================================
// ROTATION STRATEGIES
// ============================================================================

/**
 * Wallet rotation strategies
 * Discriminated union for type-safe pattern matching
 */
export type RotationStrategy =
  | { type: "ROUND_ROBIN" } // Rotate through wallets in order
  | { type: "LEAST_USED" } // Use wallet with lowest usage count
  | { type: "RANDOM" } // Random wallet selection
  | { type: "SPECIFIC"; walletId: WalletId } // Use specific wallet
  | { type: "PRIMARY_ONLY" }; // Always use primary wallet

// ============================================================================
// WALLET INFO
// ============================================================================

/**
 * Comprehensive wallet information
 * Used by rotation service and wallet manager
 */
export interface WalletInfo {
  readonly id: WalletId;
  readonly userId: string;
  readonly publicKey: SolanaAddress;
  readonly chain: string;
  readonly label: WalletLabel | null;
  readonly isPrimary: boolean;
  readonly isActive: boolean;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Wallet with usage statistics
 */
export interface WalletWithStats extends WalletInfo {
  readonly usageCount: UsageCount;
  readonly lastUsedMinutesAgo: number | null;
}

// ============================================================================
// ROTATION CONFIGURATION
// ============================================================================

/**
 * Rotation configuration per user
 */
export interface RotationConfig {
  readonly userId: string;
  readonly strategy: RotationStrategy;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Default rotation configuration
 */
export const DEFAULT_ROTATION_CONFIG: Omit<
  RotationConfig,
  "userId" | "createdAt" | "updatedAt"
> = {
  strategy: { type: "ROUND_ROBIN" },
  enabled: false, // Disabled by default, user must opt-in
};

// ============================================================================
// ROTATION STATE
// ============================================================================

/**
 * Internal rotation state (not persisted)
 * Tracks current position in round-robin rotation
 */
export interface RotationState {
  readonly userId: string;
  readonly currentIndex: number;
  readonly totalWallets: WalletCount;
  readonly lastRotatedAt: Date;
}

// ============================================================================
// WALLET CREATION
// ============================================================================

/**
 * Parameters for creating a new wallet
 */
export interface CreateWalletParams {
  readonly userId: string;
  readonly password: string;
  readonly label?: WalletLabel;
  readonly isPrimary?: boolean;
}

/**
 * Result of wallet creation
 */
export interface CreateWalletResult {
  readonly wallet: WalletInfo;
  readonly mnemonic: string; // Return mnemonic for user backup
}

// ============================================================================
// WALLET ROTATION ERRORS
// ============================================================================

/**
 * Wallet rotator errors
 * Discriminated union for type-safe error handling
 */
export type WalletRotatorError =
  | { type: "MAX_WALLETS_REACHED"; maxWallets: WalletCount }
  | { type: "NO_WALLETS_FOUND"; userId: string }
  | { type: "NO_ACTIVE_WALLETS"; userId: string; totalWallets: WalletCount }
  | { type: "WALLET_NOT_FOUND"; walletId: WalletId }
  | { type: "DUPLICATE_LABEL"; label: WalletLabel; userId: string }
  | {
      type: "MULTIPLE_PRIMARY_WALLETS";
      userId: string;
      primaryWalletIds: WalletId[];
    }
  | { type: "CANNOT_DELETE_PRIMARY"; walletId: WalletId }
  | { type: "CANNOT_DELETE_LAST_WALLET"; walletId: WalletId }
  | { type: "INVALID_ROTATION_STRATEGY"; strategy: string }
  | { type: "ROTATION_DISABLED"; userId: string }
  | { type: "RATE_LIMITED"; message: string }
  | { type: "DATABASE_ERROR"; message: string; cause?: unknown }
  | { type: "ENCRYPTION_ERROR"; message: string; cause?: unknown };

// ============================================================================
// WALLET OPERATIONS
// ============================================================================

/**
 * Parameters for updating wallet
 */
export interface UpdateWalletParams {
  readonly walletId: WalletId;
  readonly label?: WalletLabel | null;
  readonly isPrimary?: boolean;
  readonly isActive?: boolean;
}

/**
 * Parameters for deleting wallet
 */
export interface DeleteWalletParams {
  readonly walletId: WalletId;
  readonly userId: string;
}

// ============================================================================
// BALANCE AGGREGATION
// ============================================================================

/**
 * Wallet balance information
 */
export interface WalletBalance {
  readonly walletId: WalletId;
  readonly publicKey: SolanaAddress;
  readonly label: WalletLabel | null;
  readonly balanceLamports: bigint;
  readonly balanceSol: number;
}

/**
 * Aggregated balance across all wallets
 */
export interface AggregatedBalance {
  readonly userId: string;
  readonly totalWallets: WalletCount;
  readonly activeWallets: WalletCount;
  readonly totalBalanceLamports: bigint;
  readonly totalBalanceSol: number;
  readonly wallets: WalletBalance[];
  readonly fetchedAt: Date;
}

// ============================================================================
// USAGE STATISTICS
// ============================================================================

/**
 * Wallet usage statistics
 */
export interface WalletUsageStats {
  readonly walletId: WalletId;
  readonly publicKey: SolanaAddress;
  readonly label: WalletLabel | null;
  readonly totalUsages: UsageCount;
  readonly lastUsedAt: Date | null;
  readonly daysSinceCreated: number;
  readonly daysSinceLastUsed: number | null;
  readonly averageUsagesPerDay: number;
}

/**
 * Aggregated usage statistics
 */
export interface AggregatedUsageStats {
  readonly userId: string;
  readonly totalWallets: WalletCount;
  readonly totalUsages: UsageCount;
  readonly mostUsedWallet: WalletUsageStats | null;
  readonly leastUsedWallet: WalletUsageStats | null;
  readonly wallets: WalletUsageStats[];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if wallet count is at maximum
 */
export function isMaxWalletsReached(count: WalletCount): boolean {
  return count >= MAX_WALLETS_PER_USER;
}

/**
 * Calculate remaining wallet slots
 */
export function getRemainingWalletSlots(
  currentCount: WalletCount
): WalletCount {
  return asWalletCount(MAX_WALLETS_PER_USER - currentCount);
}

/**
 * Create default wallet label based on count
 */
export function generateDefaultLabel(count: WalletCount): WalletLabel {
  if (count === 0) {
    return asWalletLabel(DEFAULT_WALLET_LABEL);
  }
  return asWalletLabel(`Wallet ${count + 1}`);
}

/**
 * Check if rotation strategy is valid
 */
export function isValidRotationStrategy(
  strategy: RotationStrategy
): strategy is RotationStrategy {
  const validTypes = [
    "ROUND_ROBIN",
    "LEAST_USED",
    "RANDOM",
    "SPECIFIC",
    "PRIMARY_ONLY",
  ];
  return validTypes.includes(strategy.type);
}

/**
 * Get human-readable rotation strategy name
 */
export function getRotationStrategyName(strategy: RotationStrategy): string {
  switch (strategy.type) {
    case "ROUND_ROBIN":
      return "Round Robin (Sequential)";
    case "LEAST_USED":
      return "Least Used (Balanced)";
    case "RANDOM":
      return "Random";
    case "SPECIFIC":
      return "Specific Wallet";
    case "PRIMARY_ONLY":
      return "Primary Wallet Only";
  }
}

/**
 * Calculate minutes since last used
 */
export function getMinutesSinceLastUsed(lastUsedAt: Date | null): number | null {
  if (!lastUsedAt) return null;
  const now = Date.now();
  const diff = now - lastUsedAt.getTime();
  return Math.floor(diff / 1000 / 60);
}

/**
 * Calculate days since created
 */
export function getDaysSinceCreated(createdAt: Date): number {
  const now = Date.now();
  const diff = now - createdAt.getTime();
  return Math.floor(diff / 1000 / 60 / 60 / 24);
}

/**
 * Calculate days since last used
 */
export function getDaysSinceLastUsed(lastUsedAt: Date | null): number | null {
  if (!lastUsedAt) return null;
  const now = Date.now();
  const diff = now - lastUsedAt.getTime();
  return Math.floor(diff / 1000 / 60 / 60 / 24);
}

/**
 * Sort wallets by last used (oldest first)
 */
export function sortByLeastUsed(
  wallets: WalletWithStats[]
): WalletWithStats[] {
  return [...wallets].sort((a, b) => {
    // Prioritize never-used wallets
    if (!a.lastUsedAt && !b.lastUsedAt) return 0;
    if (!a.lastUsedAt) return -1;
    if (!b.lastUsedAt) return 1;

    // Then by usage count
    if (a.usageCount !== b.usageCount) {
      return a.usageCount - b.usageCount;
    }

    // Finally by last used date (oldest first)
    return a.lastUsedAt.getTime() - b.lastUsedAt.getTime();
  });
}

/**
 * Filter active wallets only
 */
export function filterActiveWallets(wallets: WalletInfo[]): WalletInfo[] {
  return wallets.filter((w) => w.isActive);
}

/**
 * Find primary wallet
 */
export function findPrimaryWallet(
  wallets: WalletInfo[]
): WalletInfo | null {
  const primaryWallets = wallets.filter((w) => w.isPrimary);

  if (primaryWallets.length === 0) return null;
  if (primaryWallets.length === 1) return primaryWallets[0];

  // Multiple primary wallets - this is an error state
  // Return the oldest one
  return primaryWallets.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  )[0];
}

/**
 * Validate wallet label uniqueness
 */
export function hasUniquelabel(
  wallets: WalletInfo[],
  label: WalletLabel,
  excludeWalletId?: WalletId
): boolean {
  return !wallets.some(
    (w) =>
      w.label === label &&
      (!excludeWalletId || w.id !== excludeWalletId)
  );
}
