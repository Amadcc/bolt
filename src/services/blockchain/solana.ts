/**
 * Solana connection service with RPC Pool integration
 *
 * Features:
 * - Multi-endpoint RPC pool with automatic failover
 * - Circuit breaker prevents cascade failures
 * - Rate limiting respects provider quotas
 * - Latency-aware endpoint selection
 * - Request deduplication reduces load
 * - Periodic health checks with auto-recovery
 * - Backward compatible API (drop-in replacement)
 *
 * @see RPCPool - Production-grade connection pool implementation
 */

import { Connection, type Commitment } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { RPCPool } from "./rpcPool.js";

// ============================================================================
// Configuration
// ============================================================================

export interface SolanaConfig {
  /** Primary RPC URL (backward compatible) */
  rpcUrl: string;

  /** Optional WebSocket URL (not used with RPC Pool) */
  wsUrl?: string;

  /** Commitment level */
  commitment?: Commitment;

  /** Transaction confirmation timeout */
  confirmTransactionInitialTimeout?: number;

  /** Additional RPC endpoints for pool (optional) */
  additionalEndpoints?: Array<{
    url: string;
    name: string;
    priority: number;
    maxRequestsPerSecond: number;
  }>;
}

const DEFAULT_CONFIG: Partial<SolanaConfig> = {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000, // 60 seconds
};

// ============================================================================
// Solana Service with RPC Pool
// ============================================================================

export class SolanaService {
  private rpcPool: RPCPool | null = null;
  private config: SolanaConfig;

  constructor(config: SolanaConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize RPC connection pool
   */
  async initialize(): Promise<void> {
    logger.info("Initializing Solana connection");

    // Build endpoint configuration
    const endpoints = this.buildEndpointConfig();

    logger.info("Initializing RPC Pool", {
      totalEndpoints: endpoints.length,
      endpoints: endpoints.map((e) => ({
        name: e.name,
        priority: e.priority,
        maxRps: e.maxRequestsPerSecond,
      })),
    });

    // Create RPC Pool
    this.rpcPool = new RPCPool(endpoints, {
      commitment: this.config.commitment,
      circuitBreakerThreshold: 5,
      circuitBreakerTimeout: 60000, // 60s
      healthCheckInterval: 30000, // 30s
      deduplicationCacheTTL: 5000, // 5s
      maxLatencySamples: 100,
    });

    // Initial health check
    const health = await this.checkHealth();

    logger.info("Solana connection initialized", {
      healthy: health.healthy,
      totalEndpoints: health.total,
      healthyEndpoints: health.healthy,
    });
  }

  /**
   * Get connection instance from pool
   *
   * Returns best available connection based on:
   * - Health status
   * - Circuit breaker state
   * - Priority
   * - Latency (P95)
   */
  getConnection(): Promise<Connection> {
    if (!this.rpcPool) {
      throw new Error(
        "Solana service not initialized. Call initialize() first."
      );
    }

    return this.rpcPool.getConnection();
  }

  /**
   * Execute RPC request with automatic retry and failover
   *
   * @param requestFn - Function that makes the RPC call
   * @param dedupKey - Optional key for request deduplication
   * @returns Result of the RPC call
   */
  async executeRequest<T>(
    requestFn: (connection: Connection) => Promise<T>,
    dedupKey?: string
  ): Promise<T> {
    if (!this.rpcPool) {
      throw new Error(
        "Solana service not initialized. Call initialize() first."
      );
    }

    return this.rpcPool.executeRequest(requestFn, dedupKey);
  }

  /**
   * Check pool health status
   */
  async checkHealth(): Promise<{
    healthy: number;
    unhealthy: number;
    total: number;
    endpoints: Array<{
      name: string;
      healthy: boolean;
      circuit: string;
      failures: number;
      p95Latency: number;
    }>;
  }> {
    if (!this.rpcPool) {
      return {
        healthy: 0,
        unhealthy: 0,
        total: 0,
        endpoints: [],
      };
    }

    return this.rpcPool.getHealthStatus();
  }

  /**
   * Get simplified health status (backward compatible)
   */
  getHealth(): { healthy: boolean; lastCheck: number } {
    if (!this.rpcPool) {
      return {
        healthy: false,
        lastCheck: 0,
      };
    }

    const status = this.rpcPool.getHealthStatus();

    return {
      healthy: status.healthy > 0,
      lastCheck: Date.now(),
    };
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    logger.info("Closing Solana connection pool");

    if (this.rpcPool) {
      await this.rpcPool.shutdown();
      this.rpcPool = null;
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Build endpoint configuration from environment variables
   *
   * Priority:
   * 1. Premium endpoints (Helius, QuickNode) - priority 1-2
   * 2. Public endpoints - priority 3 (fallback)
   */
  private buildEndpointConfig(): Array<{
    url: string;
    name: string;
    priority: number;
    maxRequestsPerSecond: number;
  }> {
    const endpoints = [];

    // 1. Helius (premium, highest priority)
    if (process.env.HELIUS_RPC_URL) {
      endpoints.push({
        url: process.env.HELIUS_RPC_URL,
        name: "Helius",
        priority: 1,
        maxRequestsPerSecond: 10, // Helius free tier: 10 RPS
      });
    }

    // 2. QuickNode (premium, high priority)
    if (process.env.QUICKNODE_RPC_URL) {
      endpoints.push({
        url: process.env.QUICKNODE_RPC_URL,
        name: "QuickNode",
        priority: 2,
        maxRequestsPerSecond: 10, // QuickNode free tier: 10 RPS
      });
    }

    // 3. Primary RPC URL (from config, could be public)
    // Detect if it's a public endpoint
    const isPublic =
      this.config.rpcUrl.includes("api.mainnet-beta.solana.com") ||
      this.config.rpcUrl.includes("api.devnet.solana.com");

    endpoints.push({
      url: this.config.rpcUrl,
      name: isPublic ? "Public" : "Primary",
      priority: isPublic ? 3 : 2, // Public = lowest priority
      maxRequestsPerSecond: isPublic ? 2 : 5, // Public = very conservative
    });

    // 4. Additional endpoints from config
    if (this.config.additionalEndpoints) {
      endpoints.push(...this.config.additionalEndpoints);
    }

    // Sort by priority (lower number = higher priority)
    return endpoints.sort((a, b) => a.priority - b.priority);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let solanaInstance: SolanaService | null = null;

export async function initializeSolana(
  config: SolanaConfig
): Promise<SolanaService> {
  if (solanaInstance) {
    logger.warn("Solana service already initialized");
    return solanaInstance;
  }

  solanaInstance = new SolanaService(config);
  await solanaInstance.initialize();

  return solanaInstance;
}

export function getSolana(): SolanaService {
  if (!solanaInstance) {
    throw new Error(
      "Solana service not initialized. Call initializeSolana() first."
    );
  }
  return solanaInstance;
}

/**
 * Get Solana connection from pool
 *
 * @deprecated Use getSolana().getConnection() for async access
 * @returns Connection from best available endpoint
 */
export async function getSolanaConnection(): Promise<Connection> {
  return getSolana().getConnection();
}

/**
 * Execute RPC request with automatic retry and failover
 *
 * @param requestFn - Function that makes the RPC call
 * @param dedupKey - Optional key for request deduplication
 * @returns Result of the RPC call
 *
 * @example
 * ```ts
 * const balance = await executeSolanaRequest(
 *   async (connection) => connection.getBalance(pubkey),
 *   `balance:${pubkey.toBase58()}`
 * );
 * ```
 */
export async function executeSolanaRequest<T>(
  requestFn: (connection: Connection) => Promise<T>,
  dedupKey?: string
): Promise<T> {
  return getSolana().executeRequest(requestFn, dedupKey);
}
