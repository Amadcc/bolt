/**
 * /createwallet Command
 *
 * Flow:
 * 1. User sends /createwallet
 * 2. Bot asks for password (private message)
 * 3. Bot validates password
 * 4. Bot generates wallet and encrypts private key
 * 5. Bot stores encrypted key in database
 * 6. Bot shows public key to user
 * 7. Bot deletes password message for security
 */

import type { Context } from "grammy";
import { createWallet, hasWallet } from "../../services/wallet/keyManager.js";
import { logger } from "../../utils/logger.js";
import { truncateAddress } from "../../utils/helpers.js";
import { prisma } from "../../utils/db.js";

// ============================================================================
// Command Handler
// ============================================================================

export async function handleCreateWallet(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;

  if (!telegramId) {
    await ctx.reply("❌ Unable to identify user");
    return;
  }

  try {
    // Get user from database by telegramId
    const user = await prisma.user.findUnique({
      where: { telegramId },
    });

    if (!user) {
      await ctx.reply("❌ User not found. Please use /start first.");
      return;
    }

    // Check if user already has a wallet
    const userHasWallet = await hasWallet(user.id);

    if (userHasWallet) {
      await ctx.reply(
        "💼 You already have a wallet!\n\n" +
          "Use /wallet to view your wallet details.\n" +
          "Use /export to export your private key."
      );
      return;
    }

    // Ask for password
    await ctx.reply(
      "🔐 *Create New Wallet*\n\n" +
        "To create a wallet, you need to set a password.\n\n" +
        "⚠️ *IMPORTANT:*\n" +
        "• Your password encrypts your private key\n" +
        "• We NEVER store your password\n" +
        "• If you lose it, you CANNOT recover your wallet\n" +
        "• Password must be at least 8 characters\n" +
        "• Password must contain letters and numbers\n\n" +
        "Please send your password now (it will be deleted after use):",
      { parse_mode: "Markdown" }
    );

    // Wait for password input
    // Note: In production, use conversation state management
    // For now, we'll use a simple approach with message filter
  } catch (error) {
    logger.error("Error in createwallet command", { telegramId, error });
    await ctx.reply(
      "❌ An error occurred. Please try again later.\n\n" +
        "If the problem persists, contact support."
    );
  }
}

// ============================================================================
// Password Handler (called from bot middleware)
// ============================================================================

export async function handlePasswordInput(
  ctx: Context,
  password: string
): Promise<void> {
  const telegramId = ctx.from?.id;
  const messageId = ctx.message?.message_id;

  if (!telegramId) {
    await ctx.reply("❌ Unable to identify user");
    return;
  }

  try {
    // Get user from database by telegramId
    const user = await prisma.user.findUnique({
      where: { telegramId },
    });

    if (!user) {
      await ctx.reply("❌ User not found. Please use /start first.");
      return;
    }

    // Delete password message immediately for security
    if (messageId) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, messageId);
      } catch (error) {
        logger.warn("Failed to delete password message", { error });
      }
    }

    // Show processing message
    const processingMsg = await ctx.reply("⏳ Creating your wallet...");

    // Create wallet
    const result = await createWallet({
      userId: user.id,
      password,
    });

    // Delete processing message
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id);
    } catch {
      // Ignore deletion errors
    }

    if (!result.success) {
      logger.error("Failed to create wallet", {
        userId: user.id,
        telegramId,
        error: result.error,
      });

      let errorMessage = "❌ Failed to create wallet.\n\n";

      if (result.error.type === "INVALID_PASSWORD") {
        errorMessage +=
          `⚠️ ${result.error.message}\n\n` +
          "Please try /createwallet again with a stronger password.";
      } else if (result.error.type === "ENCRYPTION_FAILED") {
        errorMessage +=
          "Encryption failed. Please try again.\n\n" +
          "If the problem persists, contact support.";
      } else {
        errorMessage +=
          "An unexpected error occurred.\n\n" +
          "Please try again or contact support.";
      }

      await ctx.reply(errorMessage);
      return;
    }

    const { publicKey, walletId } = result.value;

    // Success message
    await ctx.reply(
      "✅ *Wallet Created Successfully!*\n\n" +
        `💼 *Wallet Address:*\n\`${publicKey}\`\n\n` +
        `🔍 *Short Address:*\n${truncateAddress(publicKey, 8)}\n\n` +
        "⚠️ *IMPORTANT SECURITY NOTES:*\n" +
        "• Your private key is encrypted and stored securely\n" +
        "• NEVER share your password with anyone\n" +
        "• We will NEVER ask for your password except during operations\n" +
        "• Always verify you're talking to the official bot\n\n" +
        "📋 *Next Steps:*\n" +
        "• Use /wallet to view your wallet\n" +
        "• Use /deposit to see deposit instructions\n" +
        "• Use /balance to check your balance\n\n" +
        "🎉 You're ready to start sniping!",
      { parse_mode: "Markdown" }
    );

    logger.info("Wallet created via Telegram", {
      userId: user.id,
      telegramId,
      walletId,
      publicKey,
    });
  } catch (error) {
    logger.error("Error processing password input", { telegramId, error });
    await ctx.reply(
      "❌ An error occurred while creating your wallet.\n\n" +
        "Please try /createwallet again."
    );
  }
}
