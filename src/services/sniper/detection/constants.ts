/**
 * Solana program IDs for pool detection
 */

import { PublicKey } from "@solana/web3.js";

// ============================================================================
// DEX Program IDs
// ============================================================================

/** Raydium AMM V4 */
export const RAYDIUM_AMM_V4 = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

/** Raydium CLMM (Concentrated Liquidity) */
export const RAYDIUM_CLMM = new PublicKey(
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);

/** Pump.fun Bonding Curve */
export const PUMPFUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

/** Meteora DLMM */
export const METEORA_DLMM = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);

/** Orca Whirlpool */
export const ORCA_WHIRLPOOL = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);

// ============================================================================
// Token Mints
// ============================================================================

/** Native SOL (wrapped) */
export const SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

/** USDC */
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

/** USDT */
export const USDT_MINT = new PublicKey(
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
);

// ============================================================================
// Valid Quote Tokens
// ============================================================================

export const VALID_QUOTE_MINTS = new Set([
  SOL_MINT.toBase58(),
  USDC_MINT.toBase58(),
  USDT_MINT.toBase58(),
]);

// ============================================================================
// Program ID to DEX Type Mapping
// ============================================================================

export const PROGRAM_TO_DEX: Record<string, string> = {
  [RAYDIUM_AMM_V4.toBase58()]: "raydium_v4",
  [RAYDIUM_CLMM.toBase58()]: "raydium_clmm",
  [PUMPFUN_PROGRAM.toBase58()]: "pumpfun",
  [METEORA_DLMM.toBase58()]: "meteora",
  [ORCA_WHIRLPOOL.toBase58()]: "orca",
};
