/**
 * Telegram /buy command handler
 * User-friendly wrapper for buying tokens with SOL
 */

import type { Context as GrammyContext, SessionFlavor } from "grammy";
import { logger } from "../../utils/logger.js";
import { getTradingExecutor } from "../../services/trading/executor.js";
import { getHoneypotDetector } from "../../services/honeypot/detector.js";
import { asTokenMint } from "../../types/common.js";
import type { TradingError } from "../../types/trading.js";
import { prisma } from "../../utils/db.js";
import { resolveTokenSymbol, SOL_MINT, getNetworkName, isDevnetMode } from "../../config/tokens.js";
import { hasActivePassword, clearPasswordState } from "../utils/passwordState.js";

// Define session data structure (should match bot/index.ts)
interface SessionData {
  walletId?: string;
  encryptedKey?: string;
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
  // ✅ Redis Session Integration
  sessionToken?: string;
  sessionExpiresAt?: number;
  passwordExpiresAt?: number;
  awaitingPasswordForWallet?: boolean;
  awaitingPasswordForSwap?: {
    inputMint: string;
    outputMint: string;
    amount: string;
  };
  awaitingPasswordForBuy?: {
    tokenMint: string;
    solAmount: string;
  };
  awaitingPasswordForSell?: {
    tokenMint: string;
    tokenAmount: string;
  };
}

type Context = GrammyContext & SessionFlavor<SessionData>;

/**
 * Handle /buy command
 * Format: /buy <token> <sol_amount> [password]
 * Example: /buy BONK 0.1 mypassword
 */
export async function handleBuy(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    // Get user from database to get UUID
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
    });

    if (!user) {
      await ctx.reply("❌ User not found. Please use /start first.");
      return;
    }

    const userId = user.id; // Use UUID, not Telegram ID

    const text = ctx.message?.text;
    if (!text) {
      await ctx.reply("❌ No message text found");
      return;
    }

    // Parse command arguments
    const parts = text.split(" ").filter(Boolean);

    if (parts.length < 2) {
      await ctx.reply(
        `🛒 *Buy Tokens*\n\n` +
        `Buy any token with SOL\n\n` +
        `Usage: \`/buy <token> <sol_amount> [password]\`\n\n` +
        `Examples:\n` +
        `\`/buy BONK 0.1 mypassword\` - Buy with 0.1 SOL\n` +
        `\`/buy EPjF...t1v 1.5\` - Buy with 1.5 SOL (will ask password)\n\n` +
        `Supported tokens:\n` +
        `• Use symbol: BONK, WIF, USDC, etc.\n` +
        `• Or mint address: EPjF...t1v`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Parse arguments
    const [, tokenArg, solAmountArg, password] = parts;

    if (!tokenArg || !solAmountArg) {
      await ctx.reply("❌ Missing required arguments: token and sol_amount");
      return;
    }

    // Resolve token mint with validation
    const tokenMintResult = resolveTokenSymbol(tokenArg);
    if (!tokenMintResult.success) {
      await ctx.reply(`❌ Invalid token: ${tokenMintResult.error}`);
      return;
    }
    const tokenMint = tokenMintResult.value;

    // Parse SOL amount
    const solAmount = parseFloat(solAmountArg);
    if (isNaN(solAmount) || solAmount <= 0) {
      await ctx.reply("❌ Invalid SOL amount. Must be a positive number.");
      return;
    }

    // Convert SOL to lamports
    const lamports = Math.floor(solAmount * 1e9).toString();

    // Show network warning for devnet
    if (isDevnetMode()) {
      await ctx.reply(
        `⚠️ *Devnet Mode*\n\n` +
        `You are on *${getNetworkName()}* network.\n` +
        `Swaps may not work due to lack of liquidity pools.\n\n` +
        `To test real swaps, switch to mainnet in .env file.`,
        { parse_mode: "Markdown" }
      );
    }

    // Honeypot check before executing trade
    await ctx.reply("🔍 Analyzing token safety...");

    try {
      const detector = getHoneypotDetector();
      const honeypotCheck = await detector.check(tokenMint);

      if (!honeypotCheck.success) {
        await ctx.reply("⚠️ Could not verify token safety. Proceeding with caution...");
      } else {
        const analysis = honeypotCheck.value;

        // Format risk level
        let riskEmoji = "🟢";
        let riskLevel = "Low Risk";

        if (analysis.riskScore >= 70) {
          riskEmoji = "🔴";
          riskLevel = "High Risk";
        } else if (analysis.riskScore >= 30) {
          riskEmoji = "🟡";
          riskLevel = "Medium Risk";
        }

        await ctx.reply(
          `${riskEmoji} *Token Safety Analysis*\n\n` +
          `Risk Level: **${riskLevel}** (${analysis.riskScore}/100)\n` +
          `Confidence: ${analysis.confidence}%\n` +
          `Analysis Time: ${analysis.analysisTimeMs}ms\n\n` +
          (analysis.flags.length > 0
            ? `⚠️ Flags: ${analysis.flags.join(", ")}\n\n`
            : "") +
          (analysis.riskScore >= 70
            ? `❌ *TRADE CANCELLED*\n\nThis token appears to be a honeypot. Trading is blocked for your safety.`
            : `✅ Safety check passed. Proceeding with trade...`),
          { parse_mode: "Markdown" }
        );

        // Block high-risk trades
        if (analysis.riskScore >= 70) {
          logger.warn("Trade blocked: high risk token", {
            userId,
            tokenMint,
            riskScore: analysis.riskScore,
            flags: analysis.flags,
          });
          return;
        }
      }
    } catch (error) {
      logger.error("Honeypot check failed", { error, tokenMint });
      await ctx.reply("⚠️ Safety check unavailable. Please verify token manually before trading.");
    }

    // Execute buy (password is optional if session is active)
    await executeBuy(ctx, userId, tokenMint, lamports, solAmount, tokenArg, password);

  } catch (error) {
    logger.error("Error in buy command", { userId: ctx.from?.id, error });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}

/**
 * Execute the buy (SOL → Token swap)
 */
async function executeBuy(
  ctx: Context,
  userId: string,
  tokenMint: string,
  lamports: string,
  solAmount: number,
  tokenSymbol: string,
  password?: string
): Promise<void> {
  const messageId = ctx.message?.message_id;

  try {
    // Delete password message immediately
    if (messageId) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, messageId);
      } catch (error) {
        logger.warn("Failed to delete password message", { error });
      }
    }

    await ctx.reply(`⏳ Executing buy: ${solAmount} SOL → ${tokenSymbol}...`);

    // Get Trading Executor
    const executor = getTradingExecutor();

    // Validate mints
    let inputMint: ReturnType<typeof asTokenMint>;
    let outputMint: ReturnType<typeof asTokenMint>;

    try {
      inputMint = asTokenMint(SOL_MINT);
      outputMint = asTokenMint(tokenMint);
    } catch (error) {
      await ctx.reply(`❌ Invalid token address: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const sessionToken = ctx.session.sessionToken;
    const canUseSession = Boolean(
      sessionToken && hasActivePassword(ctx.session)
    );

    if (!canUseSession && !password) {
      await ctx.reply(
        `🔒 *Password Required*\n\n` +
        `No active session. Please either:\n\n` +
        `1. /unlock <password> - Unlock for 15 minutes\n` +
        `2. /buy ${tokenSymbol} ${solAmount} <password> - One-time trade`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Execute trade via Trading Executor
    const tradeResult = await executor.executeTrade(
      {
        userId,
        inputMint,
        outputMint,
        amount: lamports,
        slippageBps: 50, // 0.5% slippage
      },
      canUseSession ? undefined : password,
      canUseSession ? (sessionToken as any) : undefined
    );
    if (canUseSession) {
      clearPasswordState(ctx.session);
    }

    if (!tradeResult.success) {
      const error = tradeResult.error as TradingError;

      if (error.type === "WALLET_NOT_FOUND") {
        await ctx.reply("❌ Wallet not found. Create one with /createwallet");
        return;
      }

      if (error.type === "INVALID_PASSWORD") {
        if (canUseSession) {
          await ctx.reply(
            `🔒 *Session Expired*\n\n` +
            `Password cache expired or was already used.\n` +
            `Use /unlock to refresh access before trading.`,
            { parse_mode: "Markdown" }
          );
        } else {
          await ctx.reply(
            `🔒 *Password Required*\n\n` +
            `For security, password must be provided with the command:\n\n` +
            `\`/buy ${tokenSymbol} ${solAmount} yourpassword\``,
            { parse_mode: "Markdown" }
          );
        }
        return;
      }

      if (error.type === "SWAP_FAILED") {
        await ctx.reply(`❌ Buy failed: ${error.reason}`);
        return;
      }

      await ctx.reply(`❌ Trade execution failed: ${error.message}`);
      logger.error("Buy execution failed", { userId, tokenSymbol, error });
      return;
    }

    const result = tradeResult.value;

    // Success!
    await ctx.reply(
      `✅ *Buy Successful!*\n\n` +
      `Bought **${tokenSymbol}** with **${solAmount} SOL**\n\n` +
      `Transaction: \`${result.signature}\`\n` +
      `Slot: ${result.slot}\n\n` +
      `Input: ${formatAmount(result.inputAmount, 9)} SOL\n` +
      `Output: ${formatAmount(result.outputAmount, 9)} ${tokenSymbol}\n` +
      `Price Impact: ${result.priceImpactPct.toFixed(2)}%\n` +
      `Commission: $${result.commissionUsd.toFixed(4)}\n\n` +
      `[View on Solscan](https://solscan.io/tx/${result.signature})`,
      { parse_mode: "Markdown" }
    );

    logger.info("Buy completed successfully", {
      userId,
      tokenSymbol,
      tokenMint,
      orderId: result.orderId,
      signature: result.signature,
      inputAmount: result.inputAmount.toString(),
      outputAmount: result.outputAmount.toString(),
      commissionUsd: result.commissionUsd,
    });

  } catch (error) {
    logger.error("Error executing buy", { userId, tokenSymbol, error });
    await ctx.reply("❌ An unexpected error occurred. Please try again.");
  }
}

/**
 * Handle password input for buy
 */
export async function handleBuyPasswordInput(
  ctx: Context,
  password: string
): Promise<void> {
  // 🔐 DELETE PASSWORD MESSAGE IMMEDIATELY (CRITICAL-2 fix)
  const messageId = ctx.message?.message_id;
  if (messageId) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, messageId);
      logger.info("Password message deleted", { userId: ctx.from?.id });
    } catch (error) {
      logger.warn("Failed to delete password message", { error });
      // Fallback: warn user to delete manually
      await ctx.reply(
        "⚠️ Could not delete your password message. Please delete it manually for security."
      );
    }
  }

  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Get user from database to get UUID
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
  });

  if (!user) {
    await ctx.reply("❌ User not found. Please use /start first.");
    return;
  }

  const userId = user.id; // Use UUID, not Telegram ID

  const buyData = ctx.session.awaitingPasswordForBuy;
  if (!buyData) return;

  // Clear session
  ctx.session.awaitingPasswordForBuy = undefined;

  // Calculate SOL amount for display
  const solAmount = Number(buyData.solAmount) / 1e9;

  // Execute buy
  await executeBuy(
    ctx,
    userId,
    buyData.tokenMint,
    buyData.solAmount,
    solAmount,
    buyData.tokenMint.slice(0, 8) + "...", // Use truncated mint as symbol
    password
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format amount from smallest units to human-readable
 */
function formatAmount(amount: bigint, decimals: number): string {
  const num = Number(amount) / Math.pow(10, decimals);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}
