/**
 * GoPlus API Provider
 *
 * Multi-chain token security analyzer
 * - FREE API with rate limiting
 * - Fast baseline checks (1-3s)
 * - 80-85% accuracy
 *
 * API: https://api.gopluslabs.io
 * Docs: https://docs.gopluslabs.io/reference/token-security-solana
 */

import { BaseAPIProvider } from "./BaseAPIProvider.js";
import { logger } from "../../../utils/logger.js";
import type {
  APILayerResult,
  APIProviderConfig,
  HoneypotFlag,
  GoPlusResponse,
} from "../../../types/honeypot.js";

// ============================================================================
// GoPlus API Provider
// ============================================================================

export class GoPlusProvider extends BaseAPIProvider {
  private static readonly BASE_URL = "https://api.gopluslabs.io/api/v1";

  constructor(config: APIProviderConfig) {
    super("goplus", config.priority, config);
  }

  /**
   * Perform GoPlus API request
   */
  protected async performCheck(tokenMint: string): Promise<APILayerResult> {
    const startTime = Date.now();

    const response = await this.axiosClient.get<GoPlusResponse>(
      `${GoPlusProvider.BASE_URL}/token_security/solana`,
      {
        params: {
          contract_addresses: tokenMint,
        },
      }
    );

    const data = response.data;

    // Validate response
    if (data.code !== 1) {
      logger.warn("GoPlus API: non-success code", {
        code: data.code,
        message: data.message,
      });
      throw new Error(`GoPlus API error: ${data.message}`);
    }

    if (!data.result) {
      logger.warn("GoPlus API: no result data", { tokenMint });
      throw new Error("GoPlus API: no result data");
    }

    const tokenData = data.result[tokenMint];
    if (!tokenData) {
      logger.warn("GoPlus API: token not found", { tokenMint });
      throw new Error("Token not found in GoPlus");
    }

    const { score, flags, data: parsedData } = this.parseResponse(
      tokenData,
      tokenMint
    );

    return {
      source: "goplus",
      score,
      flags,
      data: parsedData,
      timeMs: Date.now() - startTime,
    };
  }

  /**
   * Parse GoPlus response into standardized format
   */
  protected parseResponse(
    data: unknown,
    tokenMint: string
  ): {
    score: number;
    flags: HoneypotFlag[];
    data: Record<string, unknown>;
  } {
    const tokenData = data as GoPlusResponse["result"][string];
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
    const sellTax = parseFloat(tokenData.sell_tax || "0");
    if (sellTax > 0.5) {
      // > 50%
      flags.push("HIGH_SELL_TAX");
      score += 50;
    }

    // Check honeypot flag
    if (tokenData.is_honeypot === "1") {
      logger.warn("GoPlus: token marked as honeypot", { tokenMint });
      score = 100; // Definite honeypot
    }

    // Check holder concentration
    if (tokenData.holder_list && tokenData.holder_list.length > 0) {
      const top10Percent = tokenData.holder_list
        .slice(0, 10)
        .reduce((sum, holder) => sum + parseFloat(holder.percent), 0);

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

    // Check if pausable
    if (tokenData.transfer_pausable === "1") {
      flags.push("FREEZE_AUTHORITY");
      score += 30;
    }

    // Cap at 100
    const finalScore = Math.min(score, 100);

    logger.debug("GoPlus response parsed", {
      tokenMint,
      isHoneypot: tokenData.is_honeypot,
      score: finalScore,
      flags,
      holderCount: tokenData.holder_count,
    });

    return {
      score: finalScore,
      flags: flags.length > 0 ? flags : [],
      data: {
        goplus: {
          owner_address: tokenData.owner_address,
          creator_address: tokenData.creator_address,
          is_mintable: tokenData.is_mintable,
          can_take_back_ownership: tokenData.can_take_back_ownership,
          buy_tax: tokenData.buy_tax,
          sell_tax: tokenData.sell_tax,
          is_honeypot: tokenData.is_honeypot,
          transfer_pausable: tokenData.transfer_pausable,
          holder_count: tokenData.holder_count,
          total_supply: tokenData.total_supply,
        },
      },
    };
  }

  /**
   * GoPlus rate limit: 60 requests per minute (observed)
   */
  protected getRateLimit(): number {
    return 60;
  }
}
