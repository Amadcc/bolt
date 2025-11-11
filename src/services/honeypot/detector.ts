/**
 * Honeypot Detection Service
 *
 * Multi-layer detection system with fallback chain:
 * - Layer 1: API Providers (GoPlus → RugCheck → TokenSniffer)
 * - Layer 2: On-chain checks (authority verification)
 * - Layer 3: Redis caching (1 hour TTL)
 *
 * Circuit breaker per API provider for resilience
 * Expected accuracy: 85-90% (with fallback)
 * Expected latency: 1-3s (with cache: <10ms)
 */

import { PublicKey } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { redis } from "../../utils/redis.js";
import { getSolana } from "../blockchain/solana.js";
import { recordHoneypotDetection } from "../../utils/metrics.js";
import { FallbackChain } from "./fallbackChain.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import type {
  HoneypotCheckResult,
  HoneypotError,
  HoneypotDetectorConfig,
  APILayerResult,
  OnChainLayerResult,
  HoneypotFlag,
  RiskScore,
  CachedHoneypotResult,
  APIProviderConfig,
  CircuitBreakerConfig,
  HoneypotDetectorOverrides,
  HoneypotProviderName,
} from "../../types/honeypot.js";
import { asRiskScore } from "../../types/honeypot.js";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60000,
  monitoringPeriod: 120000,
};

const DEFAULT_PROVIDER_CONFIG: APIProviderConfig = {
  enabled: true,
  priority: 1,
  timeout: 5000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER,
};

const DEFAULT_CONFIG: HoneypotDetectorConfig = {
  providers: {
    goplus: {
      ...DEFAULT_PROVIDER_CONFIG,
      priority: 1, // Highest priority (fastest)
    },
    rugcheck: {
      ...DEFAULT_PROVIDER_CONFIG,
      priority: 2, // Second priority (Solana-specific)
    },
    tokensniffer: {
      ...DEFAULT_PROVIDER_CONFIG,
      enabled: false, // Disabled by default (requires API key + paid)
      priority: 3, // Lowest priority (most comprehensive but slowest)
    },
  },
  fallbackChain: {
    enabled: true,
    stopOnFirstSuccess: true,
    maxProviders: 3,
  },
  highRiskThreshold: 70,
  mediumRiskThreshold: 30,
  cacheTTL: 3600, // 1 hour
  cacheEnabled: true,
  enableOnChainChecks: true,
};

// ============================================================================
// Honeypot Detector Class
// ============================================================================

export class HoneypotDetector {
  private config: HoneypotDetectorConfig;
  private fallbackChain: FallbackChain;

  constructor(config: HoneypotDetectorOverrides = {}) {
    // Deep merge config
    this.config = this.mergeConfig(DEFAULT_CONFIG, config);

    // Initialize fallback chain
    this.fallbackChain = new FallbackChain(this.config);

    logger.info("Honeypot detector initialized", {
      cacheEnabled: this.config.cacheEnabled,
      cacheTTL: this.config.cacheTTL,
      onChainEnabled: this.config.enableOnChainChecks,
      fallbackEnabled: this.config.fallbackChain.enabled,
      enabledProviders: this.getEnabledProviderNames(),
    });
  }

  /**
   * Check if token is honeypot
   * Returns cached result if available, otherwise performs full analysis
   */
  async check(tokenMint: string): Promise<Result<HoneypotCheckResult, HoneypotError>> {
    const startTime = Date.now();

    try {
      // Validate token mint
      try {
        new PublicKey(tokenMint);
      } catch {
        return Err({
          type: "INVALID_TOKEN",
          tokenMint,
        });
      }

      // Check cache first
      if (this.config.cacheEnabled) {
        const cached = await this.getFromCache(tokenMint);
        if (cached) {
          logger.debug("Honeypot check: cache hit", {
            tokenMint: tokenMint.slice(0, 8),
            riskScore: cached.riskScore,
            age: Date.now() - cached.checkedAt.getTime(),
          });
          return Ok(cached);
        }
      }

      logger.info("Honeypot check: starting analysis", { tokenMint });

      // Perform multi-layer analysis
      const [apiResult, onChainResult] = await Promise.all([
        this.config.fallbackChain.enabled
          ? this.fallbackChain.execute(tokenMint)
          : Promise.resolve(null),
        this.config.enableOnChainChecks
          ? this.checkOnChainLayer(tokenMint)
          : Promise.resolve(null),
      ]);

      // Calculate weighted risk score
      const { riskScore, flags } = this.calculateRiskScore(
        apiResult,
        onChainResult
      );

      const result: HoneypotCheckResult = {
        tokenMint,
        isHoneypot: riskScore >= this.config.highRiskThreshold,
        riskScore,
        confidence: this.calculateConfidence(apiResult, onChainResult),
        flags,
        checkedAt: new Date(),
        analysisTimeMs: Date.now() - startTime,
        layers: {
          api: apiResult || undefined,
          onchain: onChainResult || undefined,
        },
      };

      // Cache result
      if (this.config.cacheEnabled) {
        await this.saveToCache(tokenMint, result);
      }

      const riskLevel: "low" | "medium" | "high" =
        result.riskScore >= this.config.highRiskThreshold
          ? "high"
          : result.riskScore >= this.config.mediumRiskThreshold
            ? "medium"
            : "low";
      recordHoneypotDetection(riskLevel);

      logger.info("Honeypot check: completed", {
        tokenMint: tokenMint.slice(0, 8),
        isHoneypot: result.isHoneypot,
        riskScore: result.riskScore,
        flags: result.flags,
        apiProvider: apiResult?.source || "none",
        timeMs: result.analysisTimeMs,
      });

      return Ok(result);
    } catch (error) {
      logger.error("Honeypot check: unexpected error", {
        tokenMint,
        error,
        timeMs: Date.now() - startTime,
      });

      return Err({
        type: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get status of all providers (for admin/monitoring)
   */
  getProvidersStatus() {
    const providers = this.fallbackChain.getAllProviders();
    return providers.map((provider) => ({
      name: provider.name,
      priority: provider.priority,
      available: provider.isAvailable(),
      metrics: provider.getMetrics(),
    }));
  }

  /**
   * Reset all circuit breakers (for admin/testing)
   */
  resetAllProviders(): void {
    logger.info("Resetting all providers");
    this.fallbackChain.resetAll();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Layer 2: On-chain checks
   * Verify mint/freeze authority directly on blockchain
   */
  private async checkOnChainLayer(
    tokenMint: string
  ): Promise<OnChainLayerResult | null> {
    const startTime = Date.now();

    try {
      const solana = getSolana();
      const connection = await solana.getConnection();
      const mintPublicKey = new PublicKey(tokenMint);

      // Get mint account info
      const mintInfo = await connection.getParsedAccountInfo(mintPublicKey);

      if (!mintInfo.value || !mintInfo.value.data) {
        logger.warn("On-chain check: mint account not found", { tokenMint });
        return null;
      }

      // Parse mint data
      const data = mintInfo.value.data;
      if (!("parsed" in data) || data.parsed.type !== "mint") {
        logger.warn("On-chain check: invalid mint account", { tokenMint });
        return null;
      }

      const mintData = data.parsed.info;
      const flags: HoneypotFlag[] = [];
      let score = 0;

      // Check mint authority
      const mintAuthority = mintData.mintAuthority;
      if (mintAuthority) {
        flags.push("MINT_AUTHORITY");
        score += 40;
      }

      // Check freeze authority
      const freezeAuthority = mintData.freezeAuthority;
      if (freezeAuthority) {
        flags.push("FREEZE_AUTHORITY");
        score += 30;
      }

      // Check metadata existence
      const hasMetadata = await this.checkMetadata(mintPublicKey);

      return {
        mintAuthority,
        freezeAuthority,
        supply: BigInt(mintData.supply),
        decimals: mintData.decimals,
        hasMetadata,
        score: Math.min(score, 100),
        flags,
        timeMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      logger.error("On-chain check: error", { error, tokenMint });
      return null;
    }
  }

  /**
   * Check if token has Metaplex metadata
   */
  private async checkMetadata(mintPublicKey: PublicKey): Promise<boolean> {
    try {
      const solana = getSolana();
      const connection = await solana.getConnection();

      // Derive metadata PDA
      const METADATA_PROGRAM_ID = new PublicKey(
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
      );

      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("metadata"),
          METADATA_PROGRAM_ID.toBuffer(),
          mintPublicKey.toBuffer(),
        ],
        METADATA_PROGRAM_ID
      );

      const accountInfo = await connection.getAccountInfo(metadataPDA);
      return accountInfo !== null;
    } catch {
      return false;
    }
  }

  /**
   * Calculate weighted risk score from all layers
   */
  private calculateRiskScore(
    apiResult: APILayerResult | null,
    onChainResult: OnChainLayerResult | null
  ): { riskScore: RiskScore; flags: HoneypotFlag[] } {
    let totalScore = 0;
    let totalWeight = 0;
    const allFlags = new Set<HoneypotFlag>();

    // API layer weight: 0.6
    if (apiResult) {
      totalScore += apiResult.score * 0.6;
      totalWeight += 0.6;
      apiResult.flags.forEach((flag) => allFlags.add(flag));
    }

    // On-chain layer weight: 0.4
    if (onChainResult) {
      totalScore += onChainResult.score * 0.4;
      totalWeight += 0.4;
      onChainResult.flags.forEach((flag) => allFlags.add(flag));
    }

    // Normalize score
    const finalScore = totalWeight > 0 ? totalScore / totalWeight : 0;

    return {
      riskScore: asRiskScore(Math.round(finalScore)),
      flags: Array.from(allFlags),
    };
  }

  /**
   * Calculate confidence in result (0-100)
   */
  private calculateConfidence(
    apiResult: APILayerResult | null,
    onChainResult: OnChainLayerResult | null
  ): number {
    let confidence = 0;

    // Base confidence from successful checks
    if (apiResult) confidence += 60;
    if (onChainResult) confidence += 40;

    // Reduce confidence if results disagree significantly
    if (apiResult && onChainResult) {
      const scoreDiff = Math.abs(apiResult.score - onChainResult.score);
      if (scoreDiff > 40) {
        confidence -= 20; // Low agreement
      }
    }

    return Math.max(0, Math.min(100, confidence));
  }

  /**
   * Get result from Redis cache
   */
  private async getFromCache(
    tokenMint: string
  ): Promise<HoneypotCheckResult | null> {
    try {
      const key = `honeypot:${tokenMint}`;
      const cached = await redis.get(key);

      if (!cached) return null;

      const data: CachedHoneypotResult = JSON.parse(cached);

      // Check expiration
      if (Date.now() > data.expiresAt) {
        await redis.del(key);
        return null;
      }

      // Reconstruct result
      return {
        ...data.result,
        checkedAt: new Date(data.result.checkedAt),
        riskScore: asRiskScore(data.result.riskScore),
      };
    } catch (error) {
      logger.warn("Cache get failed", { error, tokenMint });
      return null;
    }
  }

  /**
   * Save result to Redis cache
   */
  private async saveToCache(
    tokenMint: string,
    result: HoneypotCheckResult
  ): Promise<void> {
    try {
      const key = `honeypot:${tokenMint}`;
      const now = Date.now();

      const cached: CachedHoneypotResult = {
        result,
        cachedAt: now,
        expiresAt: now + this.config.cacheTTL * 1000,
      };

      // Serialize with BigInt support (convert to string)
      await redis.setex(
        key,
        this.config.cacheTTL,
        JSON.stringify(cached, (_, value) =>
          typeof value === "bigint" ? value.toString() : value
        )
      );
    } catch (error) {
      logger.warn("Cache save failed", { error, tokenMint });
      // Don't fail the request if caching fails
    }
  }

  /**
   * Deep merge configuration
   */
  private mergeConfig(
    defaultConfig: HoneypotDetectorConfig,
    userConfig: HoneypotDetectorOverrides
  ): HoneypotDetectorConfig {
    return {
      providers: {
        goplus: {
          ...defaultConfig.providers.goplus,
          ...userConfig.providers?.goplus,
        },
        rugcheck: {
          ...defaultConfig.providers.rugcheck,
          ...userConfig.providers?.rugcheck,
        },
        tokensniffer: {
          ...defaultConfig.providers.tokensniffer,
          ...userConfig.providers?.tokensniffer,
        },
      },
      fallbackChain: {
        ...defaultConfig.fallbackChain,
        ...userConfig.fallbackChain,
      },
      highRiskThreshold:
        userConfig.highRiskThreshold ?? defaultConfig.highRiskThreshold,
      mediumRiskThreshold:
        userConfig.mediumRiskThreshold ?? defaultConfig.mediumRiskThreshold,
      cacheTTL: userConfig.cacheTTL ?? defaultConfig.cacheTTL,
      cacheEnabled: userConfig.cacheEnabled ?? defaultConfig.cacheEnabled,
      enableOnChainChecks:
        userConfig.enableOnChainChecks ?? defaultConfig.enableOnChainChecks,
    };
  }

  /**
   * Get enabled provider names
   */
  private getEnabledProviderNames(): HoneypotProviderName[] {
    const names: HoneypotProviderName[] = [];
    if (this.config.providers.goplus.enabled) names.push("goplus");
    if (this.config.providers.rugcheck.enabled) names.push("rugcheck");
    if (this.config.providers.tokensniffer.enabled) names.push("tokensniffer");
    return names;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let honeypotDetectorInstance: HoneypotDetector | null = null;

export function initializeHoneypotDetector(
  config?: HoneypotDetectorOverrides
): HoneypotDetector {
  if (honeypotDetectorInstance) {
    logger.warn(
      "Honeypot detector already initialized, returning existing instance"
    );
    return honeypotDetectorInstance;
  }

  honeypotDetectorInstance = new HoneypotDetector(config);
  return honeypotDetectorInstance;
}

export function getHoneypotDetector(): HoneypotDetector {
  if (!honeypotDetectorInstance) {
    throw new Error(
      "Honeypot detector not initialized. Call initializeHoneypotDetector() first"
    );
  }

  return honeypotDetectorInstance;
}
