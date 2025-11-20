import type { Redis } from "ioredis";
import { createChildLogger } from "../../../utils/logger.js";
import {
  observePoolDetectionLatency,
  recordPoolDetection,
  recordPoolDetectionDuplicate,
} from "../../../utils/metrics.js";
import type {
  PoolCreatedEvent,
  PoolCreatedRedisMessage,
} from "../../../types/sniper.js";
import type { GeyserClient } from "./geyserClient.js";

export interface PoolDetectionServiceOptions {
  channel: string;
  dedupTtlSeconds: number;
  latencyWarnThresholdMs: number;
  dedupKeyPrefix?: string;
}

export type RedisPublisher = Pick<Redis, "publish" | "set">;

const DEFAULT_DEDUP_PREFIX = "sniper:pools:dedup";

export class PoolDetectionService {
  private running = false;
  private readonly log = createChildLogger({ module: "pool-detection" });

  private readonly onPoolCreated = (event: PoolCreatedEvent) => {
    void this.processEvent(event);
  };

  private readonly onConnected = () => {
    this.log.info("Geyser connected");
  };

  private readonly onDisconnected = (error?: Error) => {
    if (error) {
      this.log.warn("Geyser disconnected", { error: error.message });
    } else {
      this.log.warn("Geyser disconnected");
    }
  };

  private readonly onError = (error: Error) => {
    this.log.error("Geyser error", { error: error.message });
  };

  constructor(
    private readonly geyserClient: GeyserClient,
    private readonly redisClient: RedisPublisher,
    private readonly options: PoolDetectionServiceOptions
  ) {}

  async start(): Promise<void> {
    if (this.running) return;

    this.registerEventHandlers();
    const result = await this.geyserClient.connect();
    if (!result.success) {
      this.unregisterEventHandlers();
      this.log.error("Failed to start geyser client", {
        error: result.error.message,
      });
      throw result.error;
    }

    this.running = true;
    this.log.info("Pool detection service started", {
      channel: this.options.channel,
      dedupTtlSeconds: this.options.dedupTtlSeconds,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.unregisterEventHandlers();
    await this.geyserClient.disconnect();
    this.log.info("Pool detection service stopped");
  }

  private registerEventHandlers(): void {
    this.geyserClient.on("pool:created", this.onPoolCreated);
    this.geyserClient.on("connected", this.onConnected);
    this.geyserClient.on("disconnected", this.onDisconnected);
    this.geyserClient.on("error", this.onError);
  }

  private unregisterEventHandlers(): void {
    this.geyserClient.off("pool:created", this.onPoolCreated);
    this.geyserClient.off("connected", this.onConnected);
    this.geyserClient.off("disconnected", this.onDisconnected);
    this.geyserClient.off("error", this.onError);
  }

  private async processEvent(event: PoolCreatedEvent): Promise<void> {
    try {
      const shouldEmit = await this.acquireDedupLocks(event);
      if (!shouldEmit) {
        recordPoolDetectionDuplicate(event.dex);
        this.log.debug("Duplicate pool detection ignored", {
          signature: event.signature,
          pool: event.poolAddress,
        });
        return;
      }

      await this.publishEvent(event);
    } catch (error) {
      this.log.error("Failed to process pool detection event", {
        error: error instanceof Error ? error.message : String(error),
        signature: event.signature,
      });
    }
  }

  private async publishEvent(event: PoolCreatedEvent): Promise<void> {
    const now = Date.now();
    const totalLatencyMs = Math.max(now - event.timestamp, 0);
    const detectionLatencyMs = Math.max(event.detectedAt - event.timestamp, 0);
    const publishLatencyMs = Math.max(now - event.detectedAt, 0);

    const payload: PoolCreatedRedisMessage = {
      event,
      latencyMs: totalLatencyMs,
      publishedAt: new Date(now).toISOString(),
    };

    const serialized = JSON.stringify(payload, (_, value) =>
      typeof value === "bigint" ? value.toString() : value
    );

    await this.redisClient.publish(this.options.channel, serialized);

    recordPoolDetection(event.dex);
    observePoolDetectionLatency(event.dex, totalLatencyMs);

    const logFn =
      totalLatencyMs > this.options.latencyWarnThresholdMs
        ? this.log.warn
        : this.log.info;
    logFn("Pool detection published", {
      signature: event.signature,
      dex: event.dex,
      baseMint: event.baseMint,
      quoteMint: event.quoteMint,
      pool: event.poolAddress,
      latencyMs: totalLatencyMs,
      detectionLatencyMs,
      publishLatencyMs,
      initialLiquidity: event.initialLiquidity.toString(),
    });
  }

  private async acquireDedupLocks(event: PoolCreatedEvent): Promise<boolean> {
    const ttlSeconds = Math.max(this.options.dedupTtlSeconds, 1);
    const prefix = this.options.dedupKeyPrefix ?? DEFAULT_DEDUP_PREFIX;
    const dedupKeys = [
      `${prefix}:sig:${event.signature}`,
      `${prefix}:pool:${event.poolAddress}`,
    ];

    const results = await Promise.all(
      dedupKeys.map((key) =>
        this.redisClient.set(key, event.signature, "EX", ttlSeconds, "NX")
      )
    );

    return results.some((result) => result === "OK");
  }
}
