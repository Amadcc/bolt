/**
 * Telegram /swap command handler
 * Allows users to swap tokens using Jupiter
 */

import type { Context as GrammyContext, SessionFlavor } from "grammy";
import { logger } from "../../utils/logger.js";
import { getTradingExecutor } from "../../services/trading/executor.js";
import { asTokenMint } from "../../types/common.js";
import type { TradingError } from "../../types/trading.js";
import { prisma } from "../../utils/db.js";
import { resolveTokenSymbol, getTokenDecimals, toMinimalUnits } from "../../config/tokens.js";

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
  password?: string;
  sessionExpiresAt?: number;
  awaitingPasswordForWallet?: boolean;
  awaitingPasswordForSwap?: {
    inputMint: string;
    outputMint: string;
    amount: string;
  };
  swapConversationStep?: "inputMint" | "outputMint" | "amount" | "password";
  swapConversationData?: {
    inputMint?: string;
    outputMint?: string;
    amount?: string;
  };
}

type Context = GrammyContext & SessionFlavor<SessionData>;

/**
 * Handle /swap command
 * Format: /swap <inputMint> <outputMint> <amount> <password>
 * Example: /swap So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 10000000 mypassword
 */
export async function handleSwap(ctx: Context): Promise<void> {
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
        `🔄 *Swap Tokens*\n\n` +
        `Usage: \`/swap <inputMint> <outputMint> <amount> [password]\`\n\n` +
        `Example:\n` +
        `\`/swap SOL USDC 0.1 mypassword\`\n\n` +
        `Or start conversation mode:\n` +
        `/swap`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Check if user wants conversation mode (just /swap with no args)
    if (parts.length === 1) {
      await startSwapConversation(ctx, userId);
      return;
    }

    // Parse arguments
    const [, inputMintArg, outputMintArg, amountArg, password] = parts;

    if (!inputMintArg || !outputMintArg || !amountArg) {
      await ctx.reply("❌ Missing required arguments: inputMint, outputMint, amount");
      return;
    }

    // Parse token mints (support common symbols)
    let inputMint: string;
    let outputMint: string;

    try {
      inputMint = resolveTokenSymbol(inputMintArg);
      outputMint = resolveTokenSymbol(outputMintArg);
    } catch (error) {
      await ctx.reply(`❌ Invalid token: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // Parse amount and convert to minimal units
    const amountFloat = parseFloat(amountArg);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      await ctx.reply("❌ Invalid amount format");
      return;
    }

    // Get decimals for input token and convert to minimal units
    const decimals = getTokenDecimals(inputMint);
    const amount = toMinimalUnits(amountFloat, decimals);

    logger.info("Swap amount conversion", {
      userId,
      inputMint,
      inputMintArg,
      humanReadableAmount: amountFloat,
      decimals,
      minimalUnits: amount,
    });

    // Execute swap (password is optional if session is active)
    await executeSwap(ctx, userId, inputMint, outputMint, amount, password);

  } catch (error) {
    logger.error("Error in swap command", { userId: ctx.from?.id, error });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}

/**
 * Start conversation mode for swap
 */
async function startSwapConversation(ctx: Context, userId: string): Promise<void> {
  ctx.session.swapConversationStep = "inputMint";

  await ctx.reply(
    "🔄 *Let's set up your swap*\n\n" +
    "Step 1/4: What token do you want to swap FROM?\n\n" +
    "Send token symbol (e.g., SOL, USDC) or mint address.",
    { parse_mode: "Markdown" }
  );
}

/**
 * Execute the swap
 */
async function executeSwap(
  ctx: Context,
  userId: string,
  inputMint: string,
  outputMint: string,
  amount: string,
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

    await ctx.reply("⏳ Executing swap...");

    // Get Trading Executor
    const executor = getTradingExecutor();

    // Validate and create mints
    let inputMintValidated: ReturnType<typeof asTokenMint>;
    let outputMintValidated: ReturnType<typeof asTokenMint>;

    try {
      inputMintValidated = asTokenMint(inputMint);
      outputMintValidated = asTokenMint(outputMint);
    } catch (error) {
      await ctx.reply(`❌ Invalid token address: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // ✅ Redis Session Integration: Get password and sessionToken from context
    const sessionPassword = ctx.session.password || password;
    const sessionToken = ctx.session.sessionToken;

    if (!sessionPassword) {
      await ctx.reply(
        `🔒 *Password Required*\n\n` +
        `No active session. Please either:\n\n` +
        `1. /unlock <password> - Unlock for 15 minutes\n` +
        `2. /swap <from> <to> <amount> <password> - One-time trade`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Execute trade via Trading Executor
    const tradeResult = await executor.executeTrade(
      {
        userId,
        inputMint: inputMintValidated,
        outputMint: outputMintValidated,
        amount,
        slippageBps: 50, // 0.5% slippage
      },
      sessionPassword,
      sessionToken as any
    );

    if (!tradeResult.success) {
      const error = tradeResult.error as TradingError;

      if (error.type === "WALLET_NOT_FOUND") {
        await ctx.reply("❌ Wallet not found. Create one with /createwallet");
        return;
      }

      if (error.type === "INVALID_PASSWORD") {
        // ✅ SECURITY (CRITICAL-2 Fix): Password now required for every trade
        await ctx.reply(
          `🔒 *Password Required*\n\n` +
          `For security, password is required for every trade.\n\n` +
          `Usage: \`/swap <from> <to> <amount> yourpassword\``,
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (error.type === "SWAP_FAILED") {
        await ctx.reply(`❌ Swap failed: ${error.reason}`);
        return;
      }

      await ctx.reply(`❌ Trade execution failed: ${error.message}`);
      logger.error("Swap execution failed", { userId, error });
      return;
    }

    const result = tradeResult.value;

    // Success!
    await ctx.reply(
      `✅ *Swap Successful!*\n\n` +
      `Transaction: \`${result.signature}\`\n` +
      `Slot: ${result.slot}\n\n` +
      `Input: ${formatAmount(result.inputAmount, 9)}\n` +
      `Output: ${formatAmount(result.outputAmount, 9)}\n` +
      `Price Impact: ${result.priceImpactPct.toFixed(2)}%\n` +
      `Commission: $${result.commissionUsd.toFixed(4)}\n\n` +
      `[View on Solscan](https://solscan.io/tx/${result.signature})`,
      { parse_mode: "Markdown" }
    );

    logger.info("Swap completed successfully", {
      userId,
      orderId: result.orderId,
      signature: result.signature,
      inputAmount: result.inputAmount.toString(),
      outputAmount: result.outputAmount.toString(),
      commissionUsd: result.commissionUsd,
    });

  } catch (error) {
    logger.error("Error executing swap", { userId, error });
    await ctx.reply("❌ An unexpected error occurred. Please try again.");
  }
}

/**
 * Handle password input for swap
 */
export async function handleSwapPasswordInput(
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

  const swapData = ctx.session.awaitingPasswordForSwap;
  if (!swapData) return;

  // Clear session
  ctx.session.awaitingPasswordForSwap = undefined;

  // Execute swap
  await executeSwap(
    ctx,
    userId,
    swapData.inputMint,
    swapData.outputMint,
    swapData.amount,
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
