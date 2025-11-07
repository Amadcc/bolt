/**
 * Telegram /buy command handler
 * User-friendly wrapper for buying tokens with SOL
 */

import type { Context as GrammyContext, SessionFlavor } from "grammy";
import { logger } from "../../utils/logger.js";
import { getTradingExecutor } from "../../services/trading/executor.js";
import { getHoneypotDetector } from "../../services/honeypot/detector.js";
import { asTokenMint, solToLamports } from "../../types/common.js";
import type { TradingError } from "../../types/trading.js";
import { prisma } from "../../utils/db.js";
import { resolveTokenSymbol, SOL_MINT, getNetworkName, isDevnetMode } from "../../config/tokens.js";
// ✅ SECURITY (CRITICAL-4 Fix): Safe password deletion
import { securePasswordDelete } from "../utils/secureDelete.js";

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

    // Resolve token mint
    let tokenMint: string;
    try {
      tokenMint = resolveTokenSymbol(tokenArg);
    } catch (error) {
      await ctx.reply(`❌ Invalid token: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // Parse SOL amount
    const solAmount = parseFloat(solAmountArg);
    if (isNaN(solAmount) || solAmount <= 0) {
      await ctx.reply("❌ Invalid SOL amount. Must be a positive number.");
      return;
    }

    // MEDIUM-3: Convert SOL to lamports using precise BigNumber arithmetic
    const lamports = solToLamports(solAmount).toString();

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

    // MEDIUM-2: Optimized honeypot check (async, non-blocking)
    // - Whitelisted tokens: 0ms (skip check)
    // - Cached tokens: <10ms (Redis lookup)
    // - New tokens: show warning, check in background
    try {
      const detector = getHoneypotDetector();

      // Fast async check (returns immediately with cache/whitelist, or null)
      const analysis = await detector.checkAsync(tokenMint);

      if (analysis) {
        // We have cached result or whitelist match
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

        const isWhitelisted = detector.isWhitelisted(tokenMint);

        await ctx.reply(
          `${riskEmoji} *Token Safety* ${isWhitelisted ? "(Verified)" : ""}\n\n` +
          `Risk Level: **${riskLevel}** (${analysis.riskScore}/100)\n` +
          (analysis.analysisTimeMs > 0
            ? `Analysis Time: ${analysis.analysisTimeMs}ms\n`
            : "") +
          (analysis.flags.length > 0
            ? `⚠️ Flags: ${analysis.flags.join(", ")}\n\n`
            : "\n") +
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
      } else {
        // No cached result - new token
        // Background check triggered, but don't block trade
        await ctx.reply(
          `⚠️ *Unknown Token - Safety Check In Progress*\n\n` +
          `This token is not in our database yet. A safety analysis is running in the background.\n\n` +
          `**PROCEED WITH CAUTION** - Only trade if you've verified this token yourself.\n\n` +
          `✅ Trade will continue in 3 seconds...`,
          { parse_mode: "Markdown" }
        );

        // Small delay to let user read the warning
        await new Promise((resolve) => setTimeout(resolve, 3000));

        logger.warn("Trade proceeding with unverified token", {
          userId,
          tokenMint,
        });
      }
    } catch (error) {
      logger.error("Honeypot check failed", { error, tokenMint });
      await ctx.reply(
        "⚠️ *Safety Check Unavailable*\n\n" +
        "Could not verify token safety. Please verify manually before trading.\n\n" +
        "Trade will continue in 5 seconds...",
        { parse_mode: "Markdown" }
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
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
    // Delete command message (not password - session-based auth)
    if (messageId) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, messageId);
      } catch (error) {
        logger.debug("Failed to delete command message", { error });
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

    // ✅ SECURITY (CRITICAL-2 Fix - Variant C+): Password NOT stored in session!
    // Session token is enough - password only for unlocking
    const sessionToken = ctx.session.sessionToken;

    if (!sessionToken) {
      await ctx.reply(
        `🔒 *Wallet Locked*\n\n` +
        `Please unlock your wallet first:\n\n` +
        `/unlock <password> - Unlock for 15 minutes\n\n` +
        `Then you can trade without entering password again!`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Execute trade via Trading Executor
    // ✅ No password needed - session token is enough!
    const tradeResult = await executor.executeTrade(
      {
        userId,
        inputMint,
        outputMint,
        amount: lamports,
        slippageBps: 50, // 0.5% slippage
      },
      undefined, // No password needed with session
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
          `Usage: \`/buy ${tokenSymbol} ${solAmount} yourpassword\``,
          { parse_mode: "Markdown" }
        );
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
