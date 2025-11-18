/**
 * Raydium V4 AMM Pool Source
 *
 * Monitors Raydium V4 AMM program for pool initialization events.
 *
 * Official Documentation:
 * - Program ID: https://docs.raydium.io/raydium/protocol/developers/addresses
 * - Account Structure: https://github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs
 *
 * Account Indices (from official source code):
 * - Position 4: AMM account (pool address)
 * - Position 8: Coin mint (base token)
 * - Position 9: PC mint (quote token, usually SOL/USDC)
 *
 * Performance Target: <100ms parsing latency
 */

import { BasePoolSource, RawPoolDetection } from "./BaseSource.js";
import type { SolanaAddress, Result } from "../../../types/common.js";
import { asSolanaAddress, asTokenMint, asTransactionSignature, Ok, Err } from "../../../types/common.js";
import type { PoolSource } from "../../../types/sniper.js";
import { RAYDIUM_V4_PROGRAM } from "../../../config/programs.js";
import { logger } from "../../../utils/logger.js";

// ============================================================================
// Raydium V4 Constants
// ============================================================================

/**
 * Account indices for Raydium V4 initialize instruction
 *
 * Source: https://github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs
 */
const ACCOUNT_INDICES = {
  POOL_ADDRESS: 4,   // AMM account
  TOKEN_MINT_A: 8,   // coin_mint (base token)
  TOKEN_MINT_B: 9,   // pc_mint (quote token, usually SOL/USDC)
} as const;

/**
 * Log patterns for pool initialization
 */
const LOG_PATTERNS = [
  "initialize",
  "InitializePool",
  "initialize2",
] as const;

// ============================================================================
// Raydium V4 Source Implementation
// ============================================================================

/**
 * Raydium V4 AMM pool source
 */
export class RaydiumV4Source extends BasePoolSource {
  get programId(): SolanaAddress {
    return RAYDIUM_V4_PROGRAM;
  }

  get sourceName(): string {
    return "Raydium V4 AMM";
  }

  get sourceType(): PoolSource {
    return "raydium_v4";
  }

  /**
   * Check if log line indicates pool initialization
   *
   * @param log - Log line from transaction
   * @returns True if log matches pool init pattern
   */
  isPoolInitLog(log: string): boolean {
    return LOG_PATTERNS.some((pattern) => log.includes(pattern));
  }

  /**
   * Parse pool initialization from transaction signature
   *
   * @param signature - Transaction signature
   * @returns Parsed pool data or error
   */
  async parsePoolInit(
    signature: string
  ): Promise<Result<RawPoolDetection, string>> {
    try {
      const txSig = asTransactionSignature(signature);

      logger.debug("Fetching Raydium V4 transaction", {
        signature: txSig,
      });

      // Fetch transaction with circuit breaker protection
      const tx = await this.rpcCircuitBreaker.execute(async () => {
        return this.connection.getTransaction(txSig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      });

      if (tx === null) {
        // Circuit breaker is OPEN - fail fast
        logger.warn("Circuit breaker OPEN for Raydium V4 RPC", {
          signature: txSig,
        });
        return Err(
          "RPC circuit breaker OPEN - degraded mode (skip transaction parsing)"
        );
      }

      if (!tx) {
        return Err(`Transaction not found: ${signature}`);
      }

      if (!tx.transaction) {
        return Err(`Transaction data not available: ${signature}`);
      }

      // Extract account keys
      const accountKeys = tx.transaction.message.staticAccountKeys || [];

      logger.debug("Raydium V4 transaction fetched", {
        signature,
        accountCount: accountKeys.length,
        blockTime: tx.blockTime,
      });

      // Validate account count
      if (accountKeys.length < ACCOUNT_INDICES.TOKEN_MINT_B + 1) {
        return Err(
          `Insufficient accounts for Raydium V4: ${accountKeys.length} (need >= ${ACCOUNT_INDICES.TOKEN_MINT_B + 1})`
        );
      }

      // Extract addresses
      const poolAddress = asSolanaAddress(
        accountKeys[ACCOUNT_INDICES.POOL_ADDRESS].toString()
      );
      const tokenMintA = asTokenMint(
        accountKeys[ACCOUNT_INDICES.TOKEN_MINT_A].toString()
      );
      const tokenMintB = asTokenMint(
        accountKeys[ACCOUNT_INDICES.TOKEN_MINT_B].toString()
      );

      logger.debug("Parsed Raydium V4 pool", {
        poolAddress,
        tokenMintA,
        tokenMintB,
      });

      return Ok({
        poolAddress,
        tokenMintA,
        tokenMintB,
        source: this.sourceType,
        signature,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
      });
    } catch (error) {
      logger.error("Error parsing Raydium V4 pool init", {
        signature,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Failed to parse Raydium V4 pool init: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
