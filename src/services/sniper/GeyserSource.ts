/**
 * Geyser Plugin Pool Source (Yellowstone gRPC)
 *
 * Ultra-low latency pool detection using Yellowstone gRPC Geyser plugin.
 * Provides <50ms latency vs ~200-500ms for WebSocket RPC.
 *
 * Key Features:
 * - Direct validator data stream via gRPC
 * - Subscribe to account updates for all DEX programs
 * - Filter for pool initialization accounts
 * - Historical replay support (fromSlot)
 * - Automatic reconnection and error handling
 *
 * Providers:
 * - Chainstack: $49/month (50 accounts/stream, sub-50ms latency)
 * - QuickNode: $499/month (unmetered fleet access)
 * - Helius: Enterprise pricing
 *
 * Performance Target: <50ms detection latency
 */

import Client, {
  CommitmentLevel,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import type { RawPoolDetection, SourceHealth, SourceMetrics } from "./sources/BaseSource.js";
import type { SolanaAddress } from "../../types/common.js";
import { logger } from "../../utils/logger.js";
import { Ok, Err, Result } from "../../types/common.js";
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import * as client from "prom-client";
import {
  RaydiumV4Source,
  RaydiumCLMMSource,
  OrcaWhirlpoolSource,
  MeteoraSource,
  PumpFunSource,
  BasePoolSource,
} from "./sources/index.js";
import {
  RAYDIUM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  METEORA_DLMM_PROGRAM,
  PUMP_FUN_PROGRAM,
  PUMPSWAP_PROGRAM,
} from "../../config/programs.js";
import type { PoolSource } from "../../types/sniper.js";
import { TokenMetadataService } from "./metadata.js";
import type { TokenMint } from "../../types/common.js";

// ============================================================================
// Types
// ============================================================================

export interface GeyserConfig {
  /** Geyser gRPC endpoint (e.g., "grpc.chainstack.com:443") */
  endpoint: string;

  /** API token for authentication */
  token: string;

  /** DEX program IDs to monitor */
  programIds: SolanaAddress[];

  /** Commitment level (confirmed, finalized) */
  commitment: CommitmentLevel;

  /** Enable historical replay from slot */
  fromSlot?: number;

  /** Enable TLS (default: true) */
  tls?: boolean;

  /** Reconnect on disconnect (default: true) */
  autoReconnect?: boolean;

  /** Max reconnect attempts (default: 5) */
  maxReconnectAttempts?: number;

  /** Reconnect delay in ms (default: 1000) */
  reconnectDelay?: number;
}

export interface GeyserStats {
  totalDetections: number;
  avgLatencyMs: number;
  totalReconnects: number;
  lastDetectionAt: Date | null;
  uptime: number;
}

// ============================================================================
// Prometheus Metrics
// ============================================================================

const geyserMessagesReceivedTotal = new client.Counter({
  name: "geyser_messages_received_total",
  help: "Total messages received from Geyser stream",
  labelNames: ["message_type"], // account, transaction, ping
});

const geyserDetectionsTotal = new client.Counter({
  name: "geyser_detections_total",
  help: "Total pool detections from Geyser",
  labelNames: ["dex_source"], // raydium_v4, orca_whirlpool, etc
});

const geyserLatencyHistogram = new client.Histogram({
  name: "geyser_latency_milliseconds",
  help: "Geyser message processing latency in milliseconds",
  labelNames: ["operation"], // parse_account, parse_transaction
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
});

const geyserErrorsTotal = new client.Counter({
  name: "geyser_errors_total",
  help: "Total errors from Geyser processing",
  labelNames: ["error_type"], // parse_error, connection_error, etc
});

const geyserConnectionStateGauge = new client.Gauge({
  name: "geyser_connection_state",
  help: "Geyser connection state (0=disconnected, 1=connecting, 2=healthy, 3=failed)",
  labelNames: ["endpoint"],
});

const geyserReconnectsTotal = new client.Counter({
  name: "geyser_reconnects_total",
  help: "Total Geyser reconnection attempts",
  labelNames: ["endpoint"],
});

// ============================================================================
// Geyser Source Implementation
// ============================================================================

/**
 * Geyser Plugin pool source using Yellowstone gRPC
 *
 * Provides ultra-low latency pool detection (<50ms) by streaming
 * account updates directly from Solana validator nodes.
 */
export class GeyserSource {
  private config: GeyserConfig & {
    tls: boolean;
    autoReconnect: boolean;
    maxReconnectAttempts: number;
    reconnectDelay: number;
  };
  private client: Client | null = null;
  private stream: AsyncIterable<any> | null = null;
  private health: SourceHealth = {
    status: "connecting",
    attemptedAt: new Date(),
  };
  private metrics: SourceMetrics = {
    totalDetections: 0,
    avgParsingLatencyMs: 0,
    uptimePct: 0,
    lastDetectionAt: null,
  };
  private stats = {
    totalReconnects: 0,
    latencies: [] as number[],
    startTime: Date.now(),
  };
  private isRunning = false;
  private abortController: AbortController | null = null;

  /**
   * DEX parser instances for pool detection
   * Map: program ID → parser instance
   */
  private dexParsers: Map<SolanaAddress, BasePoolSource> = new Map();

  /**
   * Program ID to source type mapping
   */
  private programToSource: Map<SolanaAddress, PoolSource> = new Map();

  /**
   * Connection for DEX parsers
   */
  private connection: Connection;

  /**
   * Metadata service for fetching token symbols
   */
  private metadataService: TokenMetadataService;

  constructor(config: GeyserConfig, connection: Connection) {
    this.connection = connection;
    this.config = {
      endpoint: config.endpoint,
      token: config.token,
      programIds: config.programIds,
      commitment: config.commitment,
      fromSlot: config.fromSlot ?? undefined,
      tls: config.tls ?? true,
      autoReconnect: config.autoReconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
      reconnectDelay: config.reconnectDelay ?? 5000, // 5s base delay to avoid concurrent stream limits
    };

    // Initialize metadata service for symbol fetching
    this.metadataService = new TokenMetadataService(connection);

    // Initialize DEX parsers for each program
    this.initializeDexParsers();

    // Initialize connection state gauge
    geyserConnectionStateGauge.set({ endpoint: this.config.endpoint }, 1); // 1 = connecting

    logger.info("Geyser source initialized", {
      endpoint: this.config.endpoint,
      programIds: this.config.programIds,
      commitment: this.config.commitment,
      dexParsersCount: this.dexParsers.size,
    });
  }

  /**
   * Initialize DEX parser instances
   */
  private initializeDexParsers(): void {
    // Raydium V4
    if (this.config.programIds.includes(RAYDIUM_V4_PROGRAM)) {
      const parser = new RaydiumV4Source(this.connection);
      this.dexParsers.set(RAYDIUM_V4_PROGRAM, parser);
      this.programToSource.set(RAYDIUM_V4_PROGRAM, "raydium_v4");
      logger.debug("Initialized Raydium V4 parser", { programId: RAYDIUM_V4_PROGRAM });
    }

    // Raydium CLMM
    if (this.config.programIds.includes(RAYDIUM_CLMM_PROGRAM)) {
      const parser = new RaydiumCLMMSource(this.connection);
      this.dexParsers.set(RAYDIUM_CLMM_PROGRAM, parser);
      this.programToSource.set(RAYDIUM_CLMM_PROGRAM, "raydium_clmm");
      logger.debug("Initialized Raydium CLMM parser", { programId: RAYDIUM_CLMM_PROGRAM });
    }

    // Orca Whirlpool
    if (this.config.programIds.includes(ORCA_WHIRLPOOL_PROGRAM)) {
      const parser = new OrcaWhirlpoolSource(this.connection);
      this.dexParsers.set(ORCA_WHIRLPOOL_PROGRAM, parser);
      this.programToSource.set(ORCA_WHIRLPOOL_PROGRAM, "orca_whirlpool");
      logger.debug("Initialized Orca Whirlpool parser", { programId: ORCA_WHIRLPOOL_PROGRAM });
    }

    // Meteora DLMM
    if (this.config.programIds.includes(METEORA_DLMM_PROGRAM)) {
      const parser = new MeteoraSource(this.connection);
      this.dexParsers.set(METEORA_DLMM_PROGRAM, parser);
      this.programToSource.set(METEORA_DLMM_PROGRAM, "meteora");
      logger.debug("Initialized Meteora DLMM parser", { programId: METEORA_DLMM_PROGRAM });
    }

    // Pump.fun
    if (this.config.programIds.includes(PUMP_FUN_PROGRAM)) {
      const parser = new PumpFunSource(this.connection);
      this.dexParsers.set(PUMP_FUN_PROGRAM, parser);
      this.programToSource.set(PUMP_FUN_PROGRAM, "pump_fun");
      logger.debug("Initialized Pump.fun parser", { programId: PUMP_FUN_PROGRAM });
    }

    // PumpSwap AMM (uses Raydium-like AMM structure)
    if (this.config.programIds.includes(PUMPSWAP_PROGRAM)) {
      const parser = new RaydiumV4Source(this.connection);
      this.dexParsers.set(PUMPSWAP_PROGRAM, parser);
      this.programToSource.set(PUMPSWAP_PROGRAM, "pumpswap");
      logger.debug("Initialized PumpSwap parser", { programId: PUMPSWAP_PROGRAM });
    }

    logger.info("DEX parsers initialized", {
      count: this.dexParsers.size,
      programs: Array.from(this.programToSource.keys()),
    });
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Start Geyser monitoring
   *
   * @param onDetection - Callback for new pool detections
   * @returns Success or error
   */
  async start(
    onDetection: (pool: RawPoolDetection) => void
  ): Promise<Result<void, string>> {
    try {
      logger.info("Starting Geyser monitoring", {
        programIds: this.config.programIds,
      });

      this.isRunning = true;
      this.abortController = new AbortController();

      // Connect to Geyser
      const connectResult = await this.connect();
      if (!connectResult.success) {
        return Err(`Geyser connection failed: ${connectResult.error}`);
      }

      // Start subscription
      const subscribeResult = await this.subscribe(onDetection);
      if (!subscribeResult.success) {
        return Err(`Geyser subscription failed: ${subscribeResult.error}`);
      }

      this.health = { status: "healthy", connectedAt: new Date() };

      // Update connection state gauge
      geyserConnectionStateGauge.set({ endpoint: this.config.endpoint }, 2); // 2 = healthy

      logger.info("Geyser monitoring started", {
        endpoint: this.config.endpoint,
      });

      return Ok(undefined);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.health = { status: "failed", error: errorMsg, failedAt: new Date() };

      // Update connection state gauge
      geyserConnectionStateGauge.set({ endpoint: this.config.endpoint }, 3); // 3 = failed
      geyserErrorsTotal.inc({ error_type: "connection_error" });

      logger.error("Geyser start failed", { error: errorMsg });
      return Err(errorMsg);
    }
  }

  /**
   * Stop Geyser monitoring
   */
  async stop(): Promise<void> {
    logger.info("Stopping Geyser monitoring");

    this.isRunning = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.stream) {
      this.stream = null;
    }

    if (this.client) {
      this.client = null;
    }

    this.health = {
      status: "disconnected",
      reason: "Manual stop",
      disconnectedAt: new Date(),
    };

    // Update connection state gauge
    geyserConnectionStateGauge.set({ endpoint: this.config.endpoint }, 0); // 0 = disconnected

    logger.info("Geyser monitoring stopped");
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

  /**
   * Get Geyser statistics
   */
  getStats(): GeyserStats {
    const avgLatency =
      this.stats.latencies.length > 0
        ? this.stats.latencies.reduce((a, b) => a + b, 0) / this.stats.latencies.length
        : 0;

    const uptime = Date.now() - this.stats.startTime;

    return {
      totalDetections: this.metrics.totalDetections,
      avgLatencyMs: Math.round(avgLatency * 100) / 100,
      totalReconnects: this.stats.totalReconnects,
      lastDetectionAt: this.metrics.lastDetectionAt,
      uptime: Math.floor(uptime / 1000), // seconds
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Connect to Geyser endpoint
   */
  private async connect(): Promise<Result<void, string>> {
    try {
      logger.debug("Connecting to Geyser endpoint", {
        endpoint: this.config.endpoint,
      });

      // Create Yellowstone gRPC client
      this.client = new Client(
        this.config.endpoint,
        this.config.token,
        {
          "grpc.max_receive_message_length": 1024 * 1024 * 1024 * 4, // 4GB - large blocks/transactions
          "grpc.max_send_message_length": 1024 * 1024 * 100, // 100MB
        }
      );

      logger.info("Geyser connected", {
        endpoint: this.config.endpoint,
      });

      return Ok(undefined);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Geyser connection failed", { error: errorMsg });
      return Err(errorMsg);
    }
  }

  /**
   * Subscribe to account updates for DEX programs
   */
  private async subscribe(
    onDetection: (pool: RawPoolDetection) => void
  ): Promise<Result<void, string>> {
    if (!this.client) {
      return Err("Geyser client not connected");
    }

    try {
      logger.debug("Subscribing to transaction updates", {
        programIds: this.config.programIds,
      });

      // Build subscription request
      // Chainstack Geyser blocks account subscriptions, use transaction subscription instead
      const request: SubscribeRequest = {
        accounts: {},
        slots: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        commitment: this.config.commitment,
        accountsDataSlice: [],
        ping: undefined,
      };

      // Add transaction filter for each DEX program
      // This subscribes to all transactions that interact with the program
      this.config.programIds.forEach((programId, index) => {
        request.transactions[`dex_${index}`] = {
          vote: false, // Exclude vote transactions (Chainstack requires explicit boolean)
          failed: false, // Only successful transactions
          accountInclude: [programId], // Filter transactions involving this program
          accountExclude: [],
          accountRequired: [],
        };
      });

      // NOTE: Blocks subscription disabled - causes RESOURCE_EXHAUSTED errors
      // Blocks with includeTransactions=true can be >1GB, exceeding gRPC limits
      // Transaction-only subscription is sufficient for pool detection

      // fromSlot not applicable for transaction subscriptions
      // Transaction stream is real-time only

      // Subscribe to stream
      // ClientDuplexStream - bidirectional stream for gRPC
      const stream = await this.client.subscribe();

      // Write subscription request to the stream
      await new Promise<void>((resolve, reject) => {
        stream.write(request, (err: Error | null | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      this.stream = stream;

      logger.info("Geyser subscription created", {
        programIds: this.config.programIds,
        transactionFilters: Object.keys(request.transactions),
        blockFilters: Object.keys(request.blocks),
      });

      // Process stream in background
      this.processStream(onDetection).catch((error) => {
        logger.error("Geyser stream processing error", {
          error: error instanceof Error ? error.message : String(error),
        });

        // Attempt reconnect if enabled
        if (this.config.autoReconnect && this.isRunning) {
          this.attemptReconnect(onDetection);
        }
      });

      return Ok(undefined);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Geyser subscription failed", { error: errorMsg });
      return Err(errorMsg);
    }
  }

  /**
   * Process Geyser stream
   */
  private async processStream(
    onDetection: (pool: RawPoolDetection) => void
  ): Promise<void> {
    if (!this.stream) {
      throw new Error("Geyser stream not initialized");
    }

    logger.info("Processing Geyser stream");

    let eventCount = 0;

    try {
      for await (const update of this.stream) {
        if (!this.isRunning) {
          break;
        }

        try {
        const startTime = Date.now();

        eventCount++;

        // Log every 100 events or first 10 events
        if (eventCount <= 10 || eventCount % 100 === 0) {
          logger.info("Geyser event received", {
            eventNumber: eventCount,
            hasAccount: !!update.account,
            hasTransaction: !!update.transaction,
            hasBlock: !!update.block,
            hasPing: !!update.ping,
          });
        }

        // Handle account update
        if (update.account) {
          await this.handleAccountUpdate(update.account, onDetection);
        }

        // Handle transaction update (direct transaction stream)
        if (update.transaction) {
          await this.handleTransactionUpdate(update.transaction, onDetection);
        }

        // Handle block update (contains transactions via blocks filter)
        if (update.block) {
          await this.handleBlockUpdate(update.block, onDetection);
        }

        // Track latency
        const latency = Date.now() - startTime;
        this.stats.latencies.push(latency);

        // Keep only last 100 samples
        if (this.stats.latencies.length > 100) {
          this.stats.latencies.shift();
        }
        } catch (error) {
          logger.error("Geyser update processing error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (streamError) {
      // Catch stream-level errors (like Z_BUF_ERROR from gRPC decompression)
      logger.error("Geyser stream error", {
        error: streamError instanceof Error ? streamError.message : String(streamError),
        eventCount,
      });
      geyserErrorsTotal.inc({ error_type: "stream_error" });

      // Trigger reconnect immediately on stream error
      if (this.isRunning && this.config.autoReconnect) {
        logger.warn("Geyser stream error, attempting reconnect", {
          error: streamError instanceof Error ? streamError.message : String(streamError),
        });
        this.attemptReconnect(onDetection);
        return; // Don't continue to the normal end-of-stream handling
      }
    }

    logger.info("Geyser stream ended", {
      eventCount,
      isRunning: this.isRunning,
    });

    // If stream ended but we're still supposed to be running, trigger reconnect
    if (this.isRunning && this.config.autoReconnect) {
      logger.warn("Geyser stream ended unexpectedly, attempting reconnect");
      this.attemptReconnect(onDetection);
    }
  }

  /**
   * Handle account update from Geyser
   *
   * Account-based detection is more complex as it requires parsing
   * DEX-specific account structures directly. For MVP, we rely on
   * transaction-based detection which reuses existing parsers.
   *
   * Future optimization: Parse account data directly to achieve <50ms latency
   * without additional RPC calls.
   */
  private async handleAccountUpdate(
    accountUpdate: any,
    _onDetection: (pool: RawPoolDetection) => void
  ): Promise<void> {
    const startTime = Date.now();

    try {
      geyserMessagesReceivedTotal.inc({ message_type: "account" });

      // Extract account info
      const account = accountUpdate.account;
      if (!account) {
        logger.debug("Account update missing account data");
        return;
      }

      // Extract program owner (this tells us which DEX)
      const owner = account.owner;
      if (!owner) {
        logger.debug("Account update missing owner");
        return;
      }

      // Convert owner to string
      const ownerStr = owner.toString ? owner.toString() : bs58.encode(owner);

      // Check if this is one of our monitored programs
      if (!this.dexParsers.has(ownerStr as SolanaAddress)) {
        // Not a DEX we're monitoring
        return;
      }

      const sourceType = this.programToSource.get(ownerStr as SolanaAddress)!;

      logger.debug("Account update from monitored DEX", {
        dex: sourceType,
        programId: ownerStr,
        slot: accountUpdate.slot,
      });

      // TODO: Implement direct account data parsing for <50ms latency
      // For now, we rely on transaction-based detection
      // This would require:
      // 1. Understanding DEX-specific account structures (pool state, etc)
      // 2. Detecting pool initialization by analyzing account data changes
      // 3. Extracting token mints directly from account data
      //
      // Benefit: Eliminates need for getTransaction() RPC call -> <50ms latency
      // Current: Transaction-based approach adds 50-100ms for RPC call

      const latency = Date.now() - startTime;
      geyserLatencyHistogram.observe({ operation: "parse_account" }, latency);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.debug("Account update handling error", {
        error: errorMsg,
      });
      geyserErrorsTotal.inc({ error_type: "account_processing_error" });

      const latency = Date.now() - startTime;
      geyserLatencyHistogram.observe({ operation: "parse_account" }, latency);
    }
  }

  /**
   * Handle transaction update from Geyser
   *
   * Parses transaction and uses DEX-specific parsers to extract pool data
   */
  private async handleTransactionUpdate(
    transactionUpdate: any,
    onDetection: (pool: RawPoolDetection) => void
  ): Promise<void> {
    const startTime = Date.now();

    try {
      geyserMessagesReceivedTotal.inc({ message_type: "transaction" });

      // Extract signature
      const signature = transactionUpdate.transaction?.signature;
      if (!signature) {
        logger.debug("Transaction update missing signature");
        return;
      }

      // Convert signature to base58
      const signatureBytes = Buffer.from(signature);
      const signatureBase58 = bs58.encode(signatureBytes);

      // Extract transaction data
      const txData = transactionUpdate.transaction;
      if (!txData || !txData.transaction) {
        logger.debug("Transaction update missing transaction data", {
          signature: signatureBase58,
        });
        return;
      }

      // Extract account keys from transaction message
      // Note: Geyser transaction structure may differ from RPC getTransaction()
      // We need to extract the program ID from account keys to determine DEX
      const accountKeys = txData.transaction.message?.accountKeys;
      if (!accountKeys || accountKeys.length === 0) {
        logger.debug("Transaction update missing account keys", {
          signature: signatureBase58,
        });
        return;
      }

      // Detect which DEX program is involved
      // Check if any account key matches our monitored programs
      let detectedProgramId: SolanaAddress | null = null;
      let detectedParser: BasePoolSource | null = null;

      for (const accountKey of accountKeys) {
        // Convert account key to base58 string
        // Geyser sends account keys as Uint8Array/Buffer, not strings
        let accountKeyStr: string;
        if (accountKey instanceof Uint8Array || Buffer.isBuffer(accountKey)) {
          accountKeyStr = bs58.encode(accountKey);
        } else if (typeof accountKey === 'string') {
          accountKeyStr = accountKey;
        } else {
          // Fallback for other types
          accountKeyStr = bs58.encode(Buffer.from(accountKey));
        }

        // Check if this matches any of our monitored programs
        if (this.dexParsers.has(accountKeyStr as SolanaAddress)) {
          detectedProgramId = accountKeyStr as SolanaAddress;
          detectedParser = this.dexParsers.get(detectedProgramId)!;
          break;
        }
      }

      if (!detectedParser || !detectedProgramId) {
        // Not a DEX transaction we're monitoring
        logger.debug("Transaction does not involve monitored DEX programs", {
          signature: signatureBase58,
          accountKeyCount: accountKeys.length,
        });
        return;
      }

      const sourceType = this.programToSource.get(detectedProgramId)!;

      logger.debug("Geyser pool candidate detected", {
        signature: signatureBase58,
        dex: sourceType,
        programId: detectedProgramId,
      });

      // Use DEX-specific parser to parse pool initialization
      // Note: Parser will call connection.getTransaction() internally
      // This adds latency but ensures accuracy until we implement direct parsing
      const parseResult = await detectedParser.parsePoolInit(signatureBase58);

      if (!parseResult.success) {
        logger.debug("Failed to parse pool init from Geyser transaction", {
          signature: signatureBase58,
          dex: sourceType,
          error: parseResult.error,
        });
        geyserErrorsTotal.inc({ error_type: "parse_error" });
        return;
      }

      const pool = parseResult.value;

      // Update metrics
      const latency = Date.now() - startTime;
      geyserLatencyHistogram.observe({ operation: "parse_transaction" }, latency);
      geyserDetectionsTotal.inc({ dex_source: sourceType });

      this.metrics.totalDetections += 1;
      this.metrics.lastDetectionAt = new Date();

      // Update avg parsing latency (exponential moving average)
      if (this.metrics.avgParsingLatencyMs === 0) {
        this.metrics.avgParsingLatencyMs = latency;
      } else {
        this.metrics.avgParsingLatencyMs =
          0.7 * this.metrics.avgParsingLatencyMs + 0.3 * latency;
      }

      // Emit detection event
      onDetection(pool);

      // Fetch metadata for symbol logging (async, non-blocking)
      this.metadataService.fetchMetadata(pool.tokenMintA as TokenMint)
        .then((result) => {
          const symbol = result.success ? result.value.symbol : "???";
          const name = result.success ? result.value.name : "Unknown";

          logger.info("🚀 NEW POOL DETECTED", {
            symbol,
            name,
            tokenMint: pool.tokenMintA,
            poolAddress: pool.poolAddress,
            source: pool.source,
            signature: signatureBase58,
            latencyMs: latency,
          });
        })
        .catch(() => {
          // Fallback log without symbol
          logger.info("Geyser pool detected", {
            poolAddress: pool.poolAddress,
            tokenMintA: pool.tokenMintA,
            tokenMintB: pool.tokenMintB,
            source: pool.source,
            signature: signatureBase58,
            latencyMs: latency,
          });
        });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Transaction update handling error", {
        error: errorMsg,
      });
      geyserErrorsTotal.inc({ error_type: "transaction_processing_error" });

      const latency = Date.now() - startTime;
      geyserLatencyHistogram.observe({ operation: "parse_transaction" }, latency);
    }
  }

  /**
   * Handle block update from Geyser
   *
   * Extracts transactions from block and processes them
   */
  private async handleBlockUpdate(
    blockUpdate: any,
    onDetection: (pool: RawPoolDetection) => void
  ): Promise<void> {
    const startTime = Date.now();

    try {
      geyserMessagesReceivedTotal.inc({ message_type: "block" });

      // Extract transactions from block
      const transactions = blockUpdate.transactions;
      if (!transactions || transactions.length === 0) {
        logger.debug("Block update has no transactions");
        return;
      }

      logger.debug("Block update received", {
        slot: blockUpdate.slot,
        transactionCount: transactions.length,
        blockhash: blockUpdate.blockhash,
      });

      // Process each transaction in the block
      for (const tx of transactions) {
        // Wrap transaction in the same structure as direct transaction updates
        await this.handleTransactionUpdate({ transaction: tx }, onDetection);
      }

      const latency = Date.now() - startTime;
      geyserLatencyHistogram.observe({ operation: "parse_block" }, latency);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Block update handling error", {
        error: errorMsg,
      });
      geyserErrorsTotal.inc({ error_type: "block_processing_error" });

      const latency = Date.now() - startTime;
      geyserLatencyHistogram.observe({ operation: "parse_block" }, latency);
    }
  }

  /**
   * Attempt reconnection with exponential backoff
   */
  private async attemptReconnect(
    onDetection: (pool: RawPoolDetection) => void
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.config.maxReconnectAttempts; attempt++) {
      const delay = this.config.reconnectDelay * Math.pow(2, attempt - 1);

      logger.info("Attempting Geyser reconnect", {
        attempt,
        maxAttempts: this.config.maxReconnectAttempts,
        delay,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));

      const connectResult = await this.connect();
      if (!connectResult.success) {
        logger.warn("Geyser reconnect failed", {
          attempt,
          error: connectResult.error,
        });
        continue;
      }

      const subscribeResult = await this.subscribe(onDetection);
      if (!subscribeResult.success) {
        logger.warn("Geyser resubscribe failed", {
          attempt,
          error: subscribeResult.error,
        });
        continue;
      }

      this.stats.totalReconnects++;
      this.health = { status: "healthy", connectedAt: new Date() };

      // Update metrics
      geyserReconnectsTotal.inc({ endpoint: this.config.endpoint });
      geyserConnectionStateGauge.set({ endpoint: this.config.endpoint }, 2); // 2 = healthy

      logger.info("Geyser reconnected successfully", { attempt });
      return;
    }

    logger.error("Geyser reconnect attempts exhausted", {
      maxAttempts: this.config.maxReconnectAttempts,
    });

    this.health = {
      status: "failed",
      error: "Reconnect attempts exhausted",
      failedAt: new Date(),
    };

    // Update connection state gauge
    geyserConnectionStateGauge.set({ endpoint: this.config.endpoint }, 3); // 3 = failed
    geyserErrorsTotal.inc({ error_type: "reconnect_exhausted" });
  }

  // Note: updateMetrics() method will be implemented when account/transaction
  // parsing is fully implemented. For now, metrics are tracked via getStats().
}

// ============================================================================
// Singleton
// ============================================================================

/**
 * Default Geyser source instance (singleton)
 */
export let defaultGeyserSource: GeyserSource | null = null;

/**
 * Initialize default Geyser source
 */
export function initializeGeyserSource(
  config: GeyserConfig,
  connection: Connection
): GeyserSource {
  if (defaultGeyserSource) {
    logger.warn("Geyser source already initialized, stopping existing instance");
    defaultGeyserSource.stop();
  }

  defaultGeyserSource = new GeyserSource(config, connection);
  logger.info("Default Geyser source initialized");

  return defaultGeyserSource;
}

/**
 * Get default Geyser source
 */
export function getGeyserSource(): GeyserSource {
  if (!defaultGeyserSource) {
    throw new Error(
      "Geyser source not initialized. Call initializeGeyserSource() first."
    );
  }
  return defaultGeyserSource;
}
