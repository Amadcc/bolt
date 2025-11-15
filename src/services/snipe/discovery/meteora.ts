import { ProgramLogMonitor } from "./programLogs.js";
import type { DiscoverySource } from "../../../types/snipe.js";

/**
 * Meteora DEX Program IDs
 *
 * Meteora is a highly active DEX on Solana with:
 * - Dynamic Liquidity Market Maker (DLMM) - concentrated liquidity pools
 * - Traditional AMM pools
 *
 * ⚠️ PERFORMANCE NOTES:
 * - Meteora generates VERY high event volume (5-10x more than Raydium/Orca)
 * - Default settings: reduced concurrency (2) + delays (200ms) to prevent rate limits
 * - Queue size increased to 5000 to handle burst traffic
 *
 * Configure via environment variables:
 * - SNIPE_METEORA_PROGRAM_IDS: comma-separated program IDs (defaults below)
 * - SNIPE_METEORA_CONCURRENCY: max concurrent fetches (default: 2)
 * - SNIPE_METEORA_DELAY_MS: delay between fetches in ms (default: 200)
 * - SNIPE_METEORA_QUEUE_SIZE: max queue size (default: 5000)
 */
const DEFAULT_PROGRAMS = [
  // Meteora DLMM (Dynamic Liquidity Market Maker)
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  // Meteora Pools
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
];

function resolveProgramIds(envVar: string | undefined, fallback: string[]): string[] {
  if (!envVar || envVar.trim().length === 0) {
    return fallback;
  }

  return envVar
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Meteora Log Monitor
 *
 * Monitors Meteora DEX for new token pair creations.
 * Optimized for high-volume event streams with rate limiting protection.
 */
export class MeteoraLogMonitor extends ProgramLogMonitor {
  constructor() {
    const programIds = resolveProgramIds(
      process.env.SNIPE_METEORA_PROGRAM_IDS,
      DEFAULT_PROGRAMS
    );

    // Parse configuration from environment with safe defaults
    const concurrency = parseInt(process.env.SNIPE_METEORA_CONCURRENCY || "2", 10);
    const delayMs = parseInt(process.env.SNIPE_METEORA_DELAY_MS || "200", 10);
    const queueSize = parseInt(process.env.SNIPE_METEORA_QUEUE_SIZE || "5000", 10);

    super({
      source: "meteora" as DiscoverySource,
      programIds,
      // Meteora is very active, use conservative defaults to avoid rate limits
      maxConcurrentFetches: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 2,
      maxQueueSize: Number.isFinite(queueSize) && queueSize > 0 ? queueSize : 5000,
      fetchDelayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 200,
    });
  }
}
