/**
 * /positions command - View active positions
 */

import type { Context } from "../../views/index.js";
import { navigateToPage } from "../../views/index.js";
import { logger } from "../../../utils/logger.js";

/**
 * Handle /positions command - navigate to positions page
 */
export async function handlePositionsCommand(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    logger.info("Positions command received", { userId: telegramId });

    // Navigate to positions page (single-page UI)
    await navigateToPage(ctx, "positions");

  } catch (error) {
    logger.error("Error in /positions command", { error, userId: ctx.from?.id });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}
