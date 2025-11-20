import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import type { PoolCreatedEvent } from "../../../src/types/sniper.js";
import {
  PoolDetectionService,
  type RedisPublisher,
} from "../../../src/services/sniper/detection/poolDetectionService.js";
import type { GeyserClient } from "../../../src/services/sniper/detection/geyserClient.js";
import {
  Ok,
  asLamports,
  asSolanaAddressUnsafe,
  asTokenMintUnsafe,
  asTransactionSignatureUnsafe,
} from "../../../src/types/common.js";

class FakeGeyserClient extends EventEmitter {
  async connect() {
    return Ok(undefined);
  }

  async disconnect() {
    return;
  }
}

const baseEvent: PoolCreatedEvent = {
  signature: asTransactionSignatureUnsafe("5wHu1qwD7q3S4ALZT6ddQbVmMCbBz2HpM4S1SYBsGLZp"),
  slot: 1,
  timestamp: 1_700_000_000_000,
  detectedAt: 1_700_000_000_050,
  dex: "pumpfun",
  poolAddress: asSolanaAddressUnsafe("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj"),
  baseMint: asTokenMintUnsafe("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
  quoteMint: asTokenMintUnsafe("So11111111111111111111111111111111111111112"),
  initialLiquidity: asLamports(100n),
  creator: asSolanaAddressUnsafe("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"),
};

describe("PoolDetectionService", () => {
  it("publishes events and deduplicates signatures", async () => {
    const geyser = new FakeGeyserClient();
    const redis = {
      messages: [] as string[],
      keys: new Map<string, string>(),
      publish: async (_channel: string, message: string) => {
        redis.messages.push(message);
        return 1;
      },
      set: async (key: string, value: string, ..._args: unknown[]) => {
        if (redis.keys.has(key)) {
          return null;
        }
        redis.keys.set(key, value);
        return "OK";
      },
    } satisfies RedisPublisher & { messages: string[]; keys: Map<string, string> };

    const service = new PoolDetectionService(geyser as unknown as GeyserClient, redis, {
      channel: "sniper:pools",
      dedupTtlSeconds: 60,
      latencyWarnThresholdMs: 1_000,
      dedupKeyPrefix: "test:pools",
    });

    await service.start();

    geyser.emit("pool:created", baseEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(redis.messages).toHaveLength(1);
    expect(redis.keys.size).toBe(2); // signature + pool keys

    geyser.emit("pool:created", baseEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(redis.messages).toHaveLength(1);

    await service.stop();
  });
});
