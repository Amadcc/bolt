import { Bot, session } from "grammy";
import { handlePasswordInput } from "./commands/createWallet.js";
// ✅ Redis Session Integration: Now using secure Redis sessions instead of in-memory
import {
  handleUnlock,
  handleLock,
  handleStatus,
  handleUnlockPasswordInput,
} from "./commands/session.js";
import { logger } from "../utils/logger.js";
import {
  navigateToPage,
  type Context as ViewContext,
  type SessionData,
} from "./views/index.js";
import {
  handleNavigationCallback,
  handleActionCallback,
  handleUnlockCallback,
  handleBuyCallback,
  handleSellCallback,
  handleSwapCallback,
  handleSettingsCallback,
  handleBalancePageCallback,
  executeSwapFlow,
  executeSellWithAbsoluteAmount,
  executeSellFlow,
} from "./handlers/callbacks.js";
import { executeBuyFlow } from "./flows/buy.js";
import { hasActivePassword } from "./utils/passwordState.js";
import {
  buildConversationKey,
  cancelConversationTimeout,
  CONVERSATION_TOPICS,
} from "./utils/conversationTimeouts.js";
import {
  getUserContext,
  invalidateUserContext,
} from "./utils/userContext.js";
import type { CachedUserContext } from "./utils/userContext.js";
import {
  handleSnipeActionCallback,
  handleSnipeAutomationPasswordInput,
} from "./handlers/snipe.js";
import { handleFees } from "./commands/fees.js";

type MyContext = ViewContext & {
  state: {
    userContext?: CachedUserContext;
  };
};

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
    await getUserContext(ctx).catch((error) => {
      logger.error("Failed to hydrate user context", {
        error,
        telegramId: ctx.from?.id,
      });
    });
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
  ctx.session.ui.messageId = undefined;

  const userContext = await getUserContext(ctx);
  const hasWallet = !!userContext.activeWallet;

  await navigateToPage(ctx, hasWallet ? "main" : "create_wallet");
});

/**
 * Single-page commands - all commands use navigateToPage
 */
bot.command("wallet", async (ctx) => {
  // Delete the command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete wallet command message", { error });
  }

  await navigateToPage(ctx, "wallet_info");
});

bot.command("createwallet", async (ctx) => {
  // Delete the command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete createwallet command message", { error });
  }

  await navigateToPage(ctx, "create_wallet");
});

bot.command("buy", async (ctx) => {
  // Delete the command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete buy command message", { error });
  }

  // Check if command has parameters: /buy BONK 0.01
  const params = ctx.message?.text?.split(" ").slice(1); // Remove /buy

  if (params && params.length >= 2) {
    // Execute buy directly with parameters
    const token = params[0];
    const amount = params[1];

    logger.info("Buy command with parameters", {
      token,
      amount,
      userId: ctx.from?.id,
    });

    // Save pending command (in case wallet is locked)
    ctx.session.pendingCommand = {
      type: "buy",
      params: [token, amount],
    };

    // Create UI message if needed
    if (!ctx.session.ui.messageId) {
      const msg = await ctx.reply("⏳ Processing buy...", {
        parse_mode: "Markdown",
      });
      ctx.session.ui.messageId = msg.message_id;
    }

    // Execute buy flow directly
    await executeBuyFlow(ctx, token, amount);

    // Clear pending command after execution (only if wallet is unlocked)
    // If wallet was locked, executeBuyFlow returned early and pending command should remain
    if (ctx.session.sessionToken && hasActivePassword(ctx.session)) {
      ctx.session.pendingCommand = undefined;
    }
  } else {
    // Navigate to buy page (single-page UI only)
    await navigateToPage(ctx, "buy");
  }
});

bot.command("sell", async (ctx) => {
  // Delete the command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete sell command message", { error });
  }

  // Check if command has parameters: /sell BONK 1000000
  const params = ctx.message?.text?.split(" ").slice(1); // Remove /sell

  if (params && params.length >= 2) {
    // Execute sell directly with parameters
    const token = params[0];
    const amount = params[1];

    logger.info("Sell command with parameters", {
      token,
      amount,
      userId: ctx.from?.id,
    });

    // Save pending command (in case wallet is locked)
    ctx.session.pendingCommand = {
      type: "sell",
      params: [token, amount],
    };

    // Create UI message if needed
    if (!ctx.session.ui.messageId) {
      const msg = await ctx.reply("⏳ Processing sell...", {
        parse_mode: "Markdown",
      });
      ctx.session.ui.messageId = msg.message_id;
    }

    // Execute sell flow directly
    await executeSellWithAbsoluteAmount(ctx, token, amount);

    // Clear pending command after execution (only if wallet is unlocked)
    // If wallet was locked, executeSellWithAbsoluteAmount returned early and pending command should remain
    if (ctx.session.sessionToken && hasActivePassword(ctx.session)) {
      ctx.session.pendingCommand = undefined;
    }
  } else {
    // Navigate to sell page (single-page UI only)
    await navigateToPage(ctx, "sell");
  }
});

bot.command("swap", async (ctx) => {
  // Delete the command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete swap command message", { error });
  }

  // Check if command has parameters: /swap SOL USDC 1
  const params = ctx.message?.text?.split(" ").slice(1); // Remove /swap

  if (params && params.length >= 3) {
    // Execute swap directly with parameters
    const inputToken = params[0];
    const outputToken = params[1];
    const amount = params[2];

    logger.info("Swap command with parameters", {
      inputToken,
      outputToken,
      amount,
      userId: ctx.from?.id,
    });

    // Save pending command (in case wallet is locked)
    ctx.session.pendingCommand = {
      type: "swap",
      params: [inputToken, outputToken, amount],
    };

    // Create UI message if needed (but don't navigate to swap page UI)
    if (!ctx.session.ui.messageId) {
      const msg = await ctx.reply("⏳ Processing swap...", {
        parse_mode: "Markdown",
      });
      ctx.session.ui.messageId = msg.message_id;
    }

    // Execute swap flow directly
    await executeSwapFlow(ctx, inputToken, outputToken, amount);

    // Clear pending command after execution (only if wallet is unlocked)
    // If wallet was locked, executeSwapFlow returned early and pending command should remain
    if (ctx.session.sessionToken && hasActivePassword(ctx.session)) {
      ctx.session.pendingCommand = undefined;
    }
  } else {
    // Navigate to swap page (single-page UI only)
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
  // Delete the command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete settings command message", { error });
  }

  await navigateToPage(ctx, "settings");
});

// ✅ Redis Session Integration: Secure Redis sessions (encrypted keys + password)
bot.command("unlock", handleUnlock);
bot.command("lock", handleLock);
bot.command("status", handleStatus);

bot.command("help", async (ctx) => {
  // Delete the command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete help command message", { error });
  }

  // Navigate to help page (single-page UI)
  await navigateToPage(ctx, "help");
});

bot.command("fees", handleFees);

bot.command("snipe", async (ctx) => {
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete snipe command message", { error });
  }
  await navigateToPage(ctx, "snipe");
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

    logger.debug("Callback query received", {
      data,
      action,
      params,
      userId: ctx.from?.id,
    });

    switch (action) {
      case "nav":
        // Navigation: nav:page_name
        await handleNavigationCallback(ctx, params[0]);
        break;

      case "action":
        // Actions: action:action_name:params
        await handleActionCallback(ctx, params[0], params.slice(1));
        break;

      case "unlock":
        // Unlock page actions: unlock:toggle_reuse
        await handleUnlockCallback(ctx, params[0]);
        break;

      case "buy":
        // Buy flow: buy:token:BONK or buy:amount:BONK:0.1
        logger.info("Routing to buy handler", { params });
        await handleBuyCallback(ctx, params[0], params.slice(1));
        break;

      case "sell":
        // Sell flow: sell:token:BONK or sell:amount:BONK:50
        logger.info("Routing to sell handler", { params });
        await handleSellCallback(ctx, params[0], params.slice(1));
        break;

      case "swap":
        // Swap flow: swap:input:SOL or swap:output:SOL:USDC or swap:amount:SOL:USDC:1
        logger.info("Routing to swap handler", { params });
        await handleSwapCallback(ctx, params[0], params.slice(1));
        break;

      case "settings":
        // Settings: settings:action
        await handleSettingsCallback(ctx, params[0]);
        break;

      case "balance":
        // Balance pagination: balance:page:N
        if (params[0] === "page") {
          await handleBalancePageCallback(ctx, parseInt(params[1], 10));
        } else {
          await ctx.answerCallbackQuery("❌ Unknown balance action");
        }
        break;

      case "snipe":
        await handleSnipeActionCallback(ctx, params[0], params.slice(1));
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
    cancelWalletPasswordTimeout(ctx);

    await handlePasswordInput(ctx, password);

    invalidateUserContext(ctx);

    const userContext = await getUserContext(ctx, { forceRefresh: true });

    if (userContext.activeWallet) {
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

  // ✅ Redis Session Integration: Handle password input for unlock
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
    cancelUnlockPasswordTimeout(ctx);

    // Handle unlock password input (creates Redis session)
    await handleUnlockPasswordInput(ctx, password);

    // Navigate back to page after unlock (only if successful)
    setTimeout(async () => {
      try {
        // Check if Redis session was successfully created
        if (ctx.session.sessionToken && hasActivePassword(ctx.session)) {
          // Return to saved page or default to main
          const returnPage = ctx.session.returnToPageAfterUnlock || "main";
          ctx.session.returnToPageAfterUnlock = undefined; // Clear saved page

          // Check if there's a pending command to execute
          const pendingCommand = ctx.session.pendingCommand;

          if (pendingCommand) {
            logger.info("Executing pending command after unlock", {
              command: pendingCommand,
            });

            // DON'T navigate - the execution functions will handle UI themselves
            // Execute the pending command directly
            if (
              pendingCommand.type === "buy" &&
              pendingCommand.params.length >= 2
            ) {
              const [token, amount] = pendingCommand.params;
              await executeBuyFlow(ctx, token, amount);
            } else if (
              pendingCommand.type === "sell" &&
              pendingCommand.params.length >= 2
            ) {
              const [token, amount] = pendingCommand.params;
              await executeSellWithAbsoluteAmount(ctx, token, amount);
            } else if (
              pendingCommand.type === "sell_pct" &&
              pendingCommand.params.length >= 2
            ) {
              const [token, percentage] = pendingCommand.params;
              await executeSellFlow(ctx, token, percentage);
            } else if (
              pendingCommand.type === "swap" &&
              pendingCommand.params.length >= 3
            ) {
              const [inputToken, outputToken, amount] = pendingCommand.params;
              await executeSwapFlow(ctx, inputToken, outputToken, amount);
            }

            // Clear pending command
            ctx.session.pendingCommand = undefined;
          } else {
            // No pending command, just navigate
            await navigateToPage(ctx, returnPage);
          }
        }
      } catch (error) {
        logger.error("Error navigating after unlock", { error });
      }
    }, 2000);

    return;
  }

  if (ctx.session.awaitingPasswordForSnipe) {
    const password = ctx.message?.text;
    if (!password) {
      return;
    }

    // Delete password message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn("Failed to delete automation password message", { error });
    }

    await handleSnipeAutomationPasswordInput(ctx, password);
    return;
  }

  // Check if we're waiting for custom input (token address, amount, etc)
  if (ctx.session.awaitingInput) {
    cancelAwaitingInputTimeout(ctx);
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
                  inline_keyboard: [
                    [
                      {
                        text: "🔄 Try Again",
                        callback_data: `buy:amount:${token}:custom`,
                      },
                      { text: "« Back", callback_data: "nav:buy" },
                    ],
                  ],
                },
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
                  inline_keyboard: [
                    [
                      {
                        text: "🔄 Try Again",
                        callback_data: `sell:amount:${token}:custom`,
                      },
                      { text: "« Back", callback_data: "nav:sell" },
                    ],
                  ],
                },
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
      if (
        ctx.session.ui.swapData?.inputMint &&
        ctx.session.ui.swapData?.outputMint
      ) {
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
                  inline_keyboard: [
                    [
                      {
                        text: "🔄 Try Again",
                        callback_data: `swap:amount:${inputToken}:${outputToken}:custom`,
                      },
                      { text: "« Back", callback_data: "nav:swap" },
                    ],
                  ],
                },
              }
            );
          }
          return;
        }

        // Execute swap (will check unlock inside)
        await executeSwapFromAmount(
          ctx,
          inputToken,
          outputToken,
          amount.toString()
        );
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
  // Convert to string and call the real buy flow
  await executeBuyFlow(ctx, token, solAmount.toString());
}

/**
 * Execute sell from amount (checks unlock status)
 */
async function executeSellFromAmount(
  ctx: MyContext,
  token: string,
  amount: number
): Promise<void> {
  // Use the real sell flow with absolute amount
  await executeSellWithAbsoluteAmount(ctx, token, amount.toString());
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
  // Use the real swap flow from callbacks
  await executeSwapFlow(ctx, inputToken, outputToken, amount);
}

function cancelWalletPasswordTimeout(ctx: MyContext): void {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const key = buildConversationKey(
    telegramId,
    CONVERSATION_TOPICS.walletPassword
  );
  cancelConversationTimeout(key);
}

function cancelUnlockPasswordTimeout(ctx: MyContext): void {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const key = buildConversationKey(
    telegramId,
    CONVERSATION_TOPICS.unlockPassword
  );
  cancelConversationTimeout(key);
}

function cancelAwaitingInputTimeout(ctx: MyContext): void {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const key = buildConversationKey(
    telegramId,
    CONVERSATION_TOPICS.awaitingInput
  );
  cancelConversationTimeout(key);
}

// Error handler
bot.catch((err) => {
  logger.error("Bot error", { error: err });
});

logger.info("Bot initialized");
