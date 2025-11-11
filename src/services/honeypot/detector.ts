/**
 * Honeypot Detection Service
 *
 * Multi-layer detection system:
 * - Layer 1: GoPlus API (fast, 80-85% accuracy)
 * - Layer 2: On-chain checks (authority verification)
 * - Layer 3: Redis caching (1 hour TTL)
 *
 * Expected accuracy: 80-85% (MVP)
 * Expected latency: 1-3s (with cache: <10ms)
 */

import { PublicKey } from "@solana/web3.js";
import axios, { type AxiosInstance, type AxiosResponse, type AxiosError } from "axios";
import { logger } from "../../utils/logger.js";
import { redis } from "../../utils/redis.js";
import { getSolana } from "../blockchain/solana.js";
import { recordHoneypotDetection } from "../../utils/metrics.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import type {
  HoneypotCheckResult,
  HoneypotError,
  HoneypotDetectorConfig,
  APILayerResult,
  OnChainLayerResult,
  GoPlusResponse,
  HoneypotFlag,
  RiskScore,
  CachedHoneypotResult,
} from "../../types/honeypot.js";
import { asRiskScore } from "../../types/honeypot.js";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG: HoneypotDetectorConfig = {
  goPlusTimeout: 5000,
  highRiskThreshold: 70,
  mediumRiskThreshold: 30,
  cacheTTL: 3600, // 1 hour
  cacheEnabled: true,
  enableGoPlusAPI: true,
  enableOnChainChecks: true,
};

// ============================================================================
// Honeypot Detector Class
// ============================================================================

export class HoneypotDetector {
  private config: HoneypotDetectorConfig;
  private apiClient: AxiosInstance;
  private requestCount = 0;
  private lastReset = Date.now();

  constructor(config: Partial<HoneypotDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create axios instance with retry logic
    this.apiClient = axios.create({
      timeout: this.config.goPlusTimeout,
      headers: {
        "Accept": "application/json",
        "User-Agent": "TokenSniperBot/1.0",
      },
    });

    // Add retry interceptor
    this.apiClient.interceptors.response.use(
      (response: AxiosResponse) => response,
      async (error: AxiosError) => {
        const config = error.config as any;

        if (!config || !config.retry) {
          config.retry = 0;
        }

        if (config.retry >= 3) {
          return Promise.reject(error);
        }

        config.retry += 1;

        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, config.retry - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));

        logger.warn("Retrying API request", {
          url: config.url,
          attempt: config.retry,
          delay,
        });

        return this.apiClient(config);
      }
    );

    logger.info("Honeypot detector initialized", {
      goPlusEnabled: this.config.enableGoPlusAPI,
      onChainEnabled: this.config.enableOnChainChecks,
      cacheEnabled: this.config.cacheEnabled,
      cacheTTL: this.config.cacheTTL,
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
        this.config.enableGoPlusAPI
          ? this.checkAPILayer(tokenMint)
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
   * Layer 1: GoPlus API check
   * Fast baseline check using external API
   */
  private async checkAPILayer(
    tokenMint: string
  ): Promise<APILayerResult | null> {
    const startTime = Date.now();

    try {
      // Rate limiting: max 60 requests per minute
      await this.rateLimit();

      const response = await this.apiClient.get<GoPlusResponse>(
        "https://api.gopluslabs.io/api/v1/token_security/solana",
        {
          params: {
            contract_addresses: tokenMint,
          },
        }
      );

      if (response.data.code !== 1) {
        logger.warn("GoPlus API: non-success code", {
          code: response.data.code,
          message: response.data.message,
        });
        return null;
      }

      // Check if result object exists
      if (!response.data.result) {
        logger.warn("GoPlus API: no result data", { tokenMint });
        return null;
      }

      const tokenData = response.data.result[tokenMint];
      if (!tokenData) {
        logger.warn("GoPlus API: token not found", { tokenMint });
        return null;
      }

      // Analyze results
      const flags: HoneypotFlag[] = [];
      let score = 0;

      // Check mint authority
      if (tokenData.is_mintable === "1") {
        flags.push("MINT_AUTHORITY");
        score += 30;
      }

      // Check ownership changes
      if (tokenData.can_take_back_ownership === "1") {
        flags.push("OWNER_CHANGE_POSSIBLE");
        score += 40;
      }

      // Check sell tax
      const sellTax = parseFloat(tokenData.sell_tax);
      if (sellTax > 0.5) {
        // > 50%
        flags.push("HIGH_SELL_TAX");
        score += 50;
      }

      // Check honeypot flag
      if (tokenData.is_honeypot === "1") {
        score = 100; // Definite honeypot
      }

      // Check holder concentration
      if (tokenData.holder_list && tokenData.holder_list.length > 0) {
        const top10Percent = tokenData.holder_list
          .slice(0, 10)
          .reduce((sum: number, holder: any) => sum + parseFloat(holder.percent), 0);

        if (top10Percent > 80) {
          flags.push("CENTRALIZED");
          score += 20;
        }

        const topHolder = parseFloat(tokenData.holder_list[0].percent);
        if (topHolder > 50) {
          flags.push("SINGLE_HOLDER_MAJORITY");
          score += 25;
        }
      }

      return {
        source: "goplus",
        score: Math.min(score, 100),
        flags,
        data: tokenData,
        timeMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          logger.warn("GoPlus API: rate limited");
          return null;
        }

        if (error.code === "ECONNABORTED") {
          logger.warn("GoPlus API: timeout");
          return null;
        }
      }

      logger.error("GoPlus API: error", { error, tokenMint });
      return null;
    }
  }

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
      const mintInfo = await connection.getParsedAccountInfo(
        mintPublicKey
      );

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
   * Rate limiting: max 60 requests per minute
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastReset;

    // Reset counter every minute
    if (elapsed >= 60000) {
      this.requestCount = 0;
      this.lastReset = now;
      return;
    }

    // Check limit
    if (this.requestCount >= 60) {
      const waitTime = 60000 - elapsed;
      logger.warn("Rate limit reached, waiting", { waitMs: waitTime });
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.requestCount = 0;
      this.lastReset = Date.now();
    }

    this.requestCount++;
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
          typeof value === 'bigint' ? value.toString() : value
        )
      );
    } catch (error) {
      logger.warn("Cache save failed", { error, tokenMint });
      // Don't fail the request if caching fails
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let honeypotDetectorInstance: HoneypotDetector | null = null;

export function initializeHoneypotDetector(
  config?: Partial<HoneypotDetectorConfig>
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
