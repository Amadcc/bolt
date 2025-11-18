/**
 * Sniper Bot Views
 * Single-page UI for sniper management, configuration, and position monitoring
 */

import { InlineKeyboard } from "grammy";
import type { Context } from "./index.js";
import { prisma as db } from "../../utils/db.js";
import { getUserContext } from "../utils/userContext.js";

// ============================================================================
// Main Sniper Page
// ============================================================================

/**
 * Main sniper dashboard - start/stop auto-sniper, view stats
 */
export async function renderSniperMainPage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);
  const userId = userContext.userId;

  // Get sniper status from database
  const filterPreference = await db.sniperFilterPreference.findUnique({
    where: { userId },
  });

  const isActive = filterPreference?.autoSniperEnabled ?? false;
  const preset = filterPreference?.preset ?? "BALANCED";

  // Get stats
  const [totalOrders, successfulOrders, openPositions] = await Promise.all([
    db.sniperOrder.count({
      where: { userId },
    }),
    db.sniperOrder.count({
      where: { userId, status: "CONFIRMED" },
    }),
    db.sniperPosition.count({
      where: { userId, status: "OPEN" },
    }),
  ]);

  const winRate = totalOrders > 0
    ? ((successfulOrders / totalOrders) * 100).toFixed(1)
    : "0.0";

  const statusEmoji = isActive ? "🟢" : "🔴";
  const statusText = isActive ? "Active" : "Stopped";

  const text =
    `🎯 *Sniper Bot*\n\n` +
    `Status: ${statusEmoji} *${statusText}*\n` +
    `Filter: ${preset}\n\n` +
    `━━━ Statistics ━━━\n\n` +
    `Total Snipes: ${totalOrders}\n` +
    `Successful: ${successfulOrders}\n` +
    `Win Rate: ${winRate}%\n` +
    `Open Positions: ${openPositions}\n\n` +
    (isActive
      ? `✅ Auto-sniper is monitoring new pools\n\nThe bot will automatically detect and execute trades on new token launches that match your filters.`
      : `❌ Auto-sniper is stopped\n\nTap **Start Sniper** to begin monitoring new pools.`);

  const keyboard = new InlineKeyboard();

  if (isActive) {
    keyboard.text("⏸️ Stop Sniper", "sniper:stop");
  } else {
    keyboard.text("▶️ Start Sniper", "sniper:start");
  }

  keyboard
    .row()
    .text("⚙️ Configure Filters", "nav:sniper_config")
    .row()
    .text("📊 View Positions", "nav:positions")
    .row()
    .text("🚨 Emergency Exit All", "sniper:exitall_confirm")
    .row()
    .text("« Back to Dashboard", "nav:main");

  return { text, keyboard };
}

// ============================================================================
// Sniper Configuration Page
// ============================================================================

/**
 * Configure sniper filters - preset or custom
 */
export async function renderSniperConfigPage(ctx: Context): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);
  const userId = userContext.userId;

  // Get current filter preference
  const filterPreference = await db.sniperFilterPreference.findUnique({
    where: { userId },
  });

  const currentPreset = filterPreference?.preset ?? "BALANCED";

  const text =
    `⚙️ *Sniper Configuration*\n\n` +
    `Current: *${currentPreset}*\n\n` +
    `━━━ Presets ━━━\n\n` +
    `**CONSERVATIVE** (5-10% hit rate)\n` +
    `• Min liquidity: 10 SOL\n` +
    `• Max dev holdings: 5%\n` +
    `• Freeze/mint authority revoked\n` +
    `• Very safe, few opportunities\n\n` +
    `**BALANCED** (15-25% hit rate)\n` +
    `• Min liquidity: 5 SOL\n` +
    `• Max dev holdings: 10%\n` +
    `• Moderate risk/reward\n\n` +
    `**AGGRESSIVE** (40-60% hit rate)\n` +
    `• Min liquidity: 2 SOL\n` +
    `• Max dev holdings: 20%\n` +
    `• Higher risk, more opportunities\n\n` +
    `Select a preset below:`;

  const keyboard = new InlineKeyboard()
    .text(
      currentPreset === "CONSERVATIVE" ? "✅ Conservative" : "Conservative",
      "sniper_config:preset:CONSERVATIVE"
    )
    .row()
    .text(
      currentPreset === "BALANCED" ? "✅ Balanced" : "Balanced",
      "sniper_config:preset:BALANCED"
    )
    .row()
    .text(
      currentPreset === "AGGRESSIVE" ? "✅ Aggressive" : "Aggressive",
      "sniper_config:preset:AGGRESSIVE"
    )
    .row()
    .text("🔧 Advanced Settings", "sniper_config:advanced")
    .row()
    .text("« Back to Sniper", "nav:sniper");

  return { text, keyboard };
}

/**
 * Advanced sniper settings (buy amount, slippage, priority fees)
 */
export async function renderAdvancedSniperConfigPage(): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const text =
    `🔧 *Advanced Settings*\n\n` +
    `Configure sniper execution parameters:\n\n` +
    `• Buy amount per snipe\n` +
    `• Slippage tolerance\n` +
    `• Priority fee tier\n` +
    `• Take-profit / Stop-loss defaults\n\n` +
    `⚠️ Coming soon...`;

  const keyboard = new InlineKeyboard()
    .text("« Back", "nav:sniper_config");

  return { text, keyboard };
}

// ============================================================================
// Positions Page
// ============================================================================

const POSITIONS_PER_PAGE = 5;

/**
 * View active positions with pagination
 */
export async function renderPositionsPage(
  ctx: Context,
  page = 0
): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);
  const userId = userContext.userId;

  // Get total count
  const totalPositions = await db.sniperPosition.count({
    where: { userId, status: "OPEN" },
  });

  if (totalPositions === 0) {
    const text =
      `📊 *Your Positions*\n\n` +
      `No open positions yet.\n\n` +
      `Start the sniper to automatically open positions on new launches!`;

    const keyboard = new InlineKeyboard()
      .text("🎯 Go to Sniper", "nav:sniper")
      .row()
      .text("« Back to Dashboard", "nav:main");

    return { text, keyboard };
  }

  // Get positions for current page
  const positions = await db.sniperPosition.findMany({
    where: { userId, status: "OPEN" },
    include: {
      monitor: true,
    },
    orderBy: { openedAt: "desc" },
    skip: page * POSITIONS_PER_PAGE,
    take: POSITIONS_PER_PAGE,
  });

  const totalPages = Math.ceil(totalPositions / POSITIONS_PER_PAGE);
  const currentPage = page + 1;

  let text = `📊 *Your Positions*\n\n`;
  text += `Page ${currentPage}/${totalPages} • ${totalPositions} open\n\n`;
  text += `━━━\n\n`;

  for (const position of positions) {
    const tokenSymbol = position.tokenMint.slice(0, 6) + "...";
    const entrySOL = Number(position.amountIn) / 1e9;
    const currentBalance = Number(position.currentBalance);

    // Calculate unrealized P&L if monitor has current price
    let pnlText = "";
    if (position.monitor?.currentPrice) {
      const currentPrice = Number(position.monitor.currentPrice);
      const entryPrice = Number(position.monitor.entryPrice);
      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      const pnlEmoji = pnlPct >= 0 ? "🟢" : "🔴";
      pnlText = `${pnlEmoji} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;
    }

    // TP/SL indicators
    const tpText = position.takeProfitPct ? ` TP: ${position.takeProfitPct}%` : "";
    const slText = position.stopLossPct ? ` SL: ${position.stopLossPct}%` : "";

    text += `**${tokenSymbol}**\n`;
    text += `Entry: ${entrySOL.toFixed(4)} SOL\n`;
    text += `Balance: ${formatTokenAmount(currentBalance)}\n`;
    if (pnlText) {
      text += `P&L: ${pnlText}\n`;
    }
    if (tpText || slText) {
      text += `${tpText}${slText}\n`;
    }
    text += `\n`;
  }

  const keyboard = new InlineKeyboard();

  // Position action buttons
  if (positions.length === 1) {
    // Single position - show quick actions
    const positionId = positions[0].id;
    keyboard
      .text("📈 Set TP", `position:settp:${positionId}`)
      .text("📉 Set SL", `position:setsl:${positionId}`)
      .row()
      .text("❌ Close", `position:close:${positionId}`)
      .text("📊 Details", `position:details:${positionId}`)
      .row();
  } else {
    // Multiple positions - show list
    keyboard.text("📝 Select position for details", "action:noop").row();
  }

  // Pagination
  if (totalPages > 1) {
    if (page > 0) {
      keyboard.text("◀️ Prev", `positions:page:${page - 1}`);
    }
    if (page < totalPages - 1) {
      keyboard.text("Next ▶️", `positions:page:${page + 1}`);
    }
    keyboard.row();
  }

  keyboard
    .text("🔄 Refresh", `positions:page:${page}`)
    .row()
    .text("« Back to Sniper", "nav:sniper");

  return { text, keyboard };
}

// ============================================================================
// Position Details Page
// ============================================================================

/**
 * Detailed view of a single position with TP/SL management
 */
export async function renderPositionDetailsPage(
  ctx: Context,
  positionId: string
): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const userContext = await getUserContext(ctx);
  const userId = userContext.userId;

  // Get position with monitor
  const position = await db.sniperPosition.findFirst({
    where: { id: positionId, userId },
    include: {
      monitor: true,
    },
  });

  if (!position) {
    const text = `❌ Position not found or already closed.`;
    const keyboard = new InlineKeyboard().text("« Back", "nav:positions");
    return { text, keyboard };
  }

  const entrySOL = Number(position.amountIn) / 1e9;
  const tokensReceived = Number(position.amountOut);
  const currentBalance = Number(position.currentBalance);

  // Calculate entry price
  const entryPrice = position.monitor?.entryPrice
    ? Number(position.monitor.entryPrice)
    : 0;

  // Calculate unrealized P&L
  let pnlText = "Calculating...";
  let pnlLamports = 0;
  if (position.monitor?.currentPrice && entryPrice > 0) {
    const currentPrice = Number(position.monitor.currentPrice);
    const currentValue = currentBalance * currentPrice;
    pnlLamports = Math.floor((currentValue - entrySOL) * 1e9);
    const pnlSOL = pnlLamports / 1e9;
    const pnlPct = ((currentValue - entrySOL) / entrySOL) * 100;
    const pnlEmoji = pnlPct >= 0 ? "🟢" : "🔴";
    pnlText = `${pnlEmoji} ${pnlSOL >= 0 ? "+" : ""}${pnlSOL.toFixed(4)} SOL (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`;
  }

  // Monitor status
  const monitorStatus = position.monitor?.status ?? "N/A";
  const monitorEmoji = monitorStatus === "ACTIVE" ? "🟢" : "⏸️";

  // TP/SL prices
  const tpPrice = position.monitor?.takeProfitPrice
    ? Number(position.monitor.takeProfitPrice).toExponential(4)
    : "Not set";
  const slPrice = position.monitor?.stopLossPrice
    ? Number(position.monitor.stopLossPrice).toExponential(4)
    : "Not set";

  const text =
    `📊 *Position Details*\n\n` +
    `Token: \`${position.tokenMint}\`\n\n` +
    `━━━ Entry ━━━\n\n` +
    `SOL Spent: ${entrySOL.toFixed(4)} SOL\n` +
    `Tokens Received: ${formatTokenAmount(tokensReceived)}\n` +
    `Entry Price: ${entryPrice.toExponential(4)} SOL\n` +
    `Entry TX: \`${position.entrySignature.slice(0, 16)}...\`\n\n` +
    `━━━ Current ━━━\n\n` +
    `Balance: ${formatTokenAmount(currentBalance)}\n` +
    `Unrealized P&L: ${pnlText}\n\n` +
    `━━━ Monitor ━━━\n\n` +
    `Status: ${monitorEmoji} ${monitorStatus}\n` +
    `Take-Profit: ${tpPrice}\n` +
    `Stop-Loss: ${slPrice}\n` +
    `Trailing SL: ${position.trailingStopLoss ? "✅ Enabled" : "❌ Disabled"}\n\n` +
    `Opened: ${position.openedAt.toLocaleString()}`;

  const keyboard = new InlineKeyboard()
    .text("📈 Set TP", `position:settp:${positionId}`)
    .text("📉 Set SL", `position:setsl:${positionId}`)
    .row()
    .text("🔄 Toggle Trailing SL", `position:toggle_trailing:${positionId}`)
    .row()
    .text("❌ Close Position", `position:close:${positionId}`)
    .row()
    .text("🔗 View on Solscan", `position:view_tx:${position.entrySignature}`)
    .row()
    .text("« Back to Positions", "nav:positions");

  return { text, keyboard };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format token amount with appropriate decimals
 */
function formatTokenAmount(amount: number): string {
  if (amount >= 1_000_000_000) {
    return (amount / 1_000_000_000).toFixed(2) + "B";
  }
  if (amount >= 1_000_000) {
    return (amount / 1_000_000).toFixed(2) + "M";
  }
  if (amount >= 1_000) {
    return (amount / 1_000).toFixed(2) + "K";
  }
  if (amount >= 1) {
    return amount.toFixed(2);
  }
  return amount.toExponential(2);
}
