/**
 * Single-Page UI System for Telegram Bot
 * All interactions happen in one message with inline keyboards
 */

import { InlineKeyboard } from "grammy";
import type { Context as GrammyContext, SessionFlavor } from "grammy";
import { logger } from "../../utils/logger.js";
import { hasActivePassword } from "../utils/passwordState.js";
import {
  buildConversationKey,
  CONVERSATION_TOPICS,
  DEFAULT_CONVERSATION_TTL_MS,
  scheduleConversationTimeout,
} from "../utils/conversationTimeouts.js";
import type { CachedUserContext } from "../utils/userContext.js";
import { getUserContext } from "../utils/userContext.js";
import { getSnipeConfig } from "../../services/snipe/configService.js";
import { automationLeaseActive } from "../../services/snipe/automationService.js";

// ============================================================================
// Types
// ============================================================================

export type Page =
  | "welcome"
  | "create_wallet"
  | "main"
  | "buy"
  | "sell"
  | "swap"
  | "balance"
  | "snipe"
  | "settings"
  | "wallet_info"
  | "unlock"
  | "status"
  | "help";

export interface UIState {
  currentPage: Page;
  messageId?: number;
  // Page-specific data
  buyData?: {
    selectedToken?: string;
    amount?: string;
  };
  sellData?: {
    selectedToken?: string;
    amount?: string;
  };
  swapData?: {
    inputMint?: string;
    outputMint?: string;
    amount?: string;
  };
}

export interface TokenMetadataCacheEntry {
  symbol?: string;
  name?: string;
  label?: string;
  expiresAt: number;
}

export interface TokenMetadataCacheState {
  entries: Record<string, TokenMetadataCacheEntry>;
}

export interface BalanceTokenEntry {
  mint: string;
  label: string;
  amount: number;
  amountDisplay: string;
  usdValue?: number;
}

export interface BalanceViewState {
  snapshot: string;
  walletPublicKey: string;
  solAmount: number;
  solUsdValue?: number;
  tokens: BalanceTokenEntry[];
  totalTokens: number;
  pageSize: number;
  currentPage: number;
  lastUpdated: number;
}

export interface SessionData {
  walletId?: string;
  encryptedKey?: string;
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
  // ✅ Redis Session Integration (CRITICAL-1 + CRITICAL-2 fix)
  sessionToken?: string; // Redis session token (15 min TTL)
  sessionExpiresAt?: number; // Timestamp for UI display
  passwordExpiresAt?: number; // Timestamp for password TTL indicator
  passwordReuseEnabled?: boolean;
  ui: UIState;
  awaitingPasswordForWallet?: boolean;
  awaitingPasswordForUnlock?: boolean;
  awaitingPasswordForSnipe?: boolean;
  awaitingPasswordForBuy?: {
    tokenMint: string;
    solAmount: string;
  };
  awaitingPasswordForSell?: {
    tokenMint: string;
    tokenAmount: string;
  };
  awaitingPasswordForSwap?: {
    inputMint: string;
    outputMint: string;
    amount: string;
  };
  returnToPageAfterUnlock?: Page; // Save page to return after unlock
  pendingCommand?: {
    type: "buy" | "sell" | "sell_pct" | "swap";
    params: string[];
  }; // Save command to execute after unlock
  pendingSnipeAction?: {
    type: "automation";
  };
  awaitingInput?: {
    type: "token" | "amount" | "password";
    page: Page;
  };
  swapConversationStep?: "inputMint" | "outputMint" | "amount" | "password";
  swapConversationData?: {
    inputMint?: string;
    outputMint?: string;
    amount?: string;
  };
  tokenMetadataCache?: TokenMetadataCacheState;
  balanceView?: BalanceViewState;
  cachedUserContext?: CachedUserContext;
}

export type Context = GrammyContext & SessionFlavor<SessionData>;

// ============================================================================
// Page Renderers
// ============================================================================

/**
 * Welcome page - shown on first /start
 */
export async function renderWelcomePage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);
  const hasWallet = userContext.wallets.length > 0;

  const text =
    `*Bolt Sniper Bot*\n\n` +
    `Trade Solana tokens with automatic honeypot protection and best prices from Jupiter v6.\n\n` +
    (hasWallet
      ? `✅ Wallet ready — start trading below`
      : `⚠️ Create a wallet to start trading`) +
    `\n\n━━━\n\nYour keys are encrypted and never leave your device.`;

  const keyboard = new InlineKeyboard();

  if (hasWallet) {
    keyboard.text("🏠 Go to Dashboard", "nav:main");
  } else {
    keyboard.text("🎯 Create Wallet", "nav:create_wallet");
  }

  return { text, keyboard };
}

function scheduleWalletPasswordTimeout(ctx: Context): void {
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;

  if (!telegramId || !chatId) {
    return;
  }

  const key = buildConversationKey(
    telegramId,
    CONVERSATION_TOPICS.walletPassword
  );
  const sessionRef = ctx.session;
  const api = ctx.api;

  scheduleConversationTimeout(key, DEFAULT_CONVERSATION_TTL_MS, async () => {
    if (!sessionRef.awaitingPasswordForWallet) {
      return;
    }

    sessionRef.awaitingPasswordForWallet = false;
    await api.sendMessage(
      chatId,
      "⏰ Wallet creation timed out. Please tap *Create Wallet* again.",
      { parse_mode: "Markdown" }
    );
  });
}

function scheduleUnlockPasswordTimeout(ctx: Context): void {
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;

  if (!telegramId || !chatId) {
    return;
  }

  const key = buildConversationKey(
    telegramId,
    CONVERSATION_TOPICS.unlockPassword
  );
  const sessionRef = ctx.session;
  const api = ctx.api;

  scheduleConversationTimeout(key, DEFAULT_CONVERSATION_TTL_MS, async () => {
    if (!sessionRef.awaitingPasswordForUnlock) {
      return;
    }

    sessionRef.awaitingPasswordForUnlock = false;
    await api.sendMessage(
      chatId,
      "⏰ Unlock timed out. Please tap *Unlock Wallet* again.",
      { parse_mode: "Markdown" }
    );
  });
}

/**
 * Create wallet page
 */
export function renderCreateWalletPage(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text =
    `*Create Wallet*\n\n` +
    `Send a strong password (min 8 characters) to create your encrypted Solana wallet.\n\n` +
    `⚠️ *Important:* Your password cannot be recovered. Store it safely.\n\n` +
    `━━━\n\n` +
    `Your message will be deleted automatically for security.`;

  const keyboard = new InlineKeyboard()
    .text("« Cancel", "nav:main");

  return { text, keyboard };
}

/**
 * Main dashboard page
 */
export async function renderMainPage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);

  if (!userContext.activeWallet) {
    return renderWelcomePage(ctx);
  }

  const wallet = userContext.activeWallet;
  // ✅ Redis Session Integration: Check Redis session + password TTL
  const isLocked =
    !ctx.session.sessionToken || !hasActivePassword(ctx.session);

  const text =
    `*Dashboard*\n\n` +
    `\`${wallet.publicKey}\`\n\n` +
    `${isLocked ? "🔒 Locked — unlock to trade" : "🔓 Unlocked — ready to trade"}\n\n` +
    `━━━\n\n` +
    `*Quick Commands*\n\n` +
    `\`/buy <token> <amount>\`\n` +
    `\`/sell <token> <amount>\`\n` +
    `\`/swap <from> <to> <amount>\``;

  const keyboard = new InlineKeyboard()
    .text("🛒 Buy", "nav:buy")
    .text("💸 Sell", "nav:sell")
    .row()
    .text("🔄 Swap", "nav:swap")
    .text("🎯 Token Sniper", "nav:snipe")
    .row()
    .text("📊 Balance", "nav:balance")
    .text("💼 Wallet Info", "nav:wallet_info")
    .row()
    .text("⚙️ Settings", "nav:settings")
    .text("📚 Help", "nav:help")
    .row()
    .text("📊 Session Status", "nav:status");

  if (isLocked) {
    keyboard.row().text("🔓 Unlock Wallet", "action:unlock");
  } else {
    keyboard.row().text("🔒 Lock Wallet", "action:lock");
  }

  return { text, keyboard };
}

/**
 * Buy tokens page
 */
export function renderBuyPage(data?: { selectedToken?: string }): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text =
    `*Buy Tokens*\n\n` +
    (data?.selectedToken
      ? `Token: *${data.selectedToken}*\n\nHow much SOL to spend?`
      : `Select a token to buy:`);

  const keyboard = new InlineKeyboard();

  if (!data?.selectedToken) {
    // Show popular tokens
    keyboard
      .text("🐕 BONK", "buy:token:BONK")
      .text("🐶 WIF", "buy:token:WIF")
      .row()
      .text("💵 USDC", "buy:token:USDC")
      .text("💲 USDT", "buy:token:USDT")
      .row()
      .text("✏️ Custom Address", "buy:token:custom")
      .row()
      .text("« Back to Dashboard", "nav:main");
  } else {
    // Show amount options
    keyboard
      .text("0.1 SOL", `buy:amount:${data.selectedToken}:0.1`)
      .text("0.5 SOL", `buy:amount:${data.selectedToken}:0.5`)
      .row()
      .text("1 SOL", `buy:amount:${data.selectedToken}:1`)
      .text("5 SOL", `buy:amount:${data.selectedToken}:5`)
      .row()
      .text("✏️ Custom", `buy:amount:${data.selectedToken}:custom`)
      .row()
      .text("« Back", "nav:buy")
      .text("🏠 Dashboard", "nav:main");
  }

  return { text, keyboard };
}

/**
 * Sell tokens page
 */
export function renderSellPage(data?: { selectedToken?: string }): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text =
    `*Sell Tokens*\n\n` +
    (data?.selectedToken
      ? `Token: *${data.selectedToken}*\n\nHow much to sell?`
      : `Select a token to sell:`);

  const keyboard = new InlineKeyboard();

  if (!data?.selectedToken) {
    keyboard
      .text("🐕 BONK", "sell:token:BONK")
      .text("🐶 WIF", "sell:token:WIF")
      .row()
      .text("💵 USDC", "sell:token:USDC")
      .text("💲 USDT", "sell:token:USDT")
      .row()
      .text("✏️ Custom Address", "sell:token:custom")
      .row()
      .text("« Back to Dashboard", "nav:main");
  } else {
    keyboard
      .text("25%", `sell:amount:${data.selectedToken}:25`)
      .text("50%", `sell:amount:${data.selectedToken}:50`)
      .row()
      .text("75%", `sell:amount:${data.selectedToken}:75`)
      .text("100%", `sell:amount:${data.selectedToken}:100`)
      .row()
      .text("✏️ Custom", `sell:amount:${data.selectedToken}:custom`)
      .row()
      .text("« Back", "nav:sell")
      .text("🏠 Dashboard", "nav:main");
  }

  return { text, keyboard };
}

/**
 * Swap page
 */
export function renderSwapPage(data?: {
  inputToken?: string;
  outputToken?: string;
  amount?: string;
}): {
  text: string;
  keyboard: InlineKeyboard;
} {
  let text = `*Swap Tokens*\n\n`;
  const keyboard = new InlineKeyboard();

  // Step 1: Select input token
  if (!data?.inputToken) {
    text += `Select input token:`;

    keyboard
      .text("🟣 SOL", "swap:input:SOL")
      .text("💵 USDC", "swap:input:USDC")
      .row()
      .text("💲 USDT", "swap:input:USDT")
      .text("🐕 BONK", "swap:input:BONK")
      .row()
      .text("🐶 WIF", "swap:input:WIF")
      .text("✏️ Custom", "swap:input:custom")
      .row()
      .text("« Back to Dashboard", "nav:main");
  }
  // Step 2: Select output token
  else if (!data?.outputToken) {
    text +=
      `From: *${data.inputToken}*\n\n` +
      `Select output token:`;

    // Build keyboard, excluding the input token
    const tokens = [
      { label: "🟣 SOL", value: "SOL" },
      { label: "💵 USDC", value: "USDC" },
      { label: "💲 USDT", value: "USDT" },
      { label: "🐕 BONK", value: "BONK" },
      { label: "🐶 WIF", value: "WIF" },
    ];

    // Filter out input token to prevent swapping token to itself
    const availableTokens = tokens.filter(t => t.value !== data.inputToken);

    // Add buttons in rows of 2
    for (let i = 0; i < availableTokens.length; i += 2) {
      if (i + 1 < availableTokens.length) {
        keyboard
          .text(availableTokens[i].label, `swap:output:${data.inputToken}:${availableTokens[i].value}`)
          .text(availableTokens[i + 1].label, `swap:output:${data.inputToken}:${availableTokens[i + 1].value}`)
          .row();
      } else {
        keyboard
          .text(availableTokens[i].label, `swap:output:${data.inputToken}:${availableTokens[i].value}`)
          .row();
      }
    }

    keyboard
      .text("✏️ Custom", `swap:output:${data.inputToken}:custom`)
      .row()
      .text("« Back", "nav:swap")
      .text("🏠 Dashboard", "nav:main");
  }
  // Step 3: Select amount
  else {
    text +=
      `From: *${data.inputToken}*\n` +
      `To: *${data.outputToken}*\n\n` +
      `How much to swap?`;

    // Show different amounts based on input token
    if (data.inputToken === "SOL") {
      keyboard
        .text("0.1 SOL", `swap:amount:${data.inputToken}:${data.outputToken}:0.1`)
        .text("0.5 SOL", `swap:amount:${data.inputToken}:${data.outputToken}:0.5`)
        .row()
        .text("1 SOL", `swap:amount:${data.inputToken}:${data.outputToken}:1`)
        .text("5 SOL", `swap:amount:${data.inputToken}:${data.outputToken}:5`)
        .row()
        .text("✏️ Custom", `swap:amount:${data.inputToken}:${data.outputToken}:custom`);
    } else if (data.inputToken === "USDC" || data.inputToken === "USDT") {
      keyboard
        .text("10 " + data.inputToken, `swap:amount:${data.inputToken}:${data.outputToken}:10`)
        .text("50 " + data.inputToken, `swap:amount:${data.inputToken}:${data.outputToken}:50`)
        .row()
        .text("100 " + data.inputToken, `swap:amount:${data.inputToken}:${data.outputToken}:100`)
        .text("500 " + data.inputToken, `swap:amount:${data.inputToken}:${data.outputToken}:500`)
        .row()
        .text("✏️ Custom", `swap:amount:${data.inputToken}:${data.outputToken}:custom`);
    } else {
      // For other tokens, show percentage options
      keyboard
        .text("25%", `swap:amount:${data.inputToken}:${data.outputToken}:25%`)
        .text("50%", `swap:amount:${data.inputToken}:${data.outputToken}:50%`)
        .row()
        .text("75%", `swap:amount:${data.inputToken}:${data.outputToken}:75%`)
        .text("100%", `swap:amount:${data.inputToken}:${data.outputToken}:100%`)
        .row()
        .text("✏️ Custom", `swap:amount:${data.inputToken}:${data.outputToken}:custom`);
    }

    keyboard
      .row()
      .text("« Back", `swap:back_to_output:${data.inputToken}`)
      .text("🏠 Dashboard", "nav:main");
  }

  return { text, keyboard };
}

/**
 * Balance page
 */
export async function renderBalancePage(
  ctx: Context,
  page = 0
): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);

  if (!userContext.activeWallet) {
    return renderWelcomePage(ctx);
  }

  const wallet = userContext.activeWallet;

  try {
    // Get balance with caching (60s TTL)
    const { getBalanceWithCache, getPaginatedTokens } = await import(
      "../utils/balanceCache.js"
    );

    const balance = await getBalanceWithCache(ctx, wallet.publicKey, false);

    // Update current page in balance state
    balance.currentPage = page;

    // Get paginated tokens
    const { tokens, hasNext, hasPrev, pageInfo } = getPaginatedTokens(
      balance,
      page
    );

    // Format timestamp
    const cacheAge = Math.floor((Date.now() - balance.lastUpdated) / 1000);
    const ageDisplay =
      cacheAge < 10
        ? "just now"
        : cacheAge < 60
          ? `${cacheAge}s ago`
          : `${Math.floor(cacheAge / 60)}m ago`;

    // Build text
    let text = `*Balance* 💰\n\n`;
    text += `\`${wallet.publicKey.slice(0, 4)}...${wallet.publicKey.slice(-4)}\`\n\n`;
    text += `━━━\n\n`;
    text += `**SOL:** ${balance.solAmount.toFixed(4)} SOL\n`;

    if (balance.solUsdValue) {
      text += `≈ $${balance.solUsdValue.toFixed(2)}\n`;
    }

    text += `\n━━━\n\n`;

    if (tokens.length > 0) {
      text += `**Tokens:**\n\n`;

      for (const token of tokens) {
        // Token name/symbol
        text += `**${token.label}**\n`;
        // Token address
        text += `\`${token.mint.slice(0, 4)}...${token.mint.slice(-4)}\`\n`;
        // Amount and USD value
        text += `  ${token.amountDisplay}`;
        if (token.usdValue) {
          text += ` ≈ $${token.usdValue.toFixed(2)}`;
        }
        text += `\n\n`;
      }

      text += `${pageInfo}`;
    } else {
      text += `No tokens found`;
    }

    text += `\n\n_Updated ${ageDisplay}_`;

    // Build keyboard with pagination
    const keyboard = new InlineKeyboard();

    // Pagination buttons (only if multiple pages)
    if (hasNext || hasPrev) {
      if (hasPrev) {
        keyboard.text("◀️ Prev", `balance:page:${page - 1}`);
      }
      if (hasNext) {
        keyboard.text("Next ▶️", `balance:page:${page + 1}`);
      }
      keyboard.row();
    }

    keyboard
      .text("🔄 Refresh", "action:refresh_balance")
      .row()
      .text("« Back to Dashboard", "nav:main");

    return { text, keyboard };
  } catch (error) {
    logger.error("Failed to render balance page", { error });

    const text =
      `*Balance*\n\n` +
      `❌ Failed to load balance\n\n` +
      `Error: ${error instanceof Error ? error.message : String(error)}`;

    const keyboard = new InlineKeyboard()
      .text("🔄 Retry", "action:refresh_balance")
      .row()
      .text("« Back to Dashboard", "nav:main");

    return { text, keyboard };
  }
}

/**
 * Wallet info page
 */
export async function renderWalletInfoPage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);

  if (!userContext.activeWallet) {
    return renderWelcomePage(ctx);
  }

  const wallet = userContext.activeWallet;

  const text =
    `*Wallet*\n\n` +
    `\`${wallet.publicKey}\`\n\n` +
    `Chain: ${wallet.chain.toUpperCase()}\n` +
    `${wallet.isActive ? "🟢 Active" : "🔴 Inactive"}\n\n` +
    `━━━\n\n` +
    `[View on Solscan](https://solscan.io/account/${wallet.publicKey})\n` +
    `[View on Explorer](https://explorer.solana.com/address/${wallet.publicKey})`;

  const keyboard = new InlineKeyboard()
    .text("« Back to Dashboard", "nav:main");

  return { text, keyboard };
}

export async function renderSnipePage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);
  const config = await getSnipeConfig(userContext.userId);
  const automationActive = await automationLeaseActive(userContext.userId);

  const buyAmountSol = Number(config.buyAmountLamports) / 1e9;
  const liquidityMin =
    config.minLiquidityLamports !== null && config.minLiquidityLamports !== undefined
      ? `${(Number(config.minLiquidityLamports) / 1e9).toFixed(2)} SOL`
      : "Any";
  const liquidityMax =
    config.maxLiquidityLamports !== null && config.maxLiquidityLamports !== undefined
      ? `${(Number(config.maxLiquidityLamports) / 1e9).toFixed(2)} SOL`
      : "Any";
  const marketMin =
    config.minMarketCapUsd ?? "Any";
  const marketMax =
    config.maxMarketCapUsd ?? "Any";

  const text =
    `🎯 *Token Sniper*\n\n` +
    `Status: ${config.enabled ? "🟢 Enabled" : "⚪️ Disabled"}\n` +
    `Mode: ${config.autoTrading ? "🤖 Auto-Trading" : "⏸ Manual"}\n` +
    `Buy Amount: ${buyAmountSol.toFixed(3)} SOL\n` +
    `Max Risk Score: ${config.maxHoneypotRisk}/100\n` +
    `Hourly Limit: ${config.maxBuysPerHour}\n` +
    `Daily Limit: ${config.maxBuysPerDay}\n` +
    `Automation: ${automationActive ? "🔐 Active (15 min)" : "🔒 Locked"}\n\n` +
    `━━━\n\n` +
    `*Filters*\n` +
    `Liquidity: ${liquidityMin} → ${liquidityMax}\n` +
    `Market Cap: ${marketMin === "Any" ? "Any" : `$${Number(marketMin).toLocaleString()}`} → ${marketMax === "Any" ? "Any" : `$${Number(marketMax).toLocaleString()}`}\n` +
    `Whitelist: ${config.whitelist.length || 0} tokens\n` +
    `Blacklist: ${config.blacklist.length || 0} tokens\n\n` +
    `💡 *Tip:* Use 🔓 Unlock Wallet to enable automation automatically.`;

  // Check if wallet is unlocked
  const isUnlocked = !!ctx.session.sessionToken;

  const keyboard = new InlineKeyboard();
  keyboard
    .text(
      config.enabled ? "🟢 Disable" : "⚪️ Enable",
      "snipe:toggle"
    )
    .row()
    .text(
      config.autoTrading ? "🤖 Pause Auto-Trade" : "🤖 Enable Auto-Trade",
      "snipe:toggle_auto"
    )
    .row()
    .text("💰 0.05", "snipe:set_amount:0.05")
    .text("0.10", "snipe:set_amount:0.1")
    .text("0.25", "snipe:set_amount:0.25")
    .text("0.50", "snipe:set_amount:0.5")
    .row()
    .text("⚠️ 20", "snipe:set_risk:20")
    .text("30", "snipe:set_risk:30")
    .text("40", "snipe:set_risk:40")
    .text("50", "snipe:set_risk:50")
    .row()
    .text(
      isUnlocked ? "🔒 Lock Wallet" : "🔓 Unlock Wallet",
      isUnlocked ? "action:lock" : "action:unlock"
    )
    .row()
    .text("📜 History", "snipe:history")
    .text("🔄 Refresh", "snipe:refresh")
    .row()
    .text("« Back", "nav:main");

  return { text, keyboard };
}

/**
 * Settings page
 */
export async function renderSettingsPage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const slippage = ctx.session.settings?.slippage ?? 1;
  const autoApprove = ctx.session.settings?.autoApprove ?? false;

  const text =
    `*Settings*\n\n` +
    `Slippage: ${slippage}%\n` +
    `Auto-approve: ${autoApprove ? "✅ Enabled" : "❌ Disabled"}\n\n` +
    `💡 *Tip:* Password reuse mode can be toggled on the /unlock page.`;

  const keyboard = new InlineKeyboard()
    .text("🎯 Change Slippage", "settings:slippage")
    .row()
    .text(
      autoApprove ? "❌ Disable Auto-approve" : "✅ Enable Auto-approve",
      "settings:auto_approve"
    )
    .row()
    .text("« Back to Dashboard", "nav:main");

  return { text, keyboard };
}

/**
 * Unlock wallet page
 */
export async function renderUnlockPage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);

  if (!userContext.activeWallet) {
    return renderWelcomePage(ctx);
  }

  const wallet = userContext.activeWallet;
  const reuseEnabled = userContext.allowPasswordReuse;

  // Build explanation based on current mode
  const modeExplanation = reuseEnabled
    ? `🔓 *Reuse Mode* (Convenience)\n` +
      `• Password valid for 15 minutes\n` +
      `• Trade freely without re-entering\n` +
      `• ⚠️ Higher risk if device compromised`
    : `🔐 *Strict Mode* (Maximum Security)\n` +
      `• Password valid for 2 minutes\n` +
      `• Consumed after first trade\n` +
      `• ✅ Most secure option`;

  const text =
    `*🔓 Unlock Wallet*\n\n` +
    `\`${wallet.publicKey}\`\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${modeExplanation}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📝 *How to unlock:*\n` +
    `Send your password in the next message.\n` +
    `Your message will be auto-deleted.\n\n` +
    `⚙️ Change mode below before unlocking.`;

  const keyboard = new InlineKeyboard()
    .text(
      reuseEnabled ? "🔐 Switch to Strict Mode" : "♻️ Switch to Reuse Mode",
      "unlock:toggle_reuse"
    )
    .row()
    .text("« Cancel", "nav:main");

  return { text, keyboard };
}

/**
 * Status page - shows wallet lock/unlock status
 */
export async function renderStatusPage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);

  if (!userContext.activeWallet) {
    return renderWelcomePage(ctx);
  }

  const wallet = userContext.activeWallet;

  // ✅ Redis Session Integration: Check Redis session status
  const hasSession = !!ctx.session.sessionToken;
  const sessionExpiresAt = ctx.session.sessionExpiresAt || 0;
  const now = Date.now();
  const isActive = hasSession && sessionExpiresAt > now;

  let text = `*Session Status*\n\n`;
  text += `\`${wallet.publicKey}\`\n\n`;

  const keyboard = new InlineKeyboard();

  if (isActive) {
    const timeLeft = Math.floor((sessionExpiresAt - now) / 1000 / 60);
    text +=
      `🟢 Active\n\n` +
      `Time remaining: ${timeLeft} minutes`;

    keyboard
      .text("🔒 Lock Wallet", "action:lock")
      .row()
      .text("🔄 Refresh Status", "nav:status")
      .row()
      .text("« Back to Dashboard", "nav:main");
  } else {
    text +=
      `🔴 Locked\n\n` +
      `Unlock to start trading.`;

    keyboard
      .text("🔓 Unlock Wallet", "action:unlock")
      .row()
      .text("« Back to Dashboard", "nav:main");
  }

  return { text, keyboard };
}

/**
 * Help page - shows all available commands and features
 */
export function renderHelpPage(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text =
    `*Help*\n\n` +
    `*Quick Start*\n` +
    `1. Create wallet\n` +
    `2. Unlock with password\n` +
    `3. Start trading\n\n` +
    `━━━\n\n` +
    `*Commands*\n\n` +
    `/buy <token> <amount>\n` +
    `/sell <token> <amount>\n` +
    `/swap <from> <to> <amount>\n\n` +
    `/wallet - View wallet\n` +
    `/balance - Check balance\n` +
    `/unlock - Unlock for 15 min\n` +
    `/lock - Lock wallet\n` +
    `/status - Session info\n` +
    `/settings - Configure bot`;

  const keyboard = new InlineKeyboard()
    .text("🏠 Dashboard", "nav:main")
    .row()
    .text("💼 Wallet", "nav:wallet_info")
    .text("📊 Balance", "nav:balance")
    .row()
    .text("🛒 Buy", "nav:buy")
    .text("💸 Sell", "nav:sell")
    .text("🔄 Swap", "nav:swap")
    .row()
    .text("🔓 Unlock", "action:unlock")
    .text("📊 Status", "nav:status")
    .row()
    .text("⚙️ Settings", "nav:settings");

  return { text, keyboard };
}

// ============================================================================
// Navigation Helper
// ============================================================================

/**
 * Navigate to a page and update the message
 */
export async function navigateToPage(
  ctx: Context,
  page: Page,
  data?: any
): Promise<void> {
  try {
    let result: { text: string; keyboard: InlineKeyboard };

    switch (page) {
      case "welcome":
        result = await renderWelcomePage(ctx);
        break;
      case "create_wallet":
        result = renderCreateWalletPage();
        // Set state to await password input
        ctx.session.awaitingPasswordForWallet = true;
        scheduleWalletPasswordTimeout(ctx);
        break;
      case "main":
        result = await renderMainPage(ctx);
        break;
      case "buy":
        result = renderBuyPage(data);
        break;
      case "sell":
        result = renderSellPage(data);
        break;
      case "swap":
        result = renderSwapPage(data);
        break;
      case "balance":
        result = await renderBalancePage(ctx);
        break;
      case "snipe":
        result = await renderSnipePage(ctx);
        break;
      case "wallet_info":
        result = await renderWalletInfoPage(ctx);
        break;
      case "settings":
        result = await renderSettingsPage(ctx);
        break;
      case "unlock":
        result = await renderUnlockPage(ctx);
        // Set state to await password input
        ctx.session.awaitingPasswordForUnlock = true;
        scheduleUnlockPasswordTimeout(ctx);
        break;
      case "status":
        result = await renderStatusPage(ctx);
        break;
      case "help":
        result = renderHelpPage();
        break;
      default:
        result = await renderMainPage(ctx);
    }

    // Update UI state
    ctx.session.ui.currentPage = page;

    // Edit message or send new one
    const existingMessageId = ctx.session.ui.messageId;

    if (ctx.callbackQuery?.message) {
      // From callback query - edit that message
      try {
        await ctx.editMessageText(result.text, {
          parse_mode: "Markdown",
          reply_markup: result.keyboard,
        });
        ctx.session.ui.messageId = ctx.callbackQuery.message.message_id;
      } catch (error: any) {
        // Ignore "message is not modified" error - happens when navigating to same page
        if (error?.description?.includes("message is not modified")) {
          logger.debug("Message not modified (same content)", { page });
          // Answer callback query to remove loading indicator
          await ctx.answerCallbackQuery();
        } else {
          throw error;
        }
      }
    } else if (existingMessageId && ctx.chat) {
      // We have existing UI message - edit it
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          existingMessageId,
          result.text,
          {
            parse_mode: "Markdown",
            reply_markup: result.keyboard,
          }
        );
      } catch (error: any) {
        // Ignore "message is not modified" error
        if (error?.description?.includes("message is not modified")) {
          logger.debug("Message not modified (same content)", { page });
        } else {
          throw error;
        }
      }
    } else if (ctx.message) {
      // No existing message - create new one
      const sent = await ctx.reply(result.text, {
        parse_mode: "Markdown",
        reply_markup: result.keyboard,
      });
      ctx.session.ui.messageId = sent.message_id;
    }

    logger.debug("Navigated to page", { page, userId: ctx.from?.id });
  } catch (error) {
    logger.error("Error navigating to page", { page, error });
    await ctx.reply("❌ An error occurred. Please try /start again.");
  }
}

// ============================================================================
// Helper Functions
// ============================================================================
