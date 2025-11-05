/**
 * Inline keyboards for swap confirmation
 */

import { InlineKeyboard } from "grammy";

// ============================================================================
// Swap Confirmation Keyboard
// ============================================================================

/**
 * Create a swap confirmation keyboard
 */
export function createSwapConfirmationKeyboard(swapId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm Swap", `swap_confirm:${swapId}`)
    .text("❌ Cancel", `swap_cancel:${swapId}`);
}

/**
 * Create a buy confirmation keyboard
 */
export function createBuyConfirmationKeyboard(
  tokenSymbol: string,
  solAmount: number
): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ Buy ${tokenSymbol}`, `buy_confirm:${tokenSymbol}:${solAmount}`)
    .text("❌ Cancel", "buy_cancel");
}

/**
 * Create a sell confirmation keyboard
 */
export function createSellConfirmationKeyboard(
  tokenSymbol: string,
  tokenAmount: string
): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ Sell ${tokenSymbol}`, `sell_confirm:${tokenSymbol}:${tokenAmount}`)
    .text("❌ Cancel", "sell_cancel");
}
