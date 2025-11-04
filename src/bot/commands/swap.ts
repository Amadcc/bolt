/**
 * Telegram /swap command handler
 * Allows users to swap tokens using Jupiter
 */

import type { Context as GrammyContext, SessionFlavor } from "grammy";
import { logger } from "../../utils/logger.js";

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
  swapConversationStep?: "inputMint" | "outputMint" | "amount" | "password";
  swapConversationData?: {
    inputMint?: string;
    outputMint?: string;
    amount?: string;
  };
}

type Context = GrammyContext & SessionFlavor<SessionData>;
import { unlockWallet, clearKeypair } from "../../services/wallet/keyManager.js";
import { getJupiter } from "../../services/trading/jupiter.js";
import { asTokenMint } from "../../types/common.js";
import type { WalletError } from "../../types/solana.js";
import type { JupiterError } from "../../types/jupiter.js";

/**
 * Handle /swap command
 * Format: /swap <inputMint> <outputMint> <amount> <password>
 * Example: /swap So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 10000000 mypassword
 */
export async function handleSwap(ctx: Context): Promise<void> {
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

    // Parse amount
    const amount = parseAmount(amountArg, inputMintArg);
    if (!amount) {
      await ctx.reply("❌ Invalid amount format");
      return;
    }

    // If no password provided, ask for it
    if (!password) {
      ctx.session.awaitingPasswordForSwap = {
        inputMint,
        outputMint,
        amount,
      };
      await ctx.reply(
        "🔐 Please send your password to authorize this swap.\n\n" +
        "_Your password will be deleted immediately after use._",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Execute swap with password
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
  password: string
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

    await ctx.reply("⏳ Unlocking wallet...");

    // Unlock wallet
    const unlockResult = await unlockWallet({ userId, password });

    if (!unlockResult.success) {
      const error = unlockResult.error as WalletError;

      if (error.type === "WALLET_NOT_FOUND") {
        await ctx.reply("❌ Wallet not found. Create one with /createwallet");
        return;
      }

      if (error.type === "INVALID_PASSWORD") {
        await ctx.reply("❌ Invalid password. Please try again.");
        return;
      }

      await ctx.reply("❌ Failed to unlock wallet. Please try again.");
      logger.error("Failed to unlock wallet for swap", { userId, error });
      return;
    }

    const { keypair, publicKey } = unlockResult.value;

    await ctx.reply("⏳ Getting swap quote from Jupiter...");

    // Get Jupiter service
    const jupiter = getJupiter();

    // Validate and create mints
    let inputMintValidated: ReturnType<typeof asTokenMint>;
    let outputMintValidated: ReturnType<typeof asTokenMint>;

    try {
      inputMintValidated = asTokenMint(inputMint);
      outputMintValidated = asTokenMint(outputMint);
    } catch (error) {
      await ctx.reply(`❌ Invalid token address: ${error instanceof Error ? error.message : String(error)}`);
      clearKeypair(keypair);
      return;
    }

    // Execute swap
    const swapResult = await jupiter.swap(
      {
        inputMint: inputMintValidated,
        outputMint: outputMintValidated,
        amount,
        userPublicKey: publicKey,
        slippageBps: 50, // 0.5% slippage
      },
      keypair
    );

    // Clear keypair from memory
    clearKeypair(keypair);

    if (!swapResult.success) {
      const error = swapResult.error as JupiterError;

      if (error.type === "NO_ROUTE") {
        await ctx.reply("❌ No swap route found for this token pair.");
        return;
      }

      if (error.type === "INSUFFICIENT_BALANCE") {
        await ctx.reply("❌ Insufficient balance for this swap.");
        return;
      }

      if (error.type === "SLIPPAGE_EXCEEDED") {
        await ctx.reply("❌ Slippage exceeded. Try again or increase slippage tolerance.");
        return;
      }

      const errorMessage = error.type === "TRANSACTION_FAILED"
        ? error.reason
        : "message" in error
        ? error.message
        : "Unknown error";
      await ctx.reply(`❌ Swap failed: ${errorMessage}`);
      logger.error("Swap execution failed", { userId, error });
      return;
    }

    const result = swapResult.value;

    // Success!
    await ctx.reply(
      `✅ *Swap Successful!*\n\n` +
      `Transaction: \`${result.signature}\`\n` +
      `Slot: ${result.slot}\n\n` +
      `Input: ${formatAmount(result.inputAmount, 9)}\n` +
      `Output: ${formatAmount(result.outputAmount, 9)}\n` +
      `Price Impact: ${result.priceImpactPct.toFixed(2)}%\n\n` +
      `[View on Solscan](https://solscan.io/tx/${result.signature})`,
      { parse_mode: "Markdown" }
    );

    logger.info("Swap completed successfully", {
      userId,
      signature: result.signature,
      inputAmount: result.inputAmount.toString(),
      outputAmount: result.outputAmount.toString(),
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
  const userId = ctx.from?.id.toString();
  if (!userId) return;

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
 * Resolve token symbol to mint address
 */
function resolveTokenSymbol(symbol: string): string {
  const KNOWN_TOKENS: Record<string, string> = {
    SOL: "So11111111111111111111111111111111111111112",
    WSOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
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

  throw new Error(`Unknown token symbol: ${symbol}`);
}

/**
 * Parse amount string to smallest units
 */
function parseAmount(amountStr: string, tokenSymbol: string): string | null {
  try {
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      return null;
    }

    // SOL/USDC/USDT have 9, 6, 6 decimals respectively
    // Default to 9 decimals for unknown tokens
    const decimals = tokenSymbol.toUpperCase() === "USDC" || tokenSymbol.toUpperCase() === "USDT" ? 6 : 9;

    const smallest = Math.floor(amount * Math.pow(10, decimals));
    return smallest.toString();
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
