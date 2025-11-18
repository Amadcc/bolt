/**
 * Position Monitor Initialization Service
 * Initializes and coordinates all position monitoring components
 *
 * This service:
 * - Initializes PriceFeedService, ExitExecutor, and PositionMonitor
 * - Loads existing open positions and starts monitoring
 * - Provides access to monitoring services
 * - Handles graceful shutdown
 */

import type { Keypair } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import type { MonitorConfig } from "../../types/positionMonitor.js";
import { PriceFeedService, getPriceFeedService } from "./priceFeed.js";
import { ExitExecutor, getExitExecutor } from "./exitExecutor.js";
import { PositionMonitor, getPositionMonitor } from "./positionMonitor.js";
import type { JupiterService } from "./jupiter.js";
import { getJitoService } from "./jito.js";

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  checkIntervalMs: parseInt(
    process.env.POSITION_CHECK_INTERVAL_MS || "5000",
    10
  ),
  priceCacheTtl: parseInt(
    process.env.POSITION_PRICE_CACHE_TTL_MS || "60000",
    10
  ),
  maxConcurrentChecks: parseInt(
    process.env.POSITION_MAX_CONCURRENT_CHECKS || "10",
    10
  ),
  maxExitAttempts: parseInt(process.env.POSITION_MAX_EXIT_ATTEMPTS || "3", 10),
  exitSlippageBps: parseInt(process.env.POSITION_EXIT_SLIPPAGE_BPS || "100", 10),
  exitPriorityFee: (process.env.POSITION_EXIT_PRIORITY_FEE ||
    "MEDIUM") as MonitorConfig["exitPriorityFee"],
  useJitoForExits: process.env.POSITION_USE_JITO_EXITS === "true",
  jitoExecutionMode: (process.env.POSITION_JITO_EXECUTION_MODE ||
    "MEV_TURBO") as MonitorConfig["jitoExecutionMode"],
  enableCircuitBreaker:
    process.env.POSITION_CIRCUIT_BREAKER_ENABLED !== "false",
  circuitBreakerThreshold: parseInt(
    process.env.POSITION_CIRCUIT_BREAKER_THRESHOLD || "5",
    10
  ),
  circuitBreakerTimeoutMs: parseInt(
    process.env.POSITION_CIRCUIT_BREAKER_TIMEOUT_MS || "60000",
    10
  ),
};

// ============================================================================
// Initialization State
// ============================================================================

interface InitializationState {
  priceFeedService: PriceFeedService | null;
  exitExecutor: ExitExecutor | null;
  positionMonitor: PositionMonitor | null;
  isInitialized: boolean;
}

const state: InitializationState = {
  priceFeedService: null,
  exitExecutor: null,
  positionMonitor: null,
  isInitialized: false,
};

// ============================================================================
// Initialization Function
// ============================================================================

/**
 * Initialize position monitoring system
 * Call this once at application startup
 */
export async function initializePositionMonitor(
  jupiterService: JupiterService,
  getKeypair: (userId: string) => Promise<Keypair | null>,
  config: Partial<MonitorConfig> = {}
): Promise<void> {
  if (state.isInitialized) {
    logger.warn("Position monitor already initialized");
    return;
  }

  try {
    logger.info("Initializing position monitoring system...");

    const mergedConfig = { ...DEFAULT_MONITOR_CONFIG, ...config };

    // 1. Initialize PriceFeedService
    state.priceFeedService = getPriceFeedService(mergedConfig.priceCacheTtl);
    logger.info("PriceFeedService initialized");

    // 2. Initialize JitoService (optional)
    const jitoService = mergedConfig.useJitoForExits
      ? getJitoService()
      : null;
    if (jitoService) {
      logger.info("JitoService loaded for exit protection");
    }

    // 3. Initialize ExitExecutor
    state.exitExecutor = getExitExecutor(
      jupiterService,
      jitoService,
      mergedConfig
    );
    logger.info("ExitExecutor initialized");

    // 4. Initialize PositionMonitor
    state.positionMonitor = getPositionMonitor(
      state.priceFeedService,
      state.exitExecutor,
      getKeypair,
      mergedConfig
    );
    logger.info("PositionMonitor initialized");

    // 5. Load and start monitoring existing open positions
    await loadExistingPositions();

    // 6. Start global monitoring loop
    state.positionMonitor.startGlobalMonitoring();
    logger.info("Global position monitoring started");

    state.isInitialized = true;

    logger.info("Position monitoring system initialized successfully", {
      config: mergedConfig,
    });
  } catch (error) {
    logger.error("Failed to initialize position monitoring system", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Load existing open positions and start monitoring
 */
async function loadExistingPositions(): Promise<void> {
  try {
    // Find all open positions
    const openPositions = await prisma.sniperPosition.findMany({
      where: {
        status: "OPEN",
        OR: [
          { takeProfitPct: { not: null } },
          { stopLossPct: { not: null } },
        ],
      },
      select: { id: true, tokenMint: true },
    });

    if (openPositions.length === 0) {
      logger.info("No existing open positions to monitor");
      return;
    }

    logger.info("Loading existing open positions", {
      count: openPositions.length,
    });

    // Start monitoring each position
    for (const position of openPositions) {
      const result = await state.positionMonitor!.startMonitoring(position.id);

      if (result.success) {
        logger.info("Started monitoring existing position", {
          positionId: position.id,
          tokenMint: position.tokenMint,
        });
      } else {
        logger.error("Failed to start monitoring existing position", {
          positionId: position.id,
          error: (result as Extract<typeof result, { success: false }>).error,
        });
      }
    }

    logger.info("Finished loading existing positions", {
      total: openPositions.length,
      active: state.positionMonitor!.getAllActiveMonitors().length,
    });
  } catch (error) {
    logger.error("Failed to load existing positions", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================================
// Service Access Functions
// ============================================================================

/**
 * Get PriceFeedService instance
 * @throws Error if not initialized
 */
export function getPriceFeed(): PriceFeedService {
  if (!state.priceFeedService) {
    throw new Error(
      "PriceFeedService not initialized. Call initializePositionMonitor() first."
    );
  }
  return state.priceFeedService;
}

/**
 * Get ExitExecutor instance
 * @throws Error if not initialized
 */
export function getExitExecutorInstance(): ExitExecutor {
  if (!state.exitExecutor) {
    throw new Error(
      "ExitExecutor not initialized. Call initializePositionMonitor() first."
    );
  }
  return state.exitExecutor;
}

/**
 * Get PositionMonitor instance
 * @throws Error if not initialized
 */
export function getPositionMonitorInstance(): PositionMonitor {
  if (!state.positionMonitor) {
    throw new Error(
      "PositionMonitor not initialized. Call initializePositionMonitor() first."
    );
  }
  return state.positionMonitor;
}

/**
 * Check if position monitoring is initialized
 */
export function isPositionMonitorInitialized(): boolean {
  return state.isInitialized;
}

// ============================================================================
// Helper Functions for Sniper Integration
// ============================================================================

/**
 * Start monitoring a position after sniper order execution
 * Call this after a sniper position is opened
 */
export async function startMonitoringPosition(
  positionId: string
): Promise<void> {
  if (!state.isInitialized || !state.positionMonitor) {
    logger.warn("Position monitoring not initialized, skipping", {
      positionId,
    });
    return;
  }

  const result = await state.positionMonitor.startMonitoring(positionId);

  if (result.success) {
    logger.info("Started monitoring new position", { positionId });
  } else {
    logger.error("Failed to start monitoring new position", {
      positionId,
      error: (result as Extract<typeof result, { success: false }>).error,
    });
  }
}

/**
 * Stop monitoring a position (manual close)
 * Call this when user manually closes a position
 */
export async function stopMonitoringPosition(
  positionId: string
): Promise<void> {
  if (!state.isInitialized || !state.positionMonitor) {
    logger.warn("Position monitoring not initialized, skipping", {
      positionId,
    });
    return;
  }

  const result = await state.positionMonitor.stopMonitoring(positionId);

  if (result.success) {
    logger.info("Stopped monitoring position", { positionId });
  } else {
    logger.error("Failed to stop monitoring position", {
      positionId,
      error: (result as Extract<typeof result, { success: false }>).error,
    });
  }
}

// ============================================================================
// Shutdown Function
// ============================================================================

/**
 * Gracefully shutdown position monitoring system
 * Call this on application shutdown
 */
export async function shutdownPositionMonitor(): Promise<void> {
  if (!state.isInitialized) {
    logger.warn("Position monitor not initialized, nothing to shutdown");
    return;
  }

  try {
    logger.info("Shutting down position monitoring system...");

    // Stop global monitoring
    if (state.positionMonitor) {
      state.positionMonitor.stopGlobalMonitoring();
      logger.info("Stopped global monitoring");
    }

    // Mark all active monitors as stopped in database
    const activeMonitors = state.positionMonitor?.getAllActiveMonitors() ?? [];
    if (activeMonitors.length > 0) {
      logger.info("Marking active monitors as stopped", {
        count: activeMonitors.length,
      });

      await prisma.positionMonitor.updateMany({
        where: {
          positionId: { in: activeMonitors.map((m) => m.positionId) },
          status: "ACTIVE",
        },
        data: {
          status: "COMPLETED",
          updatedAt: new Date(),
        },
      });
    }

    // Reset state
    state.priceFeedService = null;
    state.exitExecutor = null;
    state.positionMonitor = null;
    state.isInitialized = false;

    logger.info("Position monitoring system shutdown complete");
  } catch (error) {
    logger.error("Error during position monitor shutdown", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
