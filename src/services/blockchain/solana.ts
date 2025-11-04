/**
 * Solana connection service with retry logic and health monitoring
 */

import { Connection, ConnectionConfig, Commitment } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Configuration
// ============================================================================

export interface SolanaConfig {
  rpcUrl: string;
  wsUrl?: string;
  commitment?: Commitment;
  confirmTransactionInitialTimeout?: number;
}

const DEFAULT_CONFIG: Partial<SolanaConfig> = {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000, // 60 seconds
};

// ============================================================================
// Solana Service
// ============================================================================

class SolanaService {
  private connection: Connection | null = null;
  private config: SolanaConfig;
  private isHealthy = false;
  private lastHealthCheck = 0;
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

  constructor(config: SolanaConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize connection to Solana
   */
  async initialize(): Promise<void> {
    logger.info("Initializing Solana connection", {
      rpcUrl: this.config.rpcUrl,
      commitment: this.config.commitment,
    });

    const connectionConfig: ConnectionConfig = {
      commitment: this.config.commitment,
      confirmTransactionInitialTimeout:
        this.config.confirmTransactionInitialTimeout,
      wsEndpoint: this.config.wsUrl,
    };

    this.connection = new Connection(this.config.rpcUrl, connectionConfig);

    // Initial health check
    await this.checkHealth();

    logger.info("Solana connection initialized", {
      healthy: this.isHealthy,
    });
  }

  /**
   * Get connection instance
   */
  getConnection(): Connection {
    if (!this.connection) {
      throw new Error(
        "Solana connection not initialized. Call initialize() first."
      );
    }

    // Periodic health check
    const now = Date.now();
    if (now - this.lastHealthCheck > this.HEALTH_CHECK_INTERVAL) {
      // Don't await - fire and forget
      this.checkHealth().catch((error) => {
        logger.error("Background health check failed", { error });
      });
    }

    return this.connection;
  }

  /**
   * Check connection health
   */
  async checkHealth(): Promise<boolean> {
    if (!this.connection) {
      this.isHealthy = false;
      return false;
    }

    try {
      const startTime = Date.now();

      // Try to get latest blockhash
      await this.connection.getLatestBlockhash("finalized");

      const elapsed = Date.now() - startTime;

      this.isHealthy = true;
      this.lastHealthCheck = Date.now();

      logger.debug("Solana health check passed", { elapsed });

      return true;
    } catch (error) {
      this.isHealthy = false;
      this.lastHealthCheck = Date.now();

      logger.error("Solana health check failed", { error });

      return false;
    }
  }

  /**
   * Get health status
   */
  getHealth(): { healthy: boolean; lastCheck: number } {
    return {
      healthy: this.isHealthy,
      lastCheck: this.lastHealthCheck,
    };
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    logger.info("Closing Solana connection");
    this.connection = null;
    this.isHealthy = false;
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

export function getSolanaConnection(): Connection {
  return getSolana().getConnection();
}
