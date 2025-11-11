/**
 * Buy flow implementation
 * Shared between UI callbacks and text message handlers
 */

import type { Context } from "../views/index.js";
import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import { getTradingExecutor } from "../../services/trading/executor.js";
import { asTokenMint } from "../../types/common.js";
import { resolveTokenSymbol, SOL_MINT, getTokenDecimals } from "../../config/tokens.js";
import type { TradingError } from "../../types/trading.js";
import { hasActivePassword, clearPasswordState } from "../utils/passwordState.js";
import { performHoneypotAnalysis } from "../utils/honeypot.js";

/**
 * Execute buy flow with honeypot check and real Jupiter execution
 * ✅ Auto-approve support: Skip confirmation when enabled
 */
export async function executeBuyFlow(
  ctx: Context,
  token: string,
  amount: string,
  skipConfirmation = false
): Promise<void> {
  logger.info("executeBuyFlow started", {
    token,
    amount,
    userId: ctx.from?.id,
    hasSessionToken: !!ctx.session.sessionToken,
    hasPassword: hasActivePassword(ctx.session),
    autoApprove: ctx.session.settings?.autoApprove,
    skipConfirmation,
  });

  // ✅ Redis Session Integration: Check if wallet is unlocked
  if (!ctx.session.sessionToken || !hasActivePassword(ctx.session)) {
    logger.warn("Wallet locked, cannot execute buy", { token, amount, userId: ctx.from?.id });

    const msgId = ctx.session.ui.messageId;
    if (!msgId || !ctx.chat) {
      await ctx.reply("❌ Session expired. Please use /start");
      return;
    }

    // Save pending command so unlock handler can execute it
    ctx.session.pendingCommand = {
      type: "buy",
      params: [token, amount],
    };

    logger.info("Saved pending buy command", { token, amount, userId: ctx.from?.id });

    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `🔒 *Wallet Locked*\n\n` +
        `To buy ${token} with ${amount} SOL, please unlock your wallet first.\n\n` +
        `Your session will be active for 15 minutes.`,
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

  logger.info("Buy flow: wallet is unlocked, proceeding", { token, amount });

  const msgId = ctx.session.ui.messageId;
  if (!msgId || !ctx.chat) {
    await ctx.reply("❌ Session expired. Please use /start");
    return;
  }

  try {
    // Get user with wallets
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from!.id) },
      include: { wallets: { where: { isActive: true } } },
    });

    if (!user || !user.wallets.length) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        "❌ Wallet not found. Please create one first.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 Home", callback_data: "nav:main" }]]
          }
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
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:buy" }]]
          }
        }
      );
      return;
    }
    const tokenMint = tokenMintResult.value;

    // Progress: Step 1 - Honeypot check
    await updateProgress(ctx, {
      step: 1,
      total: skipConfirmation ? 3 : 4,
      message: `Token: ${token}\nAmount: ${amount} SOL`,
      status: "Analyzing token safety...",
    });

    let honeypotAnalysis;
    try {
      honeypotAnalysis = await performHoneypotAnalysis(tokenMint);
    } catch (error) {
      logger.error("Honeypot check unavailable, blocking trade", {
        token,
        error,
      });
      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `⚠️ *Safety Check Unavailable*\n\n` +
          `Could not verify ${token}. Trade cancelled. Please try again later.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:buy" }]],
          },
        }
      );
      return;
    }

    if (honeypotAnalysis.riskScore >= 70) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `🔴 *High Risk Token Detected*\n\n` +
          `Token: ${token}\n` +
          `Risk Score: ${honeypotAnalysis.riskScore}/100\n\n` +
          `⚠️ Flags: ${honeypotAnalysis.flags.join(", ")}\n\n` +
          `❌ *TRADE CANCELLED*\n\n` +
          `This token appears to be a honeypot. Trading is blocked for your safety.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:buy" }]],
          },
        }
      );
      return;
    }

    // ✅ Auto-approve check: Show confirmation if disabled
    const autoApprove = ctx.session.settings?.autoApprove ?? false;

    if (!autoApprove && !skipConfirmation) {
      // Progress: Step 2 - Getting quote
      await updateProgress(ctx, {
        step: 2,
        total: 4,
        message: `Token: ${token}\nAmount: ${amount} SOL`,
        status: "Getting quote...",
      });

      // Get quote from Jupiter
      const solAmount = parseFloat(amount);
      const lamports = Math.floor(solAmount * 1e9).toString();

      const inputMint = asTokenMint(SOL_MINT);
      const outputMint = asTokenMint(tokenMint);

      // Ensure wallet exists before getting quote
      if (!user.wallets || !user.wallets[0] || !user.wallets[0].publicKey) {
        logger.error("Cannot get quote: wallet not found", { userId: user.id });
        await ctx.api.editMessageText(
          ctx.chat.id,
          msgId,
          `❌ *Wallet Error*\\n\\nNo active wallet found. Please create one first.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "nav:buy" }]]
            }
          }
        );
        return;
      }

      logger.info("Getting quote for buy confirmation", {
        token,
        amount,
        userPublicKey: user.wallets[0].publicKey
      });

      const executor = getTradingExecutor();
      const quoteResult = await executor.getQuote({
        inputMint,
        outputMint,
        amount: lamports,
        slippageBps: 50,
        userPublicKey: user.wallets[0].publicKey,
      });

      if (!quoteResult.success) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          msgId,
          `❌ *Quote Failed*\n\nCouldn't get price quote. Please try again.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: "🔄 Try Again", callback_data: `buy:amount:${token}:${amount}` },
                { text: "« Back", callback_data: "nav:buy" }
              ]]
            }
          }
        );
        return;
      }

      const quote = quoteResult.value;
      const outputDecimals = getTokenDecimals(tokenMint);
      const estimatedOutput = Number(quote.outAmount) / Math.pow(10, outputDecimals);
      // Use priceImpact (number, 0-1 range) instead of deprecated priceImpactPct (string)
      const priceImpact = (quote.priceImpact || 0) * 100; // Convert to percentage

      // Show confirmation with quote
      logger.info("Showing confirmation (auto-approve disabled)", {
        token,
        amount,
        estimatedOutput,
        priceImpact
      });

      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `🛒 *Confirm Buy*\n\n` +
        `Token: **${token}**\n` +
        `Spending: **${amount} SOL**\n\n` +
        `━━━\n\n` +
        `📊 *Quote Preview*\n\n` +
        `You'll receive: ~**${estimatedOutput.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6
        })} ${token}**\n` +
        `Price Impact: **${priceImpact.toFixed(2)}%**\n` +
        `Slippage Tolerance: **0.5%**\n\n` +
        `━━━\n\n` +
        `⚠️ Confirm to execute this trade`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Confirm Buy", callback_data: `buy:confirm:${token}:${amount}` },
              ],
              [
                { text: "« Cancel", callback_data: "nav:buy" },
              ],
            ],
          },
        }
      );
      return;
    }

    // Auto-approve enabled or confirmation skipped - execute immediately
    logger.info("Executing buy immediately (auto-approve enabled or confirmed)", { token, amount });

    // Progress: Step 2 - Executing trade
    await updateProgress(ctx, {
      step: skipConfirmation ? 2 : 3,
      total: skipConfirmation ? 3 : 4,
      message: `Token: ${token}\nAmount: ${amount} SOL`,
      status: "Executing swap...",
    });

    // Execute trade
    const solAmount = parseFloat(amount);
    const lamports = Math.floor(solAmount * 1e9).toString();

    const inputMint = asTokenMint(SOL_MINT);
    const outputMint = asTokenMint(tokenMint);

    const executor = getTradingExecutor();
    const tradeResult = await executor.executeTrade(
      {
        userId: user.id,
        inputMint,
        outputMint,
        amount: lamports,
        slippageBps: 50, // 0.5% slippage
      },
      undefined,
      ctx.session.sessionToken as any
    );
    clearPasswordState(ctx.session);

    // Progress: Step 3 - Completed
    if (tradeResult.success) {
      await updateProgress(ctx, {
        step: skipConfirmation ? 3 : 4,
        total: skipConfirmation ? 3 : 4,
        message: `Token: ${token}\nAmount: ${amount} SOL`,
        status: "Confirmed!",
      });
    }

    if (!tradeResult.success) {
      const error = tradeResult.error as TradingError;

      let errorMessage = "Trade execution failed";
      let buttons = [[
        { text: "🔄 Try Again", callback_data: `buy:amount:${token}:${amount}` },
        { text: "« Back", callback_data: "nav:buy" }
      ]];

      if (error.type === "WALLET_NOT_FOUND") {
        errorMessage = "Wallet not found. Create one with /createwallet";
      } else if (error.type === "INVALID_PASSWORD") {
        errorMessage = "Session expired. Please unlock again.";
      } else if (error.type === "SWAP_FAILED") {
        // Check if it's insufficient funds
        if (error.reason?.includes("Insufficient funds")) {
          errorMessage =
            `💰 *Insufficient SOL Balance*\n\n` +
            `You need at least **${amount} SOL** to buy ${token}.\n\n` +
            `📊 Check your balance: /balance\n\n` +
            `💎 *Fund your wallet:*\n` +
            `Send SOL to:\n` +
            `\`${user.wallets[0].publicKey}\``;

          buttons = [[
            { text: "📊 Check Balance", callback_data: "nav:balance" },
            { text: "« Back", callback_data: "nav:buy" }
          ]];
        } else {
          errorMessage = `Swap failed: ${error.reason}`;
        }
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `❌ *Buy Failed*\n\n${errorMessage}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: buttons
          }
        }
      );
      return;
    }

    const result = tradeResult.value;

    // Show completion progress for a moment
    await new Promise(resolve => setTimeout(resolve, 800));

    // Success!
    await ctx.api.editMessageText(
      ctx.chat.id,
      msgId,
      `✅ *Buy Successful!*\n\n` +
      `Bought **${token}** with **${solAmount} SOL**\n\n` +
      `Transaction: \`${result.signature}\`\n` +
      `Slot: ${result.slot}\n\n` +
      `Input: ${formatTokenAmount(result.inputAmount, 9)} SOL\n` +
      `Output: ${formatTokenAmount(result.outputAmount, getTokenDecimals(tokenMint))} ${token}\n` +
      `Price Impact: ${result.priceImpactPct.toFixed(2)}%\n` +
      `Commission: $${result.commissionUsd.toFixed(4)}\n\n` +
      `[View on Solscan](https://solscan.io/tx/${result.signature})`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Swap", callback_data: "nav:swap" },
              { text: "💸 Sell", callback_data: "nav:sell" },
            ],
            [
              { text: "🛒 Buy Again", callback_data: "nav:buy" },
            ],
            [
              { text: "🏠 Dashboard", callback_data: "nav:main" },
            ],
          ],
        },
      }
    );

  } catch (error) {
    logger.error("Error executing buy", { error, token, amount });

    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `❌ *Unexpected Error*\n\nPlease try again or contact support.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:buy" }]]
          }
        }
      );
    } catch (editError) {
      // If edit fails, send new message
      await ctx.reply("❌ An error occurred. Please use /start");
    }
  }
}

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
 * Update progress bar in message
 */
async function updateProgress(
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
    logger.warn("Cannot update progress: no messageId", { step });
    return;
  }

  // Create progress bar
  const percentage = Math.floor((step / total) * 100);
  const filled = Math.floor((step / total) * 10);
  const empty = 10 - filled;

  const progressBar = "▓".repeat(filled) + "░".repeat(empty);

  const text =
    `*Processing Buy*\n\n` +
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
      logger.warn("Failed to update progress", { error, step });
    }
  }
}
