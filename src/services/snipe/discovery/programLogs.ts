import { EventEmitter } from "events";
import {
  Connection,
  LogsCallback,
  PublicKey,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { logger } from "../../../utils/logger.js";
import { getSolanaConnection } from "../../blockchain/solana.js";
import type { NewTokenEvent } from "../../../types/snipe.js";
import { asLamports, asTokenMint } from "../../../types/common.js";
import {
  SOL_MINT,
  KNOWN_TOKENS,
} from "../../../config/tokens.js";
import { fetchTokenMetadata } from "../../tokens/metadata.js";
import type { DiscoverySource } from "../../../types/snipe.js";
import {
  recordSnipeDiscoveryEvent,
  setProgramLogSubscriptionsActive,
  setProgramLogQueueSize,
  setProgramLogInFlight,
  observeProgramLogFetchDuration,
  recordProgramLogReconnection,
  recordProgramLogFetchError,
  recordProgramLogQueueDropped,
  updateProgramLogLastEventTimestamp,
} from "../../../utils/metrics.js";

type TokenDeltaMap = Map<string, bigint>;

interface ProgramLogMonitorOptions {
  source: DiscoverySource;
  programIds: string[];
  quoteMints?: string[];
  maxConcurrentFetches?: number;
  maxQueueSize?: number;
  fetchDelayMs?: number;
}

const DEFAULT_CONCURRENCY = 4;
const STABLE_MINTS = new Set<string>([
  KNOWN_TOKENS.USDC,
  KNOWN_TOKENS.USDT,
]);

export class ProgramLogMonitor extends EventEmitter {
  private readonly source: DiscoverySource;
  private readonly programIds: string[];
  private readonly quoteMints: Set<string>;
  private readonly maxConcurrentFetches: number;
  private connection: Connection | null = null;
  private subscriptions = new Map<string, number>();
  private processingQueue: string[] = [];
  private inFlight = new Set<string>();
  private activeFetches = 0;

  // ========== 2025 OPTIMIZATIONS: Reconnection Logic ==========
  private reconnectAttempts = new Map<string, number>();
  private readonly maxReconnects = 10;
  private readonly reconnectBaseDelayMs = 2000;

  // ========== 2025 OPTIMIZATIONS: Health Monitoring ==========
  private lastEventTime = new Map<string, number>();
  private healthCheckIntervalId: NodeJS.Timeout | null = null;
  private readonly healthCheckIntervalMs = 60000; // 1 minute
  private readonly stalenessThresholdMs = 300000; // 5 minutes

  // ========== 2025 OPTIMIZATIONS: Queue Overflow Protection ==========
  private readonly maxQueueSize: number;

  // ========== 2025 OPTIMIZATIONS: Fetch Timeout ==========
  private readonly fetchTimeoutMs = 30000; // 30 seconds

  // ========== 2025 OPTIMIZATIONS: Fetch Delay (for rate limiting) ==========
  private readonly fetchDelayMs: number;

  constructor(options: ProgramLogMonitorOptions) {
    super();
    this.source = options.source;
    this.programIds = options.programIds;
    this.quoteMints = new Set([
      SOL_MINT,
      KNOWN_TOKENS.WSOL,
      ...STABLE_MINTS,
      ...(options.quoteMints ?? []),
    ]);
    this.maxConcurrentFetches =
      options.maxConcurrentFetches ?? DEFAULT_CONCURRENCY;
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.fetchDelayMs = options.fetchDelayMs ?? 0;

    // Initialize last event times
    const now = Date.now();
    for (const programId of this.programIds) {
      this.lastEventTime.set(programId, now);
    }
  }

  async start(): Promise<void> {
    if (this.connection) {
      return;
    }

    this.connection = await getSolanaConnection();

    for (const programId of this.programIds) {
      await this.subscribeToProgramLogs(programId);
    }

    // ========== 2025 OPTIMIZATION: Start health monitoring ==========
    this.startHealthMonitoring();

    // Update metrics
    setProgramLogSubscriptionsActive(this.source, this.subscriptions.size);
  }

  async stop(): Promise<void> {
    if (!this.connection) {
      return;
    }

    // ========== 2025 OPTIMIZATION: Stop health monitoring ==========
    this.stopHealthMonitoring();

    for (const [programId, subscriptionId] of this.subscriptions.entries()) {
      try {
        await this.connection.removeOnLogsListener(subscriptionId);
        logger.info("Unsubscribed from program logs", {
          source: this.source,
          programId,
        });
      } catch (error) {
        logger.error("Failed to remove logs listener", {
          source: this.source,
          programId,
          error,
        });
      }
    }

    this.subscriptions.clear();
    this.connection = null;

    // Update metrics
    setProgramLogSubscriptionsActive(this.source, 0);
    setProgramLogQueueSize(this.source, 0);
    setProgramLogInFlight(this.source, 0);
  }

  private handleLogs = (logInfo: Parameters<LogsCallback>[0]): void => {
    const signature = logInfo.signature;
    if (!signature || this.inFlight.has(signature)) {
      return;
    }

    // ========== 2025 OPTIMIZATION: Update health timestamp ==========
    // Update timestamp for all subscribed programs (we received an event, so WebSocket is alive)
    const now = Date.now();
    for (const programId of this.subscriptions.keys()) {
      this.lastEventTime.set(programId, now);
    }

    // ========== 2025 OPTIMIZATION: Queue overflow protection ==========
    if (this.processingQueue.length >= this.maxQueueSize) {
      logger.warn("Processing queue full, dropping transaction", {
        source: this.source,
        signature,
        queueSize: this.processingQueue.length,
        maxQueueSize: this.maxQueueSize,
      });
      recordProgramLogQueueDropped(this.source);
      recordSnipeDiscoveryEvent(this.source, "ignored");
      return;
    }

    this.processingQueue.push(signature);
    setProgramLogQueueSize(this.source, this.processingQueue.length);
    this.processQueue();
  };

  private processQueue(): void {
    while (
      this.activeFetches < this.maxConcurrentFetches &&
      this.processingQueue.length > 0
    ) {
      const signature = this.processingQueue.shift();
      if (!signature || this.inFlight.has(signature)) {
        setProgramLogQueueSize(this.source, this.processingQueue.length);
        continue;
      }

      this.inFlight.add(signature);
      this.activeFetches++;

      // Update metrics
      setProgramLogQueueSize(this.source, this.processingQueue.length);
      setProgramLogInFlight(this.source, this.inFlight.size);

      this.fetchAndEmit(signature)
        .catch((error) => {
          logger.error("Failed to process program log transaction", {
            source: this.source,
            signature,
            error,
          });
          recordSnipeDiscoveryEvent(this.source, "error");

          // Record error type for metrics
          if (error instanceof Error) {
            if (error.message.includes("timeout")) {
              recordProgramLogFetchError(this.source, "timeout");
            } else if (error.message.includes("parse") || error.message.includes("Parse")) {
              recordProgramLogFetchError(this.source, "parse_error");
            } else {
              recordProgramLogFetchError(this.source, "rpc_error");
            }
            this.emit("error", error);
          } else {
            recordProgramLogFetchError(this.source, "rpc_error");
            this.emit("error", new Error(String(error)));
          }
        })
        .finally(() => {
          this.inFlight.delete(signature);
          this.activeFetches--;

          // Update metrics
          setProgramLogInFlight(this.source, this.inFlight.size);

          this.processQueue();
        });
    }
  }

  private async fetchAndEmit(signature: string): Promise<void> {
    if (!this.connection) {
      return;
    }

    // ========== 2025 OPTIMIZATION: Rate limiting delay ==========
    if (this.fetchDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.fetchDelayMs));
    }

    const startTime = Date.now();

    // ========== 2025 OPTIMIZATION: Timeout protection ==========
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Transaction fetch timeout after ${this.fetchTimeoutMs}ms`)),
        this.fetchTimeoutMs
      )
    );

    try {
      const response = await Promise.race([
        this.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }),
        timeoutPromise,
      ]);

      if (!response || !response.meta) {
        return;
      }

      const candidates = await this.extractEventsFromTransaction(
        signature,
        response
      );

      for (const event of candidates) {
        this.emit("newToken", event);
        recordSnipeDiscoveryEvent(this.source, "emitted");
      }

      // ========== 2025 OPTIMIZATION: Record successful fetch duration ==========
      const duration = Date.now() - startTime;
      observeProgramLogFetchDuration(this.source, duration);
    } catch (error) {
      // Record failed fetch duration
      const duration = Date.now() - startTime;
      observeProgramLogFetchDuration(this.source, duration);

      // Re-throw to be handled by processQueue
      throw error;
    }
  }

  private async extractEventsFromTransaction(
    signature: string,
    tx: VersionedTransactionResponse
  ): Promise<NewTokenEvent[]> {
    const meta = tx.meta;
    if (!meta) {
      return [];
    }

    const tokenDeltas = this.buildTokenDelta(meta);

    const liquidityLamports =
      (tokenDeltas.get(SOL_MINT) ?? 0n) +
      (tokenDeltas.get(KNOWN_TOKENS.WSOL) ?? 0n);

    const usdDelta = (tokenDeltas.get(KNOWN_TOKENS.USDC) ?? 0n) +
      (tokenDeltas.get(KNOWN_TOKENS.USDT) ?? 0n);
    const marketCapUsd =
      usdDelta > 0n ? Number(usdDelta) / 1_000_000 : undefined;

    const minted = Array.from(tokenDeltas.entries())
      .filter(
        ([mint, delta]) => delta > 0n && !this.quoteMints.has(mint)
      )
      .map(([mint, amount]) => ({ mint, amount }));

    if (minted.length === 0) {
      recordSnipeDiscoveryEvent(this.source, "ignored");
      return [];
    }

    const timestamp =
      tx.blockTime !== null && tx.blockTime !== undefined
        ? new Date(tx.blockTime * 1000)
        : new Date();

    const events: NewTokenEvent[] = [];

    // Fetch all token metadata in parallel for better performance
    const metadataPromises = minted.map((candidate) =>
      fetchTokenMetadata(candidate.mint)
        .then((metadata) => ({ candidate, metadata, error: null }))
        .catch((error) => ({ candidate, metadata: null, error }))
    );

    const metadataResults = await Promise.all(metadataPromises);

    for (const result of metadataResults) {
      if (result.error) {
        logger.warn("Failed to fetch token metadata from program logs", {
          source: this.source,
          mint: result.candidate.mint,
          signature,
          error: result.error,
        });
        continue;
      }

      try {
        events.push({
          source: this.source,
          mint: asTokenMint(result.candidate.mint),
          name: result.metadata?.name || result.candidate.mint,
          symbol: result.metadata?.symbol || result.candidate.mint.slice(0, 8),
          creator: undefined,
          liquidityLamports: asLamports(liquidityLamports < 0n ? 0n : liquidityLamports),
          marketCapUsd:
            marketCapUsd !== undefined
              ? Math.max(0, Math.round(marketCapUsd * 100))
              : undefined,
          tx: signature,
          timestamp,
        });
      } catch (error) {
        // Token mint validation errors are common (not all addresses are valid token mints)
        // Log as debug instead of warn to reduce noise
        logger.debug("Failed to create new token event from program logs", {
          source: this.source,
          mint: result.candidate.mint,
          signature,
          error,
        });
      }
    }

    if (events.length === 0) {
      recordSnipeDiscoveryEvent(this.source, "ignored");
    }

    return events;
  }

  private buildTokenDelta(meta: VersionedTransactionResponse["meta"]): TokenDeltaMap {
    const delta = new Map<string, bigint>();

    const postBalances = meta?.postTokenBalances ?? [];
    const preBalances = meta?.preTokenBalances ?? [];

    for (const balance of postBalances) {
      const amount = BigInt(balance.uiTokenAmount.amount || "0");
      if (amount === 0n) continue;
      const current = delta.get(balance.mint) ?? 0n;
      delta.set(balance.mint, current + amount);
    }

    for (const balance of preBalances) {
      const amount = BigInt(balance.uiTokenAmount.amount || "0");
      if (amount === 0n) continue;
      const current = delta.get(balance.mint) ?? 0n;
      delta.set(balance.mint, current - amount);
    }

    return delta;
  }

  // ========== 2025 OPTIMIZATION: Subscription Management ==========

  /**
   * Subscribe to program logs with automatic reconnection
   */
  private async subscribeToProgramLogs(programId: string): Promise<void> {
    if (!this.connection) {
      return;
    }

    try {
      const pubkey = new PublicKey(programId);
      const subscriptionId = await this.connection.onLogs(
        pubkey,
        this.handleLogs as LogsCallback,
        "confirmed"
      );

      this.subscriptions.set(programId, subscriptionId);
      this.reconnectAttempts.set(programId, 0); // Reset attempts on success

      logger.info("Subscribed to program logs", {
        source: this.source,
        programId,
        subscriptionId,
      });
    } catch (error) {
      logger.error("Failed to subscribe to program logs", {
        source: this.source,
        programId,
        error,
      });

      recordProgramLogReconnection(this.source, programId, "error");

      // Schedule reconnection
      await this.scheduleResubscribe(programId);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private async scheduleResubscribe(programId: string): Promise<void> {
    const attempts = this.reconnectAttempts.get(programId) ?? 0;

    if (attempts >= this.maxReconnects) {
      logger.error("Exhausted reconnect attempts for program", {
        source: this.source,
        programId,
        attempts,
      });
      return;
    }

    this.reconnectAttempts.set(programId, attempts + 1);

    // Exponential backoff with jitter
    const exponentialDelay = this.reconnectBaseDelayMs * Math.pow(2, attempts);
    const maxDelay = 30000; // Cap at 30 seconds
    const jitter = Math.random() * 1000; // 0-1000ms random jitter
    const delay = Math.min(exponentialDelay, maxDelay) + jitter;

    logger.info("Scheduling program log resubscription", {
      source: this.source,
      programId,
      attempt: attempts + 1,
      delayMs: Math.round(delay),
      strategy: "exponential-backoff-with-jitter",
    });

    await new Promise((resolve) => setTimeout(resolve, delay));

    // Try to resubscribe
    await this.subscribeToProgramLogs(programId);
  }

  // ========== 2025 OPTIMIZATION: Health Monitoring ==========

  /**
   * Start health monitoring for subscriptions
   * Checks if subscriptions are still receiving events
   */
  private startHealthMonitoring(): void {
    this.stopHealthMonitoring();

    this.healthCheckIntervalId = setInterval(() => {
      const now = Date.now();

      for (const programId of this.programIds) {
        const lastEvent = this.lastEventTime.get(programId) ?? now;
        const timeSinceLastEvent = now - lastEvent;

        // Update metrics
        updateProgramLogLastEventTimestamp(this.source, programId);

        // Check for staleness
        if (timeSinceLastEvent > this.stalenessThresholdMs) {
          logger.warn("No events from program logs, subscription may be stale", {
            source: this.source,
            programId,
            timeSinceLastEvent,
            stalenessThresholdMs: this.stalenessThresholdMs,
          });

          recordProgramLogReconnection(this.source, programId, "stale");

          // Proactively reconnect
          this.scheduleResubscribe(programId);
        } else {
          logger.debug("Program log subscription healthy", {
            source: this.source,
            programId,
            timeSinceLastEvent,
          });
        }
      }
    }, this.healthCheckIntervalMs);

    logger.debug("Program log health monitoring started", {
      source: this.source,
      healthCheckIntervalMs: this.healthCheckIntervalMs,
      stalenessThresholdMs: this.stalenessThresholdMs,
    });
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckIntervalId) {
      clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
      logger.debug("Program log health monitoring stopped", {
        source: this.source,
      });
    }
  }
}
