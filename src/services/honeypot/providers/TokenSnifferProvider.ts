/**
 * TokenSniffer API Provider
 *
 * Multi-chain token security analyzer by Solidus Labs
 * - Paid API: $99/mo for 500 req/day
 * - Rate limit: 5 requests per second (300 req/min)
 * - Solana chain ID: 101
 *
 * API: https://tokensniffer.com/api/v2
 * Docs: https://tokensniffer.readme.io/reference/get-token-results
 */

import { BaseAPIProvider } from "./BaseAPIProvider.js";
import { logger } from "../../../utils/logger.js";
import type {
  APILayerResult,
  APIProviderConfig,
  HoneypotFlag,
  TokenSnifferResponse,
} from "../../../types/honeypot.js";

// ============================================================================
// TokenSniffer API Provider
// ============================================================================

export class TokenSnifferProvider extends BaseAPIProvider {
  private static readonly BASE_URL = "https://tokensniffer.com/api/v2";
  private static readonly SOLANA_CHAIN_ID = 101;

  constructor(config: APIProviderConfig) {
    super("tokensniffer", config.priority, config);

    if (!config.apiKey) {
      logger.warn(
        "TokenSniffer API key not configured - provider will fail requests",
        { provider: "tokensniffer" }
      );
    }
  }

  /**
   * Perform TokenSniffer API request
   */
  protected async performCheck(tokenMint: string): Promise<APILayerResult> {
    const startTime = Date.now();

    if (!this.config.apiKey) {
      throw new Error("TokenSniffer API key not configured");
    }

    const response = await this.axiosClient.get<TokenSnifferResponse>(
      `${TokenSnifferProvider.BASE_URL}/tokens/${TokenSnifferProvider.SOLANA_CHAIN_ID}/${tokenMint}`,
      {
        params: {
          include_metrics: true,
          include_tests: true,
        },
        headers: {
          "API-KEY": this.config.apiKey,
        },
      }
    );

    const data = response.data;

    // Validate response
    if (!data || data.message === "Token not found") {
      logger.warn("TokenSniffer API: token not found", { tokenMint });
      throw new Error("Token not found in TokenSniffer");
    }

    const { score, flags, data: parsedData } = this.parseResponse(
      data,
      tokenMint
    );

    return {
      source: "tokensniffer",
      score,
      flags,
      data: parsedData,
      timeMs: Date.now() - startTime,
    };
  }

  /**
   * Parse TokenSniffer response into standardized format
   *
   * TokenSniffer scoring: 0-100, HIGHER is SAFER
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
    const response = data as TokenSnifferResponse;
    const flags: HoneypotFlag[] = [];
    let riskScore = 0;

    // Check tests object
    if (response.tests) {
      const tests = response.tests;

      // Honeypot check
      if (tests.is_honeypot?.value === true) {
        logger.warn("TokenSniffer: token marked as honeypot", { tokenMint });
        return {
          score: 100,
          flags: ["UNKNOWN"],
          data: { tokensniffer: response },
        };
      }

      // Mint authority checks
      if (tests.is_mintable?.value === true || tests.can_be_minted?.value === true) {
        flags.push("MINT_AUTHORITY");
        riskScore += 30;
      }

      // Owner control
      if (tests.owner_can_change_balance?.value === true) {
        flags.push("OWNER_CHANGE_POSSIBLE");
        riskScore += 40;
      }

      if (tests.hidden_owner?.value === true) {
        flags.push("OWNER_CHANGE_POSSIBLE");
        riskScore += 25;
      }

      // Trading taxes
      const sellTax = tests.sell_tax?.value ?? 0;
      if (sellTax > 0.5) {
        // > 50%
        flags.push("HIGH_SELL_TAX");
        riskScore += 50;
      } else if (sellTax > 0.3) {
        // > 30%
        flags.push("HIGH_SELL_TAX");
        riskScore += 30;
      }

      // Liquidity checks
      const liquidityAmount = tests.liquidity_amount?.value ?? 0;
      if (liquidityAmount < 1000) {
        flags.push("LOW_LIQUIDITY");
        riskScore += 30;
      }

      // Dangerous functions
      if (tests.selfdestruct?.value === true) {
        riskScore += 60;
      }

      if (tests.external_call?.value === true) {
        riskScore += 15;
      }
    }

    // Check exploits array
    if (response.exploits && Array.isArray(response.exploits)) {
      for (const exploit of response.exploits) {
        const severity = exploit.severity;

        if (severity === "critical") {
          riskScore += 60;
        } else if (severity === "high") {
          riskScore += 40;
        } else if (severity === "medium") {
          riskScore += 20;
        } else if (severity === "low") {
          riskScore += 10;
        }

        logger.warn("TokenSniffer: exploit detected", {
          tokenMint,
          severity,
          description: exploit.description,
        });
      }
    }

    // Use scam_probability if available
    if (response.scam_probability !== undefined) {
      const scamScore = response.scam_probability * 100;
      riskScore = Math.max(riskScore, scamScore);
    }

    // Use inverse of score if available (TokenSniffer: higher = safer)
    if (response.score !== undefined) {
      const invertedScore = 100 - response.score;
      riskScore = Math.max(riskScore, invertedScore);
    }

    // Cap at 100
    const finalScore = Math.min(Math.round(riskScore), 100);

    logger.debug("TokenSniffer response parsed", {
      tokenMint,
      tokenSnifferScore: response.score,
      scamProbability: response.scam_probability,
      mappedScore: finalScore,
      flags,
      exploitsCount: response.exploits?.length || 0,
    });

    return {
      score: finalScore,
      flags: flags.length > 0 ? flags : [],
      data: {
        tokensniffer: {
          message: response.message,
          token: response.token,
          score: response.score,
          scam_probability: response.scam_probability,
          exploitsCount: response.exploits?.length || 0,
          hasTests: !!response.tests,
        },
      },
    };
  }

  /**
   * TokenSniffer rate limit: 5 requests per second = 300 req/min
   * BUT also 500 requests per day limit on basic plan
   * We'll be conservative: 60 req/min to preserve daily quota
   */
  protected getRateLimit(): number {
    return 60;
  }
}
