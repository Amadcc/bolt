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
export function createSwapConfirmationKeyboard(
  inputToken: string,
  outputToken: string,
  amount: string
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "✅ Confirm Swap",
      `swap:confirm:${inputToken}:${outputToken}:${amount}`
    )
    .row()
    .text("« Cancel", "nav:swap");
}

/**
 * Create a buy confirmation keyboard
 */
export function createBuyConfirmationKeyboard(
  tokenSymbol: string,
  solAmount: number
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      `✅ Buy ${tokenSymbol}`,
      `buy:confirm:${tokenSymbol}:${solAmount}`
    )
    .row()
    .text("« Cancel", "nav:buy");
}

/**
 * Create a sell confirmation keyboard
 */
export function createSellConfirmationKeyboard(
  tokenSymbol: string,
  tokenAmount: string
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      `✅ Sell ${tokenSymbol}`,
      `sell:confirm:${tokenSymbol}:${tokenAmount}`
    )
    .row()
    .text("« Cancel", "nav:sell");
}
