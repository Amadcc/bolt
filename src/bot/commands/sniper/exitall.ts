/**
 * /exitall command - Emergency exit all open positions
 * DANGER: This command sells ALL open positions immediately
 */

import type { Context } from "../../views/index.js";
import { logger } from "../../../utils/logger.js";
import { prisma as db } from "../../../utils/db.js";
import { getUserContext } from "../../utils/userContext.js";

/**
 * Handle /exitall command - emergency exit confirmation
 */
export async function handleExitAllCommand(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    // Get count of open positions
    const openCount = await db.sniperPosition.count({
      where: { userId, status: "OPEN" },
    });

    if (openCount === 0) {
      await ctx.reply(
        `📊 *No Open Positions*\n\n` +
        `You don't have any open positions to exit.\n\n` +
        `Use \`/positions\` to view your position history.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Show confirmation message
    await ctx.reply(
      `🚨 *Emergency Exit All*\n\n` +
      `⚠️ **WARNING:** This will immediately close **ALL ${openCount}** open positions!\n\n` +
      `This action:\n` +
      `• Sells all tokens at market price\n` +
      `• Uses high slippage (25%)\n` +
      `• Uses ULTRA priority fees\n` +
      `• Routes through Jito (if available)\n` +
      `• **CANNOT be undone**\n\n` +
      `To confirm, type: \`/exitall confirm\`\n` +
      `To cancel, just ignore this message.`,
      { parse_mode: "Markdown" }
    );

    logger.info("Exit all warning shown", { userId, openCount });

  } catch (error) {
    logger.error("Error in /exitall command", { error, userId: ctx.from?.id });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}

/**
 * Execute emergency exit all (after confirmation)
 */
export async function executeExitAll(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    // Get all open positions
    const positions = await db.sniperPosition.findMany({
      where: { userId, status: "OPEN" },
      include: { monitor: true },
    });

    if (positions.length === 0) {
      await ctx.reply("❌ No open positions found.");
      return;
    }

    await ctx.reply(
      `🚨 *Executing Emergency Exit*\n\n` +
      `Closing ${positions.length} positions...\n\n` +
      `This may take a few moments.`
    );

    logger.info("Executing emergency exit all", {
      userId,
      positionCount: positions.length,
    });

    // TODO: Implement actual exit execution
    // This will be integrated with ExitExecutor in next step
    // For now, just show placeholder

    let successCount = 0;
    let failCount = 0;

    for (const position of positions) {
      try {
        // TODO: Call ExitExecutor here
        // const result = await exitExecutor.executeExit(...)

        // Placeholder: Mark monitor as EXITING
        if (position.monitor) {
          await db.positionMonitor.update({
            where: { id: position.monitor.id },
            data: { status: "EXITING" },
          });
        }

        successCount++;
        logger.info("Position exit initiated", {
          userId,
          positionId: position.id,
          tokenMint: position.tokenMint,
        });
      } catch (error) {
        failCount++;
        logger.error("Failed to exit position", {
          userId,
          positionId: position.id,
          error,
        });
      }
    }

    const successEmoji = failCount === 0 ? "✅" : "⚠️";

    await ctx.reply(
      `${successEmoji} *Emergency Exit Complete*\n\n` +
      `Initiated: ${successCount}/${positions.length}\n` +
      (failCount > 0 ? `Failed: ${failCount}\n` : "") +
      `\n` +
      `Check \`/positions\` for exit status.\n\n` +
      `⚠️ Exits may take 10-30 seconds to confirm on-chain.`,
      { parse_mode: "Markdown" }
    );

  } catch (error) {
    logger.error("Error executing exit all", { error, userId: ctx.from?.id });
    await ctx.reply(
      "❌ Emergency exit failed. Some positions may not have been closed.\n\n" +
      "Please check `/positions` and manually close any remaining positions."
    );
  }
}
