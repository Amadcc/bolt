/**
 * Orca Whirlpool (CLMM) Pool Source
 *
 * Monitors Orca Whirlpool program for pool initialization events.
 *
 * Official Documentation:
 * - Program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
 * - Account Structure: https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/instructions/initialize_pool.rs
 *
 * Account Indices (from official source code):
 * - Position 1: token_mint_a (first token mint)
 * - Position 2: token_mint_b (second token mint)
 * - Position 4: whirlpool (pool address)
 *
 * Performance Target: <100ms parsing latency
 */

import { BasePoolSource, RawPoolDetection } from "./BaseSource.js";
import type { SolanaAddress, Result } from "../../../types/common.js";
import { asSolanaAddress, asTokenMint, asTransactionSignature, Ok, Err } from "../../../types/common.js";
import type { PoolSource } from "../../../types/sniper.js";
import { ORCA_WHIRLPOOL_PROGRAM } from "../../../config/programs.js";
import { logger } from "../../../utils/logger.js";

// ============================================================================
// Orca Whirlpool Constants
// ============================================================================

/**
 * Account indices for Orca Whirlpool InitializePool instruction
 *
 * Source: https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/instructions/initialize_pool.rs
 */
const ACCOUNT_INDICES = {
  TOKEN_MINT_A: 1,    // token_mint_a (first token mint)
  TOKEN_MINT_B: 2,    // token_mint_b (second token mint)
  WHIRLPOOL: 4,       // whirlpool account (pool address)
} as const;

/**
 * Log patterns for pool initialization
 */
const LOG_PATTERNS = [
  "InitializePool",
  "initialize_pool",
  "InitializePoolV2",
] as const;

// ============================================================================
// Orca Whirlpool Source Implementation
// ============================================================================

/**
 * Orca Whirlpool pool source
 */
export class OrcaWhirlpoolSource extends BasePoolSource {
  get programId(): SolanaAddress {
    return ORCA_WHIRLPOOL_PROGRAM;
  }

  get sourceName(): string {
    return "Orca Whirlpool";
  }

  get sourceType(): PoolSource {
    return "orca_whirlpool";
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

      logger.debug("Fetching Orca Whirlpool transaction", {
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
        logger.warn("Circuit breaker OPEN for Orca Whirlpool RPC", {
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

      logger.debug("Orca Whirlpool transaction fetched", {
        signature,
        accountCount: accountKeys.length,
        blockTime: tx.blockTime,
      });

      // Validate account count
      if (accountKeys.length < ACCOUNT_INDICES.WHIRLPOOL + 1) {
        return Err(
          `Insufficient accounts for Orca Whirlpool: ${accountKeys.length} (need >= ${ACCOUNT_INDICES.WHIRLPOOL + 1})`
        );
      }

      // Extract addresses
      const poolAddress = asSolanaAddress(
        accountKeys[ACCOUNT_INDICES.WHIRLPOOL].toString()
      );
      const tokenMintA = asTokenMint(
        accountKeys[ACCOUNT_INDICES.TOKEN_MINT_A].toString()
      );
      const tokenMintB = asTokenMint(
        accountKeys[ACCOUNT_INDICES.TOKEN_MINT_B].toString()
      );

      logger.debug("Parsed Orca Whirlpool pool", {
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
      logger.error("Error parsing Orca Whirlpool pool init", {
        signature,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Failed to parse Orca Whirlpool pool init: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
