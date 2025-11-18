/**
 * Rug Detection Type System
 * Comprehensive types for detecting and responding to rug pulls
 */

import type { TokenMint, Lamports } from "./common.js";

// ============================================================================
// Branded Types (Compile-Time Safety)
// ============================================================================

/**
 * Liquidity amount in lamports
 * Used to track pool balance changes
 */
export type LiquidityAmount = bigint & { readonly __brand: "LiquidityAmount" };

/**
 * Token supply amount
 * Used to detect unexpected minting
 */
export type SupplyAmount = bigint & { readonly __brand: "SupplyAmount" };

/**
 * Percentage of total supply held by an address
 * Used for top holder tracking
 */
export type HolderPercentage = number & {
  readonly __brand: "HolderPercentage";
};

/**
 * Percentage change in value (can be negative)
 * Used for liquidity drop detection
 */
export type ChangePercentage = number & {
  readonly __brand: "ChangePercentage";
};

/**
 * Time interval in milliseconds
 * Used for monitoring intervals
 */
export type MonitorInterval = number & { readonly __brand: "MonitorInterval" };

// ============================================================================
// Branded Type Constructors
// ============================================================================

export function asLiquidityAmount(value: bigint): LiquidityAmount {
  if (value < 0n) {
    throw new TypeError("Liquidity amount cannot be negative");
  }
  return value as LiquidityAmount;
}

export function asSupplyAmount(value: bigint): SupplyAmount {
  if (value <= 0n) {
    throw new TypeError("Supply amount must be positive");
  }
  return value as SupplyAmount;
}

export function asHolderPercentage(value: number): HolderPercentage {
  if (value < 0 || value > 100 || !Number.isFinite(value)) {
    throw new TypeError("Holder percentage must be between 0 and 100");
  }
  return value as HolderPercentage;
}

export function asChangePercentage(value: number): ChangePercentage {
  if (!Number.isFinite(value)) {
    throw new TypeError("Change percentage must be finite");
  }
  return value as ChangePercentage;
}

export function asMonitorInterval(value: number): MonitorInterval {
  if (value <= 0 || !Number.isFinite(value)) {
    throw new TypeError("Monitor interval must be positive");
  }
  return value as MonitorInterval;
}

// ============================================================================
// Rug Detection Types
// ============================================================================

/**
 * Types of rug pulls that can be detected
 */
export type RugType =
  | "LIQUIDITY_REMOVAL" // >50% liquidity removed from pool
  | "AUTHORITY_REENABLED" // Mint/freeze authority re-enabled
  | "SUPPLY_MANIPULATION" // Unexpected minting detected
  | "HOLDER_DUMP" // Top holder sold >30% of their holdings
  | "MULTIPLE_INDICATORS"; // Multiple rug indicators detected simultaneously

/**
 * Severity level of rug detection
 */
export type RugSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Authority state for a token
 */
export type AuthorityState = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Timestamp when authority state was checked */
  checkedAt: Date;
};

/**
 * Liquidity pool state snapshot
 */
export type LiquiditySnapshot = {
  poolAddress: string;
  tokenReserve: LiquidityAmount;
  solReserve: LiquidityAmount;
  totalValueLamports: Lamports;
  timestamp: Date;
};

/**
 * Token supply snapshot
 */
export type SupplySnapshot = {
  totalSupply: SupplyAmount;
  circulatingSupply: SupplyAmount;
  timestamp: Date;
};

/**
 * Top holder information
 */
export type TopHolder = {
  address: string;
  balance: SupplyAmount;
  percentageOfSupply: HolderPercentage;
};

/**
 * Holder activity tracking
 */
export type HolderActivity = {
  holder: TopHolder;
  previousBalance: SupplyAmount;
  currentBalance: SupplyAmount;
  changePercentage: ChangePercentage;
  timestamp: Date;
};

/**
 * Rug detection result with full context
 */
export type RugDetection = {
  rugType: RugType;
  severity: RugSeverity;
  detectedAt: Date;
  confidence: number; // 0-100, how confident we are this is a rug
  evidence: RugEvidence;
  recommendation: "HOLD" | "EXIT_PARTIAL" | "EXIT_FULL" | "EXIT_EMERGENCY";
};

/**
 * Evidence for different rug types
 */
export type RugEvidence =
  | {
      type: "LIQUIDITY_REMOVAL";
      previousSnapshot: LiquiditySnapshot;
      currentSnapshot: LiquiditySnapshot;
      dropPercentage: ChangePercentage;
      removedValueLamports: Lamports;
    }
  | {
      type: "AUTHORITY_REENABLED";
      previousState: AuthorityState;
      currentState: AuthorityState;
      changedAuthorities: Array<"mint" | "freeze">;
      reenabledBy: string; // Transaction signature
    }
  | {
      type: "SUPPLY_MANIPULATION";
      previousSnapshot: SupplySnapshot;
      currentSnapshot: SupplySnapshot;
      supplyIncrease: SupplyAmount;
      increasePercentage: ChangePercentage;
      mintedBy: string; // Transaction signature
    }
  | {
      type: "HOLDER_DUMP";
      holder: TopHolder;
      activity: HolderActivity;
      soldAmount: SupplyAmount;
      sellPercentage: ChangePercentage;
      affectedMarketPct: HolderPercentage; // % of total supply sold
    }
  | {
      type: "MULTIPLE_INDICATORS";
      detections: RugDetection[];
      combinedSeverity: RugSeverity;
    };

// ============================================================================
// Emergency Exit Types
// ============================================================================

/**
 * Emergency exit execution result
 */
export type EmergencyExitResult = {
  positionId: string;
  tokenMint: TokenMint;
  exitedAt: Date;
  rugDetection: RugDetection;
  exitDetails: ExitDetails;
};

/**
 * Details of emergency exit execution
 */
export type ExitDetails = {
  amountIn: Lamports; // Original investment
  amountOut: Lamports; // Amount recovered
  pnlLamports: Lamports; // Profit/loss in lamports
  pnlPercentage: number; // Profit/loss percentage
  executionTimeMs: number;
  transactionSignature: string;
  slippageUsed: number; // Actual slippage percentage
};

/**
 * Emergency exit request parameters
 */
export type EmergencyExitRequest = {
  positionId: string;
  tokenMint: TokenMint;
  userId: string;
  reason: RugDetection;
  /** Force exit even if token appears unsafe */
  forceExit: boolean;
  /** Max acceptable loss percentage (e.g., 90 = accept up to 90% loss) */
  maxLossPercentage?: number;
};

// ============================================================================
// Monitoring Configuration
// ============================================================================

/**
 * Rug monitor configuration with thresholds
 */
export type RugMonitorConfig = {
  /** Monitoring interval in milliseconds */
  monitorIntervalMs: MonitorInterval;
  /** Liquidity drop percentage threshold */
  liquidityDropThreshold: ChangePercentage;
  /** Supply increase percentage threshold */
  supplyIncreaseThreshold: ChangePercentage;
  /** Top holder sell percentage threshold */
  holderDumpThreshold: ChangePercentage;
  /** Number of top holders to track */
  topHoldersCount: number;
  /** Enable emergency auto-exit */
  autoExitEnabled: boolean;
  /** Max slippage for emergency exits (percentage) */
  emergencyExitSlippage: number;
  /** Max retries for emergency exit */
  emergencyExitRetries: number;
  /** Retry delay in milliseconds */
  emergencyExitRetryDelayMs: number;
  /** Max concurrent position checks (batch size) */
  maxConcurrentChecks: number;
  /** Delay between batches in milliseconds */
  batchDelayMs: number;
};

/**
 * Default rug monitor configuration
 */
export const DEFAULT_RUG_MONITOR_CONFIG: RugMonitorConfig = {
  monitorIntervalMs: asMonitorInterval(5_000), // 5 seconds
  liquidityDropThreshold: asChangePercentage(-50), // -50% drop
  supplyIncreaseThreshold: asChangePercentage(10), // +10% supply increase
  holderDumpThreshold: asChangePercentage(-30), // -30% holder balance
  topHoldersCount: 10,
  autoExitEnabled: true,
  emergencyExitSlippage: 25, // 25% max slippage (desperate exit)
  emergencyExitRetries: 5,
  emergencyExitRetryDelayMs: 1_000, // 1 second
  maxConcurrentChecks: 10, // Max 10 positions checked concurrently
  batchDelayMs: 100, // 100ms delay between batches
};

// ============================================================================
// Position Tracking State
// ============================================================================

/**
 * Rug monitoring state for a position
 */
export type RugMonitorState = {
  positionId: string;
  tokenMint: TokenMint;
  userId: string;
  status: "MONITORING" | "RUG_DETECTED" | "EXITING" | "EXITED" | "STOPPED";
  startedAt: Date;
  lastCheckAt: Date;
  checksPerformed: number;
  /** Baseline snapshots taken at monitoring start */
  baseline: {
    authority: AuthorityState;
    liquidity: LiquiditySnapshot;
    supply: SupplySnapshot;
    topHolders: TopHolder[];
  };
  /** Latest snapshots */
  latest: {
    authority: AuthorityState;
    liquidity: LiquiditySnapshot;
    supply: SupplySnapshot;
    topHolders: TopHolder[];
  };
  /** Detected rugs (if any) */
  rugDetections: RugDetection[];
  /** Emergency exit result (if executed) */
  emergencyExit?: EmergencyExitResult;
};

// ============================================================================
// Error Types
// ============================================================================

/**
 * Rug monitor error discriminated union
 */
export type RugMonitorError =
  | {
      type: "POSITION_NOT_FOUND";
      positionId: string;
      message: string;
    }
  | {
      type: "MONITORING_ALREADY_ACTIVE";
      positionId: string;
      message: string;
    }
  | {
      type: "DATA_FETCH_FAILED";
      dataType: "liquidity" | "authority" | "supply" | "holders";
      reason: string;
      message: string;
    }
  | {
      type: "EMERGENCY_EXIT_FAILED";
      positionId: string;
      reason: string;
      attempts: number;
      message: string;
    }
  | {
      type: "CIRCUIT_OPEN";
      service: string;
      message: string;
      nextAttemptAt?: Date;
    }
  | {
      type: "INVALID_CONFIG";
      field: string;
      reason: string;
      message: string;
    };

// ============================================================================
// Result Types
// ============================================================================

export type Result<T, E = RugMonitorError> =
  | { success: true; value: T }
  | { success: false; error: E };

export const Ok = <T>(value: T): Result<T, never> => ({
  success: true,
  value,
});

export const Err = <E>(error: E): Result<never, E> => ({
  success: false,
  error,
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate liquidity change percentage
 */
export function calculateLiquidityChange(
  previous: LiquiditySnapshot,
  current: LiquiditySnapshot
): ChangePercentage {
  if (previous.totalValueLamports === 0n) {
    return asChangePercentage(0);
  }

  const previousValue = Number(previous.totalValueLamports);
  const currentValue = Number(current.totalValueLamports);
  const change = ((currentValue - previousValue) / previousValue) * 100;

  return asChangePercentage(change);
}

/**
 * Calculate supply change percentage
 */
export function calculateSupplyChange(
  previous: SupplySnapshot,
  current: SupplySnapshot
): ChangePercentage {
  if (previous.totalSupply === 0n) {
    return asChangePercentage(0);
  }

  const previousSupply = Number(previous.totalSupply);
  const currentSupply = Number(current.totalSupply);
  const change = ((currentSupply - previousSupply) / previousSupply) * 100;

  return asChangePercentage(change);
}

/**
 * Calculate holder balance change percentage
 */
export function calculateHolderChange(
  previousBalance: SupplyAmount,
  currentBalance: SupplyAmount
): ChangePercentage {
  if (previousBalance === 0n) {
    return asChangePercentage(0);
  }

  const previous = Number(previousBalance);
  const current = Number(currentBalance);
  const change = ((current - previous) / previous) * 100;

  return asChangePercentage(change);
}

/**
 * Calculate holder percentage of total supply
 */
export function calculateHolderPercentage(
  holderBalance: SupplyAmount,
  totalSupply: SupplyAmount
): HolderPercentage {
  if (totalSupply === 0n) {
    return asHolderPercentage(0);
  }

  const percentage =
    (Number(holderBalance) / Number(totalSupply)) * 100;

  return asHolderPercentage(Math.min(percentage, 100));
}

/**
 * Determine rug severity based on evidence
 */
export function determineRugSeverity(
  rugType: RugType,
  evidence: RugEvidence
): RugSeverity {
  switch (rugType) {
    case "LIQUIDITY_REMOVAL": {
      if (evidence.type !== "LIQUIDITY_REMOVAL") return "MEDIUM";
      const dropPct = Math.abs(evidence.dropPercentage);
      if (dropPct >= 90) return "CRITICAL";
      if (dropPct >= 75) return "HIGH";
      if (dropPct >= 50) return "MEDIUM";
      return "LOW";
    }

    case "AUTHORITY_REENABLED": {
      if (evidence.type !== "AUTHORITY_REENABLED") return "HIGH";
      // Re-enabling authorities is always critical
      return "CRITICAL";
    }

    case "SUPPLY_MANIPULATION": {
      if (evidence.type !== "SUPPLY_MANIPULATION") return "MEDIUM";
      const increasePct = evidence.increasePercentage;
      if (increasePct >= 50) return "CRITICAL";
      if (increasePct >= 25) return "HIGH";
      if (increasePct >= 10) return "MEDIUM";
      return "LOW";
    }

    case "HOLDER_DUMP": {
      if (evidence.type !== "HOLDER_DUMP") return "MEDIUM";
      const affectedPct = evidence.affectedMarketPct;
      if (affectedPct >= 20) return "CRITICAL"; // >20% of supply dumped
      if (affectedPct >= 10) return "HIGH";
      if (affectedPct >= 5) return "MEDIUM";
      return "LOW";
    }

    case "MULTIPLE_INDICATORS": {
      if (evidence.type !== "MULTIPLE_INDICATORS") return "HIGH";
      return evidence.combinedSeverity;
    }
  }
}

/**
 * Determine exit recommendation based on severity
 */
export function determineExitRecommendation(
  severity: RugSeverity,
  confidence: number
): RugDetection["recommendation"] {
  if (severity === "CRITICAL" && confidence >= 90) {
    return "EXIT_EMERGENCY"; // Immediate exit, accept high slippage
  }

  if (severity === "CRITICAL" || (severity === "HIGH" && confidence >= 80)) {
    return "EXIT_FULL"; // Exit full position ASAP
  }

  if (severity === "HIGH" || (severity === "MEDIUM" && confidence >= 70)) {
    return "EXIT_PARTIAL"; // Exit 50-75% of position
  }

  return "HOLD"; // Monitor closely
}

/**
 * Calculate confidence score for rug detection
 */
export function calculateRugConfidence(
  rugType: RugType,
  evidence: RugEvidence
): number {
  let baseConfidence = 0;

  switch (rugType) {
    case "LIQUIDITY_REMOVAL": {
      if (evidence.type !== "LIQUIDITY_REMOVAL") return 50;
      const dropPct = Math.abs(evidence.dropPercentage);
      // Confidence increases with drop percentage
      baseConfidence = Math.min(50 + dropPct, 100);
      break;
    }

    case "AUTHORITY_REENABLED": {
      // Re-enabling authority is very suspicious
      baseConfidence = 95;
      break;
    }

    case "SUPPLY_MANIPULATION": {
      if (evidence.type !== "SUPPLY_MANIPULATION") return 50;
      const increasePct = evidence.increasePercentage;
      // Large supply increases are very suspicious
      baseConfidence = Math.min(60 + increasePct * 2, 100);
      break;
    }

    case "HOLDER_DUMP": {
      if (evidence.type !== "HOLDER_DUMP") return 50;
      const affectedPct = evidence.affectedMarketPct;
      // Confidence increases with market impact
      baseConfidence = Math.min(50 + affectedPct * 3, 100);
      break;
    }

    case "MULTIPLE_INDICATORS": {
      // Multiple indicators = very high confidence
      baseConfidence = 98;
      break;
    }
  }

  return Math.round(Math.max(0, Math.min(100, baseConfidence)));
}

/**
 * Create a rug detection object with all calculated fields
 */
export function createRugDetection(
  rugType: RugType,
  evidence: RugEvidence
): RugDetection {
  const confidence = calculateRugConfidence(rugType, evidence);
  const severity = determineRugSeverity(rugType, evidence);
  const recommendation = determineExitRecommendation(severity, confidence);

  return {
    rugType,
    severity,
    detectedAt: new Date(),
    confidence,
    evidence,
    recommendation,
  };
}
