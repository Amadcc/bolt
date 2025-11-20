/**
 * Solana DEX Program Addresses
 *
 * Program IDs for token detection and sniper monitoring
 */

import type { SolanaAddress } from "../types/common.js";

// ============================================================================
// Mainnet Program Addresses
// ============================================================================

/**
 * Raydium AMM V4 Program
 * Most popular DEX on Solana - highest volume
 */
export const RAYDIUM_V4_PROGRAM: SolanaAddress = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" as SolanaAddress;

/**
 * Raydium CLMM (Concentrated Liquidity Market Maker) Program
 * Uniswap V3-style concentrated liquidity
 */
export const RAYDIUM_CLMM_PROGRAM: SolanaAddress = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" as SolanaAddress;

/**
 * Orca Whirlpool Program
 * Concentrated liquidity DEX
 */
export const ORCA_WHIRLPOOL_PROGRAM: SolanaAddress = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" as SolanaAddress;

/**
 * Meteora DLMM (Dynamic Liquidity Market Maker) Program
 * Advanced AMM with dynamic fees
 */
export const METEORA_DLMM_PROGRAM: SolanaAddress = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" as SolanaAddress;

/**
 * Pump.fun Program
 * Bonding curve token launcher (popular for memecoins)
 */
export const PUMP_FUN_PROGRAM: SolanaAddress = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" as SolanaAddress;

/**
 * PumpSwap AMM Program
 * DEX where Pump.fun tokens migrate after bonding curve
 */
export const PUMPSWAP_PROGRAM: SolanaAddress = "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP" as SolanaAddress;

// ============================================================================
// Program Metadata
// ============================================================================

export interface ProgramInfo {
  address: SolanaAddress;
  name: string;
  type: "AMM" | "CLMM" | "DLMM" | "BONDING_CURVE";
  priority: number; // 1 = highest (most volume)
}

/**
 * All monitored DEX programs with metadata
 */
export const DEX_PROGRAMS: Record<string, ProgramInfo> = {
  raydium_v4: {
    address: RAYDIUM_V4_PROGRAM,
    name: "Raydium AMM V4",
    type: "AMM",
    priority: 1, // Highest priority - most volume
  },
  raydium_clmm: {
    address: RAYDIUM_CLMM_PROGRAM,
    name: "Raydium CLMM",
    type: "CLMM",
    priority: 2,
  },
  orca_whirlpool: {
    address: ORCA_WHIRLPOOL_PROGRAM,
    name: "Orca Whirlpool",
    type: "CLMM",
    priority: 3,
  },
  meteora: {
    address: METEORA_DLMM_PROGRAM,
    name: "Meteora DLMM",
    type: "DLMM",
    priority: 4,
  },
  pump_fun: {
    address: PUMP_FUN_PROGRAM,
    name: "Pump.fun",
    type: "BONDING_CURVE",
    priority: 5,
  },
  pumpswap: {
    address: PUMPSWAP_PROGRAM,
    name: "PumpSwap AMM",
    type: "AMM",
    priority: 6,
  },
};

/**
 * Get program info by address
 */
export function getProgramInfo(address: string): ProgramInfo | undefined {
  return Object.values(DEX_PROGRAMS).find((p) => p.address === address);
}

/**
 * Get all program addresses
 */
export function getAllProgramAddresses(): SolanaAddress[] {
  return Object.values(DEX_PROGRAMS).map((p) => p.address);
}

/**
 * Get programs sorted by priority
 */
export function getProgramsByPriority(): ProgramInfo[] {
  return Object.values(DEX_PROGRAMS).sort((a, b) => a.priority - b.priority);
}
