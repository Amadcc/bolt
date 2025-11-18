/**
 * WebSocket Connection Pool with Auto-Reconnect
 *
 * Production-ready WebSocket pool for Solana RPC with:
 * - Multiple RPC endpoints with automatic failover
 * - Health monitoring and auto-reconnect
 * - Circuit breaker integration
 * - Connection pooling and load balancing
 * - Graceful degradation
 *
 * Performance Target: <100ms failover time
 */

import { Connection } from "@solana/web3.js";
import type { Commitment } from "@solana/web3.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import { logger } from "../../utils/logger.js";
import { CircuitBreaker } from "../honeypot/circuitBreaker.js";

// ============================================================================
// Types
// ============================================================================

export interface WebSocketPoolConfig {
  /** RPC endpoints (3+ recommended for redundancy) */
  endpoints: string[];

  /** Connection commitment level */
  commitment: Commitment;

  /** Health check interval in ms */
  healthCheckInterval: number;

  /** Auto-reconnect enabled */
  autoReconnect: boolean;

  /** Max reconnect attempts before failover */
  maxReconnectAttempts: number;

  /** Reconnect delay in ms */
  reconnectDelay: number;

  /** Circuit breaker config */
  circuitBreaker: {
    failureThreshold: number;
    successThreshold: number;
    timeout: number;
  };
}

export interface ConnectionHealth {
  endpoint: string;
  isHealthy: boolean;
  lastHealthCheck: Date;
  consecutiveFailures: number;
  uptime: number;
}

export interface PoolStats {
  totalConnections: number;
  healthyConnections: number;
  activeEndpoint: string;
  totalFailovers: number;
  totalReconnects: number;
  avgLatencyMs: number;
}

// ============================================================================
// Connection Wrapper
// ============================================================================

class ManagedConnection {
  public connection: Connection;
  public endpoint: string;
  public isHealthy: boolean = true;
  public consecutiveFailures: number = 0;
  public createdAt: Date = new Date();
  public lastHealthCheck: Date = new Date();
  public circuitBreaker: CircuitBreaker;

  constructor(
    endpoint: string,
    commitment: Commitment,
    circuitBreakerConfig: WebSocketPoolConfig["circuitBreaker"]
  ) {
    this.endpoint = endpoint;
    this.connection = new Connection(endpoint, {
      commitment,
      wsEndpoint: this.getWsEndpoint(endpoint),
    });

    // Initialize circuit breaker for this connection
    this.circuitBreaker = new CircuitBreaker(`websocket-${endpoint}`, {
      failureThreshold: circuitBreakerConfig.failureThreshold,
      successThreshold: circuitBreakerConfig.successThreshold,
      timeout: circuitBreakerConfig.timeout,
      monitoringPeriod: 120000, // 2 minutes
    });

    logger.info("WebSocket connection created", { endpoint });
  }

  /**
   * Convert HTTP endpoint to WebSocket endpoint
   */
  private getWsEndpoint(httpEndpoint: string): string {
    return httpEndpoint.replace("https://", "wss://").replace("http://", "ws://");
  }

  /**
   * Check connection health
   */
  async checkHealth(): Promise<boolean> {
    try {
      const startTime = Date.now();

      // Use circuit breaker for health check
      const result = await this.circuitBreaker.execute(async () => {
        const slot = await this.connection.getSlot();
        return slot > 0;
      });

      const latency = Date.now() - startTime;
      this.lastHealthCheck = new Date();

      // Circuit breaker returns null when OPEN
      if (result === null) {
        this.consecutiveFailures++;
        this.isHealthy = false;
        logger.warn("Health check blocked by circuit breaker", {
          endpoint: this.endpoint,
          consecutiveFailures: this.consecutiveFailures,
        });
        return false;
      }

      // Check if slot is valid
      if (result) {
        this.isHealthy = true;
        this.consecutiveFailures = 0;
        logger.debug("Health check passed", {
          endpoint: this.endpoint,
          latency,
        });
        return true;
      } else {
        this.consecutiveFailures++;
        this.isHealthy = false;
        logger.warn("Health check failed", {
          endpoint: this.endpoint,
          error: "Invalid slot",
          consecutiveFailures: this.consecutiveFailures,
        });
        return false;
      }
    } catch (error) {
      this.consecutiveFailures++;
      this.isHealthy = false;
      logger.error("Health check error", {
        endpoint: this.endpoint,
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures: this.consecutiveFailures,
      });
      return false;
    }
  }

  /**
   * Get uptime in seconds
   */
  getUptime(): number {
    return Math.floor((Date.now() - this.createdAt.getTime()) / 1000);
  }
}

// ============================================================================
// WebSocket Pool Implementation
// ============================================================================

/**
 * WebSocket connection pool with auto-reconnect and failover
 */
export class WebSocketPool {
  private config: WebSocketPoolConfig;
  private connections: Map<string, ManagedConnection> = new Map();
  private activeEndpoint: string;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private stats = {
    totalFailovers: 0,
    totalReconnects: 0,
    latencies: [] as number[],
  };

  constructor(config: Partial<WebSocketPoolConfig> = {}) {
    this.config = {
      endpoints: config.endpoints || [],
      commitment: config.commitment || "confirmed",
      healthCheckInterval: config.healthCheckInterval || 10000, // 10s
      autoReconnect: config.autoReconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts || 3,
      reconnectDelay: config.reconnectDelay || 1000,
      circuitBreaker: {
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 60000, // 1 minute
        ...config.circuitBreaker,
      },
    };

    if (this.config.endpoints.length === 0) {
      throw new Error("WebSocketPool requires at least one endpoint");
    }

    this.activeEndpoint = this.config.endpoints[0];
    this.initializeConnections();
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Get active connection
   */
  getConnection(): Connection {
    const active = this.connections.get(this.activeEndpoint);
    if (!active) {
      throw new Error("No active connection available");
    }
    return active.connection;
  }

  /**
   * Start health monitoring and auto-reconnect
   */
  start(): void {
    logger.info("Starting WebSocket pool", {
      endpoints: this.config.endpoints,
      commitment: this.config.commitment,
    });

    // Start health check timer
    this.healthCheckTimer = setInterval(() => {
      this.performHealthChecks();
    }, this.config.healthCheckInterval);

    // Perform initial health check
    this.performHealthChecks();
  }

  /**
   * Stop health monitoring
   */
  stop(): void {
    logger.info("Stopping WebSocket pool");

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Get pool health status
   */
  getHealth(): ConnectionHealth[] {
    return Array.from(this.connections.values()).map((conn) => ({
      endpoint: conn.endpoint,
      isHealthy: conn.isHealthy,
      lastHealthCheck: conn.lastHealthCheck,
      consecutiveFailures: conn.consecutiveFailures,
      uptime: conn.getUptime(),
    }));
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    const health = this.getHealth();
    const avgLatency =
      this.stats.latencies.length > 0
        ? this.stats.latencies.reduce((a, b) => a + b, 0) / this.stats.latencies.length
        : 0;

    return {
      totalConnections: this.connections.size,
      healthyConnections: health.filter((h) => h.isHealthy).length,
      activeEndpoint: this.activeEndpoint,
      totalFailovers: this.stats.totalFailovers,
      totalReconnects: this.stats.totalReconnects,
      avgLatencyMs: Math.round(avgLatency),
    };
  }

  /**
   * Force reconnect of specific endpoint
   */
  async reconnect(endpoint: string): Promise<Result<void, string>> {
    const conn = this.connections.get(endpoint);
    if (!conn) {
      return Err(`Endpoint not found: ${endpoint}`);
    }

    try {
      logger.info("Reconnecting endpoint", { endpoint });

      // Create new connection
      const newConn = new ManagedConnection(
        endpoint,
        this.config.commitment,
        this.config.circuitBreaker
      );

      // Check health before replacing
      const isHealthy = await newConn.checkHealth();
      if (!isHealthy) {
        return Err("Reconnected endpoint failed health check");
      }

      // Replace old connection
      this.connections.set(endpoint, newConn);
      this.stats.totalReconnects++;

      logger.info("Endpoint reconnected successfully", { endpoint });
      return Ok(undefined);
    } catch (error) {
      logger.error("Reconnect failed", {
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      });
      return Err(`Reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Initialize all connections
   */
  private initializeConnections(): void {
    for (const endpoint of this.config.endpoints) {
      const conn = new ManagedConnection(
        endpoint,
        this.config.commitment,
        this.config.circuitBreaker
      );
      this.connections.set(endpoint, conn);
    }

    logger.info("WebSocket pool initialized", {
      totalConnections: this.connections.size,
    });
  }

  /**
   * Perform health checks on all connections
   */
  private async performHealthChecks(): Promise<void> {
    const healthPromises = Array.from(this.connections.values()).map(async (conn) => {
      const startTime = Date.now();
      const isHealthy = await conn.checkHealth();
      const latency = Date.now() - startTime;

      if (isHealthy) {
        this.stats.latencies.push(latency);
        // Keep only last 100 latency samples
        if (this.stats.latencies.length > 100) {
          this.stats.latencies.shift();
        }
      }

      return { endpoint: conn.endpoint, isHealthy };
    });

    const results = await Promise.all(healthPromises);

    // Check if active endpoint is unhealthy
    const activeHealth = results.find((r) => r.endpoint === this.activeEndpoint);
    if (activeHealth && !activeHealth.isHealthy) {
      await this.failover();
    }
  }

  /**
   * Failover to healthy endpoint
   */
  private async failover(): Promise<void> {
    logger.warn("Initiating failover", {
      currentEndpoint: this.activeEndpoint,
    });

    // Find healthy endpoint
    const healthyEndpoints = Array.from(this.connections.values())
      .filter((conn) => conn.isHealthy && conn.endpoint !== this.activeEndpoint)
      .sort((a, b) => a.consecutiveFailures - b.consecutiveFailures);

    if (healthyEndpoints.length === 0) {
      logger.error("No healthy endpoints available for failover!");

      // Attempt auto-reconnect of current endpoint if enabled
      if (this.config.autoReconnect) {
        await this.attemptReconnect(this.activeEndpoint);
      }
      return;
    }

    // Switch to healthiest endpoint
    const newActiveEndpoint = healthyEndpoints[0].endpoint;
    logger.info("Failover completed", {
      oldEndpoint: this.activeEndpoint,
      newEndpoint: newActiveEndpoint,
    });

    this.activeEndpoint = newActiveEndpoint;
    this.stats.totalFailovers++;

    // Attempt to reconnect failed endpoint in background
    if (this.config.autoReconnect) {
      this.attemptReconnect(this.activeEndpoint);
    }
  }

  /**
   * Attempt reconnect with exponential backoff
   */
  private async attemptReconnect(endpoint: string): Promise<void> {
    for (let attempt = 1; attempt <= this.config.maxReconnectAttempts; attempt++) {
      const delay = this.config.reconnectDelay * Math.pow(2, attempt - 1);

      logger.info("Attempting reconnect", {
        endpoint,
        attempt,
        maxAttempts: this.config.maxReconnectAttempts,
        delay,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));

      const result = await this.reconnect(endpoint);
      if (result.success) {
        logger.info("Reconnect successful", { endpoint, attempt });
        return;
      }

      logger.warn("Reconnect attempt failed", {
        endpoint,
        attempt,
        error: result.error,
      });
    }

    logger.error("All reconnect attempts failed", {
      endpoint,
      attempts: this.config.maxReconnectAttempts,
    });
  }
}

/**
 * Default WebSocket pool instance (singleton)
 */
export let defaultWebSocketPool: WebSocketPool | null = null;

/**
 * Initialize default WebSocket pool
 */
export function initializeWebSocketPool(config: Partial<WebSocketPoolConfig>): WebSocketPool {
  if (defaultWebSocketPool) {
    logger.warn("WebSocket pool already initialized, stopping existing pool");
    defaultWebSocketPool.stop();
  }

  defaultWebSocketPool = new WebSocketPool(config);
  defaultWebSocketPool.start();

  return defaultWebSocketPool;
}

/**
 * Get default WebSocket pool
 */
export function getWebSocketPool(): WebSocketPool {
  if (!defaultWebSocketPool) {
    throw new Error(
      "WebSocket pool not initialized. Call initializeWebSocketPool() first."
    );
  }
  return defaultWebSocketPool;
}
