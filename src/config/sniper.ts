import { z } from "zod";
import type { DexType } from "../types/sniper.js";

export interface SniperDetectionConfig {
  enabled: boolean;
  geyser: {
    endpoint: string;
    token: string;
    commitment: "processed" | "confirmed";
    reconnectDelayMs: number;
    maxReconnectAttempts: number;
    enabledDexs: DexType[];
  };
  redisChannel: string;
  dedupTtlSeconds: number;
  latencyWarnThresholdMs: number;
}

const DEFAULT_ENABLED_DEXS: DexType[] = [
  "pumpfun",
  "raydium_v4",
  "raydium_clmm",
  "meteora",
];

const envSchema = z.object({
  SNIPER_DETECTION_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  GEYSER_ENDPOINT: z
    .string()
    .default("https://yellowstone-solana-mainnet.core.chainstack.com"),
  GEYSER_TOKEN: z.string().optional(),
  GEYSER_COMMITMENT: z
    .enum(["processed", "confirmed"])
    .default("processed"),
  GEYSER_RECONNECT_DELAY_MS: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return 1000;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
    }),
  GEYSER_MAX_RECONNECT_ATTEMPTS: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return 10;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    }),
  SNIPER_POOL_CHANNEL: z.string().default("sniper:pools:created"),
  SNIPER_POOL_DEDUP_TTL_SECONDS: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return 180;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
    }),
  SNIPER_DEX_FILTER: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return DEFAULT_ENABLED_DEXS;
      const normalized = value
        .split(",")
        .map((dex) => dex.trim().toLowerCase())
        .filter(Boolean) as DexType[];
      return normalized.length > 0 ? normalized : DEFAULT_ENABLED_DEXS;
    }),
  SNIPER_LATENCY_WARN_MS: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return 2500;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 2500;
    }),
});

let cachedConfig: SniperDetectionConfig | null = null;

export function getSniperDetectionConfig(): SniperDetectionConfig {
  if (cachedConfig) return cachedConfig;

  const parsed = envSchema.parse(process.env);
  const token = parsed.GEYSER_TOKEN?.trim() ?? "";
  const enabled = parsed.SNIPER_DETECTION_ENABLED && token.length > 0;

  cachedConfig = {
    enabled,
    geyser: {
      endpoint: parsed.GEYSER_ENDPOINT,
      token,
      commitment: parsed.GEYSER_COMMITMENT,
      reconnectDelayMs: parsed.GEYSER_RECONNECT_DELAY_MS,
      maxReconnectAttempts: parsed.GEYSER_MAX_RECONNECT_ATTEMPTS,
      enabledDexs: parsed.SNIPER_DEX_FILTER,
    },
    redisChannel: parsed.SNIPER_POOL_CHANNEL,
    dedupTtlSeconds: parsed.SNIPER_POOL_DEDUP_TTL_SECONDS,
    latencyWarnThresholdMs: parsed.SNIPER_LATENCY_WARN_MS,
  };

  return cachedConfig;
}
