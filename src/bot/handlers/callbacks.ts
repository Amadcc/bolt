/**
 * Callback Query Handlers
 * Handle all inline button clicks
 */

import type { Context } from "../views/index.js";
import { navigateToPage } from "../views/index.js";
import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import { handleUnlockPasswordInput, lockSession } from "../commands/session.js";

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
    "wallet_info",
    "settings",
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

    case "copy":
      await handleCopyAction(ctx, params?.[0]);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown action");
      logger.warn("Unknown action", { action, userId: ctx.from?.id });
  }
}

/**
 * Unlock wallet action
 */
async function handleUnlockAction(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery("🔓 Please send your password");

  // Set state to await password
  ctx.session.awaitingPasswordForUnlock = true;

  // Update message to show password prompt
  await ctx.editMessageText(
    `🔓 *Unlock Wallet*\n\n` +
      `Send your wallet password in the next message.\n\n` +
      `Your password will be deleted immediately after processing.\n\n` +
      `⏱ Session will be active for 30 minutes.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "« Cancel", callback_data: "nav:main" }]],
      },
    }
  );
}

/**
 * Lock wallet action
 */
async function handleLockAction(ctx: Context): Promise<void> {
  lockSession(ctx);
  await ctx.answerCallbackQuery("🔒 Wallet locked");
  await navigateToPage(ctx, "main");
}

/**
 * Refresh balance action
 */
async function handleRefreshBalanceAction(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery("🔄 Refreshing balance...");

  // Show loading state
  try {
    await ctx.editMessageText(
      `📊 *Your Balance*\n\n` +
      `⏳ Loading balances...`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 Refresh", callback_data: "action:refresh_balance" },
          ], [
            { text: "« Back to Dashboard", callback_data: "nav:main" }
          ]]
        }
      }
    );
  } catch (error) {
    logger.error("Error updating balance loading state", { error });
  }

  // Fetch and display balance
  await fetchAndDisplayBalance(ctx);
}

/**
 * Fetch balance and update message
 */
export async function fetchAndDisplayBalance(ctx: Context): Promise<void> {
  try {
    const { prisma } = await import("../../utils/db.js");
    const { getSolanaConnection } = await import("../../services/blockchain/solana.js");
    const { LAMPORTS_PER_SOL, PublicKey } = await import("@solana/web3.js");

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from!.id) },
      include: { wallets: { where: { isActive: true } } },
    });

    if (!user?.wallets.length) {
      await navigateToPage(ctx, "main");
      return;
    }

    const wallet = user.wallets[0];
    const connection = getSolanaConnection();
    const publicKey = new PublicKey(wallet.publicKey);

    // Get SOL balance
    const lamports = await connection.getBalance(publicKey);
    const sol = lamports / LAMPORTS_PER_SOL;

    // Get token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );

    // Build balance message
    let message = `📊 *Your Balance*\n\n`;
    message += `Wallet: \`${wallet.publicKey}\`\n\n`;
    message += `💎 SOL: *${sol.toFixed(4)}* SOL\n`;

    // Add token balances
    const KNOWN_TOKENS: Record<string, string> = {
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
      "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
      "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
    };

    if (tokenAccounts.value.length > 0) {
      message += `\n📊 *Tokens:*\n`;

      for (const tokenAccount of tokenAccounts.value) {
        const accountData = tokenAccount.account.data.parsed.info;
        const mint = accountData.mint;
        const amount = parseFloat(accountData.tokenAmount.uiAmountString);

        if (amount > 0) {
          const symbol = KNOWN_TOKENS[mint] || truncateAddress(mint);
          message += `• *${symbol}:* ${formatAmount(amount)}\n`;
        }
      }
    } else {
      message += `\n_No token balances_`;
    }

    // Update message with balance
    await ctx.editMessageText(message, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "🔄 Refresh", callback_data: "action:refresh_balance" },
        ], [
          { text: "« Back to Dashboard", callback_data: "nav:main" }
        ]]
      }
    });

  } catch (error) {
    logger.error("Error fetching balance", { error });
    await ctx.editMessageText(
      `📊 *Your Balance*\n\n` +
      `❌ Failed to load balance.\n\n` +
      `Please try again.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 Try Again", callback_data: "action:refresh_balance" },
          ], [
            { text: "« Back to Dashboard", callback_data: "nav:main" }
          ]]
        }
      }
    );
  }
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return amount.toExponential(2);
  if (amount >= 1000) return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (amount >= 1) return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (amount >= 0.000001) return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  return amount.toExponential(2);
}

/**
 * Copy address action
 */
async function handleCopyAction(
  ctx: Context,
  address?: string
): Promise<void> {
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
  switch (action) {
    case "token":
      await handleBuyTokenSelection(ctx, params[0]);
      break;

    case "amount":
      await handleBuyAmountSelection(ctx, params[0], params[1]);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown buy action");
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
  await ctx.answerCallbackQuery();

  if (amount === "custom") {
    // Wait for custom amount input
    ctx.session.awaitingInput = {
      type: "amount",
      page: "buy",
    };

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

  // Execute buy
  await executeBuyFlow(ctx, token, amount);
}

/**
 * Execute buy flow with confirmation
 */
async function executeBuyFlow(
  ctx: Context,
  token: string,
  amount: string
): Promise<void> {
  // Check if wallet is unlocked
  if (!ctx.session.encryptedKey) {
    await ctx.answerCallbackQuery();

    // Show unlock prompt with buttons
    await ctx.editMessageText(
      `🔒 *Wallet Locked*\n\n` +
        `To buy ${token} with ${amount} SOL, please unlock your wallet first.\n\n` +
        `Your session will be active for 30 minutes.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔓 Unlock Wallet", callback_data: "action:unlock" },
            { text: "« Cancel", callback_data: "nav:main" }
          ]]
        }
      }
    );
    return;
  }

  await ctx.answerCallbackQuery();

  // Wallet is unlocked - show processing
  await ctx.editMessageText(
    `⏳ *Executing Buy*\n\n` +
      `Token: ${token}\n` +
      `Amount: ${amount} SOL\n\n` +
      `Processing transaction...`,
    { parse_mode: "Markdown" }
  );

  // TODO: Implement actual buy execution
  setTimeout(async () => {
    try {
      await ctx.editMessageText(
        `✅ *Buy Executed* (Demo)\n\n` +
          `Token: ${token}\n` +
          `Amount: ${amount} SOL\n\n` +
          `_This is a demo. Real execution coming soon._\n\n` +
          `Returning to dashboard...`,
        { parse_mode: "Markdown" }
      );

      setTimeout(async () => {
        try {
          await navigateToPage(ctx, "main");
        } catch (error) {
          logger.error("Error navigating after buy", { error });
        }
      }, 2000);
    } catch (error) {
      logger.error("Error showing buy result", { error });
    }
  }, 1500);
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

    default:
      await ctx.answerCallbackQuery("❌ Unknown sell action");
  }
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
 */
async function executeSellFlow(
  ctx: Context,
  token: string,
  percentage: string
): Promise<void> {
  // Check if wallet is unlocked
  if (!ctx.session.encryptedKey) {
    await ctx.answerCallbackQuery();

    // Show unlock prompt with buttons
    await ctx.editMessageText(
      `🔒 *Wallet Locked*\n\n` +
        `To sell ${percentage}% of ${token}, please unlock your wallet first.\n\n` +
        `Your session will be active for 30 minutes.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔓 Unlock Wallet", callback_data: "action:unlock" },
            { text: "« Cancel", callback_data: "nav:main" }
          ]]
        }
      }
    );
    return;
  }

  await ctx.answerCallbackQuery();

  // Wallet is unlocked - show processing
  await ctx.editMessageText(
    `⏳ *Executing Sell*\n\n` +
      `Token: ${token}\n` +
      `Amount: ${percentage}% of balance\n\n` +
      `Processing transaction...`,
    { parse_mode: "Markdown" }
  );

  // TODO: Implement actual sell execution
  setTimeout(async () => {
    try {
      await ctx.editMessageText(
        `✅ *Sell Executed* (Demo)\n\n` +
          `Token: ${token}\n` +
          `Amount: ${percentage}% of balance\n\n` +
          `_This is a demo. Real execution coming soon._\n\n` +
          `Returning to dashboard...`,
        { parse_mode: "Markdown" }
      );

      setTimeout(async () => {
        try {
          await navigateToPage(ctx, "main");
        } catch (error) {
          logger.error("Error navigating after sell", { error });
        }
      }, 2000);
    } catch (error) {
      logger.error("Error showing sell result", { error });
    }
  }, 1500);
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
 */
async function executeSwapFlow(
  ctx: Context,
  inputToken: string,
  outputToken: string,
  amount: string
): Promise<void> {
  const msgId = ctx.session.ui.messageId;

  if (!msgId) {
    await ctx.answerCallbackQuery("❌ Error: No message ID");
    return;
  }

  // Check if wallet is unlocked
  if (!ctx.session.encryptedKey) {
    await ctx.editMessageText(
      `🔒 *Wallet Locked*\n\n` +
        `To swap ${amount} ${inputToken} → ${outputToken}, please unlock your wallet first.`,
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

  // Show processing
  await ctx.api.editMessageText(
    ctx.chat!.id,
    msgId,
    `⏳ *Executing Swap*\n\n` +
      `📥 Input: ${amount} ${inputToken}\n` +
      `📤 Output: ${outputToken}\n\n` +
      `Please wait...`,
    { parse_mode: "Markdown" }
  );

  // Simulate execution (TODO: implement actual swap)
  setTimeout(async () => {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msgId,
      `✅ *Swap Executed* (Demo)\n\n` +
        `📥 Sent: ${amount} ${inputToken}\n` +
        `📤 Received: ~XXX ${outputToken}\n\n` +
        `_Returning to dashboard..._`,
      { parse_mode: "Markdown" }
    );

    setTimeout(() => navigateToPage(ctx, "main"), 2000);
  }, 1500);
}
