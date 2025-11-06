/**
 * /balance Command
 *
 * Shows user's SOL and token balances
 */

import type { Context } from "grammy";
import { prisma } from "../../utils/db.js";
import { getSolanaConnection } from "../../services/blockchain/solana.js";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";

// Known token metadata (symbol and decimals)
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  So11111111111111111111111111111111111111112: { symbol: "SOL", decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", decimals: 5 },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", decimals: 6 },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", decimals: 6 },
};

export async function handleBalance(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;

  if (!telegramId) {
    await ctx.reply("❌ Unable to identify user");
    return;
  }

  try {
    // Get user from database
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      include: { wallets: { where: { isActive: true } } },
    });

    if (!user) {
      await ctx.reply("❌ User not found. Please use /start first.");
      return;
    }

    if (!user.wallets.length) {
      await ctx.reply(
        "💼 You don't have a wallet yet.\n\n" +
          "Use /createwallet to create one."
      );
      return;
    }

    const wallet = user.wallets[0];
    const connection = getSolanaConnection();
    const publicKey = new PublicKey(wallet.publicKey);

    // Show processing message
    const processingMsg = await ctx.reply("⏳ Fetching balance...");

    // Get SOL balance
    const lamports = await connection.getBalance(publicKey);
    const sol = lamports / LAMPORTS_PER_SOL;

    // Get token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );

    // Delete processing message
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id);
    } catch {
      // Ignore deletion errors
    }

    // Build balance message
    let message = `💰 *Balance*\n\n`;
    message += `Wallet: \`${wallet.publicKey}\`\n\n`;
    message += `💎 SOL: *${sol.toFixed(4)}* SOL\n`;

    // Add token balances
    if (tokenAccounts.value.length > 0) {
      message += `\n📊 *Tokens:*\n`;

      for (const tokenAccount of tokenAccounts.value) {
        const accountData = tokenAccount.account.data.parsed.info;
        const mint = accountData.mint;
        const amount = accountData.tokenAmount.uiAmountString;
        const decimals = accountData.tokenAmount.decimals;

        // Get token symbol
        const tokenInfo = KNOWN_TOKENS[mint];
        const symbol = tokenInfo?.symbol || truncateAddress(mint);

        // Only show tokens with non-zero balance
        if (parseFloat(amount) > 0) {
          message += `• *${symbol}:* ${formatTokenAmount(amount)}\n`;
        }
      }
    }

    // Format balance message
    await ctx.reply(message, { parse_mode: "Markdown" });

    logger.info("Balance checked", {
      userId: user.id,
      telegramId,
      publicKey: wallet.publicKey,
      sol,
      tokenCount: tokenAccounts.value.length,
    });
  } catch (error) {
    logger.error("Error in balance command", { telegramId, error });
    await ctx.reply(
      "❌ Failed to fetch balance.\n\n" +
        "Please try again later or contact support."
    );
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Truncate address for display
 */
function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Format token amount with appropriate precision
 */
function formatTokenAmount(amountStr: string): string {
  const amount = parseFloat(amountStr);

  if (amount === 0) return "0";

  // For very large numbers (> 1M), use scientific notation
  if (amount >= 1_000_000) {
    return amount.toExponential(2);
  }

  // For large numbers (> 1000), show with commas
  if (amount >= 1000) {
    return amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // For medium numbers (1-1000), show 2-4 decimals
  if (amount >= 1) {
    return amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }

  // For small numbers (< 1), show up to 6 decimals
  if (amount >= 0.000001) {
    return amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }

  // For very small numbers, use scientific notation
  return amount.toExponential(2);
}
