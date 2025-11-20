/**
 * Pool Monitoring Initialization & Global Instance
 *
 * Supports two modes:
 * 1. Geyser gRPC (<50ms latency, requires paid subscription)
 * 2. WebSocket RPC (200-500ms latency, works with any RPC)
 *
 * Mode Selection (via POOL_SOURCE env variable):
 * - POOL_SOURCE=geyser (default for production)
 * - POOL_SOURCE=rpc (for testing or when Geyser unavailable)
 */

import type { Connection } from "@solana/web3.js";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { logger } from "../../utils/logger.js";
import { GeyserSource, type GeyserConfig } from "./GeyserSource.js";
import { SourceManager } from "./SourceManager.js";
import type { RawPoolDetection } from "./sources/BaseSource.js";
import {
  RAYDIUM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
} from "../../config/programs.js";

// ============================================================================
// Global Instance
// ============================================================================

type PoolMonitoringSource = GeyserSource | SourceManager;

let poolSourceInstance: PoolMonitoringSource | null = null;
let poolSourceMode: "geyser" | "rpc" | null = null;
let isMonitoring = false;

// ============================================================================
// Initialization
// ============================================================================

export function initializeSourceManager(connection: Connection): void {
  if (poolSourceInstance) {
    logger.warn("Pool monitoring already initialized");
    return;
  }

  logger.info("Initializing pool monitoring...");

  // Determine mode from env variable (default: geyser)
  const poolSource = (process.env.POOL_SOURCE || "geyser").toLowerCase();

  logger.info("POOL_SOURCE value from env", {
    raw: process.env.POOL_SOURCE,
    normalized: poolSource
  });

  if (poolSource === "geyser") {
    initializeGeyserMode(connection);
  } else if (poolSource === "rpc") {
    initializeRpcMode(connection);
  } else {
    logger.warn(`Unknown POOL_SOURCE value: ${poolSource}, defaulting to RPC mode`);
    initializeRpcMode(connection);
  }
}

/**
 * Initialize Geyser gRPC mode
 */
function initializeGeyserMode(connection: Connection): void {
  // Check if Geyser is enabled
  const geyserEnabled = process.env.GEYSER_ENABLED === "true";

  if (!geyserEnabled) {
    logger.info(
      "Geyser source DISABLED - auto-sniper will not detect new pools automatically"
    );
    logger.info(
      "To enable pool detection, set GEYSER_ENABLED=true and configure GEYSER_ENDPOINT + GEYSER_TOKEN"
    );
    logger.info(
      "Or set POOL_SOURCE=rpc to use WebSocket RPC sources instead"
    );
    return;
  }

  // Validate Geyser configuration
  const geyserEndpoint = process.env.GEYSER_ENDPOINT;
  const geyserToken = process.env.GEYSER_TOKEN;

  if (!geyserEndpoint || !geyserToken) {
    logger.warn(
      "GEYSER_ENABLED=true but GEYSER_ENDPOINT or GEYSER_TOKEN not set - auto-sniper disabled"
    );
    logger.info("Please configure GEYSER_ENDPOINT and GEYSER_TOKEN environment variables");
    logger.info("Or set POOL_SOURCE=rpc to use WebSocket RPC sources instead");
    return;
  }

  // Configure Geyser
  // Monitor Raydium V4 AMM and CLMM
  const programIds = [
    RAYDIUM_V4_PROGRAM,   // Raydium AMM V4
    RAYDIUM_CLMM_PROGRAM, // Raydium CLMM (concentrated liquidity)
  ];

  const geyserConfig: GeyserConfig = {
    endpoint: geyserEndpoint,
    token: geyserToken,
    programIds,
    commitment: CommitmentLevel.PROCESSED, // Chainstack requires PROCESSED for real-time tx streaming
    ...(process.env.GEYSER_FROM_SLOT && {
      fromSlot: parseInt(process.env.GEYSER_FROM_SLOT, 10),
    }),
  };

  // Initialize Geyser source
  poolSourceInstance = new GeyserSource(geyserConfig, connection);
  poolSourceMode = "geyser";

  logger.info("Pool monitoring initialized (Geyser gRPC)", {
    mode: "geyser",
    endpoint: geyserEndpoint.substring(0, 20) + "...",
    programCount: programIds.length,
    commitment: "PROCESSED", // Real-time transaction stream
  });
}

/**
 * Initialize WebSocket RPC mode
 */
function initializeRpcMode(connection: Connection): void {
  logger.info("Initializing WebSocket RPC pool monitoring...");

  // Initialize SourceManager with all DEX sources enabled
  poolSourceInstance = new SourceManager(connection, {
    enableRaydiumV4: true,
    enableRaydiumCLMM: true,
    enableOrcaWhirlpool: true,
    enableMeteora: true,
    enablePumpFun: true,
    duplicateWindowMs: 5000,
    filterUnsafeMeteora: true,
    typicalSnipeAmountSol: 5,
  });
  poolSourceMode = "rpc";

  logger.info("Pool monitoring initialized (WebSocket RPC)", {
    mode: "rpc",
    sources: [
      "Raydium V4",
      "Raydium CLMM",
      "Orca Whirlpool",
      "Meteora DLMM",
      "Pump.fun",
    ],
    duplicateWindowMs: 5000,
  });
}

// ============================================================================
// Getters
// ============================================================================

export function getSourceManager(): PoolMonitoringSource {
  if (!poolSourceInstance) {
    throw new Error("Pool monitoring not initialized. Configure POOL_SOURCE env variable.");
  }
  return poolSourceInstance;
}

export function getPoolSourceMode(): "geyser" | "rpc" | null {
  return poolSourceMode;
}

export function isSourceManagerInitialized(): boolean {
  return poolSourceInstance !== null;
}

export function isPoolMonitoringActive(): boolean {
  return isMonitoring;
}

// ============================================================================
// Start/Stop Monitoring
// ============================================================================

/**
 * Start pool monitoring with callback for new detections
 */
export async function startPoolMonitoring(
  onDetection: (detection: RawPoolDetection) => void | Promise<void>
): Promise<void> {
  if (!poolSourceInstance) {
    logger.warn("Pool monitoring not available - not initialized");
    return;
  }

  if (isMonitoring) {
    logger.warn("Pool monitoring already active");
    return;
  }

  logger.info("Starting pool monitoring...", { mode: poolSourceMode });

  // Handle both Geyser and RPC modes
  if (poolSourceMode === "geyser") {
    // GeyserSource: returns Result<void, string>
    const geyserSource = poolSourceInstance as GeyserSource;

    const result = await geyserSource.start((detection) => {
      // Wrap in Promise to handle both sync and async callbacks
      Promise.resolve(onDetection(detection)).catch((error) => {
        logger.error("Error handling pool detection", {
          error: error instanceof Error ? error.message : String(error),
          tokenMintA: detection.tokenMintA,
          source: detection.source,
        });
      });
    });

    if (!result.success) {
      logger.error("Failed to start pool monitoring", { error: result.error });
      throw new Error(`Failed to start pool monitoring: ${result.error}`);
    }
  } else {
    // SourceManager (RPC mode): returns Promise<string[]> (source names)
    const sourceManager = poolSourceInstance as SourceManager;

    const startedSources = await sourceManager.start((scoredDetection) => {
      // Convert ScoredPoolDetection to RawPoolDetection
      // (just pass through - RawPoolDetection is a subset of ScoredPoolDetection)
      const rawDetection: RawPoolDetection = scoredDetection;

      // Wrap in Promise to handle both sync and async callbacks
      Promise.resolve(onDetection(rawDetection)).catch((error) => {
        logger.error("Error handling pool detection", {
          error: error instanceof Error ? error.message : String(error),
          tokenMintA: rawDetection.tokenMintA,
          source: rawDetection.source,
          priorityScore: scoredDetection.priorityScore,
        });
      });
    });

    logger.info("RPC sources started", {
      sources: startedSources,
      count: startedSources.length,
    });
  }

  isMonitoring = true;

  logger.info("Pool monitoring started", {
    mode: poolSourceMode,
  });
}

/**
 * Stop pool monitoring
 */
export async function stopPoolMonitoring(): Promise<void> {
  if (!poolSourceInstance) {
    logger.warn("Pool monitoring not available");
    return;
  }

  if (!isMonitoring) {
    logger.warn("Pool monitoring not active");
    return;
  }

  logger.info("Stopping pool monitoring...", { mode: poolSourceMode });

  await poolSourceInstance.stop();
  isMonitoring = false;

  logger.info("Pool monitoring stopped", { mode: poolSourceMode });
}

// ============================================================================
// Shutdown
// ============================================================================

export async function shutdownSourceManager(): Promise<void> {
  if (!poolSourceInstance) {
    return;
  }

  logger.info("Shutting down pool monitoring...", { mode: poolSourceMode });

  if (isMonitoring) {
    await stopPoolMonitoring();
  }

  poolSourceInstance = null;
  poolSourceMode = null;
  isMonitoring = false;

  logger.info("Pool monitoring shut down");
}
