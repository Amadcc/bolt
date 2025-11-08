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
  returnToPageAfterUnlock?: Page; // Save page to return after unlock
  pendingCommand?: {
    type: "buy" | "sell" | "swap";
    params: string[];
  }; // Save command to execute after unlock
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
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: true },
  });

  if (!user?.wallets.length) {
    return renderWelcomePage(ctx);
  }

  const wallet = user.wallets[0];
  // ✅ Redis Session Integration: Check Redis session instead of in-memory encryptedKey
  const isLocked = !ctx.session.sessionToken || !ctx.session.password;

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
    `*Balance*\n\n` +
    `Loading...`;

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
    `*Settings*\n\n` +
    `Slippage: ${slippage}%\n` +
    `Auto-approve: ${autoApprove ? "✅ Enabled" : "❌ Disabled"}`;

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
    `*Unlock Wallet*\n\n` +
    `\`${wallet.publicKey}\`\n\n` +
    `Send your password to unlock for 15 minutes.\n\n` +
    `⚠️ Your message will be deleted automatically.`;

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
      case "wallet_info":
        result = await renderWalletInfoPage(ctx);
        break;
      case "settings":
        result = renderSettingsPage(ctx.session.settings);
        break;
      case "unlock":
        result = await renderUnlockPage(ctx);
        // Set state to await password input
        ctx.session.awaitingPasswordForUnlock = true;
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

// ============================================================================
// Helper Functions
// ============================================================================
