/**
 * Pool Initialization Event Parser
 *
 * Parses transaction logs and extracts pool initialization data:
 * - Pool address
 * - Token mints (base and quote)
 * - Initial liquidity
 * - DEX source
 *
 * Supported DEXs:
 * - Raydium AMM V4 (accounts[8], accounts[9])
 * - Raydium CLMM (different account structure)
 * - Orca Whirlpool (different account structure)
 * - Meteora DLMM (different account structure)
 * - Pump.fun (bonding curve)
 *
 * @see https://docs.raydium.io/raydium/protocol/developers/addresses-and-program-ids
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import type { TokenMint, SolanaAddress } from "../../types/common.js";
import { asTokenMint, asSolanaAddress, asTransactionSignature } from "../../types/common.js";
import type { PoolSource } from "../../types/sniper.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import { createCircuitBreaker } from "../shared/circuitBreaker.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed pool initialization event
 */
export interface ParsedPoolInit {
  poolAddress: SolanaAddress;
  tokenMintA: TokenMint;
  tokenMintB: TokenMint;
  source: PoolSource;
  blockTime: number | null;
}

/**
 * Account indices for different DEX programs
 */
const ACCOUNT_INDICES = {
  // Raydium V4 AMM (from official source code)
  // https://github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs
  raydium_v4: {
    poolAddress: 4,    // AMM account
    tokenMintA: 8,     // coin_mint (base token)
    tokenMintB: 9,     // pc_mint (quote token, usually SOL/USDC)
  },
  // Raydium CLMM (Concentrated Liquidity)
  raydium_clmm: {
    poolAddress: 1,
    tokenMintA: 2,
    tokenMintB: 3,
  },
  // Orca Whirlpool (from official source code)
  // https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/instructions/initialize_pool.rs
  orca_whirlpool: {
    poolAddress: 4,      // whirlpool account
    tokenMintA: 1,       // token_mint_a
    tokenMintB: 2,       // token_mint_b
  },
  // Meteora DLMM
  meteora: {
    poolAddress: 0,
    tokenMintA: 1,
    tokenMintB: 2,
  },
  // Pump.fun (bonding curve)
  pump_fun: {
    bondingCurve: 0,
    tokenMint: 1,
    quoteMint: 2, // Usually SOL
  },
} as const;

// ============================================================================
// Event Parser Class
// ============================================================================

/**
 * Pool event parser with DEX-specific logic
 */
export class PoolEventParser {
  private rpcCircuitBreaker = createCircuitBreaker("pool_event_parser_rpc", {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 60000,
    monitoringPeriod: 120000,
  });

  constructor(private connection: Connection) {}

  /**
   * Parse pool initialization from transaction signature
   *
   * @param signature - Transaction signature
   * @param source - DEX source (determines account indices)
   * @returns Parsed pool init or error
   */
  async parsePoolInit(
    signature: string,
    source: PoolSource
  ): Promise<Result<ParsedPoolInit, string>> {
    try {
      const txSig = asTransactionSignature(signature);

      logger.debug("Fetching transaction", {
        signature: txSig,
        source,
      });

      // Fetch transaction with circuit breaker protection
      const tx = await this.rpcCircuitBreaker.execute(async () => {
        return this.connection.getTransaction(txSig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      });

      if (tx === null) {
        // Circuit breaker is OPEN - fallback to degraded mode
        logger.warn("Circuit breaker OPEN, skipping transaction parsing", {
          signature: txSig,
          source,
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

      logger.debug("Transaction fetched", {
        signature,
        accountCount: accountKeys.length,
        blockTime: tx.blockTime,
      });

      // Parse based on source
      switch (source) {
        case "raydium_v4":
          return this.parseRaydiumV4(accountKeys, tx.blockTime ?? null);

        case "raydium_clmm":
          return this.parseRaydiumCLMM(accountKeys, tx.blockTime ?? null);

        case "orca_whirlpool":
          return this.parseOrcaWhirlpool(accountKeys, tx.blockTime ?? null);

        case "meteora":
          return this.parseMeteora(accountKeys, tx.blockTime ?? null);

        case "pump_fun":
          return this.parsePumpFun(accountKeys, tx.blockTime ?? null);

        default:
          return Err(`Unsupported pool source: ${source}`);
      }
    } catch (error) {
      logger.error("Error parsing pool init", {
        signature,
        source,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Failed to parse pool init: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parse Raydium V4 AMM pool initialization
   *
   * Account structure for initializePool instruction:
   * 0. Token program
   * 1. System program
   * 2. Rent
   * 3. AMM program
   * 4. AMM account (pool address)
   * 5. AMM authority
   * 6. AMM open orders
   * 7. LP mint
   * 8. Coin mint (base token) ← TOKEN A
   * 9. PC mint (quote token, usually SOL/USDC) ← TOKEN B
   * 10. Pool coin token account
   * 11. Pool pc token account
   * ... (more accounts)
   */
  private parseRaydiumV4(
    accountKeys: PublicKey[],
    blockTime: number | null
  ): Result<ParsedPoolInit, string> {
    const indices = ACCOUNT_INDICES.raydium_v4;

    // Validate account count
    if (accountKeys.length < 10) {
      return Err(
        `Insufficient accounts for Raydium V4: ${accountKeys.length} (need >= 10)`
      );
    }

    try {
      // Extract addresses
      const poolAddress = asSolanaAddress(accountKeys[indices.poolAddress].toString());
      const tokenMintA = asTokenMint(accountKeys[indices.tokenMintA].toString());
      const tokenMintB = asTokenMint(accountKeys[indices.tokenMintB].toString());

      logger.debug("Parsed Raydium V4 pool", {
        poolAddress,
        tokenMintA,
        tokenMintB,
      });

      return Ok({
        poolAddress,
        tokenMintA,
        tokenMintB,
        source: "raydium_v4",
        blockTime,
      });
    } catch (error) {
      return Err(
        `Failed to parse Raydium V4 accounts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parse Raydium CLMM pool initialization
   *
   * TODO: Implement CLMM account structure parsing
   * Account structure is different from V4
   */
  private parseRaydiumCLMM(
    _accountKeys: PublicKey[],
    _blockTime: number | null
  ): Result<ParsedPoolInit, string> {
    // TODO: Implement CLMM parsing
    logger.warn("Raydium CLMM parsing not implemented yet");
    return Err("Raydium CLMM parsing not implemented");
  }

  /**
   * Parse Orca Whirlpool pool initialization
   *
   * TODO: Implement Orca Whirlpool account structure parsing
   */
  private parseOrcaWhirlpool(
    _accountKeys: PublicKey[],
    _blockTime: number | null
  ): Result<ParsedPoolInit, string> {
    // TODO: Implement Orca parsing
    logger.warn("Orca Whirlpool parsing not implemented yet");
    return Err("Orca Whirlpool parsing not implemented");
  }

  /**
   * Parse Meteora DLMM pool initialization
   *
   * TODO: Implement Meteora DLMM account structure parsing
   */
  private parseMeteora(
    _accountKeys: PublicKey[],
    _blockTime: number | null
  ): Result<ParsedPoolInit, string> {
    // TODO: Implement Meteora parsing
    logger.warn("Meteora DLMM parsing not implemented yet");
    return Err("Meteora DLMM parsing not implemented");
  }

  /**
   * Parse Pump.fun bonding curve initialization
   *
   * TODO: Implement Pump.fun account structure parsing
   */
  private parsePumpFun(
    _accountKeys: PublicKey[],
    _blockTime: number | null
  ): Result<ParsedPoolInit, string> {
    // TODO: Implement Pump.fun parsing
    logger.warn("Pump.fun parsing not implemented yet");
    return Err("Pump.fun parsing not implemented");
  }

  /**
   * Check if transaction logs indicate pool initialization
   *
   * @param logs - Transaction logs
   * @returns True if logs contain pool init pattern
   */
  static isPoolInitTransaction(logs: string[]): boolean {
    const patterns = [
      // Raydium
      "initialize",
      "InitializePool",
      "initialize2",

      // Orca
      "InitializePoolV2",
      "OpenPosition",

      // Meteora
      "InitializeLbPair",

      // Pump.fun
      "create",
      "CreateBondingCurve",
    ];

    return logs.some((log) =>
      patterns.some((pattern) => log.includes(pattern))
    );
  }

  /**
   * Extract instruction name from log line
   *
   * Example: "Program log: Instruction: InitializePool" → "InitializePool"
   */
  static extractInstructionName(log: string): string | null {
    const match = log.match(/Instruction:\s*(\w+)/);
    return match ? match[1] : null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine which token is base and which is quote
 *
 * Logic:
 * - If one token is SOL → SOL is quote, other is base
 * - If one token is USDC → USDC is quote, other is base
 * - Otherwise, alphabetically first is base
 */
export function determineBaseAndQuote(
  tokenA: TokenMint,
  tokenB: TokenMint
): { base: TokenMint; quote: TokenMint } {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  // SOL as quote
  if (tokenB === SOL_MINT) {
    return { base: tokenA, quote: tokenB };
  }
  if (tokenA === SOL_MINT) {
    return { base: tokenB, quote: tokenA };
  }

  // USDC as quote
  if (tokenB === USDC_MINT) {
    return { base: tokenA, quote: tokenB };
  }
  if (tokenA === USDC_MINT) {
    return { base: tokenB, quote: tokenA };
  }

  // Alphabetical (deterministic)
  return tokenA < tokenB
    ? { base: tokenA, quote: tokenB }
    : { base: tokenB, quote: tokenA };
}
