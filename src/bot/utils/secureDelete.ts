/**
 * Secure Password Message Deletion
 *
 * SECURITY (CRITICAL-4 Fix):
 * - If password deletion fails, ABORT the operation
 * - Show warning to user
 * - Recommend manual deletion and password change
 *
 * Why this is critical:
 * - Telegram retains deleted messages in some cases
 * - Failed deletion = password visible in chat history
 * - Attacker could see password in screenshots/backups
 */

import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";

/**
 * Safely delete password message
 *
 * Returns true if deletion succeeded, false if failed
 * Caller MUST check return value and abort operation if false
 */
export async function deletePasswordMessage(
  ctx: Context,
  messageId?: number
): Promise<boolean> {
  if (!messageId) {
    // No message to delete (e.g., inline keyboard input)
    return true;
  }

  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!chatId) {
    logger.error("Cannot delete password: no chat ID");
    return false;
  }

  try {
    await ctx.api.deleteMessage(chatId, messageId);
    logger.info("Password message deleted successfully", { userId, messageId });
    return true;
  } catch (error) {
    logger.error("CRITICAL: Failed to delete password message", {
      userId,
      chatId,
      messageId,
      error,
    });
    return false;
  }
}

/**
 * Send security warning when password deletion fails
 * Instructs user to manually delete and change password
 */
export async function sendPasswordDeletionWarning(
  ctx: Context,
  messageId?: number,
  operation: string = "operation"
): Promise<void> {
  const warningMessage =
    `🚨 *SECURITY WARNING*\n\n` +
    `Could not automatically delete your password message for security reasons.\n\n` +
    `**IMPORTANT - Do this NOW:**\n` +
    `1. ⚠️ Manually delete your password message (tap & hold → Delete)\n` +
    `2. 🔒 Consider changing your password: /changepassword\n` +
    `3. 🛡️ Clear this chat if anyone else has access to your phone\n\n` +
    `**For your safety, ${operation} has been CANCELLED.**\n\n` +
    `After deleting your password, try again.`;

  try {
    if (messageId) {
      // Reply to the password message so user knows which one to delete
      await ctx.reply(warningMessage, {
        parse_mode: "Markdown",
        reply_to_message_id: messageId,
      });
    } else {
      await ctx.reply(warningMessage, {
        parse_mode: "Markdown",
      });
    }
  } catch (error) {
    logger.error("Failed to send password deletion warning", { error });
    // Try without reply
    try {
      await ctx.reply(warningMessage, { parse_mode: "Markdown" });
    } catch (fallbackError) {
      logger.error("Failed to send warning (fallback)", { fallbackError });
    }
  }
}

/**
 * Secure password deletion with automatic abort
 *
 * Returns true if safe to proceed, false if operation should abort
 *
 * Usage:
 * ```typescript
 * if (!await securePasswordDelete(ctx, messageId, "trade")) {
 *   return; // ABORT operation
 * }
 * // Safe to proceed
 * ```
 */
export async function securePasswordDelete(
  ctx: Context,
  messageId: number | undefined,
  operation: string
): Promise<boolean> {
  const deleted = await deletePasswordMessage(ctx, messageId);

  if (!deleted) {
    // Send warning and abort
    await sendPasswordDeletionWarning(ctx, messageId, operation);
    return false; // ABORT
  }

  return true; // Safe to proceed
}
