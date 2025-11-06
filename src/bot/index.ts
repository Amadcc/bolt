import { Bot, Context, session, SessionFlavor } from "grammy";
import { prisma } from "../utils/db.js";
import {
  handleCreateWallet,
  handlePasswordInput,
} from "./commands/createWallet.js";
import { handleSwap } from "./commands/swap.js";
import { handleBuy } from "./commands/buy.js";
import { handleSell } from "./commands/sell.js";
import { handleUnlock, handleLock, handleStatus, handleUnlockPasswordInput } from "./commands/session.js";
import { handleBalance } from "./commands/balance.js";
import { logger } from "../utils/logger.js";
import { navigateToPage, type UIState, type Page } from "./views/index.js";
import {
  handleNavigationCallback,
  handleActionCallback,
  handleBuyCallback,
  handleSellCallback,
  handleSwapCallback,
  handleSettingsCallback,
} from "./handlers/callbacks.js";

interface SessionData {
  walletId?: string;
  encryptedKey?: string;
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
  // UI State
  ui: UIState;
  // Conversation state
  awaitingPasswordForWallet?: boolean;
  awaitingPasswordForUnlock?: boolean;
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
}

type MyContext = Context & SessionFlavor<SessionData>;

export const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);

// Session middleware
bot.use(
  session({
    initial: (): SessionData => ({
      settings: { slippage: 1, autoApprove: false },
      ui: {
        currentPage: "welcome",
      },
    }),
  })
);

// Middleware для проверки/создания пользователя
bot.use(async (ctx, next) => {
  if (ctx.from) {
    let user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          telegramId: BigInt(ctx.from.id),
          username: ctx.from.username || null,
        },
      });
      logger.info("New user created", {
        userId: user.id,
        telegramId: ctx.from.id,
      });
    }
  }

  await next();
});

// ============================================================================
// Commands
// ============================================================================

/**
 * /start - Show create wallet or dashboard
 */
bot.command("start", async (ctx) => {
  // Clear message ID to force creating a new message (in case user cleared chat)
  ctx.session.ui.messageId = undefined;

  // Check if user has wallet
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: true },
  });

  const hasWallet = user?.wallets && user.wallets.length > 0;

  // Navigate to appropriate page
  if (hasWallet) {
    // User has wallet → show dashboard
    await navigateToPage(ctx, "main");
  } else {
    // No wallet → show create wallet directly
    await navigateToPage(ctx, "create_wallet");
  }
});

/**
 * Legacy commands - redirect to UI pages
 */
bot.command("wallet", async (ctx) => {
  await navigateToPage(ctx, "wallet_info");
});

bot.command("createwallet", async (ctx) => {
  await navigateToPage(ctx, "create_wallet");
});

bot.command("buy", async (ctx) => {
  // Support legacy text commands OR navigate to buy page
  const text = ctx.message?.text;
  const parts = text?.split(" ").filter(Boolean) || [];

  if (parts.length > 1) {
    // Legacy command with parameters: /buy BONK 0.1
    await handleBuy(ctx);
  } else {
    // No parameters: show UI
    await navigateToPage(ctx, "buy");
  }
});

bot.command("sell", async (ctx) => {
  const text = ctx.message?.text;
  const parts = text?.split(" ").filter(Boolean) || [];

  if (parts.length > 1) {
    await handleSell(ctx);
  } else {
    await navigateToPage(ctx, "sell");
  }
});

bot.command("swap", async (ctx) => {
  const text = ctx.message?.text;
  const parts = text?.split(" ").filter(Boolean) || [];

  if (parts.length > 1) {
    await handleSwap(ctx);
  } else {
    await navigateToPage(ctx, "swap");
  }
});

bot.command("balance", async (ctx) => {
  // Delete the command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete balance command message", { error });
  }

  // Navigate to balance page
  await navigateToPage(ctx, "balance");
});

bot.command("settings", async (ctx) => {
  await navigateToPage(ctx, "settings");
});

bot.command("unlock", handleUnlock);
bot.command("lock", handleLock);
bot.command("status", handleStatus);

bot.command("help", async (ctx) => {
  await ctx.reply(
    "📚 *Bolt Sniper Bot - Help*\n\n" +
      "🎯 *Quick Start:*\n" +
      "1. /start - Open dashboard\n" +
      "2. Create wallet if needed\n" +
      "3. Use inline buttons to trade\n\n" +
      "⚡️ *Legacy Commands:*\n" +
      "You can still use text commands:\n" +
      "• `/buy BONK 0.1` - Buy with SOL\n" +
      "• `/sell BONK 1000000` - Sell for SOL\n" +
      "• `/swap USDC BONK 10` - Token swap\n\n" +
      "🔐 *Security:*\n" +
      "• Non-custodial (your keys, your crypto)\n" +
      "• Encrypted with Argon2id + AES-256\n" +
      "• Session-based unlocking\n\n" +
      "For more info, use /start",
    { parse_mode: "Markdown" }
  );
});

// ============================================================================
// Callback Query Handlers (Inline Button Clicks)
// ============================================================================

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  try {
    // Parse callback data format: "action:param1:param2:..."
    const parts = data.split(":");
    const action = parts[0];
    const params = parts.slice(1);

    switch (action) {
      case "nav":
        // Navigation: nav:page_name
        await handleNavigationCallback(ctx, params[0]);
        break;

      case "action":
        // Actions: action:action_name:params
        await handleActionCallback(ctx, params[0], params.slice(1));
        break;

      case "buy":
        // Buy flow: buy:token:BONK or buy:amount:BONK:0.1
        await handleBuyCallback(ctx, params[0], params.slice(1));
        break;

      case "sell":
        // Sell flow: sell:token:BONK or sell:amount:BONK:50
        await handleSellCallback(ctx, params[0], params.slice(1));
        break;

      case "swap":
        // Swap flow: swap:input:SOL or swap:output:SOL:USDC or swap:amount:SOL:USDC:1
        await handleSwapCallback(ctx, params[0], params.slice(1));
        break;

      case "settings":
        // Settings: settings:action
        await handleSettingsCallback(ctx, params[0]);
        break;

      default:
        await ctx.answerCallbackQuery("❌ Unknown action");
        logger.warn("Unknown callback action", {
          action,
          data,
          userId: ctx.from?.id,
        });
    }
  } catch (error) {
    logger.error("Error handling callback query", { data, error });
    await ctx.answerCallbackQuery("❌ An error occurred");
  }
});

// ============================================================================
// Text Message Handlers
// ============================================================================

bot.on("message:text", async (ctx, next) => {
  // Check if we're waiting for password input for wallet creation
  if (ctx.session.awaitingPasswordForWallet) {
    const password = ctx.message.text;

    // Delete password message immediately
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn("Failed to delete password message", { error });
    }

    // Reset conversation state
    ctx.session.awaitingPasswordForWallet = false;

    // Handle password input
    await handlePasswordInput(ctx, password);

    // After wallet creation, navigate to main page
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from!.id) },
      include: { wallets: true },
    });

    if (user?.wallets.length) {
      // Update the message to show success and navigate to main
      setTimeout(async () => {
        try {
          await navigateToPage(ctx, "main");
        } catch (error) {
          logger.error("Error navigating after wallet creation", { error });
        }
      }, 2000);
    }

    return;
  }

  // Check if we're waiting for password input for unlock
  if (ctx.session.awaitingPasswordForUnlock) {
    const password = ctx.message.text;

    // Delete password message immediately
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn("Failed to delete password message", { error });
    }

    // Reset conversation state
    ctx.session.awaitingPasswordForUnlock = false;

    // Handle unlock password input
    await handleUnlockPasswordInput(ctx, password);

    // Navigate back to main page after unlock (only if successful)
    setTimeout(async () => {
      try {
        // Check if wallet was successfully unlocked
        if (ctx.session.encryptedKey) {
          await navigateToPage(ctx, "main");
        }
      } catch (error) {
        logger.error("Error navigating after unlock", { error });
      }
    }, 2000);

    return;
  }

  // Check if we're waiting for custom input (token address, amount, etc)
  if (ctx.session.awaitingInput) {
    const input = ctx.message.text;
    const inputType = ctx.session.awaitingInput.type;
    const page = ctx.session.awaitingInput.page;

    // Delete input message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn("Failed to delete input message", { error });
    }

    // Reset state
    ctx.session.awaitingInput = undefined;

    // Handle based on input type and page
    if (page === "buy" && inputType === "token") {
      // Save custom token and show amount options
      if (!ctx.session.ui.buyData) {
        ctx.session.ui.buyData = {};
      }
      ctx.session.ui.buyData.selectedToken = input;
      await navigateToPage(ctx, "buy", { selectedToken: input });
    } else if (page === "buy" && inputType === "amount") {
      // Save custom amount and execute buy
      if (ctx.session.ui.buyData?.selectedToken) {
        const token = ctx.session.ui.buyData.selectedToken;
        const amount = parseFloat(input);

        if (isNaN(amount) || amount <= 0) {
          // Show error in same message
          const msgId = ctx.session.ui.messageId;
          if (msgId && ctx.chat) {
            await ctx.api.editMessageText(
              ctx.chat.id,
              msgId,
              `❌ *Invalid Amount*\n\nPlease enter a valid number.\n\nExample: 0.1 or 1.5`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[
                    { text: "🔄 Try Again", callback_data: `buy:amount:${token}:custom` },
                    { text: "« Back", callback_data: "nav:buy" }
                  ]]
                }
              }
            );
          }
          return;
        }

        // Execute buy (will check unlock inside)
        await executeBuyFromAmount(ctx, token, amount);
      }
    } else if (page === "sell" && inputType === "token") {
      if (!ctx.session.ui.sellData) {
        ctx.session.ui.sellData = {};
      }
      ctx.session.ui.sellData.selectedToken = input;
      await navigateToPage(ctx, "sell", { selectedToken: input });
    } else if (page === "sell" && inputType === "amount") {
      if (ctx.session.ui.sellData?.selectedToken) {
        const token = ctx.session.ui.sellData.selectedToken;
        const amount = parseFloat(input);

        if (isNaN(amount) || amount <= 0) {
          // Show error in same message
          const msgId = ctx.session.ui.messageId;
          if (msgId && ctx.chat) {
            await ctx.api.editMessageText(
              ctx.chat.id,
              msgId,
              `❌ *Invalid Amount*\n\nPlease enter a valid number.\n\nExample: 1000000`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[
                    { text: "🔄 Try Again", callback_data: `sell:amount:${token}:custom` },
                    { text: "« Back", callback_data: "nav:sell" }
                  ]]
                }
              }
            );
          }
          return;
        }

        // Execute sell (will check unlock inside)
        await executeSellFromAmount(ctx, token, amount);
      }
    } else if (page === "swap" && inputType === "token") {
      // Swap custom token input
      if (!ctx.session.ui.swapData) {
        ctx.session.ui.swapData = {};
      }

      // If we don't have input token yet, this is input token
      if (!ctx.session.ui.swapData.inputMint) {
        ctx.session.ui.swapData.inputMint = input;
        await navigateToPage(ctx, "swap", { inputToken: input });
      }
      // If we have input but not output, this is output token
      else if (!ctx.session.ui.swapData.outputMint) {
        ctx.session.ui.swapData.outputMint = input;
        await navigateToPage(ctx, "swap", {
          inputToken: ctx.session.ui.swapData.inputMint,
          outputToken: input,
        });
      }
    } else if (page === "swap" && inputType === "amount") {
      // Swap custom amount input
      if (ctx.session.ui.swapData?.inputMint && ctx.session.ui.swapData?.outputMint) {
        const inputToken = ctx.session.ui.swapData.inputMint;
        const outputToken = ctx.session.ui.swapData.outputMint;
        const amount = parseFloat(input);

        if (isNaN(amount) || amount <= 0) {
          // Show error in same message
          const msgId = ctx.session.ui.messageId;
          if (msgId && ctx.chat) {
            await ctx.api.editMessageText(
              ctx.chat.id,
              msgId,
              `❌ *Invalid Amount*\n\nPlease enter a valid number.\n\nExample: 0.5 or 100`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[
                    { text: "🔄 Try Again", callback_data: `swap:amount:${inputToken}:${outputToken}:custom` },
                    { text: "« Back", callback_data: "nav:swap" }
                  ]]
                }
              }
            );
          }
          return;
        }

        // Execute swap (will check unlock inside)
        await executeSwapFromAmount(ctx, inputToken, outputToken, amount.toString());
      }
    }

    return;
  }

  // Not in a conversation flow, continue to next handler
  await next();
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Execute buy from amount (checks unlock status)
 */
async function executeBuyFromAmount(
  ctx: MyContext,
  token: string,
  solAmount: number
): Promise<void> {
  const msgId = ctx.session.ui.messageId;

  if (!msgId || !ctx.chat) {
    await ctx.reply("❌ An error occurred. Please use /start");
    return;
  }

  // Check if wallet is unlocked
  if (!ctx.session.encryptedKey) {
    // Wallet is locked - show unlock prompt
    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `🔒 *Wallet Locked*\n\n` +
      `To buy ${token} with ${solAmount} SOL, please unlock your wallet first.\n\n` +
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

  // Wallet is unlocked - execute buy
  await ctx.api.editMessageText(
    ctx.chat.id,
    msgId,
    `⏳ *Executing Buy*\n\n` +
    `Token: ${token}\n` +
    `Amount: ${solAmount} SOL\n\n` +
    `Processing transaction...`,
    { parse_mode: "Markdown" }
  );

  // TODO: Implement actual buy execution
  // For now just show success and return to main
  setTimeout(async () => {
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msgId,
        `✅ *Buy Executed* (Demo)\n\n` +
        `Token: ${token}\n` +
        `Amount: ${solAmount} SOL\n\n` +
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

/**
 * Execute sell from amount (checks unlock status)
 */
async function executeSellFromAmount(
  ctx: MyContext,
  token: string,
  amount: number
): Promise<void> {
  const msgId = ctx.session.ui.messageId;

  if (!msgId || !ctx.chat) {
    await ctx.reply("❌ An error occurred. Please use /start");
    return;
  }

  // Check if wallet is unlocked
  if (!ctx.session.encryptedKey) {
    // Wallet is locked - show unlock prompt
    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `🔒 *Wallet Locked*\n\n` +
      `To sell ${amount} ${token}, please unlock your wallet first.\n\n` +
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

  // Wallet is unlocked - execute sell
  await ctx.api.editMessageText(
    ctx.chat.id,
    msgId,
    `⏳ *Executing Sell*\n\n` +
    `Token: ${token}\n` +
    `Amount: ${amount} tokens\n\n` +
    `Processing transaction...`,
    { parse_mode: "Markdown" }
  );

  // TODO: Implement actual sell execution
  setTimeout(async () => {
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msgId,
        `✅ *Sell Executed* (Demo)\n\n` +
        `Token: ${token}\n` +
        `Amount: ${amount} tokens\n\n` +
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

/**
 * Execute swap from amount (checks unlock status)
 */
async function executeSwapFromAmount(
  ctx: MyContext,
  inputToken: string,
  outputToken: string,
  amount: string
): Promise<void> {
  const msgId = ctx.session.ui.messageId;

  if (!msgId || !ctx.chat) {
    await ctx.reply("❌ An error occurred. Please use /start");
    return;
  }

  // Check if wallet is unlocked
  if (!ctx.session.encryptedKey) {
    // Wallet is locked - show unlock prompt
    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `🔒 *Wallet Locked*\n\n` +
      `To swap ${amount} ${inputToken} → ${outputToken}, please unlock your wallet first.\n\n` +
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

  // Wallet is unlocked - execute swap
  await ctx.api.editMessageText(
    ctx.chat.id,
    msgId,
    `⏳ *Executing Swap*\n\n` +
    `📥 Input: ${amount} ${inputToken}\n` +
    `📤 Output: ${outputToken}\n\n` +
    `Processing transaction...`,
    { parse_mode: "Markdown" }
  );

  // TODO: Implement actual swap execution
  setTimeout(async () => {
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msgId,
        `✅ *Swap Executed* (Demo)\n\n` +
        `📥 Sent: ${amount} ${inputToken}\n` +
        `📤 Received: ~XXX ${outputToken}\n\n` +
        `_This is a demo. Real execution coming soon._\n\n` +
        `Returning to dashboard...`,
        { parse_mode: "Markdown" }
      );

      setTimeout(async () => {
        try {
          await navigateToPage(ctx, "main");
        } catch (error) {
          logger.error("Error navigating after swap", { error });
        }
      }, 2000);
    } catch (error) {
      logger.error("Error showing swap result", { error });
    }
  }, 1500);
}

// Error handler
bot.catch((err) => {
  logger.error("Bot error", { error: err });
});

logger.info("Bot initialized");
