/**
 * RugCheck API Provider
 *
 * RugCheck.xyz is a Solana-specific token security analyzer
 * - FREE API with rate limiting
 * - Comprehensive risk assessment
 * - Liquidity analysis
 * - Top holder analysis
 *
 * API: https://api.rugcheck.xyz
 * Docs: https://api.rugcheck.xyz/swagger/index.html
 */

import { BaseAPIProvider } from "./BaseAPIProvider.js";
import { logger } from "../../../utils/logger.js";
import type {
  APILayerResult,
  APIProviderConfig,
  HoneypotFlag,
  RugCheckResponse,
} from "../../../types/honeypot.js";

// ============================================================================
// RugCheck API Provider
// ============================================================================

export class RugCheckProvider extends BaseAPIProvider {
  private static readonly BASE_URL = "https://api.rugcheck.xyz";

  constructor(config: APIProviderConfig) {
    super("rugcheck", config.priority, config);
  }

  /**
   * Perform RugCheck API request
   */
  protected async performCheck(tokenMint: string): Promise<APILayerResult> {
    const startTime = Date.now();

    const response = await this.axiosClient.get<RugCheckResponse>(
      `${RugCheckProvider.BASE_URL}/v1/tokens/${tokenMint}/report`,
      {
        headers: {
          ...(this.config.apiKey && { "X-API-KEY": this.config.apiKey }),
        },
      }
    );

    const data = response.data;

    // Validate response
    if (!data || !data.mint) {
      logger.warn("RugCheck API: invalid response", {
        tokenMint,
        data,
      });
      throw new Error("Invalid RugCheck response");
    }

    const { score, flags, data: parsedData } = this.parseResponse(
      data,
      tokenMint
    );

    return {
      source: "rugcheck",
      score,
      flags,
      data: parsedData,
      timeMs: Date.now() - startTime,
    };
  }

  /**
   * Parse RugCheck response into standardized format
   *
   * RugCheck scoring: 0-100, LOWER is SAFER
   * We invert it: 0 = safe, 100 = dangerous
   */
  protected parseResponse(
    data: unknown,
    tokenMint: string
  ): {
    score: number;
    flags: HoneypotFlag[];
    data: Record<string, unknown>;
  } {
    const response = data as RugCheckResponse;
    const flags: HoneypotFlag[] = [];
    let riskScore = 0;

    // Check if token is rugged (definite honeypot)
    if (response.rugged) {
      logger.warn("RugCheck: token marked as rugged", {
        tokenMint,
        result: response.result,
      });
      return {
        score: 100,
        flags: ["UNKNOWN"],
        data: { rugcheck: response },
      };
    }

    // Analyze risks array
    if (response.risks && Array.isArray(response.risks)) {
      for (const risk of response.risks) {
        // Map risk levels to scores
        const riskScoreContribution =
          risk.level === "danger" ? risk.score * 1.0 :
          risk.level === "warn" ? risk.score * 0.5 :
          0; // info level

        riskScore += riskScoreContribution;

        // Map specific risks to flags
        const riskNameLower = risk.name.toLowerCase();

        if (riskNameLower.includes("mint") && riskNameLower.includes("authority")) {
          flags.push("MINT_AUTHORITY");
        } else if (riskNameLower.includes("freeze") && riskNameLower.includes("authority")) {
          flags.push("FREEZE_AUTHORITY");
        } else if (riskNameLower.includes("liquidity") || riskNameLower.includes("low lp")) {
          if (response.totalMarketLiquidity && response.totalMarketLiquidity < 1000) {
            flags.push("LOW_LIQUIDITY");
          }
        } else if (riskNameLower.includes("holder") || riskNameLower.includes("concentration")) {
          flags.push("CENTRALIZED");
        } else if (riskNameLower.includes("locked") || riskNameLower.includes("lp")) {
          flags.push("UNLOCKED_LIQUIDITY");
        }
      }
    }

    // Check authorities directly
    if (response.mintAuthority && response.mintAuthority !== null) {
      if (!flags.includes("MINT_AUTHORITY")) {
        flags.push("MINT_AUTHORITY");
        riskScore += 30;
      }
    }

    if (response.freezeAuthority && response.freezeAuthority !== null) {
      if (!flags.includes("FREEZE_AUTHORITY")) {
        flags.push("FREEZE_AUTHORITY");
        riskScore += 30;
      }
    }

    // Check top holders concentration
    if (response.topHolders && response.topHolders.length > 0) {
      const top10Percent = response.topHolders
        .slice(0, 10)
        .reduce((sum, holder) => sum + holder.pct, 0);

      if (top10Percent > 80) {
        if (!flags.includes("CENTRALIZED")) {
          flags.push("CENTRALIZED");
          riskScore += 20;
        }
      }

      const topHolder = response.topHolders[0].pct;
      if (topHolder > 50) {
        flags.push("SINGLE_HOLDER_MAJORITY");
        riskScore += 25;
      }
    }

    // Check liquidity
    if (response.totalMarketLiquidity !== undefined) {
      if (response.totalMarketLiquidity < 1000) {
        if (!flags.includes("LOW_LIQUIDITY")) {
          flags.push("LOW_LIQUIDITY");
          riskScore += 30;
        }
      }
    }

    // Map result to additional score
    if (response.result === "Danger") {
      riskScore += 40;
    } else if (response.result === "Unknown") {
      riskScore += 10;
    }

    // Cap at 100
    const finalScore = Math.min(Math.round(riskScore), 100);

    logger.debug("RugCheck response parsed", {
      tokenMint,
      result: response.result,
      rugCheckScore: response.score,
      mappedScore: finalScore,
      flags,
      risksCount: response.risks?.length || 0,
    });

    return {
      score: finalScore,
      flags: flags.length > 0 ? flags : [],
      data: {
        rugcheck: {
          mint: response.mint,
          tokenType: response.tokenType,
          token: response.token,
          result: response.result,
          score: response.score,
          rugged: response.rugged,
          risksCount: response.risks?.length || 0,
          totalMarketLiquidity: response.totalMarketLiquidity,
          mintAuthority: response.mintAuthority,
          freezeAuthority: response.freezeAuthority,
        },
      },
    };
  }

  /**
   * RugCheck rate limit: conservative 30 req/min (no official docs)
   */
  protected getRateLimit(): number {
    return 30;
  }
}
