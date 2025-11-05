/**
 * Telegram /sell command handler
 * User-friendly wrapper for selling tokens to SOL
 */

import type { Context as GrammyContext, SessionFlavor } from "grammy";
import { logger } from "../../utils/logger.js";
import { getTradingExecutor } from "../../services/trading/executor.js";
import { asTokenMint } from "../../types/common.js";
import type { TradingError } from "../../types/trading.js";

// Define session data structure (should match bot/index.ts)
interface SessionData {
  walletId?: string;
  encryptedKey?: string;
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
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

// SOL mint address
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Handle /sell command
 * Format: /sell <token> <amount_or_percentage> [password]
 * Example: /sell BONK 1000000 mypassword
 *          /sell BONK 50% mypassword
 *          /sell BONK all mypassword
 */
export async function handleSell(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    const text = ctx.message?.text;
    if (!text) {
      await ctx.reply("❌ No message text found");
      return;
    }

    // Parse command arguments
    const parts = text.split(" ").filter(Boolean);

    if (parts.length < 2) {
      await ctx.reply(
        `💰 *Sell Tokens*\n\n` +
        `Sell any token for SOL\n\n` +
        `Usage: \`/sell <token> <amount> [password]\`\n\n` +
        `Examples:\n` +
        `\`/sell BONK 1000000 mypassword\` - Sell 1M tokens\n` +
        `\`/sell BONK 50%\` - Sell 50% of holdings\n` +
        `\`/sell BONK all\` - Sell all holdings\n` +
        `\`/sell EPjF...t1v 100\` - Sell by mint address\n\n` +
        `Supported tokens:\n` +
        `• Use symbol: BONK, WIF, USDC, etc.\n` +
        `• Or mint address: EPjF...t1v\n\n` +
        `Amount formats:\n` +
        `• Number: \`1000000\`\n` +
        `• Percentage: \`50%\`\n` +
        `• All: \`all\` or \`100%\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Parse arguments
    const [, tokenArg, amountArg, password] = parts;

    if (!tokenArg || !amountArg) {
      await ctx.reply("❌ Missing required arguments: token and amount");
      return;
    }

    // Resolve token mint
    let tokenMint: string;
    try {
      tokenMint = resolveTokenSymbol(tokenArg);
    } catch (error) {
      await ctx.reply(`❌ Invalid token: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // Parse amount (percentage or absolute)
    const amountInfo = parseAmount(amountArg);
    if (!amountInfo) {
      await ctx.reply(
        "❌ Invalid amount format. Use:\n" +
        "• Number: `1000000`\n" +
        "• Percentage: `50%`\n" +
        "• All: `all` or `100%`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // If percentage or "all", we need to fetch balance first
    if (amountInfo.type === "percentage") {
      await ctx.reply(
        `⚠️ Percentage/all selling not yet implemented.\n\n` +
        `Please specify exact amount in tokens.\n` +
        `Example: \`/sell ${tokenArg} 1000000\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Execute sell (password is optional if session is active)
    await executeSell(ctx, userId, tokenMint, amountInfo.value, tokenArg, password);

  } catch (error) {
    logger.error("Error in sell command", { userId: ctx.from?.id, error });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}

/**
 * Execute the sell (Token → SOL swap)
 */
async function executeSell(
  ctx: Context,
  userId: string,
  tokenMint: string,
  tokenAmount: string,
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

    await ctx.reply(`⏳ Executing sell: ${tokenSymbol} → SOL...`);

    // Get Trading Executor
    const executor = getTradingExecutor();

    // Validate mints
    let inputMint: ReturnType<typeof asTokenMint>;
    let outputMint: ReturnType<typeof asTokenMint>;

    try {
      inputMint = asTokenMint(tokenMint);
      outputMint = asTokenMint(SOL_MINT);
    } catch (error) {
      await ctx.reply(`❌ Invalid token address: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // Execute trade via Trading Executor
    const tradeResult = await executor.executeTrade(
      {
        userId,
        inputMint,
        outputMint,
        amount: tokenAmount,
        slippageBps: 50, // 0.5% slippage
      },
      password
    );

    if (!tradeResult.success) {
      const error = tradeResult.error as TradingError;

      if (error.type === "WALLET_NOT_FOUND") {
        await ctx.reply("❌ Wallet not found. Create one with /createwallet");
        return;
      }

      if (error.type === "INVALID_PASSWORD") {
        // Check if it's a session error
        if (error.message.includes("No active session")) {
          await ctx.reply(
            `🔒 *No Active Session*\n\n` +
            `Your wallet is locked. Please use one of:\n\n` +
            `1. /unlock - Unlock for 30 minutes\n` +
            `2. /sell ${tokenSymbol} ${tokenAmount} password - One-time unlock`,
            { parse_mode: "Markdown" }
          );
        } else {
          await ctx.reply("❌ Invalid password. Please try again.");
        }
        return;
      }

      if (error.type === "SWAP_FAILED") {
        await ctx.reply(`❌ Sell failed: ${error.reason}`);
        return;
      }

      await ctx.reply(`❌ Trade execution failed: ${error.message}`);
      logger.error("Sell execution failed", { userId, tokenSymbol, error });
      return;
    }

    const result = tradeResult.value;

    // Calculate SOL received
    const solReceived = Number(result.outputAmount) / 1e9;

    // Success!
    await ctx.reply(
      `✅ *Sell Successful!*\n\n` +
      `Sold **${tokenSymbol}** for **${solReceived.toFixed(4)} SOL**\n\n` +
      `Transaction: \`${result.signature}\`\n` +
      `Slot: ${result.slot}\n\n` +
      `Input: ${formatAmount(result.inputAmount, 9)} ${tokenSymbol}\n` +
      `Output: ${solReceived.toFixed(4)} SOL\n` +
      `Price Impact: ${result.priceImpactPct.toFixed(2)}%\n` +
      `Commission: $${result.commissionUsd.toFixed(4)}\n\n` +
      `[View on Solscan](https://solscan.io/tx/${result.signature})`,
      { parse_mode: "Markdown" }
    );

    logger.info("Sell completed successfully", {
      userId,
      tokenSymbol,
      tokenMint,
      orderId: result.orderId,
      signature: result.signature,
      inputAmount: result.inputAmount.toString(),
      outputAmount: result.outputAmount.toString(),
      solReceived,
      commissionUsd: result.commissionUsd,
    });

  } catch (error) {
    logger.error("Error executing sell", { userId, tokenSymbol, error });
    await ctx.reply("❌ An unexpected error occurred. Please try again.");
  }
}

/**
 * Handle password input for sell
 */
export async function handleSellPasswordInput(
  ctx: Context,
  password: string
): Promise<void> {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  const sellData = ctx.session.awaitingPasswordForSell;
  if (!sellData) return;

  // Clear session
  ctx.session.awaitingPasswordForSell = undefined;

  // Execute sell
  await executeSell(
    ctx,
    userId,
    sellData.tokenMint,
    sellData.tokenAmount,
    sellData.tokenMint.slice(0, 8) + "...", // Use truncated mint as symbol
    password
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve token symbol to mint address
 */
function resolveTokenSymbol(symbol: string): string {
  const KNOWN_TOKENS: Record<string, string> = {
    SOL: "So11111111111111111111111111111111111111112",
    WSOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  };

  const upper = symbol.toUpperCase();

  // If it's a known symbol, return its mint
  if (KNOWN_TOKENS[upper]) {
    return KNOWN_TOKENS[upper];
  }

  // Otherwise assume it's already a mint address
  if (symbol.length >= 32) {
    return symbol;
  }

  throw new Error(`Unknown token symbol: ${symbol}. Use mint address instead.`);
}

/**
 * Parse amount string (supports percentage and "all")
 */
function parseAmount(
  amountStr: string
): { type: "absolute" | "percentage"; value: string } | null {
  try {
    const lower = amountStr.toLowerCase().trim();

    // Handle "all"
    if (lower === "all") {
      return { type: "percentage", value: "100" };
    }

    // Handle percentage (50%, 25%, etc)
    if (lower.endsWith("%")) {
      const percentage = parseFloat(lower.slice(0, -1));
      if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
        return null;
      }
      return { type: "percentage", value: percentage.toString() };
    }

    // Handle absolute amount
    const amount = parseFloat(lower);
    if (isNaN(amount) || amount <= 0) {
      return null;
    }

    // For absolute amounts, keep as string (might be very large)
    return { type: "absolute", value: amountStr };
  } catch {
    return null;
  }
}

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
