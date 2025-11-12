import type { SnipeConfig } from "@prisma/client";
import { Err, Ok, type Result } from "../../types/common.js";
import type { NewTokenEvent } from "../../types/snipe.js";
import { logger } from "../../utils/logger.js";

export class SnipeFilter {
  apply(config: SnipeConfig, event: NewTokenEvent): Result<boolean, string> {
    if (config.whitelist.length > 0 && !config.whitelist.includes(event.mint)) {
      return Ok(false);
    }

    if (config.blacklist.includes(event.mint)) {
      return Err("Token is blacklisted");
    }

    if (
      config.minLiquidityLamports &&
      event.liquidityLamports < config.minLiquidityLamports
    ) {
      return Err("Liquidity below minimum threshold");
    }

    if (
      config.maxLiquidityLamports &&
      event.liquidityLamports > config.maxLiquidityLamports
    ) {
      return Err("Liquidity above maximum threshold");
    }

    if (
      config.minMarketCapUsd &&
      (event.marketCapUsd ?? 0) < config.minMarketCapUsd
    ) {
      return Err("Market cap below minimum");
    }

    if (
      config.maxMarketCapUsd &&
      (event.marketCapUsd ?? 0) > config.maxMarketCapUsd
    ) {
      return Err("Market cap above maximum");
    }

    logger.debug("Token passed filter", {
      userId: config.userId,
      mint: event.mint,
      source: event.source,
    });

    return Ok(true);
  }
}

export const snipeFilter = new SnipeFilter();
