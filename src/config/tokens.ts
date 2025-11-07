/**
 * Token Configuration
 *
 * Manages token mint addresses for different Solana networks
 */

// Determine current network from environment
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || "mainnet";
const isDevnet = SOLANA_NETWORK === "devnet";

// ============================================================================
// Token Mint Addresses
// ============================================================================

/**
 * Mainnet Token Addresses
 */
const MAINNET_TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
} as const;

/**
 * Token Decimals (Mainnet)
 */
const MAINNET_TOKEN_DECIMALS: Record<string, number> = {
  So11111111111111111111111111111111111111112: 9, // SOL
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5, // BONK
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 6, // WIF
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6, // JUP
};

/**
 * Devnet Token Addresses
 *
 * Note: Devnet has limited liquidity and test tokens.
 * Use these for wallet/balance testing only.
 * Swaps won't work on devnet (no liquidity pools).
 */
const DEVNET_TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  WSOL: "So11111111111111111111111111111111111111112",
  // Circle's official devnet USDC (get from https://faucet.circle.com)
  USDC: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  // For testing - you may need to create your own test tokens
  USDT: "USDT_DEVNET_NOT_AVAILABLE", // Placeholder - create your own
  BONK: "BONK_DEVNET_NOT_AVAILABLE", // Placeholder - create your own
  WIF: "WIF_DEVNET_NOT_AVAILABLE",   // Placeholder - create your own
  JUP: "JUP_DEVNET_NOT_AVAILABLE",   // Placeholder - create your own
} as const;

/**
 * Get token addresses for current network
 */
export const KNOWN_TOKENS = isDevnet ? DEVNET_TOKENS : MAINNET_TOKENS;

/**
 * SOL mint address (same on all networks)
 */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Resolve token symbol to mint address
 *
 * @param symbol - Token symbol (e.g., "USDC", "SOL") or mint address
 * @returns Token mint address
 * @throws Error if symbol is unknown
 */
export function resolveTokenSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();

  // If it's a known symbol, return its mint
  if (upper in KNOWN_TOKENS) {
    const mint = KNOWN_TOKENS[upper as keyof typeof KNOWN_TOKENS];

    // Check if token is available on current network
    if (mint.endsWith("_NOT_AVAILABLE")) {
      throw new Error(
        `${symbol} is not available on ${SOLANA_NETWORK}. ` +
        (isDevnet
          ? "Switch to mainnet or create your own test token."
          : "This token is only available on mainnet.")
      );
    }

    return mint;
  }

  // Otherwise assume it's already a mint address
  if (symbol.length >= 32) {
    return symbol;
  }

  throw new Error(
    `Unknown token symbol: ${symbol}. ` +
    `Available tokens on ${SOLANA_NETWORK}: ${Object.keys(KNOWN_TOKENS).join(", ")}`
  );
}

/**
 * Get network name
 */
export function getNetworkName(): string {
  return SOLANA_NETWORK;
}

/**
 * Check if running on devnet
 */
export function isDevnetMode(): boolean {
  return isDevnet;
}

/**
 * Get available token symbols for current network
 */
export function getAvailableTokens(): string[] {
  return Object.entries(KNOWN_TOKENS)
    .filter(([_, mint]) => !mint.endsWith("_NOT_AVAILABLE"))
    .map(([symbol]) => symbol);
}

/**
 * Get token info
 */
export function getTokenInfo(symbol: string): {
  symbol: string;
  mint: string;
  network: string;
  available: boolean;
} {
  const upper = symbol.toUpperCase();
  const mint = KNOWN_TOKENS[upper as keyof typeof KNOWN_TOKENS] || "";
  const available = !mint.endsWith("_NOT_AVAILABLE") && mint.length > 0;

  return {
    symbol: upper,
    mint: available ? mint : "",
    network: SOLANA_NETWORK,
    available,
  };
}

/**
 * Get token decimals by mint address
 * Returns 9 (default for SOL) if not found
 */
export function getTokenDecimals(mint: string): number {
  return MAINNET_TOKEN_DECIMALS[mint] || 9;
}

/**
 * Convert human-readable amount to minimal units with precise arithmetic (MEDIUM-3)
 * Example: 131921.83 BONK (5 decimals) -> 13192183000
 * Uses BigNumber to avoid floating point precision errors
 */
export function toMinimalUnits(amount: number, decimals: number): string {
  // MEDIUM-3: Use BigNumber for precise decimal arithmetic
  const BigNumber = require("bignumber.js");
  const minimalUnits = new BigNumber(amount)
    .multipliedBy(new BigNumber(10).pow(decimals))
    .integerValue(BigNumber.ROUND_DOWN);

  return minimalUnits.toString();
}
