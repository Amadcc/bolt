/**
 * Exit Executor Service
 * Executes position exits (sell orders) for take-profit and stop-loss triggers
 *
 * Features:
 * - Jupiter v6 integration for swaps
 * - Optional Jito MEV protection
 * - P&L calculation
 * - Position status updates
 * - Retry logic with exponential backoff
 * - Comprehensive metrics
 */

import type { Keypair } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import {
  recordExitTriggered,
  recordExitDuration,
  recordPositionPnl,
} from "../../utils/metrics.js";
import type { Result, TokenMint, Lamports } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import type {
  ExitTrigger,
  ExitResult,
  TokenPrice,
  MonitorError,
  MonitorConfig,
} from "../../types/positionMonitor.js";
import {
  calculatePnlLamports,
  calculatePnlPercentage,
} from "../../types/positionMonitor.js";
import type { JupiterService } from "./jupiter.js";
import type { JitoService } from "./jito.js";
import { sleep } from "../../utils/helpers.js";
import { getAlertService } from "../monitoring/alerts.js";

// ============================================================================
// Constants
// ============================================================================

const SOL_MINT = "So11111111111111111111111111111111111111112" as TokenMint; // Native SOL mint
const BASE_RETRY_DELAY_MS = 1000; // 1 second

// ============================================================================
// Exit Execution Parameters
// ============================================================================

export interface ExecuteExitParams {
  positionId: string;
  tokenMint: TokenMint;
  tokenAmount: Lamports; // Amount of tokens to sell
  trigger: ExitTrigger;
  keypair: Keypair;
  slippageBps?: number;
  priorityFee?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "TURBO" | "ULTRA";
  useJito?: boolean;
  jitoExecutionMode?: "MEV_TURBO" | "MEV_SECURE";
}

// ============================================================================
// Exit Executor Class
// ============================================================================

export class ExitExecutor {
  constructor(
    private jupiterService: JupiterService,
    _jitoService: JitoService | null,
    private config: MonitorConfig
  ) {
    logger.info("ExitExecutor initialized", {
      maxAttempts: config.maxExitAttempts,
      defaultSlippage: config.exitSlippageBps,
      defaultPriorityFee: config.exitPriorityFee,
      useJito: config.useJitoForExits,
      jitoMode: config.jitoExecutionMode,
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Execute position exit with retries
   */
  async executeExit(
    params: ExecuteExitParams
  ): Promise<Result<ExitResult, MonitorError>> {
    const startTime = Date.now();

    // Get position data first
    const positionResult = await this.getPositionData(params.positionId);
    if (!positionResult.success) {
      return Err(
        (positionResult as Extract<typeof positionResult, { success: false }>)
          .error
      );
    }

    const position = positionResult.value;

    // Record trigger metric
    this.recordTriggerMetric(params.trigger);

    // Attempt exit with retries
    let lastError: MonitorError | null = null;
    const maxAttempts = this.config.maxExitAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info("Attempting position exit", {
        positionId: params.positionId,
        attempt,
        maxAttempts,
        trigger: params.trigger.type,
      });

      const result = await this.attemptExit(params, position, attempt);

      if (result.success) {
        // Exit successful
        const exitResult = result.value;
        const executionTimeMs = Date.now() - startTime;

        // Update position in database
        await this.updatePositionAfterExit(
          params.positionId,
          exitResult,
          params.trigger
        );

        // Record metrics
        recordExitDuration(executionTimeMs);
        recordPositionPnl(exitResult.pnlPercentage);

        logger.info("Position exit completed successfully", {
          positionId: params.positionId,
          signature: exitResult.signature,
          pnlPercentage: exitResult.pnlPercentage,
          executionTimeMs,
        });

        // SPRINT 4: Alert on significant P&L (>20% profit or any loss >10%)
        const pnlThreshold = exitResult.pnlPercentage > 0 ? 20 : -10;
        if (Math.abs(exitResult.pnlPercentage) >= Math.abs(pnlThreshold)) {
          const alertService = getAlertService();
          const pnlSol = Number(exitResult.realizedPnlLamports) / 1e9;
          await alertService.alertLargePnL(
            params.positionId,
            exitResult.pnlPercentage,
            pnlSol
          );
        }

        return Ok(exitResult);
      }

      // Exit failed - TypeScript doesn't narrow after if (success) return
      lastError = (result as Extract<typeof result, { success: false }>).error;

      logger.warn("Exit attempt failed", {
        positionId: params.positionId,
        attempt,
        maxAttempts,
        error: lastError,
      });

      // Update exit attempts in monitor table
      await this.incrementExitAttempts(params.positionId);

      // Wait before retry (exponential backoff)
      if (attempt < maxAttempts) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.info("Waiting before retry", { delay, attempt });
        await sleep(delay);
      }
    }

    // All attempts exhausted
    const error: MonitorError = {
      type: "EXIT_FAILED",
      positionId: params.positionId,
      reason: "All exit attempts exhausted",
      attempts: maxAttempts,
      maxAttempts,
      lastError: lastError
        ? JSON.stringify(lastError)
        : "Unknown error",
    };

    // Mark position monitor as FAILED
    await this.markMonitorFailed(params.positionId, error);

    return Err(error);
  }

  // ==========================================================================
  // Private Methods - Exit Execution
  // ==========================================================================

  /**
   * Single exit attempt
   */
  private async attemptExit(
    params: ExecuteExitParams,
    position: PositionData,
    attempt: number
  ): Promise<Result<ExitResult, MonitorError>> {
    try {
      // Get slippage settings
      const slippageBps =
        params.slippageBps ?? this.config.exitSlippageBps;
      const useJito =
        params.useJito ?? this.config.useJitoForExits;

      logger.debug("Exit parameters", {
        positionId: params.positionId,
        tokenMint: params.tokenMint,
        tokenAmount: params.tokenAmount.toString(),
        slippageBps,
        useJito,
      });

      // SPRINT 4: Simulate swap before execution to prevent losses
      logger.info("Simulating exit swap before execution", {
        positionId: params.positionId,
        tokenMint: params.tokenMint,
        amount: params.tokenAmount.toString(),
      });

      const simulationResult = await this.jupiterService.simulateSwap(
        {
          inputMint: params.tokenMint,
          outputMint: SOL_MINT,
          amount: params.tokenAmount.toString(),
          slippageBps,
          userPublicKey: params.keypair.publicKey.toBase58(),
        },
        params.keypair
      );

      if (!simulationResult.success) {
        const simError = (simulationResult as Extract<typeof simulationResult, { success: false }>).error;

        logger.error("Exit simulation failed - aborting swap", {
          positionId: params.positionId,
          error: simError,
        });

        // SPRINT 4: Alert on simulation failure
        const alertService = getAlertService();
        await alertService.alertSimulationFailed(
          params.positionId,
          params.tokenMint,
          "message" in simError ? simError.message : "Unknown error"
        );

        return Err({
          type: "EXIT_FAILED",
          positionId: params.positionId,
          reason: `Simulation failed: ${"message" in simError ? simError.message : "Unknown error"}`,
          attempts: attempt,
          maxAttempts: this.config.maxExitAttempts,
          lastError: JSON.stringify(simError),
        });
      }

      const simulation = simulationResult.value;

      // Check if expected output is acceptable (basic sanity check)
      const expectedOutputLamports = BigInt(simulation.expectedOutputAmount);
      const minimumAcceptableLamports = position.amountIn / BigInt(10); // At least 10% of initial investment

      if (expectedOutputLamports < minimumAcceptableLamports) {
        logger.warn("Simulation shows unacceptable output - aborting swap", {
          positionId: params.positionId,
          expectedOutput: expectedOutputLamports.toString(),
          minimumAcceptable: minimumAcceptableLamports.toString(),
          priceImpact: simulation.priceImpactPct,
        });

        return Err({
          type: "EXIT_FAILED",
          positionId: params.positionId,
          reason: `Simulation output too low: expected ${expectedOutputLamports}, minimum ${minimumAcceptableLamports}`,
          attempts: attempt,
          maxAttempts: this.config.maxExitAttempts,
          lastError: "SIMULATION_OUTPUT_TOO_LOW",
        });
      }

      logger.info("Simulation successful - proceeding with swap", {
        positionId: params.positionId,
        expectedOutput: simulation.expectedOutputAmount,
        priceImpact: simulation.priceImpactPct,
      });

      const swapStartTime = Date.now();

      // Execute Jupiter swap (token → SOL)
      const swapResult = await this.jupiterService.swap(
        {
          inputMint: params.tokenMint,
          outputMint: SOL_MINT,
          amount: params.tokenAmount.toString(),
          slippageBps,
          userPublicKey: params.keypair.publicKey.toBase58(),
        },
        params.keypair
      );

      if (!swapResult.success) {
        const swapError = (
          swapResult as Extract<typeof swapResult, { success: false }>
        ).error;

        // Extract error message from discriminated union
        const errorMessage =
          "message" in swapError
            ? swapError.message
            : "reason" in swapError
            ? swapError.reason
            : "Unknown error";

        return Err({
          type: "EXIT_FAILED",
          positionId: params.positionId,
          reason: `Jupiter swap failed: ${errorMessage}`,
          attempts: attempt,
          maxAttempts: this.config.maxExitAttempts,
          lastError: JSON.stringify(swapError),
        });
      }

      const swap = swapResult.value;
      const swapDuration = Date.now() - swapStartTime;

      // Calculate P&L
      const amountOut = BigInt(swap.outputAmount) as Lamports;
      const pnlLamports = calculatePnlLamports(position.amountIn, amountOut);
      const pnlPercentage = calculatePnlPercentage(
        position.amountIn,
        amountOut
      );

      // Calculate exit price (SOL per token)
      const exitPrice = (
        Number(amountOut) / Number(params.tokenAmount)
      ) as TokenPrice;

      const exitResult: ExitResult = {
        positionId: params.positionId,
        signature: swap.signature,
        trigger: params.trigger,
        entryPrice: position.entryPrice,
        exitPrice,
        amountIn: position.amountIn,
        amountOut,
        realizedPnlLamports: pnlLamports,
        pnlPercentage,
        executionTimeMs: swapDuration,
        exitedAt: new Date(),
      };

      return Ok(exitResult);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      return Err({
        type: "EXIT_FAILED",
        positionId: params.positionId,
        reason: `Exit execution error: ${errorMsg}`,
        attempts: attempt,
        maxAttempts: this.config.maxExitAttempts,
        lastError: errorMsg,
      });
    }
  }

  // ==========================================================================
  // Private Methods - Database Operations
  // ==========================================================================

  /**
   * Get position data from database
   */
  private async getPositionData(
    positionId: string
  ): Promise<Result<PositionData, MonitorError>> {
    try {
      const position = await prisma.sniperPosition.findUnique({
        where: { id: positionId },
        select: {
          id: true,
          userId: true,
          tokenMint: true,
          amountIn: true,
          amountOut: true,
          currentBalance: true,
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
          type: "EXIT_FAILED",
          positionId,
          reason: `Position is not OPEN (status: ${position.status})`,
          attempts: 0,
          maxAttempts: 0,
        });
      }

      // Calculate entry price (SOL per token)
      const entryPrice = (
        Number(position.amountIn) / Number(position.amountOut)
      ) as TokenPrice;

      const positionData: PositionData = {
        id: position.id,
        userId: position.userId,
        tokenMint: position.tokenMint as TokenMint,
        amountIn: BigInt(position.amountIn.toString()) as Lamports,
        currentBalance: BigInt(position.currentBalance.toString()) as Lamports,
        entryPrice,
      };

      return Ok(positionData);
    } catch (error) {
      return Err({
        type: "DATABASE_ERROR",
        operation: "getPositionData",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update position after successful exit
   */
  private async updatePositionAfterExit(
    positionId: string,
    exitResult: ExitResult,
    trigger: ExitTrigger
  ): Promise<void> {
    try {
      // Determine position status based on trigger
      let status: string;
      if (trigger.type === "TAKE_PROFIT") {
        status = "CLOSED_PROFIT";
      } else if (
        trigger.type === "STOP_LOSS" ||
        trigger.type === "TRAILING_STOP"
      ) {
        status = exitResult.pnlPercentage >= 0
          ? "CLOSED_PROFIT"
          : "CLOSED_LOSS";
      } else {
        // MANUAL
        status = "CLOSED_MANUAL";
      }

      // Update SniperPosition
      await prisma.sniperPosition.update({
        where: { id: positionId },
        data: {
          status,
          exitSignature: exitResult.signature,
          realizedPnlLamports: exitResult.realizedPnlLamports.toString(),
          closedAt: exitResult.exitedAt,
        },
      });

      // Update PositionMonitor status to COMPLETED
      await prisma.positionMonitor.update({
        where: { positionId },
        data: {
          status: "COMPLETED",
          updatedAt: new Date(),
        },
      });

      logger.info("Position updated after exit", {
        positionId,
        status,
        pnlPercentage: exitResult.pnlPercentage,
      });
    } catch (error) {
      logger.error("Failed to update position after exit", {
        positionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Increment exit attempts counter in monitor table
   */
  private async incrementExitAttempts(positionId: string): Promise<void> {
    try {
      await prisma.positionMonitor.update({
        where: { positionId },
        data: {
          exitAttempts: { increment: 1 },
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error("Failed to increment exit attempts", {
        positionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Mark position monitor as FAILED
   */
  private async markMonitorFailed(
    positionId: string,
    error: MonitorError
  ): Promise<void> {
    try {
      await prisma.positionMonitor.update({
        where: { positionId },
        data: {
          status: "FAILED",
          updatedAt: new Date(),
        },
      });

      logger.error("Position monitor marked as FAILED", {
        positionId,
        error,
      });
    } catch (dbError) {
      logger.error("Failed to mark monitor as FAILED", {
        positionId,
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
    }
  }

  // ==========================================================================
  // Private Methods - Metrics
  // ==========================================================================

  /**
   * Record exit trigger metric
   */
  private recordTriggerMetric(trigger: ExitTrigger): void {
    switch (trigger.type) {
      case "TAKE_PROFIT":
        recordExitTriggered("take_profit");
        break;
      case "STOP_LOSS":
        recordExitTriggered("stop_loss");
        break;
      case "TRAILING_STOP":
        recordExitTriggered("trailing_stop");
        break;
      case "MANUAL":
        recordExitTriggered("manual");
        break;
    }
  }
}

// ============================================================================
// Helper Types
// ============================================================================

interface PositionData {
  id: string;
  userId: string;
  tokenMint: TokenMint;
  amountIn: Lamports;
  currentBalance: Lamports;
  entryPrice: TokenPrice;
}

// ============================================================================
// Singleton Management
// ============================================================================

let exitExecutorInstance: ExitExecutor | null = null;

/**
 * Get singleton ExitExecutor instance
 */
export function getExitExecutor(
  jupiterService: JupiterService,
  jitoService: JitoService | null,
  config: MonitorConfig
): ExitExecutor {
  if (!exitExecutorInstance) {
    exitExecutorInstance = new ExitExecutor(
      jupiterService,
      jitoService,
      config
    );
  }
  return exitExecutorInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetExitExecutor(): void {
  exitExecutorInstance = null;
}
