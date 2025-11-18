/**
 * Sniper Callback Handlers
 * Handle all sniper-related inline button clicks
 */

import type { Context } from "../views/index.js";
import { navigateToPage } from "../views/index.js";
import { logger } from "../../utils/logger.js";
import { prisma as db } from "../../utils/db.js";
import { getUserContext } from "../utils/userContext.js";

// ============================================================================
// Sniper Main Callbacks
// ============================================================================

/**
 * Handle sniper callbacks (sniper:action)
 */
export async function handleSniperCallback(
  ctx: Context,
  action: string
): Promise<void> {
  switch (action) {
    case "start":
      await handleSniperStart(ctx);
      break;

    case "stop":
      await handleSniperStop(ctx);
      break;

    case "exitall_confirm":
      await handleExitAllConfirmation(ctx);
      break;

    case "exitall_execute":
      await handleExitAllExecute(ctx);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown sniper action");
      logger.warn("Unknown sniper action", { action, userId: ctx.from?.id });
  }
}

/**
 * Start auto-sniper
 */
async function handleSniperStart(ctx: Context): Promise<void> {
  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    // Enable auto-sniper in database
    await db.sniperFilterPreference.upsert({
      where: { userId },
      create: {
        userId,
        preset: "BALANCED",
        autoSniperEnabled: true,
      },
      update: {
        autoSniperEnabled: true,
      },
    });

    logger.info("Auto-sniper started", { userId });

    await ctx.answerCallbackQuery("✅ Auto-sniper started");
    await navigateToPage(ctx, "sniper");
  } catch (error) {
    logger.error("Failed to start sniper", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start sniper");
  }
}

/**
 * Stop auto-sniper
 */
async function handleSniperStop(ctx: Context): Promise<void> {
  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    // Disable auto-sniper in database
    await db.sniperFilterPreference.update({
      where: { userId },
      data: { autoSniperEnabled: false },
    });

    logger.info("Auto-sniper stopped", { userId });

    await ctx.answerCallbackQuery("⏸️ Auto-sniper stopped");
    await navigateToPage(ctx, "sniper");
  } catch (error) {
    logger.error("Failed to stop sniper", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to stop sniper");
  }
}

/**
 * Handle exit all confirmation
 */
async function handleExitAllConfirmation(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    `🚨 *Confirm Emergency Exit*\n\n` +
    `Are you absolutely sure you want to exit ALL positions?\n\n` +
    `This action cannot be undone.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Yes, Exit All", callback_data: "sniper:exitall_execute" },
          ],
          [
            { text: "❌ Cancel", callback_data: "nav:sniper" },
          ],
        ],
      },
    }
  );
}

/**
 * Execute exit all (after confirmation)
 */
async function handleExitAllExecute(ctx: Context): Promise<void> {
  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    await ctx.answerCallbackQuery();

    // Get all open positions
    const positions = await db.sniperPosition.findMany({
      where: { userId, status: "OPEN" },
      include: { monitor: true },
    });

    if (positions.length === 0) {
      await ctx.editMessageText(
        "❌ No open positions found.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "« Back", callback_data: "nav:sniper" }],
            ],
          },
        }
      );
      return;
    }

    await ctx.editMessageText(
      `🚨 *Executing Emergency Exit*\n\n` +
      `Closing ${positions.length} positions...\n\n` +
      `This may take a few moments.`,
      { parse_mode: "Markdown" }
    );

    logger.info("Executing emergency exit all", {
      userId,
      positionCount: positions.length,
    });

    // TODO: Implement actual exit execution with ExitExecutor
    // For now, just mark monitors as EXITING

    let successCount = 0;

    for (const position of positions) {
      try {
        if (position.monitor) {
          await db.positionMonitor.update({
            where: { id: position.monitor.id },
            data: { status: "EXITING" },
          });
        }
        successCount++;
      } catch (error) {
        logger.error("Failed to exit position", {
          userId,
          positionId: position.id,
          error,
        });
      }
    }

    const successEmoji = successCount === positions.length ? "✅" : "⚠️";

    await ctx.editMessageText(
      `${successEmoji} *Emergency Exit Complete*\n\n` +
      `Initiated: ${successCount}/${positions.length}\n\n` +
      `Check \`/positions\` for exit status.\n\n` +
      `⚠️ Exits may take 10-30 seconds to confirm on-chain.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📊 View Positions", callback_data: "nav:positions" }],
            [{ text: "« Back to Sniper", callback_data: "nav:sniper" }],
          ],
        },
      }
    );

  } catch (error) {
    logger.error("Error executing exit all", { error, userId: ctx.from?.id });
    await ctx.editMessageText(
      "❌ Emergency exit failed. Please check `/positions` manually.",
      { parse_mode: "Markdown" }
    );
  }
}

// ============================================================================
// Sniper Config Callbacks
// ============================================================================

/**
 * Handle sniper config callbacks (sniper_config:action:params)
 */
export async function handleSniperConfigCallback(
  ctx: Context,
  action: string,
  params?: string[]
): Promise<void> {
  switch (action) {
    case "preset":
      await handlePresetChange(ctx, params?.[0]);
      break;

    case "advanced":
      // Show advanced settings page
      await ctx.answerCallbackQuery();
      const { renderAdvancedSniperConfigPage } = await import("../views/sniper.js");
      const result = await renderAdvancedSniperConfigPage();
      await ctx.editMessageText(result.text, {
        parse_mode: "Markdown",
        reply_markup: result.keyboard,
      });
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown config action");
  }
}

/**
 * Change filter preset
 */
async function handlePresetChange(ctx: Context, preset?: string): Promise<void> {
  if (!preset) {
    await ctx.answerCallbackQuery("❌ Invalid preset");
    return;
  }

  const validPresets = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"];
  if (!validPresets.includes(preset)) {
    await ctx.answerCallbackQuery("❌ Invalid preset");
    return;
  }

  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    // Update preset in database
    await db.sniperFilterPreference.upsert({
      where: { userId },
      create: {
        userId,
        preset,
        autoSniperEnabled: false,
      },
      update: {
        preset,
      },
    });

    logger.info("Filter preset changed", { userId, preset });

    await ctx.answerCallbackQuery(`✅ Filter set to ${preset}`);
    await navigateToPage(ctx, "sniper_config");
  } catch (error) {
    logger.error("Failed to change preset", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to change preset");
  }
}

// ============================================================================
// Position Callbacks
// ============================================================================

/**
 * Handle position callbacks (position:action:id)
 */
export async function handlePositionCallback(
  ctx: Context,
  action: string,
  params?: string[]
): Promise<void> {
  const positionId = params?.[0];

  switch (action) {
    case "details":
      await handlePositionDetails(ctx, positionId);
      break;

    case "settp":
      await handlePositionSetTP(ctx, positionId);
      break;

    case "setsl":
      await handlePositionSetSL(ctx, positionId);
      break;

    case "toggle_trailing":
      await handleToggleTrailingSL(ctx, positionId);
      break;

    case "close":
      await handlePositionClose(ctx, positionId);
      break;

    case "view_tx":
      await handleViewTransaction(ctx, params?.[0]);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown position action");
  }
}

/**
 * Show position details
 */
async function handlePositionDetails(ctx: Context, positionId?: string): Promise<void> {
  if (!positionId) {
    await ctx.answerCallbackQuery("❌ Invalid position");
    return;
  }

  await ctx.answerCallbackQuery();

  // Save selected position ID
  if (!ctx.session.ui.sniperData) {
    ctx.session.ui.sniperData = {};
  }
  ctx.session.ui.sniperData.selectedPositionId = positionId;

  await navigateToPage(ctx, "position_details", { positionId });
}

/**
 * Set take-profit via UI (prompts for input)
 */
async function handlePositionSetTP(ctx: Context, positionId?: string): Promise<void> {
  if (!positionId) {
    await ctx.answerCallbackQuery("❌ Invalid position");
    return;
  }

  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    `📈 *Set Take-Profit*\n\n` +
    `Enter the take-profit percentage.\n\n` +
    `Example: Send \`50\` for 50% profit target\n\n` +
    `Or use command: \`/settp <token> <percent>\``,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "« Cancel", callback_data: `position:details:${positionId}` },
          ],
        ],
      },
    }
  );

  // Set awaiting input state
  ctx.session.awaitingInput = {
    type: "amount",
    page: "position_details",
  };
  if (!ctx.session.ui.sniperData) {
    ctx.session.ui.sniperData = {};
  }
  ctx.session.ui.sniperData.selectedPositionId = positionId;
}

/**
 * Set stop-loss via UI (prompts for input)
 */
async function handlePositionSetSL(ctx: Context, positionId?: string): Promise<void> {
  if (!positionId) {
    await ctx.answerCallbackQuery("❌ Invalid position");
    return;
  }

  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    `📉 *Set Stop-Loss*\n\n` +
    `Enter the stop-loss percentage.\n\n` +
    `Example: Send \`20\` for 20% stop-loss\n\n` +
    `Or use command: \`/setsl <token> <percent>\``,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "« Cancel", callback_data: `position:details:${positionId}` },
          ],
        ],
      },
    }
  );

  // Set awaiting input state
  ctx.session.awaitingInput = {
    type: "amount",
    page: "position_details",
  };
  if (!ctx.session.ui.sniperData) {
    ctx.session.ui.sniperData = {};
  }
  ctx.session.ui.sniperData.selectedPositionId = positionId;
}

/**
 * Toggle trailing stop-loss
 */
async function handleToggleTrailingSL(ctx: Context, positionId?: string): Promise<void> {
  if (!positionId) {
    await ctx.answerCallbackQuery("❌ Invalid position");
    return;
  }

  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    // Get position
    const position = await db.sniperPosition.findFirst({
      where: { id: positionId, userId },
      include: { monitor: true },
    });

    if (!position) {
      await ctx.answerCallbackQuery("❌ Position not found");
      return;
    }

    const newValue = !position.trailingStopLoss;

    // Update position and monitor
    await Promise.all([
      db.sniperPosition.update({
        where: { id: positionId },
        data: { trailingStopLoss: newValue },
      }),
      position.monitor
        ? db.positionMonitor.update({
            where: { id: position.monitor.id },
            data: { trailingStopLoss: newValue },
          })
        : null,
    ]);

    logger.info("Trailing SL toggled", { userId, positionId, newValue });

    await ctx.answerCallbackQuery(
      newValue ? "✅ Trailing SL enabled" : "❌ Trailing SL disabled"
    );
    await navigateToPage(ctx, "position_details", { positionId });
  } catch (error) {
    logger.error("Failed to toggle trailing SL", { error, positionId });
    await ctx.answerCallbackQuery("❌ Failed to update");
  }
}

/**
 * Close position (confirmation)
 */
async function handlePositionClose(ctx: Context, positionId?: string): Promise<void> {
  if (!positionId) {
    await ctx.answerCallbackQuery("❌ Invalid position");
    return;
  }

  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    `❌ *Close Position*\n\n` +
    `Are you sure you want to close this position?\n\n` +
    `This will sell all tokens at market price.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Yes, Close", callback_data: `position:close_confirm:${positionId}` },
          ],
          [
            { text: "« Cancel", callback_data: `position:details:${positionId}` },
          ],
        ],
      },
    }
  );
}

/**
 * View transaction on Solscan
 */
async function handleViewTransaction(ctx: Context, signature?: string): Promise<void> {
  if (!signature) {
    await ctx.answerCallbackQuery("❌ Invalid transaction");
    return;
  }

  await ctx.answerCallbackQuery("🔗 Opening Solscan...");

  // Solscan link - this will be handled by Telegram
  // User will see an alert, but the button text should indicate it opens external link
}

// ============================================================================
// Positions Page Callbacks
// ============================================================================

/**
 * Handle positions page callbacks (positions:action:params)
 */
export async function handlePositionsCallback(
  ctx: Context,
  action: string,
  params?: string[]
): Promise<void> {
  switch (action) {
    case "page":
      const page = params?.[0] ? parseInt(params[0]) : 0;
      await ctx.answerCallbackQuery();
      await navigateToPage(ctx, "positions", { page });
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown positions action");
  }
}
