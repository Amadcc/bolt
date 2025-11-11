/**
 * Balance Cache Utility
 *
 * Implements wallet metadata caching in session with:
 * - 60-second TTL for balance snapshots
 * - USD price conversion via Jupiter API
 * - Pagination support for 10+ tokens
 * - Automatic invalidation on balance changes
 */

import { PublicKey } from "@solana/web3.js";
import { getSolana } from "../../services/blockchain/solana.js";
import { logger } from "../../utils/logger.js";
import type { BalanceViewState, BalanceTokenEntry, Context } from "../views/index.js";
import { getJupiter } from "../../services/trading/jupiter.js";
import { asTokenMint } from "../../types/common.js";
import { SOL_MINT } from "../../config/tokens.js";
import { fetchTokenMetadata } from "../../services/tokens/metadata.js";

// Generic context type for cache invalidation
interface CacheInvalidationContext {
  session: {
    balanceView?: BalanceViewState;
  };
}

const BALANCE_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const TOKENS_PER_PAGE = 10;

// Well-known tokens for faster display
const KNOWN_TOKENS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "WIF",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
};

/**
 * Get balance data with caching
 * Checks session cache first, falls back to RPC if expired
 */
export async function getBalanceWithCache(
  ctx: Context,
  walletPublicKey: string,
  forceRefresh = false
): Promise<BalanceViewState> {
  const now = Date.now();

  // Check cache if not forcing refresh
  if (!forceRefresh && ctx.session.balanceView) {
    const cache = ctx.session.balanceView;
    const age = now - cache.lastUpdated;

    if (age < BALANCE_CACHE_TTL_MS && cache.walletPublicKey === walletPublicKey) {
      logger.debug("Balance cache hit", {
        walletPublicKey: walletPublicKey.slice(0, 8),
        age,
        totalTokens: cache.totalTokens,
      });

      return cache;
    }
  }

  // Cache miss or expired - fetch fresh data
  logger.info("Fetching fresh balance data", {
    walletPublicKey: walletPublicKey.slice(0, 8),
    forceRefresh,
  });

  const balance = await fetchBalanceData(walletPublicKey);

  // Save to session cache
  ctx.session.balanceView = balance;

  logger.debug("Balance cached", {
    walletPublicKey: walletPublicKey.slice(0, 8),
    totalTokens: balance.totalTokens,
    solAmount: balance.solAmount,
  });

  return balance;
}

/**
 * Fetch balance data from RPC
 * - Fetches SOL balance
 * - Fetches SPL token accounts
 * - Gets USD prices via Jupiter API
 * - Caches token metadata
 */
async function fetchBalanceData(
  walletPublicKey: string
): Promise<BalanceViewState> {
  const solana = getSolana();
  const connection = await solana.getConnection();
  const pubkey = new PublicKey(walletPublicKey);

  // Get SOL balance
  const lamports = await connection.getBalance(pubkey);
  const solAmount = lamports / 1e9;

  // Get SOL price in USD
  const jupiter = getJupiter();
  const solPriceResult = await jupiter.getTokenPrice(asTokenMint(SOL_MINT));
  const solPrice = solPriceResult.success ? solPriceResult.value : null;
  const solUsdValue = solPrice ? solAmount * solPrice : undefined;

  // Get SPL token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    pubkey,
    { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
  );

  // Filter out zero balance tokens first
  const nonZeroAccounts = tokenAccounts.value.filter((account) => {
    const parsedInfo = account.account.data.parsed.info;
    const amount = parseFloat(parsedInfo.tokenAmount.uiAmountString || "0");
    return amount > 0;
  });

  // ✅ OPTIMIZATION: Parallel processing of all tokens
  const tokens: BalanceTokenEntry[] = await Promise.all(
    nonZeroAccounts.map(async (account) => {
      const parsedInfo = account.account.data.parsed.info;
      const mint = parsedInfo.mint;
      const amount = parseFloat(parsedInfo.tokenAmount.uiAmountString || "0");

      // Fetch metadata and price in parallel
      const [label, tokenPriceResult] = await Promise.all([
        getTokenLabel(mint),
        jupiter.getTokenPrice(asTokenMint(mint)),
      ]);

      const tokenPrice = tokenPriceResult.success ? tokenPriceResult.value : null;
      const usdValue = tokenPrice ? amount * tokenPrice : undefined;

      return {
        mint,
        label,
        amount,
        amountDisplay: formatTokenAmount(amount),
        usdValue,
      };
    })
  );

  // Sort tokens by amount (descending)
  tokens.sort((a, b) => b.amount - a.amount);

  const snapshot = new Date().toISOString();

  return {
    snapshot,
    walletPublicKey,
    solAmount,
    solUsdValue,
    tokens,
    totalTokens: tokens.length,
    pageSize: TOKENS_PER_PAGE,
    currentPage: 0,
    lastUpdated: Date.now(),
  };
}

/**
 * Get token label (symbol or name)
 * Uses known tokens list and Metaplex metadata
 */
async function getTokenLabel(mint: string): Promise<string> {
  // Check known tokens first
  if (KNOWN_TOKENS[mint]) {
    return KNOWN_TOKENS[mint];
  }

  try {
    // Fetch Metaplex metadata
    const metadata = await fetchTokenMetadata(mint);
    const symbol = metadata?.symbol?.trim();
    const name = metadata?.name?.trim();

    // Prefer name with symbol, then name, then symbol
    if (name && symbol && name !== symbol) {
      return `${name} (${symbol})`;
    } else if (name) {
      return name;
    } else if (symbol) {
      return symbol;
    }
  } catch (error) {
    logger.debug("Failed to fetch token metadata", { mint, error });
  }

  // Fallback to truncated address
  return truncateMint(mint);
}

/**
 * Format token amount for display
 */
function formatTokenAmount(amount: number): string {
  if (amount >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(2)}M`;
  } else if (amount >= 1_000) {
    return `${(amount / 1_000).toFixed(2)}K`;
  } else if (amount >= 1) {
    return amount.toFixed(2);
  } else if (amount >= 0.01) {
    return amount.toFixed(4);
  } else {
    return amount.toExponential(2);
  }
}

/**
 * Truncate mint address for display
 */
function truncateMint(mint: string): string {
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

/**
 * Invalidate balance cache (call after trades, deposits, etc.)
 */
export function invalidateBalanceCache(ctx: CacheInvalidationContext): void {
  if (ctx.session.balanceView) {
    logger.debug("Invalidating balance cache", {
      walletPublicKey: ctx.session.balanceView.walletPublicKey.slice(0, 8),
    });
    delete ctx.session.balanceView;
  }
}

/**
 * Get paginated tokens for display
 */
export function getPaginatedTokens(
  balance: BalanceViewState,
  page: number
): {
  tokens: BalanceTokenEntry[];
  hasNext: boolean;
  hasPrev: boolean;
  pageInfo: string;
} {
  const startIndex = page * balance.pageSize;
  const endIndex = startIndex + balance.pageSize;
  const tokens = balance.tokens.slice(startIndex, endIndex);

  const hasNext = endIndex < balance.totalTokens;
  const hasPrev = page > 0;

  const pageInfo =
    balance.totalTokens > balance.pageSize
      ? `Showing ${startIndex + 1}-${Math.min(endIndex, balance.totalTokens)} of ${balance.totalTokens} tokens`
      : `${balance.totalTokens} token${balance.totalTokens === 1 ? "" : "s"}`;

  return { tokens, hasNext, hasPrev, pageInfo };
}
