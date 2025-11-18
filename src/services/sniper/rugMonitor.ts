/**
 * Rug Monitor Service
 * Continuous monitoring of active positions for rug pull indicators
 *
 * Features:
 * - Liquidity removal detection (>50% drop)
 * - Authority re-enablement detection
 * - Supply manipulation detection (unexpected minting)
 * - Top holder dump detection (>30% sells)
 * - Emergency exit mechanism
 * - Circuit breaker pattern
 * - Comprehensive logging and metrics
 *
 * Architecture:
 * - Monitors each position independently
 * - 5-second check interval (configurable)
 * - Parallel checks for efficiency
 * - Automatic emergency exit on critical rugs
 * - Integrates with ExitExecutor from Day 9
 */

import { PublicKey, type Keypair } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import {
  recordRugDetectionCheck,
  recordRugDetected,
  recordEmergencyExitTriggered,
  recordEmergencyExitDuration,
  recordPositionSavedPercentage,
} from "../../utils/metrics.js";
import type { Result, TokenMint, Lamports } from "../../types/common.js";
import { Ok, Err, asLamports } from "../../types/common.js";
import type {
  RugDetection,
  RugMonitorState,
  RugMonitorConfig,
  RugMonitorError,
  EmergencyExitRequest,
  EmergencyExitResult,
  AuthorityState,
  LiquiditySnapshot,
  SupplySnapshot,
  SupplyAmount,
  TopHolder,
  HolderActivity,
  RugEvidence,
} from "../../types/rugDetection.js";
import {
  asLiquidityAmount,
  asSupplyAmount,
  asChangePercentage,
  calculateLiquidityChange,
  calculateSupplyChange,
  calculateHolderChange,
  calculateHolderPercentage,
  createRugDetection,
  DEFAULT_RUG_MONITOR_CONFIG,
} from "../../types/rugDetection.js";
import type {
  ExitExecutor,
  ExecuteExitParams,
} from "../trading/exitExecutor.js";
import type { SolanaService } from "../blockchain/solana.js";
import { sleep, retryWithBackoff } from "../../utils/helpers.js";

// ============================================================================
// Circuit Breaker State
// ============================================================================

type CircuitState = {
  status: "CLOSED" | "HALF_OPEN" | "OPEN";
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
};

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_TIMEOUT_MS = 60_000; // 1 minute
const HALF_OPEN_SUCCESS_THRESHOLD = 2;

// Retry configuration for RPC calls (max 3 attempts)
const RETRY_CONFIG_RPC = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  jitterFactor: 0.1,
};

// ============================================================================
// Rug Monitor Class
// ============================================================================

export class RugMonitor {
  private monitoredPositions: Map<string, RugMonitorState> = new Map();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private circuitState: CircuitState = {
    status: "CLOSED",
    failureCount: 0,
    lastFailureTime: 0,
    successCount: 0,
  };

  constructor(
    private solanaService: SolanaService,
    private exitExecutor: ExitExecutor,
    private getKeypair: (userId: string) => Promise<Keypair | null>,
    private config: RugMonitorConfig = DEFAULT_RUG_MONITOR_CONFIG
  ) {
    logger.info("RugMonitor initialized", {
      monitorIntervalMs: config.monitorIntervalMs,
      liquidityThreshold: config.liquidityDropThreshold,
      supplyThreshold: config.supplyIncreaseThreshold,
      holderThreshold: config.holderDumpThreshold,
      autoExitEnabled: config.autoExitEnabled,
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Start monitoring a position for rug indicators
   */
  async startMonitoring(
    positionId: string
  ): Promise<Result<RugMonitorState, RugMonitorError>> {
    // Check if already monitoring
    if (this.monitoredPositions.has(positionId)) {
      return Err({
        type: "MONITORING_ALREADY_ACTIVE",
        positionId,
        message: `Position ${positionId} is already being monitored`,
      });
    }

    // Get position from database
    const position = await prisma.sniperPosition.findUnique({
      where: { id: positionId },
    });

    if (!position) {
      return Err({
        type: "POSITION_NOT_FOUND",
        positionId,
        message: `Position ${positionId} not found`,
      });
    }

    const tokenMint = position.tokenMint as TokenMint;

    logger.info("Starting rug monitoring for position", {
      positionId,
      tokenMint,
      userId: position.userId,
    });

    // Fetch baseline snapshots
    const baselineResult = await this.fetchBaselineSnapshots(tokenMint);
    if (!baselineResult.success) {
      return Err(
        (baselineResult as Extract<typeof baselineResult, { success: false }>)
          .error
      );
    }

    const baseline = baselineResult.value;

    // Create monitoring state
    const monitorState: RugMonitorState = {
      positionId,
      tokenMint,
      userId: position.userId,
      status: "MONITORING",
      startedAt: new Date(),
      lastCheckAt: new Date(),
      checksPerformed: 0,
      baseline,
      latest: baseline,
      rugDetections: [],
    };

    this.monitoredPositions.set(positionId, monitorState);

    // Start global monitoring loop if not already running
    if (!this.monitoringInterval) {
      this.startGlobalMonitoring();
    }

    logger.info("Rug monitoring started", {
      positionId,
      baselineLiquidity: Number(baseline.liquidity.totalValueLamports),
      baselineSupply: Number(baseline.supply.totalSupply),
      topHoldersCount: baseline.topHolders.length,
    });

    return Ok(monitorState);
  }

  /**
   * Stop monitoring a position
   */
  async stopMonitoring(positionId: string): Promise<void> {
    const state = this.monitoredPositions.get(positionId);
    if (!state) {
      logger.warn("Attempted to stop monitoring non-existent position", {
        positionId,
      });
      return;
    }

    state.status = "STOPPED";
    this.monitoredPositions.delete(positionId);

    logger.info("Rug monitoring stopped", {
      positionId,
      checksPerformed: state.checksPerformed,
      rugDetections: state.rugDetections.length,
    });

    // Stop global monitoring if no positions left
    if (this.monitoredPositions.size === 0 && this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info("Global rug monitoring stopped (no positions)");
    }
  }

  /**
   * Get current monitoring state for a position
   */
  getMonitorState(positionId: string): RugMonitorState | null {
    return this.monitoredPositions.get(positionId) || null;
  }

  /**
   * Get all monitored positions
   */
  getAllMonitoredPositions(): RugMonitorState[] {
    return Array.from(this.monitoredPositions.values());
  }

  /**
   * Manually trigger emergency exit (user-requested)
   */
  async manualEmergencyExit(
    positionId: string
  ): Promise<Result<EmergencyExitResult, RugMonitorError>> {
    const state = this.monitoredPositions.get(positionId);
    if (!state) {
      return Err({
        type: "POSITION_NOT_FOUND",
        positionId,
        message: `Position ${positionId} not found or not monitored`,
      });
    }

    // Create manual rug detection
    const manualDetection: RugDetection = {
      rugType: "MULTIPLE_INDICATORS",
      severity: "CRITICAL",
      detectedAt: new Date(),
      confidence: 100,
      recommendation: "EXIT_EMERGENCY",
      evidence: {
        type: "MULTIPLE_INDICATORS",
        detections: [],
        combinedSeverity: "CRITICAL",
      },
    };

    const request: EmergencyExitRequest = {
      positionId,
      tokenMint: state.tokenMint,
      userId: state.userId,
      reason: manualDetection,
      forceExit: true,
    };

    return this.executeEmergencyExit(request);
  }

  /**
   * Get circuit breaker status
   */
  getCircuitStatus(): CircuitState {
    return { ...this.circuitState };
  }

  // ==========================================================================
  // Global Monitoring Loop
  // ==========================================================================

  /**
   * Start global monitoring interval
   */
  private startGlobalMonitoring(): void {
    if (this.monitoringInterval) {
      logger.warn("Global monitoring already running");
      return;
    }

    logger.info("Starting global rug monitoring loop", {
      intervalMs: this.config.monitorIntervalMs,
    });

    this.monitoringInterval = setInterval(() => {
      void this.monitorAllPositions();
    }, this.config.monitorIntervalMs);
  }

  /**
   * Monitor all active positions
   */
  private async monitorAllPositions(): Promise<void> {
    const positions = Array.from(this.monitoredPositions.values());

    if (positions.length === 0) {
      return;
    }

    // Check circuit breaker
    if (this.circuitState.status === "OPEN") {
      const timeSinceLastFailure =
        Date.now() - this.circuitState.lastFailureTime;
      if (timeSinceLastFailure >= CIRCUIT_TIMEOUT_MS) {
        logger.info("Circuit breaker transitioning to HALF_OPEN");
        this.circuitState.status = "HALF_OPEN";
        this.circuitState.successCount = 0;
      } else {
        logger.warn("Circuit breaker is OPEN, skipping rug checks", {
          timeSinceLastFailure,
          timeoutRemaining: CIRCUIT_TIMEOUT_MS - timeSinceLastFailure,
        });
        return;
      }
    }

    logger.debug("Monitoring all positions for rugs", {
      positionsCount: positions.length,
      circuitStatus: this.circuitState.status,
    });

    // Monitor positions in batches to prevent rate limits
    const batchStartTime = Date.now();
    const results: Array<PromiseSettledResult<Result<void, RugMonitorError>>> =
      [];

    for (
      let i = 0;
      i < positions.length;
      i += this.config.maxConcurrentChecks
    ) {
      const batch = positions.slice(i, i + this.config.maxConcurrentChecks);

      logger.debug("Processing position batch", {
        batchIndex: Math.floor(i / this.config.maxConcurrentChecks) + 1,
        batchSize: batch.length,
        totalPositions: positions.length,
        batchStartIndex: i,
        batchEndIndex: Math.min(i + this.config.maxConcurrentChecks, positions.length),
      });

      const batchResults = await Promise.allSettled(
        batch.map((state) => this.monitorPosition(state))
      );

      results.push(...batchResults);

      // Add delay between batches (except after last batch)
      if (i + this.config.maxConcurrentChecks < positions.length) {
        await sleep(this.config.batchDelayMs);
      }
    }

    const batchTotalTime = Date.now() - batchStartTime;

    logger.debug("Batch processing completed", {
      totalPositions: positions.length,
      totalBatches: Math.ceil(positions.length / this.config.maxConcurrentChecks),
      totalTimeMs: batchTotalTime,
      avgTimePerBatch: Math.round(
        batchTotalTime /
          Math.ceil(positions.length / this.config.maxConcurrentChecks)
      ),
    });

    // Count successes/failures for circuit breaker
    let successCount = 0;
    let failureCount = 0;

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    // Update circuit breaker state
    this.updateCircuitState(successCount > 0, failureCount);
  }

  /**
   * Monitor a single position
   */
  private async monitorPosition(
    state: RugMonitorState
  ): Promise<Result<void, RugMonitorError>> {
    const startTime = Date.now();

    try {
      // Skip if already exiting or exited
      if (state.status === "EXITING" || state.status === "EXITED") {
        return Ok(undefined);
      }

      // Update check timestamp
      state.lastCheckAt = new Date();
      state.checksPerformed++;

      recordRugDetectionCheck("success");

      // Fetch supply once and reuse across all methods (optimization)
      const supplyDataResult = await this.fetchTokenSupplyData(state.tokenMint);
      if (!supplyDataResult.success) {
        recordRugDetectionCheck("error");
        return Err(
          (supplyDataResult as Extract<typeof supplyDataResult, { success: false }>).error
        );
      }

      const supplyData = supplyDataResult.value;

      // Fetch current state (parallel), passing supply data to avoid duplicate calls
      const [authorityResult, liquidityResult, holdersResult] =
        await Promise.all([
          this.fetchAuthorityState(state.tokenMint),
          this.fetchLiquiditySnapshot(state.tokenMint, supplyData),
          this.fetchTopHolders(state.tokenMint, this.config.topHoldersCount, supplyData),
        ]);

      // Check for fetch errors
      if (!authorityResult.success) {
        recordRugDetectionCheck("error");
        return Err(
          (
            authorityResult as Extract<
              typeof authorityResult,
              { success: false }
            >
          ).error
        );
      }
      if (!liquidityResult.success) {
        recordRugDetectionCheck("error");
        return Err(
          (
            liquidityResult as Extract<
              typeof liquidityResult,
              { success: false }
            >
          ).error
        );
      }
      if (!holdersResult.success) {
        recordRugDetectionCheck("error");
        return Err(
          (holdersResult as Extract<typeof holdersResult, { success: false }>)
            .error
        );
      }

      // Create supply snapshot from the shared supply data
      const supplySnapshot: SupplySnapshot = {
        totalSupply: asSupplyAmount(BigInt(supplyData.amount)),
        circulatingSupply: asSupplyAmount(BigInt(supplyData.amount)), // Simplified
        timestamp: new Date(),
      };

      // Update latest state
      state.latest = {
        authority: authorityResult.value,
        liquidity: liquidityResult.value,
        supply: supplySnapshot,
        topHolders: holdersResult.value,
      };

      // Check for rug indicators
      const detections: RugDetection[] = [];

      // 1. Check liquidity removal
      const liquidityDetection = this.checkLiquidityRemoval(
        state.baseline.liquidity,
        state.latest.liquidity
      );
      if (liquidityDetection) {
        detections.push(liquidityDetection);
      }

      // 2. Check authority changes
      const authorityDetection = this.checkAuthorityChanges(
        state.baseline.authority,
        state.latest.authority
      );
      if (authorityDetection) {
        detections.push(authorityDetection);
      }

      // 3. Check supply manipulation
      const supplyDetection = this.checkSupplyManipulation(
        state.baseline.supply,
        state.latest.supply
      );
      if (supplyDetection) {
        detections.push(supplyDetection);
      }

      // 4. Check holder dumps
      const holderDetection = this.checkHolderDumps(
        state.baseline.topHolders,
        state.latest.topHolders
      );
      if (holderDetection) {
        detections.push(holderDetection);
      }

      // Process detections
      if (detections.length > 0) {
        logger.warn("Rug indicators detected", {
          positionId: state.positionId,
          tokenMint: state.tokenMint,
          detectionsCount: detections.length,
          types: detections.map((d) => d.rugType),
          severities: detections.map((d) => d.severity),
        });

        // Add to state
        state.rugDetections.push(...detections);
        state.status = "RUG_DETECTED";

        // Record metrics
        for (const detection of detections) {
          recordRugDetected(detection.rugType, detection.severity);
        }

        // Determine if emergency exit is needed
        const criticalDetection = detections.find(
          (d) => d.recommendation === "EXIT_EMERGENCY"
        );

        if (criticalDetection && this.config.autoExitEnabled) {
          logger.error("Critical rug detected, triggering emergency exit", {
            positionId: state.positionId,
            tokenMint: state.tokenMint,
            rugType: criticalDetection.rugType,
            severity: criticalDetection.severity,
            confidence: criticalDetection.confidence,
          });

          // Trigger emergency exit
          const exitRequest: EmergencyExitRequest = {
            positionId: state.positionId,
            tokenMint: state.tokenMint,
            userId: state.userId,
            reason: criticalDetection,
            forceExit: true,
            maxLossPercentage: 90, // Accept up to 90% loss in emergency
          };

          const exitResult = await this.executeEmergencyExit(exitRequest);
          if (exitResult.success) {
            state.emergencyExit = exitResult.value;
            state.status = "EXITED";
            logger.info("Emergency exit completed", {
              positionId: state.positionId,
              pnlPercentage: exitResult.value.exitDetails.pnlPercentage,
              executionTimeMs: exitResult.value.exitDetails.executionTimeMs,
            });
          } else {
            const error = (
              exitResult as Extract<typeof exitResult, { success: false }>
            ).error;
            logger.error("Emergency exit failed", {
              positionId: state.positionId,
              error: error.message,
            });
          }
        }
      }

      const duration = Date.now() - startTime;
      logger.debug("Position rug check completed", {
        positionId: state.positionId,
        durationMs: duration,
        detectionsCount: detections.length,
      });

      return Ok(undefined);
    } catch (error) {
      recordRugDetectionCheck("error");
      logger.error("Error monitoring position", {
        positionId: state.positionId,
        error: String(error),
      });

      return Err({
        type: "DATA_FETCH_FAILED",
        dataType: "holders",
        reason: String(error),
        message: `Failed to monitor position: ${String(error)}`,
      });
    }
  }

  // ==========================================================================
  // Data Fetching Methods
  // ==========================================================================

  /**
   * Fetch baseline snapshots for a token
   * Optimized to fetch token supply only once
   */
  private async fetchBaselineSnapshots(tokenMint: TokenMint): Promise<
    Result<
      {
        authority: AuthorityState;
        liquidity: LiquiditySnapshot;
        supply: SupplySnapshot;
        topHolders: TopHolder[];
      },
      RugMonitorError
    >
  > {
    try {
      // Fetch supply once and reuse across all methods
      const supplyDataResult = await this.fetchTokenSupplyData(tokenMint);
      if (!supplyDataResult.success) {
        return Err(
          (supplyDataResult as Extract<typeof supplyDataResult, { success: false }>).error
        );
      }

      const supplyData = supplyDataResult.value;

      // Fetch all other data in parallel, passing supply data to avoid duplicate calls
      const [authorityResult, liquidityResult, holdersResult] =
        await Promise.all([
          this.fetchAuthorityState(tokenMint),
          this.fetchLiquiditySnapshot(tokenMint, supplyData),
          this.fetchTopHolders(tokenMint, this.config.topHoldersCount, supplyData),
        ]);

      if (!authorityResult.success) {
        return Err(
          (
            authorityResult as Extract<
              typeof authorityResult,
              { success: false }
            >
          ).error
        );
      }
      if (!liquidityResult.success) {
        return Err(
          (
            liquidityResult as Extract<
              typeof liquidityResult,
              { success: false }
            >
          ).error
        );
      }
      if (!holdersResult.success) {
        return Err(
          (holdersResult as Extract<typeof holdersResult, { success: false }>)
            .error
        );
      }

      // Create supply snapshot from the shared supply data
      const supplySnapshot: SupplySnapshot = {
        totalSupply: asSupplyAmount(BigInt(supplyData.amount)),
        circulatingSupply: asSupplyAmount(BigInt(supplyData.amount)), // Simplified
        timestamp: new Date(),
      };

      return Ok({
        authority: authorityResult.value,
        liquidity: liquidityResult.value,
        supply: supplySnapshot,
        topHolders: holdersResult.value,
      });
    } catch (error) {
      return Err({
        type: "DATA_FETCH_FAILED",
        dataType: "holders",
        reason: String(error),
        message: `Failed to fetch baseline data: ${String(error)}`,
      });
    }
  }

  /**
   * Fetch token supply data (shared helper to avoid duplicate RPC calls)
   *
   * This method fetches token supply once and can be reused by:
   * - fetchLiquiditySnapshot (uses supply for estimation)
   * - fetchTopHolders (uses supply for percentage calculation)
   * - Supply snapshot creation (direct usage)
   *
   * Reduces RPC calls from 3 to 1 per position check (67% reduction)
   */
  private async fetchTokenSupplyData(
    tokenMint: TokenMint
  ): Promise<Result<{ amount: string; decimals: number; uiAmount: number | null }, RugMonitorError>> {
    try {
      const connection = await this.solanaService.getConnection();
      const mintPubkey = new PublicKey(tokenMint);

      // Retry RPC call (max 3 attempts)
      const supplyResult = await retryWithBackoff(
        () => connection.getTokenSupply(mintPubkey),
        {
          ...RETRY_CONFIG_RPC,
          operationName: "rug_monitor_get_token_supply",
        }
      );

      if (!supplyResult.success) {
        const err = supplyResult.error;
        throw err.originalError;
      }

      const supply = supplyResult.value.value;

      return Ok({
        amount: supply.value.amount,
        decimals: supply.value.decimals,
        uiAmount: supply.value.uiAmount,
      });
    } catch (error) {
      return Err({
        type: "DATA_FETCH_FAILED",
        dataType: "supply",
        reason: String(error),
        message: `Failed to fetch token supply: ${String(error)}`,
      });
    }
  }

  /**
   * Fetch authority state (mint/freeze authority)
   */
  private async fetchAuthorityState(
    tokenMint: TokenMint
  ): Promise<Result<AuthorityState, RugMonitorError>> {
    try {
      const connection = await this.solanaService.getConnection();
      const mintPubkey = new PublicKey(tokenMint);

      // Retry RPC call (max 3 attempts)
      const mintInfoResult = await retryWithBackoff(
        () => connection.getParsedAccountInfo(mintPubkey),
        {
          ...RETRY_CONFIG_RPC,
          operationName: "rug_monitor_get_parsed_account_info",
        }
      );

      if (!mintInfoResult.success) {
        const err = mintInfoResult.error;
        throw err.originalError;
      }

      const mintInfo = mintInfoResult.value.value;

      if (!mintInfo.value || !("parsed" in mintInfo.value.data)) {
        return Err({
          type: "DATA_FETCH_FAILED",
          dataType: "authority",
          reason: "Invalid mint account data",
          message: `Failed to fetch authority state for ${tokenMint}`,
        });
      }

      const parsed = mintInfo.value.data.parsed;
      const info = parsed.info;

      return Ok({
        mintAuthority: info.mintAuthority || null,
        freezeAuthority: info.freezeAuthority || null,
        checkedAt: new Date(),
      });
    } catch (error) {
      return Err({
        type: "DATA_FETCH_FAILED",
        dataType: "authority",
        reason: String(error),
        message: `Failed to fetch authority state: ${String(error)}`,
      });
    }
  }

  /**
   * Fetch liquidity snapshot from main pool
   *
   * NOTE: This is a simplified implementation for MVP.
   * Full implementation requires pool address tracking in SniperPosition schema.
   * For now, returns mock data based on token supply.
   *
   * @param supplyData - Pre-fetched supply data (optional, avoids duplicate RPC call)
   */
  private async fetchLiquiditySnapshot(
    tokenMint: TokenMint,
    supplyData?: { amount: string; decimals: number; uiAmount: number | null }
  ): Promise<Result<LiquiditySnapshot, RugMonitorError>> {
    try {
      let supplyAmount: bigint;

      if (supplyData) {
        // Use pre-fetched supply data (optimization)
        supplyAmount = BigInt(supplyData.amount);
      } else {
        // Fallback: fetch supply if not provided (for backward compatibility)
        const connection = await this.solanaService.getConnection();

        // Retry RPC call (max 3 attempts)
        const supplyResult = await retryWithBackoff(
          () => connection.getTokenSupply(new PublicKey(tokenMint)),
          {
            ...RETRY_CONFIG_RPC,
            operationName: "rug_monitor_get_token_supply_fallback",
          }
        );

        if (!supplyResult.success) {
          const err = supplyResult.error;
          throw err.originalError;
        }

        supplyAmount = BigInt(supplyResult.value.value.value.amount);
      }

      // Estimate liquidity based on supply (simplified)
      // Real implementation needs actual pool data
      const estimatedSolReserve = supplyAmount / 1000n; // Rough estimate
      const tokenReserve = asLiquidityAmount(supplyAmount / 2n);
      const solReserve = asLiquidityAmount(estimatedSolReserve);
      const totalValue = asLamports(estimatedSolReserve * 2n);

      return Ok({
        poolAddress: "unknown", // Will be added when poolAddress is in schema
        tokenReserve,
        solReserve,
        totalValueLamports: totalValue,
        timestamp: new Date(),
      });
    } catch (error) {
      return Err({
        type: "DATA_FETCH_FAILED",
        dataType: "liquidity",
        reason: String(error),
        message: `Failed to fetch liquidity snapshot: ${String(error)}`,
      });
    }
  }

  /**
   * Fetch top token holders
   *
   * @param supplyData - Pre-fetched supply data (optional, avoids duplicate RPC call)
   */
  private async fetchTopHolders(
    tokenMint: TokenMint,
    count: number,
    supplyData?: { amount: string; decimals: number; uiAmount: number | null }
  ): Promise<Result<TopHolder[], RugMonitorError>> {
    try {
      const connection = await this.solanaService.getConnection();
      const mintPubkey = new PublicKey(tokenMint);

      // Get largest token accounts with retry (max 3 attempts)
      const largestAccountsResult = await retryWithBackoff(
        () => connection.getTokenLargestAccounts(mintPubkey),
        {
          ...RETRY_CONFIG_RPC,
          operationName: "rug_monitor_get_token_largest_accounts",
        }
      );

      if (!largestAccountsResult.success) {
        const err = largestAccountsResult.error;
        throw err.originalError;
      }

      const largestAccounts = largestAccountsResult.value.value;

      let totalSupply: SupplyAmount;

      if (supplyData) {
        // Use pre-fetched supply data (optimization)
        totalSupply = asSupplyAmount(BigInt(supplyData.amount));
      } else {
        // Fallback: fetch supply if not provided (for backward compatibility)

        // Retry RPC call (max 3 attempts)
        const supplyResult = await retryWithBackoff(
          () => connection.getTokenSupply(mintPubkey),
          {
            ...RETRY_CONFIG_RPC,
            operationName: "rug_monitor_get_token_supply_for_holders",
          }
        );

        if (!supplyResult.success) {
          const err = supplyResult.error;
          throw err.originalError;
        }

        totalSupply = asSupplyAmount(BigInt(supplyResult.value.value.value.amount));
      }

      const holders: TopHolder[] = largestAccounts.value
        .slice(0, count)
        .map((account) => {
          const balance = asSupplyAmount(BigInt(account.amount));
          const percentage = calculateHolderPercentage(balance, totalSupply);

          return {
            address: account.address.toBase58(),
            balance,
            percentageOfSupply: percentage,
          };
        });

      return Ok(holders);
    } catch (error) {
      return Err({
        type: "DATA_FETCH_FAILED",
        dataType: "holders",
        reason: String(error),
        message: `Failed to fetch top holders: ${String(error)}`,
      });
    }
  }

  // ==========================================================================
  // Rug Detection Logic
  // ==========================================================================

  /**
   * Check for liquidity removal (>50% drop)
   */
  private checkLiquidityRemoval(
    baseline: LiquiditySnapshot,
    current: LiquiditySnapshot
  ): RugDetection | null {
    const change = calculateLiquidityChange(baseline, current);

    if (change <= this.config.liquidityDropThreshold) {
      const removedValue = asLamports(
        baseline.totalValueLamports - current.totalValueLamports
      );

      const evidence: RugEvidence = {
        type: "LIQUIDITY_REMOVAL",
        previousSnapshot: baseline,
        currentSnapshot: current,
        dropPercentage: change,
        removedValueLamports: removedValue,
      };

      return createRugDetection("LIQUIDITY_REMOVAL", evidence);
    }

    return null;
  }

  /**
   * Check for authority re-enablement
   */
  private checkAuthorityChanges(
    baseline: AuthorityState,
    current: AuthorityState
  ): RugDetection | null {
    const changedAuthorities: Array<"mint" | "freeze"> = [];

    // Check if mint authority was null and is now set
    if (!baseline.mintAuthority && current.mintAuthority) {
      changedAuthorities.push("mint");
    }

    // Check if freeze authority was null and is now set
    if (!baseline.freezeAuthority && current.freezeAuthority) {
      changedAuthorities.push("freeze");
    }

    if (changedAuthorities.length > 0) {
      const evidence: RugEvidence = {
        type: "AUTHORITY_REENABLED",
        previousState: baseline,
        currentState: current,
        changedAuthorities,
        reenabledBy: "unknown", // Would need transaction history to determine
      };

      return createRugDetection("AUTHORITY_REENABLED", evidence);
    }

    return null;
  }

  /**
   * Check for supply manipulation (unexpected minting)
   */
  private checkSupplyManipulation(
    baseline: SupplySnapshot,
    current: SupplySnapshot
  ): RugDetection | null {
    const change = calculateSupplyChange(baseline, current);

    if (change >= this.config.supplyIncreaseThreshold) {
      const increase = asSupplyAmount(
        current.totalSupply - baseline.totalSupply
      );

      const evidence: RugEvidence = {
        type: "SUPPLY_MANIPULATION",
        previousSnapshot: baseline,
        currentSnapshot: current,
        supplyIncrease: increase,
        increasePercentage: change,
        mintedBy: "unknown", // Would need transaction history
      };

      return createRugDetection("SUPPLY_MANIPULATION", evidence);
    }

    return null;
  }

  /**
   * Check for top holder dumps (>30% wallet sells)
   */
  private checkHolderDumps(
    baseline: TopHolder[],
    current: TopHolder[]
  ): RugDetection | null {
    // Match holders by address
    for (const baselineHolder of baseline) {
      const currentHolder = current.find(
        (h) => h.address === baselineHolder.address
      );

      if (!currentHolder) {
        // Holder completely exited (100% dump)
        const activity: HolderActivity = {
          holder: baselineHolder,
          previousBalance: baselineHolder.balance,
          currentBalance: asSupplyAmount(0n),
          changePercentage: asChangePercentage(-100),
          timestamp: new Date(),
        };

        const evidence: RugEvidence = {
          type: "HOLDER_DUMP",
          holder: baselineHolder,
          activity,
          soldAmount: baselineHolder.balance,
          sellPercentage: asChangePercentage(-100),
          affectedMarketPct: baselineHolder.percentageOfSupply,
        };

        return createRugDetection("HOLDER_DUMP", evidence);
      }

      // Check for significant balance reduction
      const change = calculateHolderChange(
        baselineHolder.balance,
        currentHolder.balance
      );

      if (change <= this.config.holderDumpThreshold) {
        const soldAmount = asSupplyAmount(
          baselineHolder.balance - currentHolder.balance
        );

        const activity: HolderActivity = {
          holder: baselineHolder,
          previousBalance: baselineHolder.balance,
          currentBalance: currentHolder.balance,
          changePercentage: change,
          timestamp: new Date(),
        };

        const evidence: RugEvidence = {
          type: "HOLDER_DUMP",
          holder: baselineHolder,
          activity,
          soldAmount,
          sellPercentage: change,
          affectedMarketPct: baselineHolder.percentageOfSupply,
        };

        return createRugDetection("HOLDER_DUMP", evidence);
      }
    }

    return null;
  }

  // ==========================================================================
  // Emergency Exit
  // ==========================================================================

  /**
   * Execute emergency exit for a position
   */
  private async executeEmergencyExit(
    request: EmergencyExitRequest
  ): Promise<Result<EmergencyExitResult, RugMonitorError>> {
    const startTime = Date.now();

    recordEmergencyExitTriggered(request.reason.rugType);

    logger.warn("Executing emergency exit", {
      positionId: request.positionId,
      tokenMint: request.tokenMint,
      rugType: request.reason.rugType,
      severity: request.reason.severity,
      forceExit: request.forceExit,
    });

    try {
      // Get position data
      const position = await prisma.sniperPosition.findUnique({
        where: { id: request.positionId },
      });

      if (!position) {
        return Err({
          type: "POSITION_NOT_FOUND",
          positionId: request.positionId,
          message: `Position ${request.positionId} not found`,
        });
      }

      // Get user keypair
      const keypair = await this.getKeypair(request.userId);
      if (!keypair) {
        return Err({
          type: "EMERGENCY_EXIT_FAILED",
          positionId: request.positionId,
          reason: "User keypair not available",
          attempts: 0,
          message: "Failed to get user keypair for emergency exit",
        });
      }

      // Prepare exit parameters with aggressive settings
      const exitParams: ExecuteExitParams = {
        positionId: request.positionId,
        tokenMint: request.tokenMint,
        tokenAmount: position.currentBalance as unknown as Lamports, // Current token balance
        trigger: {
          type: "MANUAL",
          reason: `Emergency exit: ${request.reason.rugType}`,
          requestedBy: request.userId,
        },
        keypair,
        slippageBps: this.config.emergencyExitSlippage * 100, // Convert % to bps
        priorityFee: "ULTRA", // Maximum priority
        useJito: true, // Use Jito for MEV protection
        jitoExecutionMode: "MEV_TURBO", // Fast execution
      };

      // Execute exit with retries
      let lastError: RugMonitorError | null = null;

      for (
        let attempt = 1;
        attempt <= this.config.emergencyExitRetries;
        attempt++
      ) {
        logger.info("Emergency exit attempt", {
          positionId: request.positionId,
          attempt,
          maxAttempts: this.config.emergencyExitRetries,
        });

        const exitResult = await this.exitExecutor.executeExit(exitParams);

        if (exitResult.success) {
          const exit = exitResult.value;
          const duration = Date.now() - startTime;

          recordEmergencyExitDuration(duration);

          // Calculate percentage of value saved
          const amountIn = BigInt(position.amountIn.toString());
          const savedPercentage =
            amountIn > 0n ? Number((exit.amountOut * 100n) / amountIn) : 0;

          recordPositionSavedPercentage(savedPercentage);

          const result: EmergencyExitResult = {
            positionId: request.positionId,
            tokenMint: request.tokenMint,
            exitedAt: new Date(),
            rugDetection: request.reason,
            exitDetails: {
              amountIn: amountIn as unknown as Lamports,
              amountOut: exit.amountOut,
              pnlLamports: exit.realizedPnlLamports,
              pnlPercentage: exit.pnlPercentage,
              executionTimeMs: duration,
              transactionSignature: exit.signature,
              slippageUsed: this.config.emergencyExitSlippage,
            },
          };

          logger.info("Emergency exit successful", {
            positionId: request.positionId,
            pnlPercentage: exit.pnlPercentage,
            savedPercentage,
            executionTimeMs: duration,
            signature: exit.signature,
          });

          return Ok(result);
        }

        // Exit failed, prepare for retry
        const error = (
          exitResult as Extract<typeof exitResult, { success: false }>
        ).error;
        const errorMessage = "message" in error ? error.message : error.reason;

        logger.error("Emergency exit attempt failed", {
          positionId: request.positionId,
          attempt,
          error: errorMessage,
        });

        lastError = {
          type: "EMERGENCY_EXIT_FAILED",
          positionId: request.positionId,
          reason: errorMessage,
          attempts: attempt,
          message: `Emergency exit failed after ${attempt} attempts: ${errorMessage}`,
        };

        // Wait before retry (exponential backoff)
        if (attempt < this.config.emergencyExitRetries) {
          const delay =
            this.config.emergencyExitRetryDelayMs * Math.pow(2, attempt - 1);
          await sleep(delay);
        }
      }

      // All retries exhausted
      return Err(
        lastError || {
          type: "EMERGENCY_EXIT_FAILED",
          positionId: request.positionId,
          reason: "All retry attempts exhausted",
          attempts: this.config.emergencyExitRetries,
          message: "Emergency exit failed after all retry attempts",
        }
      );
    } catch (error) {
      return Err({
        type: "EMERGENCY_EXIT_FAILED",
        positionId: request.positionId,
        reason: String(error),
        attempts: 0,
        message: `Emergency exit error: ${String(error)}`,
      });
    }
  }

  // ==========================================================================
  // Circuit Breaker
  // ==========================================================================

  /**
   * Update circuit breaker state based on check results
   */
  private updateCircuitState(success: boolean, failureCount: number): void {
    if (success) {
      if (this.circuitState.status === "HALF_OPEN") {
        this.circuitState.successCount++;

        if (this.circuitState.successCount >= HALF_OPEN_SUCCESS_THRESHOLD) {
          logger.info("Circuit breaker closing after successful checks");
          this.circuitState.status = "CLOSED";
          this.circuitState.failureCount = 0;
          this.circuitState.successCount = 0;
        }
      } else if (this.circuitState.status === "CLOSED") {
        // Reset failure count on success
        this.circuitState.failureCount = Math.max(
          0,
          this.circuitState.failureCount - 1
        );
      }
    } else {
      // Record failure
      this.circuitState.failureCount += failureCount;
      this.circuitState.lastFailureTime = Date.now();

      if (
        this.circuitState.status === "CLOSED" &&
        this.circuitState.failureCount >= CIRCUIT_THRESHOLD
      ) {
        logger.error("Circuit breaker opening due to repeated failures", {
          failureCount: this.circuitState.failureCount,
          threshold: CIRCUIT_THRESHOLD,
        });
        this.circuitState.status = "OPEN";
      } else if (this.circuitState.status === "HALF_OPEN") {
        logger.warn("Circuit breaker reopening after failure in HALF_OPEN");
        this.circuitState.status = "OPEN";
        this.circuitState.successCount = 0;
      }
    }
  }
}
