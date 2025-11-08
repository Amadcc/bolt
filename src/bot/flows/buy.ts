/**
 * Buy flow implementation
 * Shared between UI callbacks and text message handlers
 */

import type { Context } from "../views/index.js";
import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import { getTradingExecutor } from "../../services/trading/executor.js";
import { getHoneypotDetector } from "../../services/honeypot/detector.js";
import { asTokenMint } from "../../types/common.js";
import { resolveTokenSymbol, SOL_MINT, getTokenDecimals } from "../../config/tokens.js";
import type { TradingError } from "../../types/trading.js";

/**
 * Execute buy flow with honeypot check and real Jupiter execution
 */
export async function executeBuyFlow(
  ctx: Context,
  token: string,
  amount: string
): Promise<void> {
  logger.info("executeBuyFlow started", {
    token,
    amount,
    userId: ctx.from?.id,
    hasSessionToken: !!ctx.session.sessionToken,
    hasPassword: !!ctx.session.password,
  });

  // ✅ Redis Session Integration: Check if wallet is unlocked
  if (!ctx.session.sessionToken || !ctx.session.password) {
    logger.warn("Wallet locked, cannot execute buy", { token, amount, userId: ctx.from?.id });

    const msgId = ctx.session.ui.messageId;
    if (!msgId || !ctx.chat) {
      await ctx.reply("❌ Session expired. Please use /start");
      return;
    }

    // DON'T set returnToPageAfterUnlock when there's a pending command
    // The unlock handler will execute the pending command directly
    // Only set it if there's no pending command (manual UI navigation)
    if (!ctx.session.pendingCommand) {
      ctx.session.returnToPageAfterUnlock = "buy";
    }

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

    // Resolve token mint
    let tokenMint: string;
    try {
      tokenMint = resolveTokenSymbol(token);
    } catch (error) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        msgId,
        `❌ *Invalid Token*\n\n${error instanceof Error ? error.message : String(error)}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Back", callback_data: "nav:buy" }]]
          }
        }
      );
      return;
    }

    // Progress: Step 1 - Honeypot check
    await updateProgress(ctx, {
      step: 1,
      total: 3,
      message: `Token: ${token}\nAmount: ${amount} SOL`,
      status: "Analyzing token safety...",
    });

    // Honeypot check
    const detector = getHoneypotDetector();
    const honeypotCheck = await detector.check(tokenMint);

    if (honeypotCheck.success) {
      const analysis = honeypotCheck.value;

      // Block high-risk trades
      if (analysis.riskScore >= 70) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          msgId,
          `🔴 *High Risk Token Detected*\n\n` +
          `Token: ${token}\n` +
          `Risk Score: ${analysis.riskScore}/100\n\n` +
          `⚠️ Flags: ${analysis.flags.join(", ")}\n\n` +
          `❌ *TRADE CANCELLED*\n\n` +
          `This token appears to be a honeypot. Trading is blocked for your safety.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back", callback_data: "nav:buy" }]]
            }
          }
        );
        return;
      }
    }

    // Progress: Step 2 - Executing trade
    await updateProgress(ctx, {
      step: 2,
      total: 3,
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
      ctx.session.password!,
      ctx.session.sessionToken as any
    );

    // Progress: Step 3 - Completed
    if (tradeResult.success) {
      await updateProgress(ctx, {
        step: 3,
        total: 3,
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

