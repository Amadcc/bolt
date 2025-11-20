import { getSniperDetectionConfig } from "../../../config/sniper.js";
import { redis } from "../../../utils/redis.js";
import { createChildLogger } from "../../../utils/logger.js";
import { createGeyserClient } from "./geyserClient.js";
import { PoolDetectionService } from "./poolDetectionService.js";

let detectionService: PoolDetectionService | null = null;
const log = createChildLogger({ module: "sniper-detection-init" });

export async function initializeSniperDetection(): Promise<boolean> {
  const config = getSniperDetectionConfig();

  if (!config.enabled) {
    log.info("Sniper detection disabled (missing token or env override)");
    return false;
  }

  if (detectionService) {
    log.warn("Sniper detection already initialized");
    return false;
  }

  const { enabledDexs: _enabledDexs, ...geyserConfig } = config.geyser;

  const geyserClient = createGeyserClient(geyserConfig);

  detectionService = new PoolDetectionService(geyserClient, redis, {
    channel: config.redisChannel,
    dedupTtlSeconds: config.dedupTtlSeconds,
    latencyWarnThresholdMs: config.latencyWarnThresholdMs,
    dedupKeyPrefix: "sniper:pool:detection",
  });

  await detectionService.start();
  return true;
}

export async function shutdownSniperDetection(): Promise<boolean> {
  if (!detectionService) return false;
  await detectionService.stop();
  detectionService = null;
  return true;
}

export function getPoolDetectionService(): PoolDetectionService | null {
  return detectionService;
}
