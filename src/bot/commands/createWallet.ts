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

import type { Context } from "../views/index.js";
import { createWallet, hasWallet } from "../../services/wallet/keyManager.js";
import { logger } from "../../utils/logger.js";
import { getUserContext, invalidateUserContext } from "../utils/userContext.js";

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
    const userContext = await getUserContext(ctx);

    // Check if user already has a wallet
    const userHasWallet = await hasWallet(userContext.userId);

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

  if (!telegramId) {
    await ctx.reply("❌ Unable to identify user");
    return;
  }

  try {
    const userContext = await getUserContext(ctx);

    // Update UI message to show processing
    const messageId = (ctx as any).session?.ui?.messageId;
    if (messageId) {
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          messageId,
          "⏳ Creating your wallet...\n\nThis may take a few seconds."
        );
      } catch (error) {
        logger.warn("Failed to update processing message", { error });
      }
    }

    // Create wallet
    const result = await createWallet({
      userId: userContext.userId,
      password,
    });

    if (!result.success) {
      logger.error("Failed to create wallet", {
        userId: userContext.userId,
        telegramId,
        error: result.error,
      });

      let errorMessage = "❌ *Failed to create wallet*\n\n";

      if (result.error.type === "INVALID_PASSWORD") {
        errorMessage +=
          `⚠️ ${result.error.message}\n\n` +
          "Please send a stronger password or use /start to go back.";
      } else if (result.error.type === "ENCRYPTION_FAILED") {
        errorMessage +=
          "Encryption failed. Please try again.\n\n" +
          "Use /start to go back.";
      } else {
        errorMessage +=
          "An unexpected error occurred.\n\n" +
          "Use /start to go back.";
      }

      if (messageId) {
        await ctx.api.editMessageText(ctx.chat!.id, messageId, errorMessage, {
          parse_mode: "Markdown",
        });
      } else {
        await ctx.reply(errorMessage, { parse_mode: "Markdown" });
      }
      return;
    }

    const { publicKey, walletId } = result.value;

    // Success message
    const successMessage =
      "✅ *Wallet Created Successfully!*\n\n" +
      `💼 *Address:*\n\`${publicKey}\`\n\n` +
      "🔐 *Security:*\n" +
      "• Private key encrypted securely\n" +
      "• NEVER share your password\n\n" +
      "🎉 Ready to start trading!\n\n" +
      "_Redirecting to dashboard..._";

    if (messageId) {
      await ctx.api.editMessageText(ctx.chat!.id, messageId, successMessage, {
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply(successMessage, { parse_mode: "Markdown" });
    }

    logger.info("Wallet created via Telegram", {
      userId: userContext.userId,
      telegramId,
      walletId,
      publicKey,
    });

    invalidateUserContext(ctx);
  } catch (error) {
    logger.error("Error processing password input", { telegramId, error });
    await ctx.reply(
      "❌ An error occurred while creating your wallet.\n\n" +
        "Please use /start to try again."
    );
  }
}
