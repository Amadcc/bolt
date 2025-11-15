/**
 * /fees Command
 *
 * Shows transparent breakdown of all fees and costs
 */

import type { Context } from "../views/index.js";
import { logger } from "../../utils/logger.js";

/**
 * Get current SOL price in USD (mock - replace with real price feed)
 */
async function getSolPriceUsd(): Promise<number> {
  // TODO: Integrate with real price feed (Jupiter, Pyth, etc)
  return 200; // Mock price for now
}

export async function handleFees(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;

  if (!telegramId) {
    await ctx.reply("❌ Unable to identify user");
    return;
  }

  try {
    const solPrice = await getSolPriceUsd();

    // Calculate fee amounts
    const jitoTipLamports = parseInt(process.env.JITO_TIP_LAMPORTS || "100000");
    const jitoTipSol = jitoTipLamports / 1e9;
    const jitoTipUsd = jitoTipSol * solPrice;

    const networkFeeLamports = 5000; // Typical Solana transaction fee
    const networkFeeSol = networkFeeLamports / 1e9;
    const networkFeeUsd = networkFeeSol * solPrice;

    const jupiterFeePercent = "0-0.05%"; // Jupiter routing fees vary

    // Build fees message
    let message = `💰 *Fee Transparency*\n\n`;
    message += `We believe in complete transparency. Here's a breakdown of all fees:\n\n`;

    // 1. Jito MEV Protection
    message += `🛡️ *Jito MEV Protection*\n`;
    message += `• Amount: ${jitoTipSol.toFixed(6)} SOL (~$${jitoTipUsd.toFixed(4)})\n`;
    message += `• Purpose: Protects your trades from front-running and sandwich attacks\n`;
    message += `• Goes to: Jito validators (not us)\n`;
    message += `• Status: ${process.env.JITO_ENABLED !== "false" ? "✅ Enabled" : "❌ Disabled"}\n\n`;

    // 2. Jupiter Routing Fees
    message += `🔀 *Jupiter Routing Fees*\n`;
    message += `• Amount: ${jupiterFeePercent} of swap\n`;
    message += `• Purpose: Finds best swap routes across all DEXs\n`;
    message += `• Goes to: Jupiter Protocol (not us)\n`;
    message += `• Note: Varies by route complexity\n\n`;

    // 3. Solana Network Fees
    message += `⛓️ *Solana Network Fees*\n`;
    message += `• Amount: ${networkFeeSol.toFixed(6)} SOL (~$${networkFeeUsd.toFixed(4)})\n`;
    message += `• Purpose: Standard blockchain transaction fee\n`;
    message += `• Goes to: Solana validators (not us)\n`;
    message += `• Note: Required for all Solana transactions\n\n`;

    // 4. Platform Commission
    message += `📊 *Platform Commission*\n`;
    message += `• Amount: 0% (No commission!)\n`;
    message += `• Note: We don't take any cut from your trades\n\n`;

    // Total estimate
    const totalUsd = jitoTipUsd + networkFeeUsd;
    message += `💵 *Estimated Total per Trade*\n`;
    message += `• Fixed Fees: ~$${totalUsd.toFixed(4)}\n`;
    message += `• Variable Fees: Jupiter routing (${jupiterFeePercent})\n\n`;

    // Example
    message += `📝 *Example: $100 Swap*\n`;
    message += `• You pay: $100.00\n`;
    message += `• Jito MEV: $${jitoTipUsd.toFixed(4)}\n`;
    message += `• Network: $${networkFeeUsd.toFixed(4)}\n`;
    message += `• Jupiter: ~$0.01-0.05\n`;
    message += `• Platform: $0.00\n`;
    message += `• *Net trade value*: ~$${(100 - totalUsd - 0.05).toFixed(2)}\n\n`;

    // Footer
    message += `ℹ️ *Notes*\n`;
    message += `• All fees go to third-party services (Jito, Jupiter, Solana)\n`;
    message += `• We operate on a no-commission model\n`;
    message += `• MEV protection can be disabled to save ~$${jitoTipUsd.toFixed(4)} per trade\n`;
    message += `• Prices are estimates and may vary\n\n`;

    message += `Questions? Contact support or check our docs.`;

    await ctx.reply(message, { parse_mode: "Markdown" });

    logger.info("Fees info displayed", {
      telegramId,
      jitoEnabled: process.env.JITO_ENABLED !== "false",
      jitoTipLamports,
      solPrice,
    });
  } catch (error) {
    logger.error("Error in fees command", { telegramId, error });
    await ctx.reply(
      "❌ Failed to fetch fee information.\n\n" +
        "Please try again later or contact support."
    );
  }
}
