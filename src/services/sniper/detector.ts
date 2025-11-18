/**
 * Token Pool Detector - Real-Time WebSocket Monitoring
 *
 * Features:
 * - Multi-endpoint WebSocket connection pool (3+ RPC endpoints)
 * - Circuit breaker per endpoint (prevent cascade failures)
 * - Automatic reconnection with exponential backoff
 * - Health monitoring and failover
 * - Event parsing for new pool detection
 * - Redis pub/sub for broadcasting events
 * - Comprehensive metrics and logging
 *
 * Detection Flow:
 * 1. Subscribe to DEX program logs via onLogs (Raydium, Orca, etc.)
 * 2. Parse transaction logs for pool initialization events
 * 3. Extract token mints from account indices
 * 4. Fetch token metadata from Metaplex
 * 5. Broadcast event to Redis pub/sub
 * 6. Store detection in database
 *
 * @see SNIPER_TODO.md - Day 1: WebSocket Infrastructure
 */

import { Connection, PublicKey, type Logs, type Context } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { redis } from "../../utils/redis.js";
import { CircuitBreaker } from "../honeypot/circuitBreaker.js";
import {
  RAYDIUM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  METEORA_DLMM_PROGRAM,
  PUMP_FUN_PROGRAM,
} from "../../config/programs.js";
import type {
  DetectorConfig,
  DetectorState,
  TokenPoolDetection,
  PoolSource,
  WebSocketEndpoint,
} from "../../types/sniper.js";
import type {
  TokenMint,
  SolanaAddress,
  TransactionSignature,
} from "../../types/common.js";
import { asLamports, asTransactionSignature } from "../../types/common.js";
import {
  registerInterval,
  clearRegisteredInterval,
} from "../../utils/intervals.js";
import { PoolEventParser, determineBaseAndQuote } from "./eventParser.js";

// ============================================================================
// Types
// ============================================================================

/**
 * WebSocket connection state per endpoint
 */
interface WebSocketConnection {
  endpoint: WebSocketEndpoint;
  connection: Connection;
  circuitBreaker: CircuitBreaker;
  subscriptionId: number | null;
  isConnected: boolean;
  lastHeartbeat: number | null;
  reconnectAttempts: number;
  failureCount: number;
}

/**
 * Parsed pool initialization event
 */
interface PoolInitEvent {
  poolAddress: SolanaAddress;
  tokenMintA: TokenMint;
  tokenMintB: TokenMint;
  source: PoolSource;
  signature: TransactionSignature;
  slot: number;
  blockTime: number | null;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: DetectorConfig = {
  endpoints: [
    {
      url: process.env.HELIUS_WS_URL || "wss://mainnet.helius-rpc.com",
      name: "Helius",
      priority: 1,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
    },
    {
      url: process.env.QUICKNODE_WS_URL || "wss://api.mainnet-beta.solana.com",
      name: "Quicknode",
      priority: 2,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
    },
  ],
  programs: {
    raydiumV4: RAYDIUM_V4_PROGRAM,
    raydiumCLMM: RAYDIUM_CLMM_PROGRAM,
    orcaWhirlpool: ORCA_WHIRLPOOL_PROGRAM,
    meteora: METEORA_DLMM_PROGRAM,
    pumpFun: PUMP_FUN_PROGRAM,
  },
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 60000, // 60s
    monitoringPeriod: 120000, // 2min
  },
  healthCheckInterval: 30000, // 30s
  enableRedisPubSub: true,
  redisChannel: "sniper:pool:detection",
};

// ============================================================================
// Token Pool Detector Class
// ============================================================================

/**
 * Production-grade token pool detector with enterprise patterns
 *
 * Monitors multiple DEXs via WebSocket for new liquidity pool creation.
 * Features automatic failover, circuit breakers, and health monitoring.
 */
export class TokenPoolDetector {
  private config: DetectorConfig;
  private connections: Map<string, WebSocketConnection>;
  private state: DetectorState;
  private healthCheckTimer: NodeJS.Timeout | null;
  private isShuttingDown: boolean;
  private eventParser: PoolEventParser | null;

  // Metrics
  private totalDetections: number;
  private detectionsBySource: Map<PoolSource, number>;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.connections = new Map();
    this.state = { status: "initializing", startedAt: new Date() };
    this.healthCheckTimer = null;
    this.isShuttingDown = false;
    this.eventParser = null;

    // Initialize metrics
    this.totalDetections = 0;
    this.detectionsBySource = new Map();

    logger.info("TokenPoolDetector initialized", {
      endpoints: this.config.endpoints.map((e) => e.name),
      programs: Object.keys(this.config.programs),
      circuitBreaker: this.config.circuitBreaker,
    });
  }

  /**
   * Start detector - connect to all endpoints and subscribe
   */
  async start(): Promise<void> {
    logger.info("Starting TokenPoolDetector");

    this.state = { status: "initializing", startedAt: new Date() };

    // Initialize WebSocket connections for all endpoints
    const connectionPromises = this.config.endpoints.map((endpoint) =>
      this.initializeConnection(endpoint)
    );

    await Promise.allSettled(connectionPromises);

    // Check if at least one endpoint connected
    const connectedCount = Array.from(this.connections.values()).filter(
      (conn) => conn.isConnected
    ).length;

    if (connectedCount === 0) {
      logger.error("No WebSocket endpoints connected", {
        attempted: this.config.endpoints.length,
      });

      this.state = {
        status: "failed",
        error: "Failed to connect to any WebSocket endpoint",
        failedAt: new Date(),
      };

      throw new Error("Failed to connect to any WebSocket endpoint");
    }

    // Start health monitoring
    this.startHealthChecks();

    // Update state
    if (connectedCount < this.config.endpoints.length) {
      const failedEndpoints = this.config.endpoints
        .filter((e) => {
          const conn = this.connections.get(e.name);
          return !conn || !conn.isConnected;
        })
        .map((e) => e.name);

      this.state = {
        status: "degraded",
        connectedEndpoints: connectedCount,
        failedEndpoints,
      };

      logger.warn("Detector started in degraded mode", {
        connected: connectedCount,
        total: this.config.endpoints.length,
        failed: failedEndpoints,
      });
    } else {
      this.state = {
        status: "running",
        connectedEndpoints: connectedCount,
        startedAt: new Date(),
      };

      logger.info("Detector started successfully", {
        connectedEndpoints: connectedCount,
      });
    }
  }

  /**
   * Stop detector - close all connections gracefully
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn("Detector already shutting down");
      return;
    }

    this.isShuttingDown = true;
    logger.info("Stopping TokenPoolDetector");

    // Stop health checks
    if (this.healthCheckTimer) {
      clearRegisteredInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Close all WebSocket connections
    const closePromises = Array.from(this.connections.values()).map((conn) =>
      this.closeConnection(conn)
    );

    await Promise.allSettled(closePromises);

    this.connections.clear();

    this.state = {
      status: "stopped",
      reason: "Manual shutdown",
      stoppedAt: new Date(),
    };

    logger.info("Detector stopped successfully");
  }

  /**
   * Get current detector state
   */
  getState(): DetectorState {
    return this.state;
  }

  /**
   * Get detection metrics
   */
  getMetrics(): {
    totalDetections: number;
    detectionsBySource: Record<PoolSource, number>;
    connectedEndpoints: number;
    totalEndpoints: number;
  } {
    const connectedCount = Array.from(this.connections.values()).filter(
      (conn) => conn.isConnected
    ).length;

    return {
      totalDetections: this.totalDetections,
      detectionsBySource: Object.fromEntries(
        this.detectionsBySource
      ) as Record<PoolSource, number>,
      connectedEndpoints: connectedCount,
      totalEndpoints: this.config.endpoints.length,
    };
  }

  // ==========================================================================
  // Private Methods - Connection Management
  // ==========================================================================

  /**
   * Initialize WebSocket connection for an endpoint
   */
  private async initializeConnection(
    endpoint: WebSocketEndpoint
  ): Promise<void> {
    try {
      logger.info("Initializing WebSocket connection", {
        endpoint: endpoint.name,
        url: endpoint.url,
      });

      // Create Connection instance (uses WebSocket internally)
      const connection = new Connection(endpoint.url, {
        commitment: "confirmed",
        wsEndpoint: endpoint.url,
      });

      // Create circuit breaker for this endpoint
      const circuitBreaker = new CircuitBreaker(
        `detector-${endpoint.name}`,
        this.config.circuitBreaker
      );

      // Store connection
      const wsConnection: WebSocketConnection = {
        endpoint,
        connection,
        circuitBreaker,
        subscriptionId: null,
        isConnected: false,
        lastHeartbeat: null,
        reconnectAttempts: 0,
        failureCount: 0,
      };

      this.connections.set(endpoint.name, wsConnection);

      // Subscribe to program logs
      await this.subscribeToProgram(wsConnection);

      logger.info("WebSocket connection established", {
        endpoint: endpoint.name,
      });
    } catch (error) {
      logger.error("Failed to initialize WebSocket connection", {
        endpoint: endpoint.name,
        error: error instanceof Error ? error.message : String(error),
      });

      // Mark as failed but don't throw - other endpoints may succeed
    }
  }

  /**
   * Subscribe to DEX program logs
   */
  private async subscribeToProgram(
    wsConnection: WebSocketConnection
  ): Promise<void> {
    const { connection, endpoint, circuitBreaker } = wsConnection;

    try {
      // Execute subscription with circuit breaker protection
      const subscriptionId = await circuitBreaker.execute(async () => {
        // Subscribe to Raydium V4 program logs (most popular DEX)
        const programId = new PublicKey(this.config.programs.raydiumV4);

        logger.debug("Subscribing to program logs", {
          endpoint: endpoint.name,
          program: programId.toString(),
        });

        const id = connection.onLogs(
          programId,
          (logs: Logs, ctx: Context) => {
            void this.handleProgramLog(logs, ctx, "raydium_v4", wsConnection);
          },
          "confirmed"
        );

        return id;
      });

      if (subscriptionId === null) {
        throw new Error("Circuit breaker is OPEN");
      }

      wsConnection.subscriptionId = subscriptionId;
      wsConnection.isConnected = true;
      wsConnection.lastHeartbeat = Date.now();
      wsConnection.reconnectAttempts = 0;

      logger.info("Subscribed to program logs", {
        endpoint: endpoint.name,
        subscriptionId,
      });
    } catch (error) {
      logger.error("Failed to subscribe to program logs", {
        endpoint: endpoint.name,
        error: error instanceof Error ? error.message : String(error),
      });

      wsConnection.isConnected = false;
      wsConnection.failureCount++;

      throw error;
    }
  }

  /**
   * Handle incoming program log event
   */
  private async handleProgramLog(
    logs: Logs,
    _ctx: Context,
    source: PoolSource,
    wsConnection: WebSocketConnection
  ): Promise<void> {
    try {
      // Update heartbeat
      wsConnection.lastHeartbeat = Date.now();

      // Log received event
      logger.debug("Program log received", {
        endpoint: wsConnection.endpoint.name,
        source,
        signature: logs.signature,
        slot: _ctx.slot,
      });

      // Parse pool initialization event
      const poolEvent = await this.parsePoolInitEvent(logs, _ctx, source);

      if (!poolEvent) {
        // Not a pool initialization event - skip
        return;
      }

      logger.info("New pool detected", {
        source: poolEvent.source,
        tokenA: poolEvent.tokenMintA,
        tokenB: poolEvent.tokenMintB,
        pool: poolEvent.poolAddress,
        signature: poolEvent.signature,
      });

      // Create detection event
      const detection = await this.createDetectionEvent(poolEvent);

      // Broadcast to Redis pub/sub
      if (this.config.enableRedisPubSub) {
        await this.broadcastDetection(detection);
      }

      // Update metrics
      this.totalDetections++;
      const count = this.detectionsBySource.get(source) || 0;
      this.detectionsBySource.set(source, count + 1);

      // TODO: Store in database (will be implemented in Day 2)
      // TODO: Fetch token metadata (will be implemented in Day 2)
    } catch (error) {
      logger.error("Error handling program log", {
        endpoint: wsConnection.endpoint.name,
        error: error instanceof Error ? error.message : String(error),
      });

      wsConnection.failureCount++;
    }
  }

  /**
   * Parse pool initialization event from logs
   *
   * Raydium V4 pool initialization:
   * - Instruction: initialize2 or initializePool
   * - Accounts: [amm, authority, openOrders, lpMint, coinMint, pcMint, ...]
   * - Account indices: 8 (coinMint), 9 (pcMint) contain token mints
   */
  private async parsePoolInitEvent(
    logs: Logs,
    ctx: Context,
    source: PoolSource
  ): Promise<PoolInitEvent | null> {
    try {
      // Check if logs contain pool initialization pattern
      const hasInitPattern = PoolEventParser.isPoolInitTransaction(logs.logs);

      if (!hasInitPattern) {
        return null;
      }

      // Lazy-initialize event parser
      if (!this.eventParser) {
        // Get first available connection for parsing
        const firstConnection = Array.from(this.connections.values()).find(
          (conn) => conn.isConnected
        );

        if (!firstConnection) {
          logger.error("No connection available for event parsing");
          return null;
        }

        this.eventParser = new PoolEventParser(firstConnection.connection);
      }

      // Parse transaction to extract pool data
      const result = await this.eventParser.parsePoolInit(logs.signature, source);

      if (!result.success) {
        logger.debug("Failed to parse pool init", {
          signature: logs.signature,
          source,
          error: result.error,
        });
        return null;
      }

      const parsed = result.value;

      return {
        poolAddress: parsed.poolAddress,
        tokenMintA: parsed.tokenMintA,
        tokenMintB: parsed.tokenMintB,
        source: parsed.source,
        signature: asTransactionSignature(logs.signature),
        slot: ctx.slot,
        blockTime: parsed.blockTime,
      };
    } catch (error) {
      logger.error("Error parsing pool init event", {
        signature: logs.signature,
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
  }

  /**
   * Create detection event from parsed pool init
   */
  private async createDetectionEvent(
    poolEvent: PoolInitEvent
  ): Promise<TokenPoolDetection> {
    // Determine which token is the base and which is quote
    const { base, quote } = determineBaseAndQuote(
      poolEvent.tokenMintA,
      poolEvent.tokenMintB
    );

    return {
      tokenMint: base,
      quoteMint: quote,
      poolAddress: poolEvent.poolAddress,
      source: poolEvent.source,
      liquidity: asLamports(0n), // TODO: Calculate from pool state (Day 2)
      signature: poolEvent.signature,
      slot: poolEvent.slot,
      detectedAt: new Date(),
      // metadata will be fetched in Day 2
    };
  }

  /**
   * Broadcast detection event to Redis pub/sub
   */
  private async broadcastDetection(
    detection: TokenPoolDetection
  ): Promise<void> {
    try {
      await redis.publish(
        this.config.redisChannel,
        JSON.stringify(detection)
      );

      logger.debug("Detection broadcasted to Redis", {
        channel: this.config.redisChannel,
        tokenMint: detection.tokenMint,
      });
    } catch (error) {
      logger.error("Failed to broadcast detection to Redis", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Close WebSocket connection
   */
  private async closeConnection(
    wsConnection: WebSocketConnection
  ): Promise<void> {
    try {
      if (wsConnection.subscriptionId !== null) {
        await wsConnection.connection.removeOnLogsListener(
          wsConnection.subscriptionId
        );
        wsConnection.subscriptionId = null;
      }

      wsConnection.isConnected = false;

      logger.info("WebSocket connection closed", {
        endpoint: wsConnection.endpoint.name,
      });
    } catch (error) {
      logger.error("Error closing WebSocket connection", {
        endpoint: wsConnection.endpoint.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // Private Methods - Health Monitoring
  // ==========================================================================

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    this.healthCheckTimer = registerInterval(
      () => {
        void this.performHealthChecks();
      },
      this.config.healthCheckInterval,
      "detector-health"
    );

    logger.info("Health check timer started", {
      interval: this.config.healthCheckInterval,
    });
  }

  /**
   * Perform health checks on all connections
   */
  private async performHealthChecks(): Promise<void> {
    logger.debug("Performing health checks", {
      connections: this.connections.size,
    });

    const checks = Array.from(this.connections.values()).map((conn) =>
      this.healthCheckConnection(conn)
    );

    await Promise.allSettled(checks);

    // Update state based on connected endpoints
    const connectedCount = Array.from(this.connections.values()).filter(
      (conn) => conn.isConnected
    ).length;

    if (connectedCount === 0) {
      this.state = {
        status: "failed",
        error: "All WebSocket endpoints disconnected",
        failedAt: new Date(),
      };
    } else if (connectedCount < this.config.endpoints.length) {
      const failedEndpoints = this.config.endpoints
        .filter((e) => {
          const conn = this.connections.get(e.name);
          return !conn || !conn.isConnected;
        })
        .map((e) => e.name);

      this.state = {
        status: "degraded",
        connectedEndpoints: connectedCount,
        failedEndpoints,
      };
    } else {
      this.state = {
        status: "running",
        connectedEndpoints: connectedCount,
        startedAt: new Date(),
      };
    }
  }

  /**
   * Health check single connection
   */
  private async healthCheckConnection(
    wsConnection: WebSocketConnection
  ): Promise<void> {
    try {
      // Check if last heartbeat was recent (within 2x health check interval)
      const now = Date.now();
      const maxHeartbeatAge = this.config.healthCheckInterval * 2;

      if (
        wsConnection.lastHeartbeat &&
        now - wsConnection.lastHeartbeat < maxHeartbeatAge
      ) {
        // Heartbeat is recent - connection healthy
        return;
      }

      // No recent heartbeat - attempt reconnection
      logger.warn("WebSocket connection unhealthy (no heartbeat)", {
        endpoint: wsConnection.endpoint.name,
        lastHeartbeat: wsConnection.lastHeartbeat,
        age: wsConnection.lastHeartbeat
          ? now - wsConnection.lastHeartbeat
          : null,
      });

      await this.reconnectConnection(wsConnection);
    } catch (error) {
      logger.error("Health check failed", {
        endpoint: wsConnection.endpoint.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reconnect WebSocket connection
   */
  private async reconnectConnection(
    wsConnection: WebSocketConnection
  ): Promise<void> {
    const { endpoint } = wsConnection;

    // Check if max reconnect attempts reached
    if (
      wsConnection.reconnectAttempts >= endpoint.maxReconnectAttempts
    ) {
      logger.error("Max reconnect attempts reached", {
        endpoint: endpoint.name,
        attempts: wsConnection.reconnectAttempts,
      });

      wsConnection.isConnected = false;
      return;
    }

    wsConnection.reconnectAttempts++;

    logger.info("Attempting to reconnect WebSocket", {
      endpoint: endpoint.name,
      attempt: wsConnection.reconnectAttempts,
      maxAttempts: endpoint.maxReconnectAttempts,
    });

    try {
      // Close existing subscription
      await this.closeConnection(wsConnection);

      // Wait before reconnecting (exponential backoff)
      const delay =
        endpoint.reconnectDelay * Math.pow(2, wsConnection.reconnectAttempts - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Resubscribe to program logs
      await this.subscribeToProgram(wsConnection);

      logger.info("WebSocket reconnected successfully", {
        endpoint: endpoint.name,
      });
    } catch (error) {
      logger.error("Reconnection failed", {
        endpoint: endpoint.name,
        error: error instanceof Error ? error.message : String(error),
      });

      wsConnection.isConnected = false;
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let detectorInstance: TokenPoolDetector | null = null;

/**
 * Initialize global detector instance
 */
export function initializeDetector(
  config?: Partial<DetectorConfig>
): TokenPoolDetector {
  if (detectorInstance) {
    logger.warn("Detector already initialized");
    return detectorInstance;
  }

  detectorInstance = new TokenPoolDetector(config);
  return detectorInstance;
}

/**
 * Get global detector instance
 */
export function getDetector(): TokenPoolDetector {
  if (!detectorInstance) {
    throw new Error("Detector not initialized. Call initializeDetector() first.");
  }

  return detectorInstance;
}

/**
 * Shutdown global detector instance
 */
export async function shutdownDetector(): Promise<void> {
  if (detectorInstance) {
    await detectorInstance.stop();
    detectorInstance = null;
  }
}
