/**
 * Position Monitor Service
 * Tracks open positions and executes exit strategies (TP/SL/Trailing)
 *
 * Features:
 * - Real-time price monitoring with configurable intervals
 * - Take-profit trigger evaluation
 * - Stop-loss trigger evaluation
 * - Trailing stop-loss with dynamic updates
 * - Automatic exit execution via ExitExecutor
 * - Database state management
 * - Comprehensive metrics tracking
 * - Circuit breaker for reliability
 */

import type { Keypair } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import {
  recordPositionMonitorStarted,
  recordPositionMonitorStopped,
  recordTrailingStopUpdate,
} from "../../utils/metrics.js";
import type { Result, Lamports } from "../../types/common.js";
import { Ok, Err, asTokenMint } from "../../types/common.js";
import type {
  PositionMonitorState,
  MonitorStatus,
  MonitorConfig,
  MonitorError,
  ExitTrigger,
  TokenPrice,
  Percentage,
  StartMonitorOptions,
} from "../../types/positionMonitor.js";
import {
  asTokenPrice,
  asPercentage,
  calculateTakeProfitPrice,
  calculateStopLossPrice,
  calculateTrailingStopPrice,
  calculatePriceChangePct,
} from "../../types/positionMonitor.js";
import type { PriceFeedService } from "./priceFeed.js";
import type { ExitExecutor, ExecuteExitParams } from "./exitExecutor.js";
import {
  registerInterval,
  clearRegisteredInterval,
} from "../../utils/intervals.js";

// ============================================================================
// Constants
// ============================================================================

const MONITOR_INTERVAL_NAME = "position-monitor";
const DEFAULT_CHECK_INTERVAL_MS = 5000; // 5 seconds
const MAX_STALE_PRICE_AGE_MS = 30_000; // 30 seconds - max age for stale price

// ============================================================================
// Position Monitor Class
// ============================================================================

export class PositionMonitor {
  private activeMonitors: Map<string, PositionMonitorState> = new Map();
  private isRunning: boolean = false;
  private monitorIntervalHandle: NodeJS.Timeout | null = null;
  private config: MonitorConfig;

  constructor(
    private priceFeedService: PriceFeedService,
    private exitExecutor: ExitExecutor,
    private getKeypair: (userId: string) => Promise<Keypair | null>,
    config: Partial<MonitorConfig> = {}
  ) {
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      priceCacheTtl: config.priceCacheTtl ?? 60_000,
      maxConcurrentChecks: config.maxConcurrentChecks ?? 10,
      maxExitAttempts: config.maxExitAttempts ?? 3,
      exitSlippageBps: config.exitSlippageBps ?? 100,
      exitPriorityFee: config.exitPriorityFee ?? "MEDIUM",
      useJitoForExits: config.useJitoForExits ?? false,
      jitoExecutionMode: config.jitoExecutionMode ?? "MEV_TURBO",
      enableCircuitBreaker: config.enableCircuitBreaker ?? true,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
      circuitBreakerTimeoutMs: config.circuitBreakerTimeoutMs ?? 60_000,
    };

    logger.info("PositionMonitor initialized", {
      checkIntervalMs: this.config.checkIntervalMs,
      maxConcurrentChecks: this.config.maxConcurrentChecks,
    });
  }

  // ==========================================================================
  // Public API - Lifecycle
  // ==========================================================================

  /**
   * Start global monitoring loop
   * Checks all active positions at configured interval
   */
  startGlobalMonitoring(): void {
    if (this.isRunning) {
      logger.warn("Position monitoring already running");
      return;
    }

    this.isRunning = true;

    this.monitorIntervalHandle = registerInterval(
      async () => {
        await this.checkAllPositions();
      },
      this.config.checkIntervalMs,
      MONITOR_INTERVAL_NAME
    );

    logger.info("Global position monitoring started", {
      intervalMs: this.config.checkIntervalMs,
    });
  }

  /**
   * Stop global monitoring loop
   */
  stopGlobalMonitoring(): void {
    if (!this.isRunning) {
      logger.warn("Position monitoring not running");
      return;
    }

    this.isRunning = false;

    if (this.monitorIntervalHandle) {
      clearRegisteredInterval(this.monitorIntervalHandle);
      this.monitorIntervalHandle = null;
    }

    logger.info("Global position monitoring stopped");
  }

  /**
   * Check if global monitoring is running
   */
  isMonitoring(): boolean {
    return this.isRunning;
  }

  // ==========================================================================
  // Public API - Position Management
  // ==========================================================================

  /**
   * Start monitoring a specific position
   */
  async startMonitoring(
    positionId: string,
    options: StartMonitorOptions = {}
  ): Promise<Result<void, MonitorError>> {
    try {
      // Check if already monitoring
      if (this.activeMonitors.has(positionId)) {
        return Err({
          type: "ALREADY_MONITORING",
          positionId,
          message: `Position ${positionId} is already being monitored`,
        });
      }

      // Load position data from database
      const loadResult = await this.loadPositionMonitor(positionId);
      if (!loadResult.success) {
        return Err(
          (loadResult as Extract<typeof loadResult, { success: false }>).error
        );
      }

      const monitor = loadResult.value;

      // Add to active monitors
      this.activeMonitors.set(positionId, monitor);
      recordPositionMonitorStarted();

      logger.info("Started monitoring position", {
        positionId,
        tokenMint: monitor.tokenMint,
        entryPrice: monitor.entryPrice,
        takeProfitPrice: monitor.takeProfitPrice,
        stopLossPrice: monitor.stopLossPrice,
        trailingStopLoss: monitor.trailingStopLoss,
      });

      // Perform initial price check if requested
      if (options.forceRefresh) {
        await this.checkPosition(monitor);
      }

      return Ok(undefined);
    } catch (error) {
      return Err({
        type: "UNKNOWN",
        message: `Failed to start monitoring: ${error instanceof Error ? error.message : String(error)}`,
        originalError: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Stop monitoring a specific position
   */
  async stopMonitoring(
    positionId: string
  ): Promise<Result<void, MonitorError>> {
    try {
      const monitor = this.activeMonitors.get(positionId);
      if (!monitor) {
        return Err({
          type: "POSITION_NOT_FOUND",
          positionId,
          message: `Position ${positionId} is not being monitored`,
        });
      }

      // Remove from active monitors
      this.activeMonitors.delete(positionId);
      recordPositionMonitorStopped();

      // Update status in database
      await prisma.positionMonitor.update({
        where: { positionId },
        data: {
          status: "COMPLETED",
          updatedAt: new Date(),
        },
      });

      logger.info("Stopped monitoring position", {
        positionId,
        priceCheckCount: monitor.priceCheckCount,
      });

      return Ok(undefined);
    } catch (error) {
      return Err({
        type: "UNKNOWN",
        message: `Failed to stop monitoring: ${error instanceof Error ? error.message : String(error)}`,
        originalError: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Get current state of monitored position
   */
  getMonitorState(positionId: string): PositionMonitorState | null {
    return this.activeMonitors.get(positionId) ?? null;
  }

  /**
   * Get all active monitors
   */
  getAllActiveMonitors(): PositionMonitorState[] {
    return Array.from(this.activeMonitors.values());
  }

  // ==========================================================================
  // Private Methods - Position Checking
  // ==========================================================================

  /**
   * Check all active positions
   * Called by global monitoring loop
   */
  private async checkAllPositions(): Promise<void> {
    const monitors = Array.from(this.activeMonitors.values());

    if (monitors.length === 0) {
      return;
    }

    logger.debug("Checking all positions", { count: monitors.length });

    // Process in batches to respect maxConcurrentChecks
    const batchSize = this.config.maxConcurrentChecks;
    for (let i = 0; i < monitors.length; i += batchSize) {
      const batch = monitors.slice(i, i + batchSize);
      await Promise.all(batch.map((monitor) => this.checkPosition(monitor)));
    }
  }

  /**
   * Check single position
   * Fetches price, evaluates triggers, executes exit if needed
   */
  private async checkPosition(
    monitor: PositionMonitorState
  ): Promise<Result<void, MonitorError>> {
    try {
      // Skip if status is not ACTIVE
      if (monitor.status !== "ACTIVE") {
        logger.debug("Skipping non-active monitor", {
          positionId: monitor.positionId,
          status: monitor.status,
        });
        return Ok(undefined);
      }

      // Fetch current price
      const priceResult = await this.priceFeedService.getPrice(
        monitor.tokenMint
      );

      if (!priceResult.success) {
        logger.warn("Failed to fetch price for position", {
          positionId: monitor.positionId,
          tokenMint: monitor.tokenMint,
          error: (priceResult as Extract<typeof priceResult, { success: false }>)
            .error,
        });

        // Use stale price if available (graceful degradation)
        if (monitor.currentPrice) {
          // Check stale price age (SECURITY: prevent using very old prices)
          const priceAge = monitor.lastPriceUpdate
            ? Date.now() - monitor.lastPriceUpdate.getTime()
            : Infinity;

          if (priceAge > MAX_STALE_PRICE_AGE_MS) {
            // Price is too stale (>30 seconds), pause monitoring
            monitor.status = "PAUSED";
            logger.error("Price too stale, pausing monitoring", {
              positionId: monitor.positionId,
              priceAgeMs: priceAge,
              maxAgeMs: MAX_STALE_PRICE_AGE_MS,
              lastPriceUpdate: monitor.lastPriceUpdate?.toISOString(),
            });

            // Persist paused state to database
            await this.persistMonitorState(monitor);

            return Ok(undefined);
          }

          logger.info("Using stale price within acceptable age", {
            positionId: monitor.positionId,
            stalePrice: monitor.currentPrice,
            priceAgeMs: priceAge,
            maxAgeMs: MAX_STALE_PRICE_AGE_MS,
          });
        } else {
          // No price available, skip this check
          return Ok(undefined);
        }
      }

      const priceUpdate = priceResult.success ? priceResult.value : null;
      const currentPrice = priceUpdate?.price ?? monitor.currentPrice;

      if (!currentPrice) {
        return Ok(undefined);
      }

      // Update monitor state with new price
      monitor.currentPrice = currentPrice;
      monitor.lastPriceUpdate = new Date();
      monitor.priceCheckCount++;
      monitor.lastCheckAt = new Date();

      // Update trailing stop if enabled
      if (monitor.trailingStopLoss && monitor.highestPriceSeen) {
        if (currentPrice > monitor.highestPriceSeen) {
          monitor.highestPriceSeen = currentPrice;
          recordTrailingStopUpdate();

          logger.info("Updated trailing stop highest price", {
            positionId: monitor.positionId,
            highestPrice: currentPrice,
          });
        }
      } else if (monitor.trailingStopLoss && !monitor.highestPriceSeen) {
        // Initialize highest price
        monitor.highestPriceSeen = currentPrice;
      }

      // Persist state to database
      await this.persistMonitorState(monitor);

      // Evaluate exit triggers
      const trigger = this.evaluateExitTrigger(monitor, currentPrice);

      if (trigger) {
        logger.info("Exit trigger activated", {
          positionId: monitor.positionId,
          trigger: trigger.type,
          currentPrice,
        });

        // Mark as EXITING to prevent duplicate exit attempts
        monitor.status = "EXITING";
        await this.persistMonitorState(monitor);

        // Execute exit
        await this.executePositionExit(monitor, trigger);
      }

      return Ok(undefined);
    } catch (error) {
      logger.error("Error checking position", {
        positionId: monitor.positionId,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err({
        type: "UNKNOWN",
        message: `Position check failed: ${error instanceof Error ? error.message : String(error)}`,
        originalError: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Evaluate if any exit trigger conditions are met
   * Returns trigger if condition met, null otherwise
   */
  private evaluateExitTrigger(
    monitor: PositionMonitorState,
    currentPrice: TokenPrice
  ): ExitTrigger | null {
    // 1. Check take-profit
    if (monitor.takeProfitPrice && currentPrice >= monitor.takeProfitPrice) {
      const targetPct = calculatePriceChangePct(
        monitor.entryPrice,
        monitor.takeProfitPrice
      ) as Percentage;

      return {
        type: "TAKE_PROFIT",
        triggerPrice: monitor.takeProfitPrice,
        currentPrice,
        targetPct: asPercentage(targetPct),
      };
    }

    // 2. Check trailing stop-loss
    if (
      monitor.trailingStopLoss &&
      monitor.highestPriceSeen &&
      monitor.stopLossPrice
    ) {
      // Recalculate trailing stop from highest price
      const trailingStopPrice = calculateTrailingStopPrice(
        monitor.highestPriceSeen,
        asPercentage(
          calculatePriceChangePct(monitor.entryPrice, monitor.stopLossPrice)
        )
      );

      if (currentPrice <= trailingStopPrice) {
        const trailingPct = calculatePriceChangePct(
          monitor.highestPriceSeen,
          trailingStopPrice
        ) as Percentage;

        return {
          type: "TRAILING_STOP",
          triggerPrice: trailingStopPrice,
          currentPrice,
          highestPrice: monitor.highestPriceSeen,
          trailingPct: asPercentage(Math.abs(trailingPct)),
        };
      }
    }

    // 3. Check regular stop-loss
    if (monitor.stopLossPrice && currentPrice <= monitor.stopLossPrice) {
      const targetPct = calculatePriceChangePct(
        monitor.entryPrice,
        monitor.stopLossPrice
      ) as Percentage;

      return {
        type: "STOP_LOSS",
        triggerPrice: monitor.stopLossPrice,
        currentPrice,
        targetPct: asPercentage(Math.abs(targetPct)),
      };
    }

    // No trigger conditions met
    return null;
  }

  /**
   * Execute position exit via ExitExecutor
   */
  private async executePositionExit(
    monitor: PositionMonitorState,
    trigger: ExitTrigger
  ): Promise<void> {
    try {
      // Get user keypair
      const keypair = await this.getKeypair(monitor.userId);
      if (!keypair) {
        logger.error("Failed to get keypair for position exit", {
          positionId: monitor.positionId,
          userId: monitor.userId,
        });

        // Mark monitor as FAILED
        monitor.status = "FAILED";
        await this.persistMonitorState(monitor);
        this.activeMonitors.delete(monitor.positionId);
        recordPositionMonitorStopped();

        return;
      }

      // Get position balance from database
      const position = await prisma.sniperPosition.findUnique({
        where: { id: monitor.positionId },
        select: { currentBalance: true },
      });

      if (!position) {
        logger.error("Position not found for exit", {
          positionId: monitor.positionId,
        });
        return;
      }

      const exitParams: ExecuteExitParams = {
        positionId: monitor.positionId,
        tokenMint: monitor.tokenMint,
        tokenAmount: BigInt(position.currentBalance.toString()) as Lamports,
        trigger,
        keypair,
        slippageBps: this.config.exitSlippageBps,
        useJito: this.config.useJitoForExits,
        jitoExecutionMode: this.config.jitoExecutionMode,
      };

      // Execute exit
      const exitResult = await this.exitExecutor.executeExit(exitParams);

      if (exitResult.success) {
        logger.info("Position exit completed successfully", {
          positionId: monitor.positionId,
          signature: exitResult.value.signature,
          pnlPercentage: exitResult.value.pnlPercentage,
        });

        // Remove from active monitors
        this.activeMonitors.delete(monitor.positionId);
        recordPositionMonitorStopped();
      } else {
        logger.error("Position exit failed", {
          positionId: monitor.positionId,
          error: (exitResult as Extract<typeof exitResult, { success: false }>)
            .error,
        });

        // ExitExecutor already marked monitor as FAILED
        this.activeMonitors.delete(monitor.positionId);
        recordPositionMonitorStopped();
      }
    } catch (error) {
      logger.error("Error executing position exit", {
        positionId: monitor.positionId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Mark monitor as FAILED
      monitor.status = "FAILED";
      await this.persistMonitorState(monitor);
      this.activeMonitors.delete(monitor.positionId);
      recordPositionMonitorStopped();
    }
  }

  // ==========================================================================
  // Private Methods - Database Operations
  // ==========================================================================

  /**
   * Load position monitor from database
   */
  private async loadPositionMonitor(
    positionId: string
  ): Promise<Result<PositionMonitorState, MonitorError>> {
    try {
      // Try to find existing monitor
      let monitor = await prisma.positionMonitor.findUnique({
        where: { positionId },
      });

      if (!monitor) {
        // Create new monitor from position
        const position = await prisma.sniperPosition.findUnique({
          where: { id: positionId },
          select: {
            userId: true,
            tokenMint: true,
            amountIn: true,
            amountOut: true,
            takeProfitPct: true,
            stopLossPct: true,
            trailingStopLoss: true,
            status: true,
          },
        });

        if (!position) {
          return Err({
            type: "POSITION_NOT_FOUND",
            positionId,
            message: `Position ${positionId} not found`,
          });
        }

        if (position.status !== "OPEN") {
          return Err({
            type: "INVALID_CONFIGURATION",
            field: "status",
            value: position.status,
            reason: "Position is not OPEN",
          });
        }

        // Calculate entry price (SOL per token)
        const entryPrice = asTokenPrice(
          Number(position.amountIn) / Number(position.amountOut)
        );

        // Calculate trigger prices
        const takeProfitPrice = position.takeProfitPct
          ? calculateTakeProfitPrice(
              entryPrice,
              asPercentage(Number(position.takeProfitPct))
            )
          : null;

        const stopLossPrice = position.stopLossPct
          ? calculateStopLossPrice(
              entryPrice,
              asPercentage(Number(position.stopLossPct))
            )
          : null;

        // Create monitor in database
        monitor = await prisma.positionMonitor.create({
          data: {
            positionId,
            tokenMint: position.tokenMint,
            userId: position.userId,
            entryPrice: entryPrice.toString(),
            takeProfitPrice: takeProfitPrice?.toString() ?? null,
            stopLossPrice: stopLossPrice?.toString() ?? null,
            trailingStopLoss: position.trailingStopLoss,
            status: "ACTIVE",
          },
        });
      }

      // Convert to PositionMonitorState
      const state: PositionMonitorState = {
        id: monitor.id,
        positionId: monitor.positionId,
        tokenMint: asTokenMint(monitor.tokenMint),
        userId: monitor.userId,
        entryPrice: asTokenPrice(Number(monitor.entryPrice)),
        currentPrice: monitor.currentPrice
          ? asTokenPrice(Number(monitor.currentPrice))
          : null,
        lastPriceUpdate: monitor.lastPriceUpdate,
        takeProfitPrice: monitor.takeProfitPrice
          ? asTokenPrice(Number(monitor.takeProfitPrice))
          : null,
        stopLossPrice: monitor.stopLossPrice
          ? asTokenPrice(Number(monitor.stopLossPrice))
          : null,
        trailingStopLoss: monitor.trailingStopLoss,
        highestPriceSeen: monitor.highestPriceSeen
          ? asTokenPrice(Number(monitor.highestPriceSeen))
          : null,
        priceCheckCount: monitor.priceCheckCount,
        exitAttempts: monitor.exitAttempts,
        lastCheckAt: monitor.lastCheckAt,
        status: monitor.status as MonitorStatus,
        createdAt: monitor.createdAt,
        updatedAt: monitor.updatedAt,
      };

      return Ok(state);
    } catch (error) {
      return Err({
        type: "DATABASE_ERROR",
        operation: "loadPositionMonitor",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist monitor state to database
   */
  private async persistMonitorState(
    monitor: PositionMonitorState
  ): Promise<void> {
    try {
      await prisma.positionMonitor.update({
        where: { positionId: monitor.positionId },
        data: {
          currentPrice: monitor.currentPrice?.toString() ?? null,
          lastPriceUpdate: monitor.lastPriceUpdate,
          highestPriceSeen: monitor.highestPriceSeen?.toString() ?? null,
          priceCheckCount: monitor.priceCheckCount,
          lastCheckAt: monitor.lastCheckAt,
          status: monitor.status,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error("Failed to persist monitor state", {
        positionId: monitor.positionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let positionMonitorInstance: PositionMonitor | null = null;

/**
 * Get singleton PositionMonitor instance
 */
export function getPositionMonitor(
  priceFeedService: PriceFeedService,
  exitExecutor: ExitExecutor,
  getKeypair: (userId: string) => Promise<Keypair | null>,
  config?: Partial<MonitorConfig>
): PositionMonitor {
  if (!positionMonitorInstance) {
    positionMonitorInstance = new PositionMonitor(
      priceFeedService,
      exitExecutor,
      getKeypair,
      config
    );
  }
  return positionMonitorInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetPositionMonitor(): void {
  if (positionMonitorInstance) {
    positionMonitorInstance.stopGlobalMonitoring();
  }
  positionMonitorInstance = null;
}
