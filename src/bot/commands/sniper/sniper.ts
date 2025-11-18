/**
 * /sniper command - Auto-sniper management
 * Start/stop auto-sniper, view status
 */

import type { Context } from "../../views/index.js";
import { navigateToPage } from "../../views/index.js";
import { logger } from "../../../utils/logger.js";

/**
 * Handle /sniper command - navigate to sniper dashboard
 */
export async function handleSniperCommand(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    logger.info("Sniper command received", { userId: telegramId });

    // Navigate to sniper main page (single-page UI)
    await navigateToPage(ctx, "sniper");

  } catch (error) {
    logger.error("Error in /sniper command", { error, userId: ctx.from?.id });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}
