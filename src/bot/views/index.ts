/**
 * Single-Page UI System for Telegram Bot
 * All interactions happen in one message with inline keyboards
 */

import { InlineKeyboard } from "grammy";
import type { Context as GrammyContext, SessionFlavor } from "grammy";
import { prisma } from "../../utils/db.js";
import { logger } from "../../utils/logger.js";

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

interface SessionData {
  walletId?: string;
  encryptedKey?: string;
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
  // ✅ Redis Session Integration (CRITICAL-1 + CRITICAL-2 fix)
  sessionToken?: string; // Redis session token (15 min TTL)
  password?: string; // For getKeypairForSigning() - stored in Grammy memory only
  sessionExpiresAt?: number; // Timestamp for UI display
  ui: UIState;
  awaitingPasswordForWallet?: boolean;
  awaitingPasswordForUnlock?: boolean;
  awaitingInput?: {
    type: "token" | "amount" | "password";
    page: Page;
  };
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
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: true },
  });

  const hasWallet = user?.wallets && user.wallets.length > 0;

  const text =
    `⚡️ *Bolt Sniper Bot*\n\n` +
    `Trade Solana tokens instantly with built-in honeypot protection and best prices from Jupiter.\n\n` +
    (hasWallet
      ? `✅ Your wallet is ready — let's trade!\n\n`
      : `👉 Create your secure wallet in 30 seconds\n\n`) +
    `*Your keys, your crypto* 🔐`;

  const keyboard = new InlineKeyboard();

  if (hasWallet) {
    keyboard.text("🏠 Go to Dashboard", "nav:main");
  } else {
    keyboard.text("🎯 Create Wallet", "nav:create_wallet");
  }

  return { text, keyboard };
}

/**
 * Create wallet page
 */
export function renderCreateWalletPage(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text =
    `💼 *Create Wallet*\n\n` +
    `Let's create your secure Solana wallet!\n\n` +
    `*How it works:*\n` +
    `1️⃣ Choose a strong password (min 8 chars)\n` +
    `2️⃣ Send it in next message\n` +
    `3️⃣ Done! Your wallet is ready\n\n` +
    `🔐 *Security:*\n` +
    `• Your password encrypts your private keys\n` +
    `• Password is NEVER stored anywhere\n` +
    `• Your message will auto-delete\n\n` +
    `⚠️ *Important:* Save your password safely — we can't recover it!\n\n` +
    `✍️ Ready? Send your password now...`;

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
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: true },
  });

  if (!user?.wallets.length) {
    return renderWelcomePage(ctx);
  }

  const wallet = user.wallets[0];
  // ✅ Redis Session Integration: Check Redis session instead of in-memory encryptedKey
  const isLocked = !ctx.session.sessionToken;

  const text =
    `🏠 *Dashboard*\n\n` +
    `💼 Wallet: \`${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-6)}\`\n\n` +
    `${isLocked ? "🔒 *Locked* — unlock to start trading" : "🔓 *Unlocked* — ready to trade"}\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `What would you like to do?`;

  const keyboard = new InlineKeyboard()
    .text("🛒 Buy", "nav:buy")
    .text("💸 Sell", "nav:sell")
    .row()
    .text("🔄 Swap", "nav:swap")
    .text("📊 Balance", "nav:balance")
    .row()
    .text("💼 Wallet Info", "nav:wallet_info")
    .text("⚙️ Settings", "nav:settings")
    .row()
    .text("📊 Session Status", "nav:status")
    .text("📚 Help", "nav:help");

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
    (data?.selectedToken
      ? `🛒 *Buy ${data.selectedToken}*\n\n` +
        `How much SOL to spend?`
      : `🛒 *Buy Tokens*\n\n` +
        `Choose a token to buy:`);

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
    (data?.selectedToken
      ? `💸 *Sell ${data.selectedToken}*\n\n` +
        `How much to sell?`
      : `💸 *Sell Tokens*\n\n` +
        `Choose a token to sell:`);

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
 * MEDIUM-7: Refactored Swap Page (split into 3 smaller functions)
 * Main coordinator function
 */
export function renderSwapPage(data?: {
  inputToken?: string;
  outputToken?: string;
  amount?: string;
}): {
  text: string;
  keyboard: InlineKeyboard;
} {
  // Step 1: Select input token
  if (!data?.inputToken) {
    return renderSwapStepSelectInput();
  }
  // Step 2: Select output token
  else if (!data?.outputToken) {
    return renderSwapStepSelectOutput(data.inputToken);
  }
  // Step 3: Select amount
  else {
    return renderSwapStepSelectAmount(data.inputToken, data.outputToken);
  }
}

/**
 * MEDIUM-7: Swap Step 1 - Select input token
 */
function renderSwapStepSelectInput(): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text =
    `🔄 *Swap Tokens*\n\n` +
    `*Step 1 of 3:* Choose input token\n\n` +
    `What do you want to swap FROM?`;

  const keyboard = new InlineKeyboard()
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

  return { text, keyboard };
}

/**
 * MEDIUM-7: Swap Step 2 - Select output token
 */
function renderSwapStepSelectOutput(inputToken: string): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text =
    `🔄 *Swap Tokens*\n\n` +
    `From: *${inputToken}*\n\n` +
    `*Step 2 of 3:* Choose output token\n\n` +
    `What do you want to swap TO?`;

  const keyboard = new InlineKeyboard()
    .text("🟣 SOL", `swap:output:${inputToken}:SOL`)
    .text("💵 USDC", `swap:output:${inputToken}:USDC`)
    .row()
    .text("💲 USDT", `swap:output:${inputToken}:USDT`)
    .text("🐕 BONK", `swap:output:${inputToken}:BONK`)
    .row()
    .text("🐶 WIF", `swap:output:${inputToken}:WIF`)
    .text("✏️ Custom", `swap:output:${inputToken}:custom`)
    .row()
    .text("« Back", "nav:swap")
    .text("🏠 Dashboard", "nav:main");

  return { text, keyboard };
}

/**
 * MEDIUM-7: Swap Step 3 - Select amount
 */
function renderSwapStepSelectAmount(
  inputToken: string,
  outputToken: string
): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text =
    `🔄 *Swap Tokens*\n\n` +
    `*${inputToken}* → *${outputToken}*\n\n` +
    `*Step 3 of 3:* Choose amount\n\n` +
    `How much ${inputToken} to swap?`;

  const keyboard = new InlineKeyboard();

  // Show different amounts based on input token
  if (inputToken === "SOL") {
    keyboard
      .text("0.1 SOL", `swap:amount:${inputToken}:${outputToken}:0.1`)
      .text("0.5 SOL", `swap:amount:${inputToken}:${outputToken}:0.5`)
      .row()
      .text("1 SOL", `swap:amount:${inputToken}:${outputToken}:1`)
      .text("5 SOL", `swap:amount:${inputToken}:${outputToken}:5`)
      .row()
      .text("✏️ Custom", `swap:amount:${inputToken}:${outputToken}:custom`);
  } else if (inputToken === "USDC" || inputToken === "USDT") {
    keyboard
      .text("10 " + inputToken, `swap:amount:${inputToken}:${outputToken}:10`)
      .text("50 " + inputToken, `swap:amount:${inputToken}:${outputToken}:50`)
      .row()
      .text("100 " + inputToken, `swap:amount:${inputToken}:${outputToken}:100`)
      .text("500 " + inputToken, `swap:amount:${inputToken}:${outputToken}:500`)
      .row()
      .text("✏️ Custom", `swap:amount:${inputToken}:${outputToken}:custom`);
  } else {
    // For other tokens, show percentage options
    keyboard
      .text("25%", `swap:amount:${inputToken}:${outputToken}:25%`)
      .text("50%", `swap:amount:${inputToken}:${outputToken}:50%`)
      .row()
      .text("75%", `swap:amount:${inputToken}:${outputToken}:75%`)
      .text("100%", `swap:amount:${inputToken}:${outputToken}:100%`)
      .row()
      .text("✏️ Custom", `swap:amount:${inputToken}:${outputToken}:custom`);
  }

  keyboard
    .row()
    .text("« Back", `swap:back_to_output:${inputToken}`)
    .text("🏠 Dashboard", "nav:main");

  return { text, keyboard };
}

/**
 * Balance page
 */
export async function renderBalancePage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: { where: { isActive: true } } },
  });

  if (!user?.wallets.length) {
    return renderWelcomePage(ctx);
  }

  const text =
    `📊 *Balance*\n\n` +
    `⏳ Loading balances...\n\n` +
    `Please wait a moment.`;

  const keyboard = new InlineKeyboard()
    .text("🔄 Refresh", "action:refresh_balance")
    .row()
    .text("« Back to Dashboard", "nav:main");

  return { text, keyboard };
}

/**
 * Wallet info page
 */
export async function renderWalletInfoPage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: true },
  });

  if (!user?.wallets.length) {
    return renderWelcomePage(ctx);
  }

  const wallet = user.wallets[0];

  const text =
    `💼 *Wallet Info*\n\n` +
    `*Address:*\n\`${wallet.publicKey}\`\n\n` +
    `Chain: *${wallet.chain.toUpperCase()}*\n` +
    `Status: ${wallet.isActive ? "*Active* 🟢" : "*Inactive* 🔴"}\n\n` +
    `*View on:*\n` +
    `• [Solscan](https://solscan.io/account/${wallet.publicKey})\n` +
    `• [Solana Explorer](https://explorer.solana.com/address/${wallet.publicKey})`;

  const keyboard = new InlineKeyboard()
    .text("« Back to Dashboard", "nav:main");

  return { text, keyboard };
}

/**
 * Settings page
 */
export function renderSettingsPage(settings?: {
  slippage: number;
  autoApprove: boolean;
}): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const slippage = settings?.slippage ?? 1;
  const autoApprove = settings?.autoApprove ?? false;

  const text =
    `⚙️ *Settings*\n\n` +
    `*Slippage:* ${slippage}%\n` +
    `*Auto-approve:* ${autoApprove ? "✅ Enabled" : "❌ Disabled"}\n\n` +
    `Use buttons below to adjust:`;

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
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: true },
  });

  if (!user?.wallets.length) {
    return renderWelcomePage(ctx);
  }

  const wallet = user.wallets[0];

  const text =
    `🔓 *Unlock Wallet*\n\n` +
    `Wallet: \`${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-6)}\`\n\n` +
    `*How it works:*\n` +
    `• Session lasts *15 minutes*\n` +
    `• Password auto-deleted\n` +
    `• Never stored\n\n` +
    `✍️ Send your password in the next message...`;

  const keyboard = new InlineKeyboard()
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
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: true },
  });

  if (!user?.wallets.length) {
    return renderWelcomePage(ctx);
  }

  const wallet = user.wallets[0];

  // ✅ Redis Session Integration: Check Redis session status
  const hasSession = !!ctx.session.sessionToken;
  const sessionExpiresAt = ctx.session.sessionExpiresAt || 0;
  const now = Date.now();
  const isActive = hasSession && sessionExpiresAt > now;

  let text = `📊 *Session Status*\n\n`;
  text += `Wallet: \`${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-6)}\`\n\n`;

  const keyboard = new InlineKeyboard();

  if (isActive) {
    const timeLeft = Math.floor((sessionExpiresAt - now) / 1000 / 60);
    text +=
      `🟢 *Unlocked*\n\n` +
      `Time left: *${timeLeft} min*\n\n` +
      `You can trade without password until session expires.`;

    keyboard
      .text("🔒 Lock Now", "action:lock")
      .row()
      .text("🔄 Refresh", "nav:status")
      .row()
      .text("« Back", "nav:main");
  } else {
    text +=
      `🔴 *Locked*\n\n` +
      `Unlock your wallet to start trading.`;

    keyboard
      .text("🔓 Unlock", "action:unlock")
      .row()
      .text("« Back", "nav:main");
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
    `📚 *Help & Commands*\n\n` +
    `*Quick Start:*\n` +
    `1. /start — open dashboard\n` +
    `2. Create wallet\n` +
    `3. Use buttons to trade\n\n` +
    `*Main Commands:*\n` +
    `🛒 /buy — buy tokens with SOL\n` +
    `💸 /sell — sell tokens for SOL\n` +
    `🔄 /swap — swap any tokens\n` +
    `📊 /balance — check balances\n\n` +
    `*Wallet & Security:*\n` +
    `💼 /wallet — view wallet info\n` +
    `🔓 /unlock — unlock for 15 min\n` +
    `🔒 /lock — lock immediately\n` +
    `📊 /status — session status\n\n` +
    `*Features:*\n` +
    `✅ Non-custodial wallet\n` +
    `✅ Honeypot protection\n` +
    `✅ Best prices (Jupiter)\n` +
    `✅ 15-min session unlock\n\n` +
    `Use the buttons below for quick access 👇`;

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
 * MEDIUM-7: Refactored navigateToPage() (split into smaller functions)
 * Main coordinator function
 */
export async function navigateToPage(
  ctx: Context,
  page: Page,
  data?: any
): Promise<void> {
  try {
    // Get page content
    const result = await getPageContent(ctx, page, data);

    // Update UI state
    ctx.session.ui.currentPage = page;

    // Update the message in Telegram
    await updateUIMessage(ctx, result, page);

    logger.debug("Navigated to page", { page, userId: ctx.from?.id });

    // Trigger balance fetch after navigation if on balance page
    if (page === "balance") {
      // Dynamically import to avoid circular dependency
      const { fetchAndDisplayBalance } = await import("../handlers/callbacks.js");
      await fetchAndDisplayBalance(ctx);
    }
  } catch (error) {
    logger.error("Error navigating to page", { page, error });
    await ctx.reply("❌ An error occurred. Please try /start again.");
  }
}

/**
 * MEDIUM-7: Get page content by calling appropriate renderer
 */
async function getPageContent(
  ctx: Context,
  page: Page,
  data?: any
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  switch (page) {
    case "welcome":
      return await renderWelcomePage(ctx);

    case "create_wallet":
      // Set state to await password input
      ctx.session.awaitingPasswordForWallet = true;
      return renderCreateWalletPage();

    case "main":
      return await renderMainPage(ctx);

    case "buy":
      return renderBuyPage(data);

    case "sell":
      return renderSellPage(data);

    case "swap":
      return renderSwapPage(data);

    case "balance":
      return await renderBalancePage(ctx);

    case "wallet_info":
      return await renderWalletInfoPage(ctx);

    case "settings":
      return renderSettingsPage(ctx.session.settings);

    case "unlock":
      // Set state to await password input
      ctx.session.awaitingPasswordForUnlock = true;
      return await renderUnlockPage(ctx);

    case "status":
      return await renderStatusPage(ctx);

    case "help":
      return renderHelpPage();

    default:
      return await renderMainPage(ctx);
  }
}

/**
 * MEDIUM-7: Update UI message (edit existing or send new)
 */
async function updateUIMessage(
  ctx: Context,
  result: { text: string; keyboard: InlineKeyboard },
  page: Page
): Promise<void> {
  const existingMessageId = ctx.session.ui.messageId;

  if (ctx.callbackQuery?.message) {
    // From callback query - edit that message
    await editMessageWithErrorHandling(
      ctx,
      result,
      page,
      async () => {
        await ctx.editMessageText(result.text, {
          parse_mode: "Markdown",
          reply_markup: result.keyboard,
        });
        ctx.session.ui.messageId = ctx.callbackQuery!.message!.message_id;
      }
    );
  } else if (existingMessageId && ctx.chat) {
    // We have existing UI message - edit it
    await editMessageWithErrorHandling(
      ctx,
      result,
      page,
      async () => {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          existingMessageId,
          result.text,
          {
            parse_mode: "Markdown",
            reply_markup: result.keyboard,
          }
        );
      }
    );
  } else if (ctx.message) {
    // No existing message - create new one
    const sent = await ctx.reply(result.text, {
      parse_mode: "Markdown",
      reply_markup: result.keyboard,
    });
    ctx.session.ui.messageId = sent.message_id;
  }
}

/**
 * MEDIUM-7: Handle message edit errors (ignore "not modified" errors)
 */
async function editMessageWithErrorHandling(
  ctx: Context,
  result: { text: string; keyboard: InlineKeyboard },
  page: Page,
  editFn: () => Promise<void>
): Promise<void> {
  try {
    await editFn();
  } catch (error: any) {
    // Ignore "message is not modified" error - happens when navigating to same page
    if (error?.description?.includes("message is not modified")) {
      logger.debug("Message not modified (same content)", { page });
      // Answer callback query to remove loading indicator (if applicable)
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery();
      }
    } else {
      throw error;
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================
