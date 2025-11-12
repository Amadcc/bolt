/**
 * Callback Query Handlers
 * Handle all inline button clicks
 */

import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type {
  BalanceViewState,
  Context,
  Page,
  TokenMetadataCacheState,
} from "../views/index.js";
import { navigateToPage } from "../views/index.js";
import { logger } from "../../utils/logger.js";
import { lockSession } from "../commands/session.js";
import { destroySession } from "../../services/wallet/session.js";
import { getTradingExecutor } from "../../services/trading/executor.js";
import { asTokenMint } from "../../types/common.js";
import {
  resolveTokenSymbol,
  SOL_MINT,
  getTokenDecimals,
  toMinimalUnits,
} from "../../config/tokens.js";
import type { TradingError } from "../../types/trading.js";
import { executeBuyFlow } from "../flows/buy.js";
import { clearPasswordState } from "../utils/passwordState.js";
import { getSolanaConnection } from "../../services/blockchain/solana.js";
import { getJupiter } from "../../services/trading/jupiter.js";
import { getTokenAccountsForOwner } from "../../services/tokens/accounts.js";
import { fetchTokenMetadata } from "../../services/tokens/metadata.js";
import {
  buildConversationKey,
  CONVERSATION_TOPICS,
  DEFAULT_CONVERSATION_TTL_MS,
  scheduleConversationTimeout,
} from "../utils/conversationTimeouts.js";
import { createSwapConfirmationKeyboard } from "../keyboards/swap.js";
import { getUserContext, invalidateUserContext } from "../utils/userContext.js";
import { setPasswordReusePreference } from "../../services/security/passwordPreference.js";

const BALANCE_PAGE_SIZE = 10;
const SESSION_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;

const KNOWN_TOKENS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "WIF",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
};

// ============================================================================
// Navigation Callbacks
// ============================================================================

/**
 * Handle navigation callbacks (nav:page_name)
 */
export async function handleNavigationCallback(
  ctx: Context,
  page: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  const validPages = [
    "create_wallet",
    "main",
    "buy",
    "sell",
    "swap",
    "balance",
    "snipe",
    "wallet_info",
    "settings",
    "unlock",
    "status",
    "help",
  ];

  if (!validPages.includes(page)) {
    logger.warn("Invalid navigation page", { page, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Invalid page");
    return;
  }

  await navigateToPage(ctx, page as any);
}

// ============================================================================
// Action Callbacks
// ============================================================================

/**
 * Handle action callbacks (action:action_name)
 */
export async function handleActionCallback(
  ctx: Context,
  action: string,
  params?: string[]
): Promise<void> {
  switch (action) {
    case "unlock":
      await handleUnlockAction(ctx);
      break;

    case "lock":
      await handleLockAction(ctx);
      break;

    case "refresh_balance":
      await handleRefreshBalanceAction(ctx);
      break;

    case "balance_page":
      await handleBalancePaginationAction(ctx, params?.[0]);
      break;

    case "copy":
      await handleCopyAction(ctx, params?.[0]);
      break;

    case "noop":
      await ctx.answerCallbackQuery();
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown action");
      logger.warn("Unknown action", { action, userId: ctx.from?.id });
  }
}

/**
 * Unlock wallet action
 * ✅ Single-Page UI: Navigate to unlock page
 */
async function handleUnlockAction(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery("🔓 Unlock wallet");

  // Save current page to return after unlock
  const currentPage = ctx.session.ui?.currentPage;
  if (currentPage && currentPage !== "unlock") {
    ctx.session.returnToPageAfterUnlock = currentPage;
  }

  await navigateToPage(ctx, "unlock");
}

/**
 * Lock wallet action
 * ✅ CRITICAL-3 Fix: Destroy Redis session to prevent stolen token attacks
 */
async function handleLockAction(ctx: Context): Promise<void> {
  // 🔐 Destroy Redis session if exists (CRITICAL-3 fix)
  if (ctx.session.sessionToken) {
    await destroySession(ctx.session.sessionToken as any);
  }

  // Save current page to return after lock
  const currentPage = ctx.session.ui?.currentPage;
  const returnToPage =
    currentPage && currentPage !== "main" ? currentPage : "main";

  // Clear Grammy session
  await lockSession(ctx);

  await ctx.answerCallbackQuery("🔒 Wallet locked");
  await navigateToPage(ctx, returnToPage);
}

/**
 * Refresh balance action
 */
async function handleRefreshBalanceAction(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery("🔄 Refreshing balance...");

  // Show loading state
  try {
    await ctx.editMessageText(
      `📊 *Your Balance*\n\n` + `⏳ Loading balances...`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "action:refresh_balance" }],
            [{ text: "« Back to Dashboard", callback_data: "nav:main" }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error("Error updating balance loading state", { error });
  }

  const userContext = await getUserContext(ctx);

  if (!userContext.activeWallet) {
    await navigateToPage(ctx, "main");
    return;
  }

  const wallet = userContext.activeWallet;

  // Use new balance cache with forceRefresh=true
  const { getBalanceWithCache } = await import("../utils/balanceCache.js");
  const { renderBalancePage } = await import("../views/index.js");

  // Invalidate cache and fetch fresh data
  await getBalanceWithCache(ctx, wallet.publicKey, true);

  // Re-render balance page with new data
  const { text, keyboard } = await renderBalancePage(ctx, 0);

  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error("Error updating balance after refresh", { error });
  }
}

/**
 * Fetch balance and update message
 * @deprecated Use renderBalancePage() from views/index.ts instead (with caching)
 * This function is kept only for backward compatibility
 */
export async function fetchAndDisplayBalance(ctx: Context): Promise<void> {
  const startedAt = Date.now();

  try {
    const userContext = await getUserContext(ctx);

    if (!userContext.activeWallet) {
      await navigateToPage(ctx, "main");
      return;
    }

    const wallet = userContext.activeWallet;
    const connection = await getSolanaConnection();
    const publicKey = new PublicKey(wallet.publicKey);

    const [lamports, tokenAccounts] = await Promise.all([
      connection.getBalance(publicKey),
      getTokenAccountsForOwner(publicKey, connection),
    ]);

    const snapshot = createBalanceSnapshot(lamports, tokenAccounts);
    const previousSnapshot = ctx.session.balanceView?.snapshot;

    if (previousSnapshot && previousSnapshot !== snapshot) {
      ctx.session.tokenMetadataCache = undefined;
    }

    const metadataCache = ensureTokenMetadataCache(ctx);
    const metadataStats = { hits: 0, misses: 0 };

    const sol = lamports / LAMPORTS_PER_SOL;
    const jupiter = getJupiter();
    const solPriceResult = await jupiter.getTokenPrice(asTokenMint(SOL_MINT));
    const solPrice = solPriceResult.success ? solPriceResult.value : null;
    const solUsdValue = solPrice ? sol * solPrice : undefined;

    const tokenRows: BalanceViewState["tokens"] = [];

    for (const tokenAccount of tokenAccounts) {
      if (tokenAccount.amount <= 0) {
        continue;
      }

      const mint = tokenAccount.mint;
      const label =
        KNOWN_TOKENS[mint] ??
        (await resolveTokenLabel(metadataCache, mint, metadataStats));

      const tokenPriceResult = await jupiter.getTokenPrice(asTokenMint(mint));
      const tokenPrice = tokenPriceResult.success
        ? tokenPriceResult.value
        : null;
      const tokenUsdValue = tokenPrice
        ? tokenAccount.amount * tokenPrice
        : undefined;

      tokenRows.push({
        mint,
        label,
        amount: tokenAccount.amount,
        amountDisplay: formatAmount(tokenAccount.amount),
        usdValue: tokenUsdValue,
      });
    }

    tokenRows.sort((a, b) => b.amount - a.amount);

    const balanceState: BalanceViewState = {
      snapshot,
      walletPublicKey: wallet.publicKey,
      solAmount: sol,
      solUsdValue,
      tokens: tokenRows,
      totalTokens: tokenRows.length,
      pageSize: BALANCE_PAGE_SIZE,
      currentPage: 0,
      lastUpdated: Date.now(),
    };

    ctx.session.balanceView = balanceState;

    await updateBalanceMessage(ctx, balanceState);

    logger.debug("Balance view refreshed", {
      userId: ctx.from?.id,
      tokens: tokenRows.length,
      durationMs: Date.now() - startedAt,
      metadataCacheHits: metadataStats.hits,
      metadataCacheMisses: metadataStats.misses,
    });
  } catch (error) {
    logger.error("Error fetching balance", { error });
    await ctx.editMessageText(
      `*Balance*\n\n` + `Failed to load. Please try again.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Try Again", callback_data: "action:refresh_balance" }],
            [{ text: "« Back to Dashboard", callback_data: "nav:main" }],
          ],
        },
      }
    );
  }
}

async function handleBalancePaginationAction(
  ctx: Context,
  direction?: string
): Promise<void> {
  const state = ctx.session.balanceView;

  if (!state) {
    await ctx.answerCallbackQuery("⚠️ Tap refresh first");
    return;
  }

  if (state.totalTokens <= state.pageSize) {
    await ctx.answerCallbackQuery("ℹ️ All tokens already visible");
    return;
  }

  const totalPages = Math.max(1, Math.ceil(state.totalTokens / state.pageSize));

  if (direction === "next") {
    state.currentPage = (state.currentPage + 1) % totalPages;
  } else if (direction === "prev") {
    state.currentPage = (state.currentPage - 1 + totalPages) % totalPages;
  }

  ctx.session.balanceView = state;
  await ctx.answerCallbackQuery();
  await updateBalanceMessage(ctx, state);
}

/**
 * Handle balance page navigation (new format: balance:page:N)
 */
export async function handleBalancePageCallback(
  ctx: Context,
  page: number
): Promise<void> {
  const state = ctx.session.balanceView;

  if (!state) {
    await ctx.answerCallbackQuery("⚠️ Tap refresh first");
    return;
  }

  if (state.totalTokens <= state.pageSize) {
    await ctx.answerCallbackQuery("ℹ️ All tokens already visible");
    return;
  }

  const totalPages = Math.max(1, Math.ceil(state.totalTokens / state.pageSize));

  // Validate page number
  if (page < 0 || page >= totalPages) {
    await ctx.answerCallbackQuery("❌ Invalid page");
    return;
  }

  await ctx.answerCallbackQuery();

  // Use new rendering system
  const { renderBalancePage } = await import("../views/index.js");
  const { text, keyboard } = await renderBalancePage(ctx, page);

  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error("Error updating balance page", { error });
  }
}

function ensureTokenMetadataCache(ctx: Context): TokenMetadataCacheState {
  if (!ctx.session.tokenMetadataCache) {
    ctx.session.tokenMetadataCache = { entries: {} };
  }
  return ctx.session.tokenMetadataCache;
}

type MetadataStats = {
  hits: number;
  misses: number;
};

async function resolveTokenLabel(
  cache: TokenMetadataCacheState,
  mint: string,
  stats: MetadataStats
): Promise<string> {
  const now = Date.now();
  const cached = cache.entries[mint];

  if (cached && cached.expiresAt > now) {
    stats.hits++;
    return (
      cached.label ?? cached.symbol ?? cached.name ?? truncateAddress(mint)
    );
  }

  if (cached) {
    delete cache.entries[mint];
  }

  stats.misses++;

  const metadata = await fetchTokenMetadata(mint);
  const symbol = metadata?.symbol?.trim();
  const name = metadata?.name?.trim();

  let label: string;
  if (name && symbol && name !== symbol) {
    label = `${name} (${symbol})`;
  } else if (name) {
    label = name;
  } else if (symbol) {
    label = symbol;
  } else {
    label = truncateAddress(mint);
  }

  cache.entries[mint] = {
    symbol,
    name,
    label,
    expiresAt: now + SESSION_METADATA_CACHE_TTL_MS,
  };

  return label;
}

/**
 * @deprecated Use renderBalancePage() from views/index.ts instead (with caching)
 * This function uses old format without caching
 */
async function updateBalanceMessage(
  ctx: Context,
  state: BalanceViewState
): Promise<void> {
  const totalPages =
    state.totalTokens > 0 ? Math.ceil(state.totalTokens / state.pageSize) : 1;

  if (state.totalTokens > 0 && state.currentPage >= totalPages) {
    state.currentPage = Math.max(totalPages - 1, 0);
  }

  const payload = buildBalancePayload(state, totalPages);

  try {
    await ctx.editMessageText(payload.text, {
      parse_mode: "Markdown",
      reply_markup: payload.keyboard,
    });
    ctx.session.balanceView = state;
  } catch (error: any) {
    if (error?.description?.includes("message is not modified")) {
      logger.debug("Balance message unchanged", {
        userId: ctx.from?.id,
        page: state.currentPage,
      });
      return;
    }
    throw error;
  }
}

function buildBalancePayload(
  state: BalanceViewState,
  totalPages: number
): {
  text: string;
  keyboard: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
} {
  const hasTokens = state.totalTokens > 0;
  const startIndex = hasTokens ? state.currentPage * state.pageSize : 0;
  const endIndex = hasTokens
    ? Math.min(state.totalTokens, startIndex + state.pageSize)
    : 0;
  const visibleTokens = hasTokens
    ? state.tokens.slice(startIndex, endIndex)
    : [];

  let text = `*Balance*\n\n`;
  text += `\`${state.walletPublicKey}\`\n\n`;
  text += `SOL: *${state.solAmount.toFixed(4)}*`;
  if (state.solUsdValue !== undefined) {
    text += ` ($${state.solUsdValue.toFixed(2)})`;
  }
  text += `\n`;

  if (!hasTokens) {
    text += `\nNo tokens yet`;
  } else {
    text += `\n*Tokens (${state.totalTokens})*\n`;
    for (const token of visibleTokens) {
      text += `${token.label}: ${token.amountDisplay}`;
      if (token.usdValue !== undefined) {
        text += ` ($${token.usdValue.toFixed(2)})`;
      }
      text += `\n`;
    }

    if (state.totalTokens > state.pageSize) {
      text += `\nShowing ${startIndex + 1}-${endIndex} of ${
        state.totalTokens
      } tokens`;
    }
  }

  text += `\nLast updated: ${new Date(state.lastUpdated).toLocaleTimeString()}`;

  const inline_keyboard: { text: string; callback_data: string }[][] = [];

  if (state.totalTokens > state.pageSize) {
    inline_keyboard.push([
      { text: "⬅️ Prev", callback_data: "action:balance_page:prev" },
      {
        text: `Page ${state.currentPage + 1}/${totalPages}`,
        callback_data: "action:noop",
      },
      { text: "Next ➡️", callback_data: "action:balance_page:next" },
    ]);
  }

  inline_keyboard.push([
    { text: "🔄 Refresh", callback_data: "action:refresh_balance" },
  ]);
  inline_keyboard.push([
    { text: "« Back to Dashboard", callback_data: "nav:main" },
  ]);

  return {
    text,
    keyboard: { inline_keyboard },
  };
}

function createBalanceSnapshot(
  lamports: number,
  tokenAccounts: Array<{ mint: string; rawAmount: bigint }>
): string {
  const parts = tokenAccounts
    .map((account) => `${account.mint}:${account.rawAmount.toString()}`)
    .sort();
  return `${lamports}:${parts.join("|")}`;
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return amount.toExponential(2);
  if (amount >= 1000)
    return amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (amount >= 1)
    return amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  if (amount >= 0.000001)
    return amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  return amount.toExponential(2);
}

const INPUT_TIMEOUT_MESSAGES: Partial<Record<Page, string>> = {
  buy: "⏰ Buy flow timed out. Open *Buy* again to continue.",
  sell: "⏰ Sell flow timed out. Open *Sell* again to continue.",
  swap: "⏰ Swap flow timed out. Open *Swap* again to continue.",
};

function scheduleAwaitingInputTimeout(ctx: Context, page: Page): void {
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;

  if (!telegramId || !chatId) {
    return;
  }

  const key = buildConversationKey(
    telegramId,
    CONVERSATION_TOPICS.awaitingInput
  );
  const sessionRef = ctx.session;
  const api = ctx.api;
  const timeoutMessage =
    INPUT_TIMEOUT_MESSAGES[page] ??
    "⏰ Input timed out. Please reopen the flow to continue.";

  scheduleConversationTimeout(key, DEFAULT_CONVERSATION_TTL_MS, async () => {
    if (!sessionRef.awaitingInput || sessionRef.awaitingInput.page !== page) {
      return;
    }

    sessionRef.awaitingInput = undefined;
    await api.sendMessage(chatId, timeoutMessage, {
      parse_mode: "Markdown",
    });
  });
}

/**
 * Copy address action
 */
async function handleCopyAction(ctx: Context, address?: string): Promise<void> {
  if (!address) {
    await ctx.answerCallbackQuery("❌ No address to copy");
    return;
  }

  await ctx.answerCallbackQuery(`📋 Address copied: ${address.slice(0, 8)}...`);
}

// ============================================================================
// Buy Flow Callbacks
// ============================================================================

/**
 * Handle buy callbacks (buy:action:params)
 */
export async function handleBuyCallback(
  ctx: Context,
  action: string,
  params: string[]
): Promise<void> {
  logger.info("Buy callback received", {
    action,
    params,
    userId: ctx.from?.id,
  });

  switch (action) {
    case "token":
      await handleBuyTokenSelection(ctx, params[0]);
      break;

    case "amount":
      await handleBuyAmountSelection(ctx, params[0], params[1]);
      break;

    case "confirm":
      // User confirmed buy - execute with skipConfirmation=true
      await handleBuyConfirmation(ctx, params[0], params[1]);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown buy action");
      logger.warn("Unknown buy action", {
        action,
        params,
        userId: ctx.from?.id,
      });
  }
}

/**
 * Handle token selection for buy
 */
async function handleBuyTokenSelection(
  ctx: Context,
  token: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  if (token === "custom") {
    // Wait for custom address input
    ctx.session.awaitingInput = {
      type: "token",
      page: "buy",
    };
    scheduleAwaitingInputTimeout(ctx, "buy");

    await ctx.editMessageText(
      `🛒 *Buy Tokens*\n\n` +
        `✏️ *Custom Token Address*\n\n` +
        `Send the token mint address in the next message.\n\n` +
        `Example: \`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel", callback_data: "nav:buy" }]],
        },
      }
    );
    return;
  }

  // Save selected token and show amount options
  if (!ctx.session.ui.buyData) {
    ctx.session.ui.buyData = {};
  }
  ctx.session.ui.buyData.selectedToken = token;

  await navigateToPage(ctx, "buy", { selectedToken: token });
}

/**
 * Handle amount selection for buy
 */
async function handleBuyAmountSelection(
  ctx: Context,
  token: string,
  amount: string
): Promise<void> {
  logger.info("Buy amount selection", { token, amount, userId: ctx.from?.id });

  await ctx.answerCallbackQuery();

  if (amount === "custom") {
    // Wait for custom amount input
    ctx.session.awaitingInput = {
      type: "amount",
      page: "buy",
    };
    scheduleAwaitingInputTimeout(ctx, "buy");

    if (!ctx.session.ui.buyData) {
      ctx.session.ui.buyData = {};
    }
    ctx.session.ui.buyData.selectedToken = token;

    await ctx.editMessageText(
      `🛒 *Buy ${token}*\n\n` +
        `✏️ *Custom Amount*\n\n` +
        `Send the amount of SOL you want to spend.\n\n` +
        `Example: \`0.1\` or \`1.5\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel", callback_data: "nav:buy" }]],
        },
      }
    );
    return;
  }

  logger.info("Executing buy flow", { token, amount, userId: ctx.from?.id });

  // Execute buy
  await ctx.answerCallbackQuery();
  await executeBuyFlow(ctx, token, amount);
}

/**
 * Handle buy confirmation (after user clicks "Confirm Buy")
 * ✅ Skips confirmation step since user already confirmed
 */
async function handleBuyConfirmation(
  ctx: Context,
  token: string,
  amount: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  logger.info("Buy confirmation received", {
    token,
    amount,
    userId: ctx.from?.id,
    autoApprove: ctx.session.settings?.autoApprove,
  });

  // Execute buy with skipConfirmation=true
  await executeBuyFlow(ctx, token, amount, true);
}

// ============================================================================
// Sell Flow Callbacks
// ============================================================================

/**
 * Handle sell callbacks (sell:action:params)
 */
export async function handleSellCallback(
  ctx: Context,
  action: string,
  params: string[]
): Promise<void> {
  switch (action) {
    case "token":
      await handleSellTokenSelection(ctx, params[0]);
      break;

    case "amount":
      await handleSellAmountSelection(ctx, params[0], params[1]);
      break;

    case "confirm":
      // User confirmed sell (percentage-based) - execute with skipConfirmation=true
      await handleSellConfirmation(ctx, params[0], params[1]);
      break;

    case "confirm_abs":
      // User confirmed sell (absolute amount) - execute with skipConfirmation=true
      await handleSellAbsoluteConfirmation(ctx, params[0], params[1]);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown sell action");
  }
}

/**
 * Handle sell confirmation (after user clicks "Confirm Sell")
 * ✅ Skips confirmation step since user already confirmed
 */
async function handleSellConfirmation(
  ctx: Context,
  token: string,
  percentage: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  logger.info("Sell confirmation received", {
    token,
    percentage,
    userId: ctx.from?.id,
    autoApprove: ctx.session.settings?.autoApprove,
  });

  // Execute sell with skipConfirmation=true
  await executeSellFlow(ctx, token, percentage, true);
}

/**
 * Handle sell confirmation for absolute amount (after user clicks "Confirm Sell")
 * ✅ Skips confirmation step since user already confirmed
 */
async function handleSellAbsoluteConfirmation(
  ctx: Context,
  token: string,
  absoluteAmount: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  logger.info("Sell absolute confirmation received", {
    token,
    absoluteAmount,
    userId: ctx.from?.id,
    autoApprove: ctx.session.settings?.autoApprove,
  });

  // Execute sell with skipConfirmation=true
  await executeSellWithAbsoluteAmount(ctx, token, absoluteAmount, true);
}

/**
 * Handle token selection for sell
 */
async function handleSellTokenSelection(
  ctx: Context,
  token: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  if (token === "custom") {
    ctx.session.awaitingInput = {
      type: "token",
      page: "sell",
    };
    scheduleAwaitingInputTimeout(ctx, "sell");

    await ctx.editMessageText(
      `💸 *Sell Tokens*\n\n` +
        `✏️ *Custom Token Address*\n\n` +
        `Send the token mint address in the next message.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel", callback_data: "nav:sell" }]],
        },
      }
    );
    return;
  }

  if (!ctx.session.ui.sellData) {
    ctx.session.ui.sellData = {};
  }
  ctx.session.ui.sellData.selectedToken = token;

  await navigateToPage(ctx, "sell", { selectedToken: token });
}

/**
 * Handle amount selection for sell
 */
async function handleSellAmountSelection(
  ctx: Context,
  token: string,
  amount: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  if (amount === "custom") {
    ctx.session.awaitingInput = {
      type: "amount",
      page: "sell",
    };
    scheduleAwaitingInputTimeout(ctx, "sell");

    if (!ctx.session.ui.sellData) {
      ctx.session.ui.sellData = {};
    }
    ctx.session.ui.sellData.selectedToken = token;

    await ctx.editMessageText(
      `💸 *Sell ${token}*\n\n` +
        `✏️ *Custom Amount*\n\n` +
        `Send the amount you want to sell.\n\n` +
        `Example: \`1000000\` tokens`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel", callback_data: "nav:sell" }]],
        },
      }
    );
    return;
  }

  // Execute sell (percentage-based)
  await executeSellFlow(ctx, token, amount);
}

/**
 * Execute sell flow with confirmation
 * ✅ Auto-approve support: Skip confirmation when enabled
 */
export async function executeSellFlow(
  ctx: Context,
  token: string,
  percentage: string,
  skipConfirmation = false
): Promise<void> {
  // ✅ Redis Session Integration: Check if wallet is unlocked
  // We only check sessionToken - password availability will be checked in executor
  if (!ctx.session.sessionToken) {
    // Only answer callback query if this is a callback context
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery();
    }

    // Save pending command so unlock handler can execute it
    ctx.session.pendingCommand = {
      type: "sell_pct", // Percentage-based sell
      params: [token, percentage],
    };

    logger.info("Saved pending sell command", {
      token,
      percentage,
      userId: ctx.from?.id,
    });

    const msgId = ctx.session.ui.messageId;
    if (!msgId || !ctx.chat) {
      await ctx.reply("❌ Session expired. Please use /start");
      return;
    }

    // Show unlock prompt with buttons
    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `🔒 *Wallet Locked*\n\n` +
        `To sell ${percentage}% of ${token}, please unlock your wallet first.\n\n` +
        `Your session will be active for 15 minutes.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔓 Unlock Wallet", callback_data: "action:unlock" },
              { text: "« Cancel", callback_data: "nav:main" },
            ],
          ],
        },
      }
    );
    return;
  }

  // ✅ Auto-approve check: Show confirmation if disabled
  const autoApprove = ctx.session.settings?.autoApprove ?? false;

  if (!autoApprove && !skipConfirmation) {
    // Show confirmation before selling
    logger.info("Showing sell confirmation (auto-approve disabled)", {
      token,
      percentage,
      userId: ctx.from?.id,
    });

    const msgId = ctx.session.ui.messageId;
    if (msgId && ctx.chat) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `💸 *Confirm Sell*\n\n` +
          `Token: **${token}**\n` +
          `Amount: **${percentage}%** of balance\n\n` +
          `━━━\n\n` +
          `⚠️ Confirm to execute this trade`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Confirm Sell",
                  callback_data: `sell:confirm:${token}:${percentage}`,
                },
              ],
              [{ text: "« Cancel", callback_data: "nav:sell" }],
            ],
          },
        }
      );
    }
    return;
  }

  // Auto-approve enabled or confirmation skipped - execute immediately
  logger.info(
    "Executing sell immediately (auto-approve enabled or confirmed)",
    { token, percentage }
  );

  try {
    const userContext = await getUserContext(ctx);
    const wallet = userContext.activeWallet;

    if (!wallet) {
      await ctx.editMessageText(
        "❌ Wallet not found. Please create one first.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 Home", callback_data: "nav:main" }]],
          },
        }
      );
      return;
    }

    // Resolve token mint with validation
    const tokenMintResult = resolveTokenSymbol(token);
    if (!tokenMintResult.success) {
      await ctx.editMessageText(
        `❌ *Invalid Token*\n\n${tokenMintResult.error}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:sell" }]],
          },
        }
      );
      return;
    }
    const tokenMint = tokenMintResult.value;

    // Progress: Step 1 - Checking balance
    await updateSellProgress(ctx, {
      step: 1,
      total: 3,
      message: `Token: ${token}\nAmount: ${percentage}%`,
      status: "Checking balance...",
    });

    // Get balance from blockchain
    const { getSolanaConnection } = await import(
      "../../services/blockchain/solana.js"
    );
    const { PublicKey } = await import("@solana/web3.js");
    const connection = await getSolanaConnection();
    const publicKey = new PublicKey(wallet.publicKey);

    // Get token balance
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      publicKey,
      { mint: new PublicKey(tokenMint) }
    );

    if (tokenAccounts.value.length === 0) {
      await ctx.editMessageText(
        `❌ *No Balance*\n\nYou don't have any ${token} tokens.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:sell" }]],
          },
        }
      );
      return;
    }

    const tokenAccount = tokenAccounts.value[0];
    const accountData = tokenAccount.account.data.parsed.info;
    const balance = BigInt(accountData.tokenAmount.amount);
    const decimals = accountData.tokenAmount.decimals;

    // Calculate amount to sell based on percentage
    const percentageNum = parseInt(percentage);
    const amountToSell = (balance * BigInt(percentageNum)) / 100n;

    if (amountToSell === 0n) {
      await ctx.editMessageText(
        `❌ *Insufficient Balance*\n\nAmount too small to sell.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:sell" }]],
          },
        }
      );
      return;
    }

    // Progress: Step 2 - Executing sell
    await updateSellProgress(ctx, {
      step: 2,
      total: 3,
      message: `Token: ${token}\nAmount: ${formatTokenAmount(
        amountToSell,
        decimals
      )} (${percentage}%)`,
      status: "Executing sell...",
    });

    // Execute trade
    const inputMint = asTokenMint(tokenMint);
    const outputMint = asTokenMint(SOL_MINT);

    const executor = getTradingExecutor();
    const tradeResult = await executor.executeTrade(
      {
        userId: userContext.userId,
        inputMint,
        outputMint,
        amount: amountToSell.toString(),
        slippageBps: 50, // 0.5% slippage
      },
      undefined,
      ctx.session.sessionToken as any,
      { reusePassword: Boolean(ctx.session.passwordReuseEnabled) }
    );
    if (!ctx.session.passwordReuseEnabled) {
      clearPasswordState(ctx.session);
      // In strict mode, also clear sessionToken to force unlock on next trade
      ctx.session.sessionToken = undefined;
      ctx.session.sessionExpiresAt = undefined;
      logger.info("Strict mode: cleared session after trade", {
        userId: userContext.userId,
      });
    }

    if (!tradeResult.success) {
      const error = tradeResult.error as TradingError;

      let errorMessage = "Trade execution failed";
      if (error.type === "WALLET_NOT_FOUND") {
        errorMessage = "Wallet not found";
      } else if (error.type === "INVALID_PASSWORD") {
        errorMessage = "Session expired. Please unlock again.";
      } else if (error.type === "SWAP_FAILED") {
        errorMessage = `Swap failed: ${error.reason}`;
      }

      await ctx.editMessageText(`❌ *Sell Failed*\n\n${errorMessage}`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 Try Again",
                callback_data: `sell:amount:${token}:${percentage}`,
              },
              { text: "« Back", callback_data: "nav:sell" },
            ],
          ],
        },
      });
      return;
    }

    const result = tradeResult.value;
    const solReceived = Number(result.outputAmount) / 1e9;

    // Progress: Step 3 - Completed
    await updateSellProgress(ctx, {
      step: 3,
      total: 3,
      message: `Token: ${token}\nAmount: ${formatTokenAmount(
        amountToSell,
        decimals
      )} (${percentage}%)`,
      status: "Confirmed!",
    });

    // Show completion progress for a moment
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Success!
    await ctx.editMessageText(
      `✅ *Sell Successful!*\n\n` +
        `Sold **${token}** for **${solReceived.toFixed(4)} SOL**\n\n` +
        `Transaction: \`${result.signature}\`\n` +
        `Slot: ${result.slot}\n\n` +
        `Input: ${formatTokenAmount(result.inputAmount, decimals)} ${token}\n` +
        `Output: ${solReceived.toFixed(4)} SOL\n` +
        `Price Impact: ${result.priceImpactPct.toFixed(2)}%\n` +
        `Commission: $${result.commissionUsd.toFixed(4)}\n\n` +
        `[View on Solscan](https://solscan.io/tx/${result.signature})`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Swap", callback_data: "nav:swap" },
              { text: "🛒 Buy", callback_data: "nav:buy" },
            ],
            [{ text: "💸 Sell Again", callback_data: "nav:sell" }],
            [{ text: "🏠 Dashboard", callback_data: "nav:main" }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error("Error executing sell", { error, token, percentage });
    await ctx.editMessageText(
      `❌ *Unexpected Error*\n\nPlease try again or contact support.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Back", callback_data: "nav:sell" }]],
        },
      }
    );
  }
}

// ============================================================================
// Settings Callbacks
// ============================================================================

/**
 * Handle settings callbacks (settings:action)
 */
export async function handleSettingsCallback(
  ctx: Context,
  action: string
): Promise<void> {
  switch (action) {
    case "slippage":
      await handleSlippageChange(ctx);
      break;

    case "auto_approve":
      await handleAutoApproveToggle(ctx);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown setting");
  }
}

/**
 * Change slippage setting
 */
async function handleSlippageChange(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery("⚙️ Slippage setting - coming soon");
  // TODO: Implement slippage change flow
}

/**
 * Toggle auto-approve setting
 */
async function handleAutoApproveToggle(ctx: Context): Promise<void> {
  const current = ctx.session.settings?.autoApprove ?? false;
  const newValue = !current;

  if (!ctx.session.settings) {
    ctx.session.settings = { slippage: 1, autoApprove: false };
  }
  ctx.session.settings.autoApprove = newValue;

  await ctx.answerCallbackQuery(
    newValue ? "✅ Auto-approve enabled" : "❌ Auto-approve disabled"
  );
  await navigateToPage(ctx, "settings");
}

// ============================================================================
// Unlock Page Callbacks
// ============================================================================

/**
 * Handle unlock page callbacks (unlock:action)
 */
export async function handleUnlockCallback(
  ctx: Context,
  action: string
): Promise<void> {
  switch (action) {
    case "toggle_reuse":
      await handleUnlockToggleReuse(ctx);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown unlock action");
      logger.warn("Unknown unlock action", { action, userId: ctx.from?.id });
  }
}

/**
 * Toggle password reuse mode from unlock page
 * Shows detailed risk explanation before toggling
 */
async function handleUnlockToggleReuse(ctx: Context): Promise<void> {
  const userContext = await getUserContext(ctx);
  const newMode = !userContext.allowPasswordReuse;

  // Update preference in database
  await setPasswordReusePreference(userContext.userId, newMode);
  invalidateUserContext(ctx);

  // Show toast notification with risk explanation
  await ctx.answerCallbackQuery({
    text: newMode
      ? "♻️ Switched to Reuse Mode (15 min)\n⚠️ Higher risk, more convenience"
      : "🔐 Switched to Strict Mode\n✅ Maximum security",
    show_alert: false,
  });

  // Refresh unlock page to show new mode explanation
  await navigateToPage(ctx, "unlock");
}

// ============================================================================
// Swap Flow Callbacks
// ============================================================================

/**
 * Handle swap callbacks (swap:action:params)
 */
export async function handleSwapCallback(
  ctx: Context,
  action: string,
  params: string[]
): Promise<void> {
  switch (action) {
    case "input":
      await handleSwapInputSelection(ctx, params[0]);
      break;

    case "output":
      await handleSwapOutputSelection(ctx, params[0], params[1]);
      break;

    case "amount":
      await handleSwapAmountSelection(ctx, params[0], params[1], params[2]);
      break;

    case "confirm":
      // User confirmed swap - execute with skipConfirmation=true
      await handleSwapConfirmation(ctx, params[0], params[1], params[2]);
      break;

    case "back_to_output":
      // Go back to output token selection with saved input token
      await ctx.answerCallbackQuery();
      if (!ctx.session.ui.swapData) {
        ctx.session.ui.swapData = {};
      }
      ctx.session.ui.swapData.inputMint = params[0];
      await navigateToPage(ctx, "swap", { inputToken: params[0] });
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown swap action");
  }
}

/**
 * Handle swap confirmation (after user clicks "Confirm Swap")
 * ✅ Skips confirmation step since user already confirmed
 */
async function handleSwapConfirmation(
  ctx: Context,
  inputToken: string,
  outputToken: string,
  amount: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  logger.info("Swap confirmation received", {
    inputToken,
    outputToken,
    amount,
    userId: ctx.from?.id,
    autoApprove: ctx.session.settings?.autoApprove,
  });

  // Execute swap with skipConfirmation=true
  await executeSwapFlow(ctx, inputToken, outputToken, amount, true);
}

/**
 * Handle input token selection for swap
 */
async function handleSwapInputSelection(
  ctx: Context,
  token: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  if (token === "custom") {
    ctx.session.awaitingInput = {
      type: "token",
      page: "swap",
    };
    scheduleAwaitingInputTimeout(ctx, "swap");

    await ctx.editMessageText(
      `🔄 *Swap Tokens*\n\n` +
        `✏️ *Custom Input Token*\n\n` +
        `Send the input token mint address.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel", callback_data: "nav:swap" }]],
        },
      }
    );
    return;
  }

  if (!ctx.session.ui.swapData) {
    ctx.session.ui.swapData = {};
  }
  ctx.session.ui.swapData.inputMint = token;

  await navigateToPage(ctx, "swap", { inputToken: token });
}

/**
 * Handle output token selection for swap
 */
async function handleSwapOutputSelection(
  ctx: Context,
  inputToken: string,
  outputToken: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  if (outputToken === "custom") {
    ctx.session.awaitingInput = {
      type: "token",
      page: "swap",
    };
    scheduleAwaitingInputTimeout(ctx, "swap");

    if (!ctx.session.ui.swapData) {
      ctx.session.ui.swapData = {};
    }
    ctx.session.ui.swapData.inputMint = inputToken;

    await ctx.editMessageText(
      `🔄 *Swap ${inputToken}*\n\n` +
        `✏️ *Custom Output Token*\n\n` +
        `Send the output token mint address.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel", callback_data: "nav:swap" }]],
        },
      }
    );
    return;
  }

  if (!ctx.session.ui.swapData) {
    ctx.session.ui.swapData = {};
  }
  ctx.session.ui.swapData.inputMint = inputToken;
  ctx.session.ui.swapData.outputMint = outputToken;

  await navigateToPage(ctx, "swap", {
    inputToken,
    outputToken,
  });
}

/**
 * Handle amount selection for swap
 */
async function handleSwapAmountSelection(
  ctx: Context,
  inputToken: string,
  outputToken: string,
  amount: string
): Promise<void> {
  await ctx.answerCallbackQuery();

  if (amount === "custom") {
    ctx.session.awaitingInput = {
      type: "amount",
      page: "swap",
    };
    scheduleAwaitingInputTimeout(ctx, "swap");

    if (!ctx.session.ui.swapData) {
      ctx.session.ui.swapData = {};
    }
    ctx.session.ui.swapData.inputMint = inputToken;
    ctx.session.ui.swapData.outputMint = outputToken;

    await ctx.editMessageText(
      `🔄 *Swap ${inputToken} → ${outputToken}*\n\n` +
        `✏️ *Custom Amount*\n\n` +
        `Send the amount of ${inputToken} to swap.\n\n` +
        `Example: \`0.5\` or \`100\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel", callback_data: "nav:swap" }]],
        },
      }
    );
    return;
  }

  // Execute swap
  await executeSwapFlow(ctx, inputToken, outputToken, amount);
}

/**
 * Execute swap with unlock check
 * ✅ Auto-approve support: Skip confirmation when enabled
 */
export async function executeSwapFlow(
  ctx: Context,
  inputToken: string,
  outputToken: string,
  amount: string,
  skipConfirmation = false
): Promise<void> {
  const msgId = ctx.session.ui.messageId;

  if (!msgId || !ctx.chat) {
    logger.warn("Cannot execute swap: no messageId or chat", {
      msgId,
      hasChat: !!ctx.chat,
    });
    return;
  }

  // ✅ Redis Session Integration: Check if wallet is unlocked
  // We only check sessionToken - password availability will be checked in executor
  if (!ctx.session.sessionToken) {
    // Save pending command so unlock handler can execute it (if not already set by text command)
    if (!ctx.session.pendingCommand) {
      ctx.session.pendingCommand = {
        type: "swap",
        params: [inputToken, outputToken, amount],
      };

      logger.info("Saved pending swap command", {
        inputToken,
        outputToken,
        amount,
        userId: ctx.from?.id,
      });
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `*Wallet Locked*\n\n` +
        `Unlock to swap ${amount} ${inputToken} → ${outputToken}.\n\n` +
        `Session active for 15 minutes.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔓 Unlock Wallet", callback_data: "action:unlock" },
              { text: "« Cancel", callback_data: "nav:main" },
            ],
          ],
        },
      }
    );
    return;
  }

  // ✅ Auto-approve check: Show confirmation if disabled
  const autoApprove = ctx.session.settings?.autoApprove ?? false;

  if (!autoApprove && !skipConfirmation) {
    // Show confirmation before swapping
    logger.info("Showing swap confirmation (auto-approve disabled)", {
      inputToken,
      outputToken,
      amount,
      userId: ctx.from?.id,
    });

    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `🔄 *Confirm Swap*\n\n` +
        `From: **${inputToken}**\n` +
        `To: **${outputToken}**\n` +
        `Amount: **${amount}**\n\n` +
        `━━━\n\n` +
        `⚠️ Confirm to execute this trade`,
      {
        parse_mode: "Markdown",
        reply_markup: createSwapConfirmationKeyboard(
          inputToken,
          outputToken,
          amount
        ),
      }
    );
    return;
  }

  // Auto-approve enabled or confirmation skipped - execute immediately
  logger.info(
    "Executing swap immediately (auto-approve enabled or confirmed)",
    { inputToken, outputToken, amount }
  );

  try {
    const userContext = await getUserContext(ctx);
    const wallet = userContext.activeWallet;

    if (!wallet) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msgId,
        "❌ Wallet not found. Please create one first.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 Home", callback_data: "nav:main" }]],
          },
        }
      );
      return;
    }

    // Resolve token mints with validation
    const inputMintResult = resolveTokenSymbol(inputToken);
    if (!inputMintResult.success) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msgId,
        `❌ *Invalid Input Token*\n\n${inputMintResult.error}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:swap" }]],
          },
        }
      );
      return;
    }
    const inputMintAddr = inputMintResult.value;

    const outputMintResult = resolveTokenSymbol(outputToken);
    if (!outputMintResult.success) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msgId,
        `❌ *Invalid Output Token*\n\n${outputMintResult.error}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:swap" }]],
          },
        }
      );
      return;
    }
    const outputMintAddr = outputMintResult.value;

    // Check if amount is percentage (e.g., "25%", "50%", "75%", "100%")
    const isPercentage = amount.includes("%");
    let minimalUnits: string;
    let displayAmount: string;
    let inputDecimals: number;

    if (isPercentage) {
      // Percentage-based swap - fetch balance and calculate
      const percentageStr = amount.replace("%", "");
      const percentage = parseInt(percentageStr);

      // Progress: Step 1 - Balance check
      await updateSwapProgress(ctx, {
        step: 1,
        total: 3,
        message: `${inputToken} → ${outputToken}`,
        status: `Checking balance...`,
      });

      // Get balance from blockchain
      const { getSolanaConnection } = await import(
        "../../services/blockchain/solana.js"
      );
      const { PublicKey } = await import("@solana/web3.js");
      const connection = await getSolanaConnection();
      const publicKey = new PublicKey(wallet.publicKey);

      // Get token balance
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        { mint: new PublicKey(inputMintAddr) }
      );

      if (tokenAccounts.value.length === 0) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          msgId,
          `❌ *No Balance*\n\nYou don't have any ${inputToken} tokens.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back", callback_data: "nav:swap" }],
              ],
            },
          }
        );
        return;
      }

      const tokenAccount = tokenAccounts.value[0];
      const accountData = tokenAccount.account.data.parsed.info;
      const balance = BigInt(accountData.tokenAmount.amount);
      const decimals = accountData.tokenAmount.decimals;

      // Calculate amount to swap based on percentage
      const amountToSwap = (balance * BigInt(percentage)) / 100n;

      if (amountToSwap === 0n) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          msgId,
          `❌ *Insufficient Balance*\n\nAmount too small to swap.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "« Back", callback_data: "nav:swap" }],
              ],
            },
          }
        );
        return;
      }

      minimalUnits = amountToSwap.toString();
      displayAmount = `${formatTokenAmount(
        amountToSwap,
        decimals
      )} ${inputToken} (${percentage}%)`;
      inputDecimals = decimals;
    } else {
      // Fixed amount swap - parse directly
      // Progress: Step 1 - Preparing swap
      await updateSwapProgress(ctx, {
        step: 1,
        total: 3,
        message: `${inputToken} → ${outputToken}`,
        status: `Preparing swap...`,
      });

      const amountFloat = parseFloat(amount);
      const decimals = getTokenDecimals(inputMintAddr);
      minimalUnits = toMinimalUnits(amountFloat, decimals);
      displayAmount = `${amount} ${inputToken}`;
      inputDecimals = decimals;
    }

    // Progress: Step 2 - Executing swap
    await updateSwapProgress(ctx, {
      step: 2,
      total: 3,
      message: `Input: ${displayAmount}\nOutput: ${outputToken}`,
      status: "Executing swap...",
    });

    // Execute trade
    const inputMint = asTokenMint(inputMintAddr);
    const outputMint = asTokenMint(outputMintAddr);

    const executor = getTradingExecutor();
    const tradeResult = await executor.executeTrade(
      {
        userId: userContext.userId,
        inputMint,
        outputMint,
        amount: minimalUnits,
        slippageBps: 50, // 0.5% slippage
      },
      undefined,
      ctx.session.sessionToken as any,
      { reusePassword: Boolean(ctx.session.passwordReuseEnabled) }
    );
    if (!ctx.session.passwordReuseEnabled) {
      clearPasswordState(ctx.session);
      // In strict mode, also clear sessionToken to force unlock on next trade
      ctx.session.sessionToken = undefined;
      ctx.session.sessionExpiresAt = undefined;
      logger.info("Strict mode: cleared session after trade", {
        userId: userContext.userId,
      });
    }

    // Progress: Step 3 - Completed
    if (tradeResult.success) {
      await updateSwapProgress(ctx, {
        step: 3,
        total: 3,
        message: `Input: ${displayAmount}\nOutput: ${outputToken}`,
        status: "Confirmed!",
      });
    }

    if (!tradeResult.success) {
      const error = tradeResult.error as TradingError;

      let errorMessage = "Trade execution failed";
      if (error.type === "WALLET_NOT_FOUND") {
        errorMessage = "Wallet not found";
      } else if (error.type === "INVALID_PASSWORD") {
        errorMessage = "Session expired. Please unlock again.";
      } else if (error.type === "SWAP_FAILED") {
        errorMessage = `Swap failed: ${error.reason}`;
      }

      await ctx.api.editMessageText(
        ctx.chat!.id,
        msgId,
        `❌ *Swap Failed*\n\n${errorMessage}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 Try Again",
                  callback_data: `swap:amount:${inputToken}:${outputToken}:${amount}`,
                },
                { text: "« Back", callback_data: "nav:swap" },
              ],
            ],
          },
        }
      );
      return;
    }

    const result = tradeResult.value;

    // Show completion progress for a moment
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Success!
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msgId,
      `✅ *Swap Successful!*\n\n` +
        `Swapped **${displayAmount}** → **${outputToken}**\n\n` +
        `Transaction: \`${result.signature}\`\n` +
        `Slot: ${result.slot}\n\n` +
        `📥 Input: ${formatTokenAmount(
          result.inputAmount,
          inputDecimals
        )} ${inputToken}\n` +
        `📤 Output: ${formatTokenAmount(
          result.outputAmount,
          getTokenDecimals(outputMintAddr)
        )} ${outputToken}\n` +
        `Price Impact: ${result.priceImpactPct.toFixed(2)}%\n` +
        `Commission: $${result.commissionUsd.toFixed(4)}\n\n` +
        `[View on Solscan](https://solscan.io/tx/${result.signature})`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🛒 Buy", callback_data: "nav:buy" },
              { text: "💸 Sell", callback_data: "nav:sell" },
            ],
            [{ text: "🔄 Swap Again", callback_data: "nav:swap" }],
            [{ text: "🏠 Dashboard", callback_data: "nav:main" }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error("Error executing swap", {
      error,
      inputToken,
      outputToken,
      amount,
    });
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msgId,
      `❌ *Unexpected Error*\n\nPlease try again or contact support.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Back", callback_data: "nav:swap" }]],
        },
      }
    );
  }
}

// ============================================================================
// Custom Sell with Absolute Amount
// ============================================================================

/**
 * Execute sell with absolute token amount (for custom input)
 * ✅ Auto-approve support: Skip confirmation when enabled
 */
export async function executeSellWithAbsoluteAmount(
  ctx: Context,
  token: string,
  absoluteAmount: string,
  skipConfirmation = false
): Promise<void> {
  const msgId = ctx.session.ui.messageId;

  if (!msgId || !ctx.chat) {
    await ctx.reply("❌ Session expired. Please use /start");
    return;
  }

  // Check if wallet is unlocked
  // We only check sessionToken - password availability will be checked in executor
  if (!ctx.session.sessionToken) {
    // Save pending command so unlock handler can execute it (if not already set by text command)
    if (!ctx.session.pendingCommand) {
      ctx.session.pendingCommand = {
        type: "sell",
        params: [token, absoluteAmount],
      };

      logger.info("Saved pending sell command (absolute)", {
        token,
        absoluteAmount,
        userId: ctx.from?.id,
      });
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `🔒 *Wallet Locked*\n\n` +
        `To sell ${absoluteAmount} ${token}, please unlock your wallet first.\n\n` +
        `Your session will be active for 15 minutes.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔓 Unlock Wallet", callback_data: "action:unlock" },
              { text: "« Cancel", callback_data: "nav:main" },
            ],
          ],
        },
      }
    );
    return;
  }

  // ✅ Auto-approve check: Show confirmation if disabled
  const autoApprove = ctx.session.settings?.autoApprove ?? false;

  if (!autoApprove && !skipConfirmation) {
    // Show confirmation before selling
    logger.info("Showing sell confirmation (auto-approve disabled)", {
      token,
      absoluteAmount,
      userId: ctx.from?.id,
    });

    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `💸 *Confirm Sell*\n\n` +
        `Token: **${token}**\n` +
        `Amount: **${absoluteAmount}** tokens\n\n` +
        `━━━\n\n` +
        `⚠️ Confirm to execute this trade`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Confirm Sell",
                callback_data: `sell:confirm_abs:${token}:${absoluteAmount}`,
              },
            ],
            [{ text: "« Cancel", callback_data: "nav:sell" }],
          ],
        },
      }
    );
    return;
  }

  // Auto-approve enabled or confirmation skipped - execute immediately
  logger.info(
    "Executing sell immediately (auto-approve enabled or confirmed)",
    { token, absoluteAmount }
  );

  try {
    const userContext = await getUserContext(ctx);
    const wallet = userContext.activeWallet;

    if (!wallet) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        "❌ Wallet not found. Please create one first.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 Home", callback_data: "nav:main" }]],
          },
        }
      );
      return;
    }

    // Resolve token mint with validation
    const tokenMintResult = resolveTokenSymbol(token);
    if (!tokenMintResult.success) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `❌ *Invalid Token*\n\n${tokenMintResult.error}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:sell" }]],
          },
        }
      );
      return;
    }
    const tokenMint = tokenMintResult.value;

    // Progress: Step 1 - Preparing sell
    await updateSellProgress(ctx, {
      step: 1,
      total: 3,
      message: `Token: ${token}\nAmount: ${absoluteAmount}`,
      status: "Preparing...",
    });

    // Parse amount and convert to minimal units
    const amountFloat = parseFloat(absoluteAmount);
    const decimals = getTokenDecimals(tokenMint);
    const minimalUnits = toMinimalUnits(amountFloat, decimals);

    // Progress: Step 2 - Executing transaction
    await updateSellProgress(ctx, {
      step: 2,
      total: 3,
      message: `Token: ${token}\nAmount: ${absoluteAmount}`,
      status: "Executing sell...",
    });

    // Execute trade
    const inputMint = asTokenMint(tokenMint);
    const outputMint = asTokenMint(SOL_MINT);

    const executor = getTradingExecutor();
    const tradeResult = await executor.executeTrade(
      {
        userId: userContext.userId,
        inputMint,
        outputMint,
        amount: minimalUnits,
        slippageBps: 50, // 0.5% slippage
      },
      undefined,
      ctx.session.sessionToken as any,
      { reusePassword: Boolean(ctx.session.passwordReuseEnabled) }
    );
    if (!ctx.session.passwordReuseEnabled) {
      clearPasswordState(ctx.session);
      // In strict mode, also clear sessionToken to force unlock on next trade
      ctx.session.sessionToken = undefined;
      ctx.session.sessionExpiresAt = undefined;
      logger.info("Strict mode: cleared session after trade", {
        userId: userContext.userId,
      });
    }

    if (!tradeResult.success) {
      const error = tradeResult.error as TradingError;

      let errorMessage = "Trade execution failed";
      if (error.type === "WALLET_NOT_FOUND") {
        errorMessage = "Wallet not found";
      } else if (error.type === "INVALID_PASSWORD") {
        errorMessage = "Session expired. Please unlock again.";
      } else if (error.type === "SWAP_FAILED") {
        errorMessage = `Sell failed: ${error.reason}`;
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `❌ *Sell Failed*\n\n${errorMessage}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔄 Try Again", callback_data: `nav:sell` },
                { text: "« Back", callback_data: "nav:sell" },
              ],
            ],
          },
        }
      );
      return;
    }

    const result = tradeResult.value;
    const solReceived = Number(result.outputAmount) / 1e9;

    // Progress: Step 3 - Completed
    await updateSellProgress(ctx, {
      step: 3,
      total: 3,
      message: `Token: ${token}\nAmount: ${absoluteAmount}`,
      status: "Confirmed!",
    });

    // Show completion progress for a moment
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Success!
    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `✅ *Sell Successful!*\n\n` +
        `Sold **${absoluteAmount} ${token}** for **${solReceived.toFixed(
          4
        )} SOL**\n\n` +
        `Transaction: \`${result.signature}\`\n` +
        `Slot: ${result.slot}\n\n` +
        `Input: ${absoluteAmount} ${token}\n` +
        `Output: ${solReceived.toFixed(4)} SOL\n` +
        `Price Impact: ${result.priceImpactPct.toFixed(2)}%\n` +
        `Commission: $${result.commissionUsd.toFixed(4)}\n\n` +
        `[View on Solscan](https://solscan.io/tx/${result.signature})`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Swap", callback_data: "nav:swap" },
              { text: "🛒 Buy", callback_data: "nav:buy" },
            ],
            [{ text: "💸 Sell Again", callback_data: "nav:sell" }],
            [{ text: "🏠 Dashboard", callback_data: "nav:main" }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error("Error executing custom sell", {
      error,
      token,
      absoluteAmount,
    });
    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `❌ *Unexpected Error*\n\nPlease try again or contact support.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Back", callback_data: "nav:sell" }]],
        },
      }
    );
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format token amount from minimal units to human-readable
 */
function formatTokenAmount(amount: bigint, decimals: number): string {
  const num = Number(amount) / Math.pow(10, decimals);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.min(decimals, 6),
  });
}

/**
 * Update swap progress bar in message
 */
async function updateSwapProgress(
  ctx: Context,
  config: {
    step: number;
    total: number;
    message: string;
    status: string;
  }
): Promise<void> {
  const { step, total, message, status } = config;

  const msgId = ctx.session.ui.messageId;
  if (!msgId || !ctx.chat) {
    logger.warn("Cannot update swap progress: no messageId", { step });
    return;
  }

  // Create progress bar
  const percentage = Math.floor((step / total) * 100);
  const filled = Math.floor((step / total) * 10);
  const empty = 10 - filled;

  const progressBar = "▓".repeat(filled) + "░".repeat(empty);

  const text =
    `*Processing Swap*\n\n` +
    `${message}\n\n` +
    `${progressBar} ${percentage}%\n` +
    `${status}\n\n` +
    `Step ${step}/${total}`;

  try {
    await ctx.api.editMessageText(ctx.chat.id, msgId, text, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    // Ignore "message is not modified" errors
    if (!String(error).includes("message is not modified")) {
      logger.warn("Failed to update swap progress", { error, step });
    }
  }
}

/**
 * Update sell progress bar in message
 */
async function updateSellProgress(
  ctx: Context,
  config: {
    step: number;
    total: number;
    message: string;
    status: string;
  }
): Promise<void> {
  const { step, total, message, status } = config;

  const msgId = ctx.session.ui.messageId;
  if (!msgId || !ctx.chat) {
    logger.warn("Cannot update sell progress: no messageId", { step });
    return;
  }

  // Create progress bar
  const percentage = Math.floor((step / total) * 100);
  const filled = Math.floor((step / total) * 10);
  const empty = 10 - filled;

  const progressBar = "▓".repeat(filled) + "░".repeat(empty);

  const text =
    `*Processing Sell*\n\n` +
    `${message}\n\n` +
    `${progressBar} ${percentage}%\n` +
    `${status}\n\n` +
    `Step ${step}/${total}`;

  try {
    await ctx.api.editMessageText(ctx.chat.id, msgId, text, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    // Ignore "message is not modified" errors
    if (!String(error).includes("message is not modified")) {
      logger.warn("Failed to update sell progress", { error, step });
    }
  }
}
