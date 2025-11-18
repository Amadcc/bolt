/**
 * Pump.fun Bonding Curve Source
 *
 * Monitors Pump.fun program for token creation events (bonding curve).
 *
 * Official Documentation:
 * - Program ID: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 * - IDL: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 * - Breaking Change (Nov 11, 2025): create_v2 introduced
 *
 * Supported Instructions:
 * - create_v2 (NEW, Token2022 + Mayhem program)
 * - create (LEGACY, Metaplex metadata, still works but deprecated)
 *
 * Account Indices (create_v2 - preferred):
 * - Position 0: mint (token mint, writable, signer)
 * - Position 2: bonding_curve (PDA, pool address)
 * - Position 9: mayhem_program_id (Mayhem program integration)
 *
 * Account Indices (create - legacy):
 * - Position 0: mint (token mint, writable, signer)
 * - Position 2: bonding_curve (PDA, pool address)
 * - Position 4: global (global config)
 *
 * Important Notes:
 * - Pump.fun tokens have 6 decimals (not 9!)
 * - Quote token is always SOL (wrapped SOL)
 * - Bonding curve is PDA: [b"bonding-curve", mint]
 * - create_v2 uses Token2022 (not SPL Token)
 * - Mayhem program ID: MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e
 *
 * Performance Target: <100ms parsing latency
 */

import { BasePoolSource, RawPoolDetection } from "./BaseSource.js";
import type { SolanaAddress, TokenMint, Result } from "../../../types/common.js";
import { asSolanaAddress, asTokenMint, asTransactionSignature, Ok, Err } from "../../../types/common.js";
import type { PoolSource } from "../../../types/sniper.js";
import { PUMP_FUN_PROGRAM } from "../../../config/programs.js";
import { logger } from "../../../utils/logger.js";

// ============================================================================
// Pump.fun Constants
// ============================================================================

/**
 * Account indices for Pump.fun create_v2 instruction (NEW - Token2022)
 *
 * Source: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 * Breaking change: Nov 11, 2025
 */
const ACCOUNT_INDICES_V2 = {
  MINT: 0,                  // mint (token mint address, writable, signer)
  BONDING_CURVE: 2,         // bonding_curve (PDA, pool address)
  MAYHEM_PROGRAM_ID: 9,     // mayhem_program_id (Mayhem integration)
  GLOBAL_PARAMS: 10,        // global_params (global config)
} as const;

/**
 * Account indices for Pump.fun create instruction (LEGACY - Metaplex)
 *
 * Still works but will be deprecated
 */
const ACCOUNT_INDICES_LEGACY = {
  MINT: 0,              // mint (token mint address, writable, signer)
  BONDING_CURVE: 2,     // bonding_curve (PDA, pool address)
  GLOBAL: 4,            // global (config account)
} as const;

/**
 * SOL mint address (used as quote token)
 */
const SOL_MINT = "So11111111111111111111111111111111111111112" as TokenMint;

/**
 * Mayhem program ID (for create_v2)
 */
const MAYHEM_PROGRAM_ID = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e";

/**
 * Log patterns for token creation
 */
const LOG_PATTERNS = [
  "create_v2",          // NEW: Token2022 + Mayhem
  "create",             // LEGACY: Metaplex
  "Create",
  "CreateBondingCurve",
] as const;

// ============================================================================
// Pump.fun Source Implementation
// ============================================================================

/**
 * Pump.fun bonding curve source
 */
export class PumpFunSource extends BasePoolSource {
  get programId(): SolanaAddress {
    return PUMP_FUN_PROGRAM;
  }

  get sourceName(): string {
    return "Pump.fun";
  }

  get sourceType(): PoolSource {
    return "pump_fun";
  }

  /**
   * Check if log line indicates token creation
   *
   * @param log - Log line from transaction
   * @returns True if log matches creation pattern
   */
  isPoolInitLog(log: string): boolean {
    return LOG_PATTERNS.some((pattern) => log.includes(pattern));
  }

  /**
   * Parse token creation from transaction signature
   *
   * Supports both create_v2 (Token2022) and create (legacy Metaplex)
   * Note: For Pump.fun, tokenMintB is always SOL (wrapped SOL mint)
   *
   * @param signature - Transaction signature
   * @returns Parsed pool data or error
   */
  async parsePoolInit(
    signature: string
  ): Promise<Result<RawPoolDetection, string>> {
    try {
      const txSig = asTransactionSignature(signature);

      logger.debug("Fetching Pump.fun transaction", {
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
        logger.warn("Circuit breaker OPEN for Pump.fun RPC", {
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

      logger.debug("Pump.fun transaction fetched", {
        signature,
        accountCount: accountKeys.length,
        blockTime: tx.blockTime,
      });

      // Detect instruction version (create_v2 or create legacy)
      const isCreateV2 = this.detectCreateV2(accountKeys);

      let poolAddress: SolanaAddress;
      let tokenMintA: TokenMint;

      if (isCreateV2) {
        // create_v2 (Token2022 + Mayhem)
        if (accountKeys.length < ACCOUNT_INDICES_V2.GLOBAL_PARAMS + 1) {
          return Err(
            `Insufficient accounts for Pump.fun create_v2: ${accountKeys.length} (need >= ${ACCOUNT_INDICES_V2.GLOBAL_PARAMS + 1})`
          );
        }

        poolAddress = asSolanaAddress(
          accountKeys[ACCOUNT_INDICES_V2.BONDING_CURVE].toString()
        );
        tokenMintA = asTokenMint(
          accountKeys[ACCOUNT_INDICES_V2.MINT].toString()
        );

        logger.debug("Parsed Pump.fun bonding curve (create_v2)", {
          poolAddress,
          tokenMintA,
          version: "create_v2",
          tokenProgram: "Token2022",
        });
      } else {
        // create (legacy Metaplex)
        if (accountKeys.length < ACCOUNT_INDICES_LEGACY.GLOBAL + 1) {
          return Err(
            `Insufficient accounts for Pump.fun create: ${accountKeys.length} (need >= ${ACCOUNT_INDICES_LEGACY.GLOBAL + 1})`
          );
        }

        poolAddress = asSolanaAddress(
          accountKeys[ACCOUNT_INDICES_LEGACY.BONDING_CURVE].toString()
        );
        tokenMintA = asTokenMint(
          accountKeys[ACCOUNT_INDICES_LEGACY.MINT].toString()
        );

        logger.debug("Parsed Pump.fun bonding curve (create legacy)", {
          poolAddress,
          tokenMintA,
          version: "create",
          tokenProgram: "SPL Token",
        });
      }

      const tokenMintB = SOL_MINT; // Always SOL for Pump.fun

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
      logger.error("Error parsing Pump.fun token creation", {
        signature,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Failed to parse Pump.fun token creation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Detect if transaction uses create_v2 (Token2022) or create (legacy)
   *
   * create_v2 has 16 accounts and includes Mayhem program
   * create has 14 accounts and includes Metaplex metadata
   *
   * @param accountKeys - Transaction account keys
   * @returns True if create_v2, false if create (legacy)
   */
  private detectCreateV2(accountKeys: any[]): boolean {
    // Check account count (create_v2 has 16 accounts, create has 14)
    if (accountKeys.length >= 16) {
      // Additional check: verify Mayhem program ID at position 9
      const maybeMayhemProgram = accountKeys[ACCOUNT_INDICES_V2.MAYHEM_PROGRAM_ID]?.toString();
      return maybeMayhemProgram === MAYHEM_PROGRAM_ID;
    }

    // Fallback to legacy create
    return false;
  }
}
