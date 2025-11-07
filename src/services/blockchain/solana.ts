/**
 * Solana connection service with RPC connection pooling (HIGH-1)
 *
 * Features:
 * - RPC connection pooling for high availability
 * - Automatic failover between multiple endpoints
 * - Circuit breaker protection
 * - Health monitoring
 * - Backwards compatible with single RPC URL
 */

import { Connection, Commitment } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import {
  RpcConnectionPool,
  createRpcPoolFromEnv,
  RpcPoolStats,
} from "./rpcPool.js";
import { getRpcEndpoints } from "../../config/env.js";

// ============================================================================
// Configuration
// ============================================================================

export interface SolanaConfig {
  /** Single RPC URL (legacy) or undefined to use pool from env */
  rpcUrl?: string;

  /** Multiple RPC URLs for pooling */
  rpcUrls?: string[];

  /** Commitment level */
  commitment?: Commitment;

  /** Use connection pooling */
  usePool?: boolean;
}

const DEFAULT_CONFIG: Partial<SolanaConfig> = {
  commitment: "confirmed",
  usePool: true, // Enable pooling by default
};

// ============================================================================
// Solana Service
// ============================================================================

class SolanaService {
  private connection: Connection | null = null;
  private pool: RpcConnectionPool | null = null;
  private config: SolanaConfig;
  private readonly usePool: boolean;

  constructor(config: SolanaConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Determine if we should use pool
    const urls = config.rpcUrls || (config.rpcUrl ? [config.rpcUrl] : getRpcEndpoints());
    this.usePool = (config.usePool !== false) && urls.length > 1;
  }

  /**
   * Initialize connection to Solana
   */
  async initialize(): Promise<void> {
    const urls = this.config.rpcUrls ||
      (this.config.rpcUrl ? [this.config.rpcUrl] : getRpcEndpoints());

    if (urls.length === 0) {
      throw new Error("No RPC URLs configured");
    }

    if (this.usePool) {
      // ✅ HIGH-1: Use RPC Connection Pool
      logger.info("Initializing Solana with RPC connection pool", {
        endpoints: urls.length,
        commitment: this.config.commitment,
      });

      this.pool = createRpcPoolFromEnv(urls);

      // Get initial connection from pool
      this.connection = this.pool.getConnection();

      logger.info("Solana RPC pool initialized", {
        stats: this.pool.getStats(),
      });
    } else {
      // Legacy: Single connection
      logger.info("Initializing Solana with single RPC connection", {
        rpcUrl: urls[0],
        commitment: this.config.commitment,
      });

      this.connection = new Connection(urls[0], {
        commitment: this.config.commitment,
      });

      // Health check
      try {
        await this.connection.getSlot();
        logger.info("Solana connection initialized");
      } catch (error) {
        logger.error("Solana connection health check failed", { error });
        throw error;
      }
    }
  }

  /**
   * Get connection instance
   *
   * If using pool, returns a healthy connection from the pool.
   * Otherwise, returns the single connection.
   */
  getConnection(): Connection {
    if (!this.connection) {
      throw new Error(
        "Solana connection not initialized. Call initialize() first."
      );
    }

    // If using pool, get fresh connection (handles failover)
    if (this.pool) {
      return this.pool.getConnection();
    }

    // Single connection
    return this.connection;
  }

  /**
   * Get RPC connection pool
   * Returns null if not using pool
   */
  getPool(): RpcConnectionPool | null {
    return this.pool;
  }

  /**
   * Check connection health
   */
  async checkHealth(): Promise<boolean> {
    try {
      const connection = this.getConnection();
      const startTime = Date.now();

      // Try to get slot
      await connection.getSlot();

      const elapsed = Date.now() - startTime;

      logger.debug("Solana health check passed", { elapsed });

      return true;
    } catch (error) {
      logger.error("Solana health check failed", { error });
      return false;
    }
  }

  /**
   * Get RPC pool statistics
   * Returns null if not using pool
   */
  getPoolStats(): RpcPoolStats | null {
    return this.pool?.getStats() || null;
  }

  /**
   * Get health status
   */
  getHealth(): { healthy: boolean; poolStats?: RpcPoolStats } {
    const poolStats = this.getPoolStats();

    return {
      healthy: poolStats ? poolStats.healthy > 0 : this.connection !== null,
      poolStats: poolStats || undefined,
    };
  }

  /**
   * Close connection and cleanup
   */
  async close(): Promise<void> {
    logger.info("Closing Solana service");

    if (this.pool) {
      this.pool.destroy();
    }

    this.connection = null;
    this.pool = null;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let solanaInstance: SolanaService | null = null;

/**
 * Initialize Solana service
 *
 * @param config - Solana configuration
 * @returns Initialized Solana service
 */
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

/**
 * Get Solana service instance
 *
 * @throws {Error} If not initialized
 */
export function getSolana(): SolanaService {
  if (!solanaInstance) {
    throw new Error(
      "Solana service not initialized. Call initializeSolana() first."
    );
  }
  return solanaInstance;
}

/**
 * Get Solana connection
 *
 * If using pool, returns a healthy connection from the pool.
 *
 * @throws {Error} If not initialized
 */
export function getSolanaConnection(): Connection {
  return getSolana().getConnection();
}

/**
 * Get RPC pool statistics (if using pool)
 *
 * @returns Pool stats or null if not using pool
 */
export function getSolanaPoolStats(): RpcPoolStats | null {
  return getSolana().getPoolStats();
}
