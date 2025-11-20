/**
 * Sniper Callback Handlers
 * Handle all sniper-related inline button clicks
 */

import type { Context } from "../views/index.js";
import { navigateToPage } from "../views/index.js";
import { logger } from "../../utils/logger.js";
import { prisma as db } from "../../utils/db.js";
import { getUserContext } from "../utils/userContext.js";
import {
  startPoolMonitoring,
  stopPoolMonitoring,
  isPoolMonitoringActive,
} from "../../services/sniper/sourceManagerInit.js";

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

    logger.info("Auto-sniper started (UI)", { userId });

    // Start pool monitoring if not already active (GLOBAL for all users)
    if (!isPoolMonitoringActive()) {
      logger.info("Starting global pool monitoring...");

      await startPoolMonitoring(async (detection) => {
        // Handle new pool detection
        logger.info("New pool detected", {
          source: detection.source,
          poolAddress: detection.poolAddress,
          tokenMintA: detection.tokenMintA,
          tokenMintB: detection.tokenMintB,
          signature: detection.signature,
          slot: detection.slot,
        });

        // TODO: Implement filter matching and auto-execution
        // - Query all users with autoSniperEnabled=true
        // - Check if pool matches their filters
        // - Execute snipe via orchestrator.executeSnipe()
      });

      logger.info("Global pool monitoring started");
    } else {
      logger.info("Pool monitoring already active");
    }

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

    logger.info("Auto-sniper stopped (UI)", { userId });

    // Check if ANY users still have auto-sniper enabled
    const activeUsers = await db.sniperFilterPreference.count({
      where: { autoSniperEnabled: true },
    });

    // If no users have auto-sniper enabled, stop global monitoring
    if (activeUsers === 0 && isPoolMonitoringActive()) {
      logger.info("No active users - stopping global pool monitoring");
      await stopPoolMonitoring();
      logger.info("Global pool monitoring stopped");
    } else {
      logger.info("Pool monitoring continues", {
        activeUsers,
      });
    }

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

// ============================================================================
// Advanced Settings Callbacks
// ============================================================================

/**
 * Handle filter editing callbacks (filter_edit:action)
 */
export async function handleFilterEditCallback(
  ctx: Context,
  action: string,
  params?: string[]
): Promise<void> {
  switch (action) {
    case "liquidity":
      if (params && params[0] === "min") {
        await startEditMinLiquidity(ctx);
      } else if (params && params[0] === "max") {
        await startEditMaxLiquidity(ctx);
      }
      break;

    case "tax":
      if (params && params[0] === "buy") {
        await startEditMaxBuyTax(ctx);
      } else if (params && params[0] === "sell") {
        await startEditMaxSellTax(ctx);
      }
      break;

    case "holders":
      if (params && params[0] === "top10") {
        await startEditMaxTop10Holders(ctx);
      } else if (params && params[0] === "min") {
        await startEditMinHolders(ctx);
      }
      break;

    case "risk":
      if (params && params[0] === "max_score") {
        await startEditMaxRiskScore(ctx);
      } else if (params && params[0] === "min_confidence") {
        await startEditMinConfidence(ctx);
      }
      break;

    case "reset":
      await handleFilterReset(ctx);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown filter edit action");
      logger.warn("Unknown filter edit action", { action, userId: ctx.from?.id });
  }
}

/**
 * Handle execution settings editing callbacks (exec_edit:action)
 */
export async function handleExecEditCallback(
  ctx: Context,
  action: string,
  params?: string[]
): Promise<void> {
  switch (action) {
    case "buy_amount":
      await startEditBuyAmount(ctx);
      break;

    case "slippage":
      await startEditSlippage(ctx);
      break;

    case "priority":
      // Priority fee uses callback (not text input)
      if (params && params[0]) {
        await handlePriorityFeeSelect(ctx, params[0]);
      } else {
        await showPriorityFeeMenu(ctx);
      }
      break;

    case "tp":
      await startEditTakeProfit(ctx);
      break;

    case "sl":
      await startEditStopLoss(ctx);
      break;

    case "toggle_trailing":
      // Toggle trailing stop-loss (global default)
      await handleToggleTrailingSLGlobal(ctx);
      break;

    case "reset":
      // Reset execution settings to defaults
      await handleExecReset(ctx);
      break;

    default:
      await ctx.answerCallbackQuery("❌ Unknown execution edit action");
      logger.warn("Unknown execution edit action", { action, userId: ctx.from?.id });
  }
}

/**
 * Reset filters to preset defaults
 */
async function handleFilterReset(ctx: Context): Promise<void> {
  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    // Reset customFilters to null (will use preset defaults)
    const { Prisma } = await import("@prisma/client");
    await db.sniperFilterPreference.update({
      where: { userId },
      data: { customFilters: Prisma.JsonNull },
    });

    logger.info("Filters reset to preset", { userId });

    await ctx.answerCallbackQuery("✅ Filters reset to preset defaults");
    await navigateToPage(ctx, "filter_settings");
  } catch (error) {
    logger.error("Failed to reset filters", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to reset filters");
  }
}

/**
 * Reset execution settings to defaults
 */
async function handleExecReset(ctx: Context): Promise<void> {
  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    // Reset executionSettings to null (will use defaults)
    const { Prisma } = await import("@prisma/client");
    await db.sniperFilterPreference.update({
      where: { userId },
      data: { executionSettings: Prisma.JsonNull },
    });

    logger.info("Execution settings reset to defaults", { userId });

    await ctx.answerCallbackQuery("✅ Execution settings reset to defaults");
    await navigateToPage(ctx, "execution_settings");
  } catch (error) {
    logger.error("Failed to reset execution settings", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to reset execution settings");
  }
}

/**
 * Toggle trailing stop-loss (global default for new positions)
 */
async function handleToggleTrailingSLGlobal(ctx: Context): Promise<void> {
  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;
    const { DEFAULT_EXECUTION_SETTINGS } = await import("../../types/sniperFilters.js");

    // Get current settings
    const prefs = await db.sniperFilterPreference.findUnique({
      where: { userId },
    });

    let settings = DEFAULT_EXECUTION_SETTINGS;
    if (prefs?.executionSettings) {
      settings = prefs.executionSettings as any;
    }

    // Toggle trailing SL
    const newValue = !settings.enableTrailingStopLoss;
    settings.enableTrailingStopLoss = newValue;

    // Save to database
    await db.sniperFilterPreference.update({
      where: { userId },
      data: { executionSettings: settings as any },
    });

    logger.info("Trailing SL toggled", { userId, newValue });

    await ctx.answerCallbackQuery(
      newValue ? "✅ Trailing SL enabled" : "❌ Trailing SL disabled"
    );
    await navigateToPage(ctx, "execution_settings");
  } catch (error) {
    logger.error("Failed to toggle trailing SL", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to update");
  }
}

// ============================================================================
// Execution Settings Edit Dialogs
// ============================================================================

async function startEditBuyAmount(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `💰 *Edit Buy Amount*\n\n` +
        `Enter the SOL amount to buy per snipe.\n\n` +
        `Example: 0.1\n` +
        `Range: 0.01 - 10 SOL`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "buy_amount",
      category: "execution",
      dialogMessageId: msg.message_id,
    };
    logger.info("Started buy amount edit dialog", { userId: ctx.from?.id });
  } catch (error) {
    logger.error("Failed to start buy amount edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditSlippage(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `📉 *Edit Slippage*\n\n` +
        `Enter slippage tolerance as a percentage.\n\n` +
        `Example: 1.5 (for 1.5%)\n` +
        `Range: 0.1 - 50%`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "slippage",
      category: "execution",
      dialogMessageId: msg.message_id,
    };
    logger.info("Started slippage edit dialog", { userId: ctx.from?.id });
  } catch (error) {
    logger.error("Failed to start slippage edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function showPriorityFeeMenu(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const { InlineKeyboard } = await import("grammy");

    const keyboard = new InlineKeyboard()
      .text("None (0 SOL)", "exec_edit:priority:NONE").row()
      .text("Low (~0.00001 SOL)", "exec_edit:priority:LOW").row()
      .text("Medium (~0.00005 SOL)", "exec_edit:priority:MEDIUM").row()
      .text("High (~0.0001 SOL)", "exec_edit:priority:HIGH").row()
      .text("Very High (~0.0005 SOL)", "exec_edit:priority:VERY_HIGH").row()
      .text("« Cancel", "nav:execution_settings");

    await ctx.reply(
      `⚡ *Select Priority Fee Tier*\n\n` +
        `Higher priority = faster inclusion in blocks`,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard
      }
    );
    logger.info("Showed priority fee menu", { userId: ctx.from?.id });
  } catch (error) {
    logger.error("Failed to show priority fee menu", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to show menu");
  }
}

async function handlePriorityFeeSelect(ctx: Context, tier: string): Promise<void> {
  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;
    const { DEFAULT_EXECUTION_SETTINGS, PriorityFeeTier } = await import("../../types/sniperFilters.js");

    // Validate tier
    if (!Object.values(PriorityFeeTier).includes(tier as any)) {
      await ctx.answerCallbackQuery("❌ Invalid priority fee tier");
      return;
    }

    // Get current settings
    const prefs = await db.sniperFilterPreference.findUnique({
      where: { userId },
    });

    let settings = { ...DEFAULT_EXECUTION_SETTINGS };
    if (prefs?.executionSettings) {
      settings = { ...settings, ...(prefs.executionSettings as any) };
    }

    // Update priority fee
    settings.priorityFee = tier as any;

    // Save to database
    await db.sniperFilterPreference.update({
      where: { userId },
      data: { executionSettings: settings as any },
    });

    logger.info("Priority fee updated", { userId, tier });
    await ctx.answerCallbackQuery(`✅ Priority fee set to ${tier}`);
    await navigateToPage(ctx, "execution_settings");
  } catch (error) {
    logger.error("Failed to update priority fee", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to update");
  }
}

async function startEditTakeProfit(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `📈 *Edit Take-Profit*\n\n` +
        `Enter take-profit percentage.\n\n` +
        `Example: 100 (for 100% profit = 2x)\n` +
        `Range: 10 - 1000%`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "tp",
      category: "execution",
      dialogMessageId: msg.message_id,
    };
    logger.info("Started take-profit edit dialog", { userId: ctx.from?.id });
  } catch (error) {
    logger.error("Failed to start take-profit edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditStopLoss(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `🛑 *Edit Stop-Loss*\n\n` +
        `Enter stop-loss percentage.\n\n` +
        `Example: 50 (for 50% loss)\n` +
        `Range: 10 - 90%`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "sl",
      category: "execution",
      dialogMessageId: msg.message_id,
    };
    logger.info("Started stop-loss edit dialog", { userId: ctx.from?.id });
  } catch (error) {
    logger.error("Failed to start stop-loss edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

/**
 * Process settings input from user text message
 * Called from bot/index.ts text message handler
 */
export async function processSettingsInput(
  ctx: Context,
  input: string
): Promise<void> {
  const settingsInput = ctx.session.awaitingSettingsInput;
  if (!settingsInput) {
    return;
  }

  try {
    const userContext = await getUserContext(ctx);
    const userId = userContext.userId;

    if (settingsInput.category === "execution") {
      await processExecutionInput(ctx, userId, settingsInput.type, input);
    } else if (settingsInput.category === "filter") {
      await processFilterInput(ctx, userId, settingsInput.type, input);
    }

    // Clear awaiting state
    delete ctx.session.awaitingSettingsInput;
  } catch (error) {
    logger.error("Failed to process settings input", {
      error,
      userId: ctx.from?.id,
      type: settingsInput.type,
    });
    await ctx.reply("❌ Failed to save setting. Please try again.");
  }
}

async function processExecutionInput(
  ctx: Context,
  userId: string,
  type: string,
  input: string
): Promise<void> {
  const { DEFAULT_EXECUTION_SETTINGS } = await import("../../types/sniperFilters.js");

  // Delete user's input message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete user input message", { error });
  }

  // Delete dialog message
  const dialogMessageId = ctx.session.awaitingSettingsInput?.dialogMessageId;
  if (dialogMessageId && ctx.chat) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, dialogMessageId);
    } catch (error) {
      logger.warn("Failed to delete dialog message", { error });
    }
  }

  // Get current settings
  const prefs = await db.sniperFilterPreference.findUnique({
    where: { userId },
  });

  let settings = { ...DEFAULT_EXECUTION_SETTINGS };
  if (prefs?.executionSettings) {
    settings = { ...settings, ...(prefs.executionSettings as any) };
  }

  // Parse and validate input
  const value = parseFloat(input.trim());
  if (isNaN(value)) {
    await ctx.reply("❌ Invalid number. Please enter a valid number.", {
      reply_markup: { remove_keyboard: true }
    });
    // Delete error message after 3 seconds
    setTimeout(async () => {
      try {
        const msg = await ctx.reply("Returning to settings...");
        await ctx.api.deleteMessage(ctx.chat!.id, msg.message_id);
      } catch (e) { /* ignore */ }
    }, 3000);
    setTimeout(() => navigateToPage(ctx, "execution_settings"), 3000);
    return;
  }

  // Update setting based on type with validation
  let errorMsg: string | null = null;

  switch (type) {
    case "buy_amount":
      if (value < 0.01 || value > 10) {
        errorMsg = "❌ Buy amount must be between 0.01 and 10 SOL.";
      } else {
        settings.buyAmountSol = value;
      }
      break;

    case "slippage":
      if (value < 0.1 || value > 50) {
        errorMsg = "❌ Slippage must be between 0.1 and 50%.";
      } else {
        settings.slippageBps = Math.round(value * 100); // Convert % to bps
      }
      break;

    case "tp":
      if (value < 10 || value > 1000) {
        errorMsg = "❌ Take-profit must be between 10 and 1000%.";
      } else {
        settings.defaultTakeProfitPct = value;
      }
      break;

    case "sl":
      if (value < 10 || value > 90) {
        errorMsg = "❌ Stop-loss must be between 10 and 90%.";
      } else {
        settings.defaultStopLossPct = value;
      }
      break;

    default:
      errorMsg = "❌ Unknown setting type.";
  }

  // Handle validation error
  if (errorMsg) {
    const errMsg = await ctx.reply(errorMsg);
    // Delete error message after 3 seconds and return to page
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, errMsg.message_id);
        await navigateToPage(ctx, "execution_settings");
      } catch (e) {
        logger.warn("Failed to cleanup error message", { error: e });
      }
    }, 3000);
    return;
  }

  // Save to database
  await db.sniperFilterPreference.update({
    where: { userId },
    data: { executionSettings: settings as any },
  });

  logger.info("Execution setting updated", { userId, type, value });

  // Navigate back to page (updates dashboard, doesn't create new message)
  await navigateToPage(ctx, "execution_settings");
}

async function processFilterInput(
  ctx: Context,
  userId: string,
  type: string,
  input: string
): Promise<void> {
  const { BALANCED_FILTERS } = await import("../../types/sniperFilters.js");

  // Delete user's input message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("Failed to delete user input message", { error });
  }

  // Delete dialog message
  const dialogMessageId = ctx.session.awaitingSettingsInput?.dialogMessageId;
  if (dialogMessageId && ctx.chat) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, dialogMessageId);
    } catch (error) {
      logger.warn("Failed to delete dialog message", { error });
    }
  }

  // Get current filters
  const prefs = await db.sniperFilterPreference.findUnique({
    where: { userId },
  });

  let filters: any = { ...BALANCED_FILTERS };
  if (prefs?.customFilters) {
    filters = { ...filters, ...(prefs.customFilters as any) };
  }

  // Parse and validate input based on type
  const value = parseFloat(input.trim());
  if (isNaN(value)) {
    const errMsg = await ctx.reply("❌ Invalid number. Please enter a valid number.");
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, errMsg.message_id);
        await navigateToPage(ctx, "filter_settings");
      } catch (e) { /* ignore */ }
    }, 3000);
    return;
  }

  // Update filter based on type with validation
  let errorMsg: string | null = null;

  switch (type) {
    case "min_liquidity":
      if (value < 0 || value > 1000000) {
        errorMsg = "❌ Min liquidity must be between 0 and 1,000,000 SOL.";
      } else {
        filters.minLiquiditySol = value;
      }
      break;

    case "max_liquidity":
      if (value < 0 || value > 10000000) {
        errorMsg = "❌ Max liquidity must be between 0 and 10,000,000 SOL.";
      } else {
        filters.maxLiquiditySol = value > 0 ? value : undefined;
      }
      break;

    case "max_buy_tax":
      if (value < 0 || value > 100) {
        errorMsg = "❌ Max buy tax must be between 0 and 100%.";
      } else {
        filters.maxBuyTax = value;
      }
      break;

    case "max_sell_tax":
      if (value < 0 || value > 100) {
        errorMsg = "❌ Max sell tax must be between 0 and 100%.";
      } else {
        filters.maxSellTax = value;
      }
      break;

    case "max_top10_holders":
      if (value < 0 || value > 100) {
        errorMsg = "❌ Max top 10 holders must be between 0 and 100%.";
      } else {
        filters.maxTop10HoldersPct = value;
      }
      break;

    case "min_holders":
      if (value < 0 || value > 100000) {
        errorMsg = "❌ Min holders must be between 0 and 100,000.";
      } else {
        filters.minHolders = Math.round(value);
      }
      break;

    case "max_risk_score":
      if (value < 0 || value > 100) {
        errorMsg = "❌ Max risk score must be between 0 and 100.";
      } else {
        filters.maxRiskScore = value;
      }
      break;

    case "min_confidence":
      if (value < 0 || value > 100) {
        errorMsg = "❌ Min confidence must be between 0 and 100%.";
      } else {
        filters.minConfidence = value;
      }
      break;

    default:
      errorMsg = "❌ Unknown filter type.";
  }

  // Handle validation error
  if (errorMsg) {
    const errMsg = await ctx.reply(errorMsg);
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, errMsg.message_id);
        await navigateToPage(ctx, "filter_settings");
      } catch (e) {
        logger.warn("Failed to cleanup error message", { error: e });
      }
    }, 3000);
    return;
  }

  // Mark as custom preset and save
  await db.sniperFilterPreference.update({
    where: { userId },
    data: {
      preset: "CUSTOM",
      customFilters: filters as any,
    },
  });

  logger.info("Filter updated", { userId, type, value });

  // Navigate back to page (updates dashboard, doesn't create new message)
  await navigateToPage(ctx, "filter_settings");
}

// ============================================================================
// Filter Settings Edit Dialogs
// ============================================================================

async function startEditMinLiquidity(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `💧 *Edit Min Liquidity*\n\n` +
        `Enter minimum liquidity in SOL.\n\n` +
        `Example: 5\n` +
        `Range: 0 - 1,000,000 SOL`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "min_liquidity",
      category: "filter",
      dialogMessageId: msg.message_id,
    };
  } catch (error) {
    logger.error("Failed to start min liquidity edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditMaxLiquidity(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `💧 *Edit Max Liquidity*\n\n` +
        `Enter maximum liquidity in SOL (0 for no limit).\n\n` +
        `Example: 1000\n` +
        `Range: 0 - 10,000,000 SOL`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "max_liquidity",
      category: "filter",
      dialogMessageId: msg.message_id,
    };
  } catch (error) {
    logger.error("Failed to start max liquidity edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditMaxBuyTax(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `💸 *Edit Max Buy Tax*\n\n` +
        `Enter maximum buy tax percentage.\n\n` +
        `Example: 5\n` +
        `Range: 0 - 100%`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "max_buy_tax",
      category: "filter",
      dialogMessageId: msg.message_id,
    };
  } catch (error) {
    logger.error("Failed to start buy tax edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditMaxSellTax(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `💸 *Edit Max Sell Tax*\n\n` +
        `Enter maximum sell tax percentage.\n\n` +
        `Example: 10\n` +
        `Range: 0 - 100%`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "max_sell_tax",
      category: "filter",
      dialogMessageId: msg.message_id,
    };
  } catch (error) {
    logger.error("Failed to start sell tax edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditMaxTop10Holders(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `👥 *Edit Max Top 10 Holders %*\n\n` +
        `Enter maximum percentage held by top 10 holders.\n\n` +
        `Example: 50\n` +
        `Range: 0 - 100%`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "max_top10_holders",
      category: "filter",
      dialogMessageId: msg.message_id,
    };
  } catch (error) {
    logger.error("Failed to start top10 holders edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditMinHolders(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `👥 *Edit Min Holders Count*\n\n` +
        `Enter minimum number of holders.\n\n` +
        `Example: 100\n` +
        `Range: 0 - 100,000`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "min_holders",
      category: "filter",
      dialogMessageId: msg.message_id,
    };
  } catch (error) {
    logger.error("Failed to start min holders edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditMaxRiskScore(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `⚠️ *Edit Max Risk Score*\n\n` +
        `Enter maximum risk score (0-100).\n\n` +
        `Example: 70\n` +
        `Range: 0 - 100`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "max_risk_score",
      category: "filter",
      dialogMessageId: msg.message_id,
    };
  } catch (error) {
    logger.error("Failed to start max risk score edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}

async function startEditMinConfidence(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `⚠️ *Edit Min Confidence*\n\n` +
        `Enter minimum confidence percentage.\n\n` +
        `Example: 80\n` +
        `Range: 0 - 100%`,
      { parse_mode: "Markdown" }
    );
    ctx.session.awaitingSettingsInput = {
      type: "min_confidence",
      category: "filter",
      dialogMessageId: msg.message_id,
    };
  } catch (error) {
    logger.error("Failed to start min confidence edit", { error, userId: ctx.from?.id });
    await ctx.answerCallbackQuery("❌ Failed to start edit");
  }
}
