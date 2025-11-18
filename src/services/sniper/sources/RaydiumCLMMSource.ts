/**
 * Raydium CLMM (Concentrated Liquidity) Pool Source
 *
 * Monitors Raydium CLMM program for pool creation events.
 *
 * Official Documentation:
 * - Program ID: https://docs.raydium.io/raydium/protocol/developers/addresses
 * - Account Structure: https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/create_pool.rs
 *
 * Account Indices (from official source code):
 * - Position 2: pool_state (pool address)
 * - Position 3: token_mint_0 (first token mint, constraint: key < token_mint_1)
 * - Position 4: token_mint_1 (second token mint)
 *
 * Performance Target: <100ms parsing latency
 */

import { BasePoolSource, RawPoolDetection } from "./BaseSource.js";
import type { SolanaAddress, Result } from "../../../types/common.js";
import { asSolanaAddress, asTokenMint, asTransactionSignature, Ok, Err } from "../../../types/common.js";
import type { PoolSource } from "../../../types/sniper.js";
import { RAYDIUM_CLMM_PROGRAM } from "../../../config/programs.js";
import { logger } from "../../../utils/logger.js";

// ============================================================================
// Raydium CLMM Constants
// ============================================================================

/**
 * Account indices for Raydium CLMM CreatePool instruction
 *
 * Source: https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/create_pool.rs
 */
const ACCOUNT_INDICES = {
  POOL_STATE: 2,      // pool_state (initialized account, pool address)
  TOKEN_MINT_0: 3,    // token_mint_0 (constraint: key < token_mint_1)
  TOKEN_MINT_1: 4,    // token_mint_1
} as const;

/**
 * Log patterns for pool creation
 */
const LOG_PATTERNS = [
  "CreatePool",
  "create_pool",
  "Initialize",
] as const;

// ============================================================================
// Raydium CLMM Source Implementation
// ============================================================================

/**
 * Raydium CLMM pool source
 */
export class RaydiumCLMMSource extends BasePoolSource {
  get programId(): SolanaAddress {
    return RAYDIUM_CLMM_PROGRAM;
  }

  get sourceName(): string {
    return "Raydium CLMM";
  }

  get sourceType(): PoolSource {
    return "raydium_clmm";
  }

  /**
   * Check if log line indicates pool creation
   *
   * @param log - Log line from transaction
   * @returns True if log matches pool creation pattern
   */
  isPoolInitLog(log: string): boolean {
    return LOG_PATTERNS.some((pattern) => log.includes(pattern));
  }

  /**
   * Parse pool creation from transaction signature
   *
   * @param signature - Transaction signature
   * @returns Parsed pool data or error
   */
  async parsePoolInit(
    signature: string
  ): Promise<Result<RawPoolDetection, string>> {
    try {
      const txSig = asTransactionSignature(signature);

      logger.debug("Fetching Raydium CLMM transaction", {
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
        logger.warn("Circuit breaker OPEN for Raydium CLMM RPC", {
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

      logger.debug("Raydium CLMM transaction fetched", {
        signature,
        accountCount: accountKeys.length,
        blockTime: tx.blockTime,
      });

      // Validate account count
      if (accountKeys.length < ACCOUNT_INDICES.TOKEN_MINT_1 + 1) {
        return Err(
          `Insufficient accounts for Raydium CLMM: ${accountKeys.length} (need >= ${ACCOUNT_INDICES.TOKEN_MINT_1 + 1})`
        );
      }

      // Extract addresses
      const poolAddress = asSolanaAddress(
        accountKeys[ACCOUNT_INDICES.POOL_STATE].toString()
      );
      const tokenMintA = asTokenMint(
        accountKeys[ACCOUNT_INDICES.TOKEN_MINT_0].toString()
      );
      const tokenMintB = asTokenMint(
        accountKeys[ACCOUNT_INDICES.TOKEN_MINT_1].toString()
      );

      logger.debug("Parsed Raydium CLMM pool", {
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
      logger.error("Error parsing Raydium CLMM pool creation", {
        signature,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Failed to parse Raydium CLMM pool creation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
