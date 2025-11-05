/**
 * Session management commands
 * /unlock, /lock, /status
 */

import type { Context as GrammyContext, SessionFlavor } from "grammy";
import { logger } from "../../utils/logger.js";
import { unlockWallet, lockWallet, getSessionStatus } from "../../services/wallet/keyManager.js";
import { prisma } from "../../utils/db.js";

// Define session data structure (should match bot/index.ts)
interface SessionData {
  walletId?: string;
  encryptedKey?: string;
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
  awaitingPasswordForWallet?: boolean;
  awaitingPasswordForUnlock?: boolean;
}

type Context = GrammyContext & SessionFlavor<SessionData>;

/**
 * Handle /unlock command
 * Format: /unlock <password>
 * Example: /unlock mypassword
 */
export async function handleUnlock(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
    });

    if (!user) {
      await ctx.reply("❌ User not found. Please use /start first.");
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
      // No password provided, ask for it
      ctx.session.awaitingPasswordForUnlock = true;
      await ctx.reply(
        `🔐 *Unlock Wallet*\n\n` +
        `Please send your password to unlock your wallet for 30 minutes.\n\n` +
        `_Your password will be deleted immediately after use._`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const password = parts[1];

    // Execute unlock with UUID userId
    await executeUnlock(ctx, user.id, password);

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

    // Unlock wallet (creates session)
    const unlockResult = await unlockWallet({ userId, password });

    if (!unlockResult.success) {
      const error = unlockResult.error;

      if (error.type === "WALLET_NOT_FOUND") {
        await ctx.reply("❌ Wallet not found. Create one with /createwallet");
        return;
      }

      if (error.type === "INVALID_PASSWORD") {
        await ctx.reply("❌ Invalid password. Please try again.");
        return;
      }

      await ctx.reply("❌ Failed to unlock wallet. Please try again.");
      logger.error("Failed to unlock wallet", { userId, error });
      return;
    }

    const { publicKey } = unlockResult.value;

    // Success!
    await ctx.reply(
      `✅ *Wallet Unlocked!*\n\n` +
      `Address: \`${publicKey}\`\n\n` +
      `Your wallet is unlocked for *30 minutes*.\n` +
      `You can now use /buy, /sell, /swap without entering password.\n\n` +
      `Use /lock to lock immediately.\n` +
      `Use /status to check session status.`,
      { parse_mode: "Markdown" }
    );

    logger.info("Wallet unlocked successfully", { userId, publicKey });

  } catch (error) {
    logger.error("Error executing unlock", { userId, error });
    await ctx.reply("❌ An unexpected error occurred. Please try again.");
  }
}

/**
 * Handle password input for unlock
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
export async function handleLock(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
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

    // Lock wallet (clears session) with UUID userId
    await lockWallet(user.id);

    await ctx.reply(
      `🔒 *Wallet Locked*\n\n` +
      `Your wallet session has been cleared.\n` +
      `Use /unlock to unlock again.`,
      { parse_mode: "Markdown" }
    );

    logger.info("Wallet locked", { userId: user.id, telegramId });

  } catch (error) {
    logger.error("Error in lock command", { telegramId: ctx.from?.id, error });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}

/**
 * Handle /status command
 * Shows current session status
 */
export async function handleStatus(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    // Check if user has a wallet
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      include: { wallets: true },
    });

    if (!user || !user.wallets.length) {
      await ctx.reply(
        `💼 *Wallet Status*\n\n` +
        `🔴 No wallet found\n\n` +
        `Use /createwallet to create one.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const wallet = user.wallets[0];

    // Get session status with UUID userId
    const sessionStatus = await getSessionStatus(user.id);

    if (sessionStatus.isActive) {
      const timeLeft = Math.floor((sessionStatus.expiresAt - Date.now()) / 1000 / 60);

      await ctx.reply(
        `💼 *Wallet Status*\n\n` +
        `Address: \`${wallet.publicKey}\`\n\n` +
        `🟢 *Session Active*\n` +
        `Time remaining: ${timeLeft} minutes\n\n` +
        `You can trade without password until session expires.\n` +
        `Use /lock to lock immediately.`,
        { parse_mode: "Markdown" }
      );
    } else {
      await ctx.reply(
        `💼 *Wallet Status*\n\n` +
        `Address: \`${wallet.publicKey}\`\n\n` +
        `🔴 *Session Locked*\n\n` +
        `Use /unlock to unlock for 30 minutes.`,
        { parse_mode: "Markdown" }
      );
    }

    logger.info("Session status checked", { userId: user.id, telegramId, isActive: sessionStatus.isActive });

  } catch (error) {
    logger.error("Error in status command", { telegramId: ctx.from?.id, error });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}
