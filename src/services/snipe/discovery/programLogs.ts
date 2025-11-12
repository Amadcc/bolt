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
import { recordSnipeDiscoveryEvent } from "../../../utils/metrics.js";

type TokenDeltaMap = Map<string, bigint>;

interface ProgramLogMonitorOptions {
  source: DiscoverySource;
  programIds: string[];
  quoteMints?: string[];
  maxConcurrentFetches?: number;
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
  }

  async start(): Promise<void> {
    if (this.connection) {
      return;
    }

    this.connection = await getSolanaConnection();

    for (const programId of this.programIds) {
      try {
        const pubkey = new PublicKey(programId);
        const subscriptionId = await this.connection.onLogs(
          pubkey,
          this.handleLogs as LogsCallback,
          "confirmed"
        );

        this.subscriptions.set(programId, subscriptionId);
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
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.connection) {
      return;
    }

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
  }

  private handleLogs = (logInfo: Parameters<LogsCallback>[0]): void => {
    const signature = logInfo.signature;
    if (!signature || this.inFlight.has(signature)) {
      return;
    }

    this.processingQueue.push(signature);
    this.processQueue();
  };

  private processQueue(): void {
    while (
      this.activeFetches < this.maxConcurrentFetches &&
      this.processingQueue.length > 0
    ) {
      const signature = this.processingQueue.shift();
      if (!signature || this.inFlight.has(signature)) {
        continue;
      }

      this.inFlight.add(signature);
      this.activeFetches++;

      this.fetchAndEmit(signature)
        .catch((error) => {
          logger.error("Failed to process program log transaction", {
            source: this.source,
            signature,
            error,
          });
          recordSnipeDiscoveryEvent(this.source, "error");
          if (error instanceof Error) {
            this.emit("error", error);
          } else {
            this.emit("error", new Error(String(error)));
          }
        })
        .finally(() => {
          this.inFlight.delete(signature);
          this.activeFetches--;
          this.processQueue();
        });
    }
  }

  private async fetchAndEmit(signature: string): Promise<void> {
    if (!this.connection) {
      return;
    }

    const response = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

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
        logger.warn("Failed to create new token event from program logs", {
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
}
