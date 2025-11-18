/**
 * Base Pool Source Abstract Class
 *
 * Defines interface for DEX-specific pool monitoring.
 * Each DEX (Raydium V4, CLMM, Orca, Meteora, Pump.fun) extends this.
 *
 * Key Responsibilities:
 * - Subscribe to program logs via WebSocket
 * - Parse pool initialization events
 * - Extract token mints and pool address
 * - Emit standardized pool detection events
 *
 * Performance: Target <100ms event parsing latency
 */

import { Connection, PublicKey, Logs, Context } from "@solana/web3.js";
import type { TokenMint, SolanaAddress } from "../../../types/common.js";
import type { PoolSource } from "../../../types/sniper.js";
import { logger } from "../../../utils/logger.js";
import { Result } from "../../../types/common.js";
import { createCircuitBreaker } from "../../shared/circuitBreaker.js";
import type { CircuitBreaker } from "../../shared/circuitBreaker.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Raw pool detection event (before metadata fetching)
 */
export interface RawPoolDetection {
  /** Pool address */
  poolAddress: SolanaAddress;

  /** Token mint A (base or quote, depends on DEX) */
  tokenMintA: TokenMint;

  /** Token mint B (base or quote, depends on DEX) */
  tokenMintB: TokenMint;

  /** DEX source */
  source: PoolSource;

  /** Transaction signature */
  signature: string;

  /** Slot number */
  slot: number;

  /** Block time (UNIX timestamp, nullable) */
  blockTime: number | null;

  /** Meteora anti-sniper config (if applicable) */
  meteoraAntiSniper?: import("../../../types/sniper.js").MeteoraAntiSniperConfig;
}

/**
 * Source health status
 */
export type SourceHealth =
  | { status: "healthy"; connectedAt: Date }
  | { status: "connecting"; attemptedAt: Date }
  | { status: "disconnected"; reason: string; disconnectedAt: Date }
  | { status: "failed"; error: string; failedAt: Date };

/**
 * Source metrics
 */
export interface SourceMetrics {
  /** Total detections */
  totalDetections: number;

  /** Average parsing latency (ms) */
  avgParsingLatencyMs: number;

  /** Connection uptime (%) */
  uptimePct: number;

  /** Last detection timestamp */
  lastDetectionAt: Date | null;
}

// ============================================================================
// Base Source Abstract Class
// ============================================================================

/**
 * Abstract base class for DEX-specific pool sources
 *
 * Subclasses must implement:
 * - `parsePoolInit()` - Extract pool data from transaction
 * - `isPoolInitLog()` - Check if log matches pool init pattern
 * - `programId` - DEX program ID to monitor
 */
export abstract class BasePoolSource {
  protected connection: Connection;
  protected rpcCircuitBreaker: CircuitBreaker;
  protected subscriptionId: number | null = null;
  protected health: SourceHealth = {
    status: "connecting",
    attemptedAt: new Date(),
  };
  protected metrics: SourceMetrics = {
    totalDetections: 0,
    avgParsingLatencyMs: 0,
    uptimePct: 0,
    lastDetectionAt: null,
  };

  constructor(connection: Connection, sourceName?: string) {
    this.connection = connection;
    // Create dedicated circuit breaker for this source's RPC calls
    this.rpcCircuitBreaker = createCircuitBreaker(
      `pool_source_rpc_${sourceName || "unknown"}`,
      {
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 60000,
        monitoringPeriod: 120000,
      }
    );
  }

  // ==========================================================================
  // Abstract Methods (must be implemented by subclasses)
  // ==========================================================================

  /**
   * DEX program ID to monitor
   */
  abstract get programId(): SolanaAddress;

  /**
   * Source name (e.g., "Raydium V4", "Orca Whirlpool")
   */
  abstract get sourceName(): string;

  /**
   * Pool source type identifier
   */
  abstract get sourceType(): PoolSource;

  /**
   * Parse pool initialization from transaction signature
   *
   * @param signature - Transaction signature
   * @returns Parsed pool data or error
   */
  abstract parsePoolInit(
    signature: string
  ): Promise<Result<RawPoolDetection, string>>;

  /**
   * Check if log line indicates pool initialization
   *
   * @param log - Log line from transaction
   * @returns True if log matches pool init pattern
   */
  abstract isPoolInitLog(log: string): boolean;

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Start monitoring program logs
   *
   * @param onDetection - Callback for new pool detections
   * @returns Subscription ID or error
   */
  async start(
    onDetection: (pool: RawPoolDetection) => void
  ): Promise<Result<number, string>> {
    try {
      logger.info(`Starting ${this.sourceName} monitoring`, {
        programId: this.programId,
      });

      // Subscribe to program logs
      const subscriptionId = this.connection.onLogs(
        new PublicKey(this.programId),
        (logs: Logs, ctx: Context) => {
          this.handleLogs(logs, ctx, onDetection).catch((error) => {
            logger.error(`${this.sourceName} log handling error`, {
              error: error instanceof Error ? error.message : String(error),
              signature: logs.signature,
            });
          });
        },
        "confirmed"
      );

      this.subscriptionId = subscriptionId;
      this.health = { status: "healthy", connectedAt: new Date() };

      logger.info(`${this.sourceName} monitoring started`, {
        subscriptionId,
      });

      return { success: true, value: subscriptionId };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.health = { status: "failed", error: errorMsg, failedAt: new Date() };

      logger.error(`${this.sourceName} start failed`, { error: errorMsg });
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Stop monitoring program logs
   */
  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
        this.subscriptionId = null;
        this.health = {
          status: "disconnected",
          reason: "Manual stop",
          disconnectedAt: new Date(),
        };

        logger.info(`${this.sourceName} monitoring stopped`);
      } catch (error) {
        logger.error(`${this.sourceName} stop failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Get current health status
   */
  getHealth(): SourceHealth {
    return this.health;
  }

  /**
   * Get current metrics
   */
  getMetrics(): SourceMetrics {
    return this.metrics;
  }

  // ==========================================================================
  // Protected Methods
  // ==========================================================================

  /**
   * Handle incoming program logs
   *
   * @param logs - Program logs
   * @param ctx - Context (slot, etc.)
   * @param onDetection - Callback for new pool detections
   */
  protected async handleLogs(
    logs: Logs,
    ctx: Context,
    onDetection: (pool: RawPoolDetection) => void
  ): Promise<void> {
    const startTime = Date.now();

    // Check if logs contain pool initialization
    const hasPoolInit = logs.logs.some((log) => this.isPoolInitLog(log));

    if (!hasPoolInit) {
      return;
    }

    logger.debug(`${this.sourceName} pool init detected`, {
      signature: logs.signature,
      slot: ctx.slot,
    });

    // Parse pool initialization
    const result = await this.parsePoolInit(logs.signature);

    if (!result.success) {
      logger.warn(`${this.sourceName} parse failed`, {
        signature: logs.signature,
        error: result.error,
      });
      return;
    }

    const pool = result.value;

    // Update metrics
    const parsingLatency = Date.now() - startTime;
    this.updateMetrics(parsingLatency);

    // Emit detection event
    onDetection(pool);

    logger.info(`${this.sourceName} pool detected`, {
      poolAddress: pool.poolAddress,
      tokenMintA: pool.tokenMintA,
      tokenMintB: pool.tokenMintB,
      signature: pool.signature,
      parsingLatencyMs: parsingLatency,
    });
  }

  /**
   * Update source metrics
   *
   * @param parsingLatency - Parsing latency (ms)
   */
  protected updateMetrics(parsingLatency: number): void {
    this.metrics.totalDetections += 1;
    this.metrics.lastDetectionAt = new Date();

    // Update avg parsing latency (exponential moving average)
    if (this.metrics.avgParsingLatencyMs === 0) {
      this.metrics.avgParsingLatencyMs = parsingLatency;
    } else {
      this.metrics.avgParsingLatencyMs =
        0.7 * this.metrics.avgParsingLatencyMs + 0.3 * parsingLatency;
    }
  }
}
