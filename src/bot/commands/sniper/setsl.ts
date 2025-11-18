/**
 * /setsl command - Set stop-loss for position
 * Usage: /setsl <token> <percent>
 */

import type { Context } from "../../views/index.js";
import { logger } from "../../../utils/logger.js";
import { prisma as db } from "../../../utils/db.js";
import { getUserContext } from "../../utils/userContext.js";
import { asPercentage } from "../../../types/positionMonitor.js";

/**
 * Handle /setsl <token> <percent> command
 */
export async function handleSetStopLossCommand(ctx: Context): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("❌ Could not identify user");
      return;
    }

    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    const text = ctx.message?.text;
    if (!text) {
      await ctx.reply("❌ No message text found");
      return;
    }

    // Parse command arguments
    const parts = text.split(" ").filter(Boolean);

    if (parts.length < 3) {
      await ctx.reply(
        `📉 *Set Stop-Loss*\n\n` +
        `Set stop-loss percentage for a position.\n\n` +
        `Usage: \`/setsl <token> <percent>\`\n\n` +
        `Examples:\n` +
        `\`/setsl BONK 20\` - Set 20% SL\n` +
        `\`/setsl EPjF...t1v 50\` - Set 50% SL\n\n` +
        `💡 You can also use the Positions page to set SL via buttons.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const [, tokenArg, percentArg] = parts;

    // Parse percentage
    const percentNum = parseFloat(percentArg);
    if (isNaN(percentNum) || percentNum <= 0 || percentNum > 100) {
      await ctx.reply(
        "❌ Invalid percentage. Must be between 0 and 100.\n\n" +
        "Example: `/setsl BONK 20` for 20% stop-loss",
        { parse_mode: "Markdown" }
      );
      return;
    }

    asPercentage(percentNum); // Validate percentage

    // Find open position for this token
    const position = await db.sniperPosition.findFirst({
      where: {
        userId,
        status: "OPEN",
        OR: [
          { tokenMint: tokenArg },
          { tokenMint: { contains: tokenArg } }, // Partial match
        ],
      },
      include: {
        monitor: true,
      },
    });

    if (!position) {
      await ctx.reply(
        `❌ *Position Not Found*\n\n` +
        `No open position found for token: \`${tokenArg}\`\n\n` +
        `Use \`/positions\` to view all open positions.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Calculate SL price from entry price
    const entryPrice = position.monitor?.entryPrice
      ? Number(position.monitor.entryPrice)
      : 0;

    if (entryPrice === 0) {
      await ctx.reply(
        "❌ Cannot set SL: Entry price not available.\n\n" +
        "Position monitor may still be initializing."
      );
      return;
    }

    const slPrice = entryPrice * (1 - percentNum / 100);

    // Update position and monitor
    await Promise.all([
      db.sniperPosition.update({
        where: { id: position.id },
        data: { stopLossPct: percentNum },
      }),
      position.monitor
        ? db.positionMonitor.update({
            where: { id: position.monitor.id },
            data: { stopLossPrice: slPrice },
          })
        : null,
    ]);

    logger.info("Stop-loss updated", {
      userId,
      positionId: position.id,
      tokenMint: position.tokenMint,
      slPercent: percentNum,
      slPrice,
    });

    const tokenSymbol = position.tokenMint.slice(0, 8) + "...";

    await ctx.reply(
      `✅ *Stop-Loss Set*\n\n` +
      `Token: \`${position.tokenMint}\`\n` +
      `Symbol: ${tokenSymbol}\n\n` +
      `Entry Price: ${entryPrice.toExponential(4)} SOL\n` +
      `SL Trigger: ${slPrice.toExponential(4)} SOL (-${percentNum}%)\n\n` +
      `The position will auto-exit when price drops to the SL level.\n\n` +
      `Use \`/positions\` to view all positions.`,
      { parse_mode: "Markdown" }
    );

  } catch (error) {
    logger.error("Error in /setsl command", { error, userId: ctx.from?.id });
    await ctx.reply("❌ An error occurred. Please try again.");
  }
}
