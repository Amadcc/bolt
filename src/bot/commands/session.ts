/**
 * Session management commands
 * /unlock, /lock, /status
 *
 * ✅ Redis Session Integration (CRITICAL-1 + CRITICAL-2 fix)
 * ✅ Single-Page UI: All commands now use navigateToPage
 */

import { logger } from "../../utils/logger.js";
// ✅ Redis Session Integration
import {
  createSession,
  destroySession
} from "../../services/wallet/session.js";
import {
  storePasswordTemporary,
  deletePasswordTemporary,
  PASSWORD_TTL_MS,
} from "../../services/wallet/passwordVault.js";
import { prisma } from "../../utils/db.js";
import { navigateToPage, type Context } from "../views/index.js";
import {
  clearUnlockFailures,
  isUnlockRateLimited,
  recordUnlockFailure,
  MAX_UNLOCK_ATTEMPTS,
} from "../../services/security/unlockRateLimiter.js";

/**
 * Handle /unlock command
 * ✅ Single-Page UI: Navigate to unlock page
 */
export async function handleUnlock(ctx: Context): Promise<void> {
  try {
    // Delete the command message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn("Failed to delete unlock command message", { error });
    }

    // Navigate to unlock page
    await navigateToPage(ctx, "unlock");

  } catch (error) {
    logger.error("Error in unlock command", { userId: ctx.from?.id, error });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}

/**
 * Execute the unlock
 */
async function executeUnlock(
  ctx: Context,
  userId: string,
  password: string
): Promise<void> {
  try {
    // Get UI message ID
    const uiMessageId = (ctx as any).session?.ui?.messageId;

    const rateLimitStatus = await isUnlockRateLimited(userId);
    if (rateLimitStatus.blocked) {
      const retrySeconds =
        rateLimitStatus.retryAfterSeconds ?? 15 * 60;
      const cooldownMinutes = Math.max(
        1,
        Math.ceil(retrySeconds / 60)
      );
      const blockedMessage =
        `🚫 *Too Many Attempts*\n\n` +
        `Please wait ${cooldownMinutes} minute(s) before trying again.\n` +
        `This protects your wallet from brute-force attacks.\n\n` +
        `_If this wasn't you, contact support for manual verification._`;

      if (uiMessageId) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          uiMessageId,
          blockedMessage,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(blockedMessage, { parse_mode: "Markdown" });
      }

      logger.warn("Unlock blocked by rate limiter", {
        userId,
        cooldownMinutes,
      });
      return;
    }

    // Update UI to show progress
    if (uiMessageId) {
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          uiMessageId,
          "⏳ *Unlocking wallet...*\n\nPlease wait...",
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        logger.warn("Failed to update UI message", { error });
      }
    }

    // ✅ Redis Session Integration: Create Redis session (encrypted keys)
    const sessionResult = await createSession({ userId, password });

    if (!sessionResult.success) {
      const error = sessionResult.error;

      let errorMessage = "❌ *Failed to unlock wallet*\n\n";
      let rateLimitNotice = "";

      if (error.message.includes("Failed to create session: WALLET_NOT_FOUND")) {
        errorMessage += "Wallet not found.\n\nUse /start to create one.";
      } else if (error.message.includes("password")) {
        errorMessage += "Invalid password.\n\nPlease try again.";

        try {
          const failureInfo = await recordUnlockFailure(userId);
          const attemptsLeft = Math.max(
            MAX_UNLOCK_ATTEMPTS - failureInfo.attempts,
            0
          );
          rateLimitNotice =
            attemptsLeft > 0
              ? `Attempts remaining: ${attemptsLeft}`
              : `Cooldown: ${Math.ceil(
                  failureInfo.retryAfterSeconds / 60
                )} minute(s).`;
        } catch (rateError) {
          logger.error("Failed to record unlock failure", {
            userId,
            error: rateError,
          });
        }
      } else {
        errorMessage += "An error occurred.\n\nPlease try again.";
      }

      // Add inline keyboard with retry and back options
      const keyboard = {
        inline_keyboard: [
          [
            { text: "🔄 Try Again", callback_data: "action:unlock" },
            { text: "« Back", callback_data: "nav:main" }
          ]
        ]
      };

      const finalMessage = rateLimitNotice
        ? `${errorMessage}\n${rateLimitNotice}`
        : errorMessage;

      if (uiMessageId) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          uiMessageId,
          finalMessage,
          {
            parse_mode: "Markdown",
            reply_markup: keyboard
          }
        );
      } else {
        await ctx.reply(finalMessage, {
          parse_mode: "Markdown",
          reply_markup: keyboard
        });
      }

      logger.error("Failed to unlock wallet", { userId, error });
      return;
    }

    const { sessionToken, expiresAt } = sessionResult.value;

    const passwordStoreResult = await storePasswordTemporary(
      sessionToken,
      password
    );

    if (!passwordStoreResult.success) {
      await destroySession(sessionToken);

      const secureError =
        "❌ *Failed to Secure Session*\n\n" +
        "We couldn't store your password safely. Please try unlocking again.";

      const keyboard = {
        inline_keyboard: [
          [
            { text: "🔄 Try Again", callback_data: "action:unlock" },
            { text: "« Back", callback_data: "nav:main" }
          ]
        ]
      };

      if (uiMessageId) {
        await ctx.api.editMessageText(ctx.chat!.id, uiMessageId, secureError, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      } else {
        await ctx.reply(secureError, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      }

      logger.error("Failed to store password in Redis, unlock aborted", {
        userId,
      });
      return;
    }

    // ✅ Store session metadata only (no password)
    ctx.session.sessionToken = sessionToken;
    ctx.session.sessionExpiresAt = expiresAt.getTime();
    ctx.session.passwordExpiresAt = Date.now() + PASSWORD_TTL_MS;

    // Get wallet publicKey from database
    const wallet = await prisma.wallet.findFirst({
      where: { userId, isActive: true },
    });

    const publicKey = wallet?.publicKey || "Unknown";

    // Success message
    const successMessage =
      `✅ *Wallet Unlocked!*\n\n` +
      `Address: \`${publicKey}\`\n\n` +
      `🔐 Session active for *15 minutes*.\n` +
      `You can now trade without entering password.\n\n` +
      `_Returning to dashboard..._`;

    if (uiMessageId) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        uiMessageId,
        successMessage,
        { parse_mode: "Markdown" }
      );
    } else {
      await ctx.reply(successMessage, { parse_mode: "Markdown" });
    }

    await clearUnlockFailures(userId);
    logger.info("Wallet unlocked successfully via Redis session", {
      userId,
      publicKey,
      sessionToken: "[REDACTED]",
      sessionTokenPresent: true,
    });

  } catch (error) {
    logger.error("Error executing unlock", { userId, error });

    const uiMessageId = (ctx as any).session?.ui?.messageId;
    const errorMsg = "❌ An unexpected error occurred.\n\nPlease try again with /start";

    if (uiMessageId) {
      await ctx.api.editMessageText(ctx.chat!.id, uiMessageId, errorMsg);
    } else {
      await ctx.reply(errorMsg);
    }
  }
}

/**
 * Handle password input for unlock
 *
 * NOTE: Password message is already deleted in index.ts (line 451)
 * before this function is called. No need to delete again here.
 */
export async function handleUnlockPasswordInput(
  ctx: Context,
  password: string
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Clear session
  ctx.session.awaitingPasswordForUnlock = false;

  // Get user from database
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
  });

  if (!user) {
    await ctx.reply("❌ User not found. Please use /start first.");
    return;
  }

  // Execute unlock with UUID userId
  await executeUnlock(ctx, user.id, password);
}

/**
 * Handle /lock command
 * Immediately locks the wallet
 */
/**
 * Lock session (without sending message)
 * Used by UI system
 */
export async function lockSession(ctx: Context): Promise<void> {
  // Attempt to wipe temporary password from Redis
  if (ctx.session.sessionToken) {
    const deleteResult = await deletePasswordTemporary(
      ctx.session.sessionToken as any
    );

    if (!deleteResult.success) {
      logger.warn("Failed to delete temporary password during lock", {
        error: deleteResult.error?.message,
      });
    }
  }

  // ✅ Clear Redis session metadata from Grammy session
  ctx.session.sessionToken = undefined;
  ctx.session.sessionExpiresAt = undefined;
  ctx.session.passwordExpiresAt = undefined;
  // Legacy fields (may still be used in some places)
  ctx.session.encryptedKey = undefined;
  ctx.session.walletId = undefined;
}

/**
 * Handle /lock command
 * ✅ Single-Page UI: Lock and navigate to main
 */
export async function handleLock(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    // Delete the command message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn("Failed to delete lock command message", { error });
    }

    // Check if user has a wallet
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      include: { wallets: true },
    });

    if (!user || !user.wallets.length) {
      await ctx.reply("❌ You don't have a wallet yet. Use /createwallet to create one.");
      return;
    }

    // ✅ Destroy Redis session if exists
    if (ctx.session.sessionToken) {
      await destroySession(ctx.session.sessionToken as any);
    }

    // Also clear Grammy session
    await lockSession(ctx);

    logger.info("Wallet locked - Redis session destroyed", { userId: user.id, telegramId });

    // Navigate to main page (will show locked status)
    await navigateToPage(ctx, "main");

  } catch (error) {
    logger.error("Error in lock command", { telegramId: ctx.from?.id, error });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}

/**
 * Handle /status command
 * ✅ Single-Page UI: Navigate to status page
 */
export async function handleStatus(ctx: Context): Promise<void> {
  try {
    // Delete the command message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn("Failed to delete status command message", { error });
    }

    // Navigate to status page
    await navigateToPage(ctx, "status");

  } catch (error) {
    logger.error("Error in status command", { telegramId: ctx.from?.id, error });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}
