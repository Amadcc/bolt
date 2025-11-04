/**
 * Jupiter integration test
 * Tests quote fetching from Jupiter v6 API
 */

import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { JupiterService } from "./services/trading/jupiter.js";
import { asTokenMint } from "./types/common.js";
import { logger } from "./utils/logger.js";

// Known token mints
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function testJupiter() {
  logger.info("🧪 Starting Jupiter integration test...");

  // Initialize Solana connection
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL not set in environment");
  }

  const connection = new Connection(rpcUrl, "confirmed");
  logger.info("Solana connection initialized", { rpcUrl });

  // Initialize Jupiter service
  const jupiter = new JupiterService(connection, {
    baseUrl: "https://lite-api.jup.ag",
    timeout: 15000,
    defaultSlippageBps: 50,
  });

  try {
    // Test 1: Get quote for SOL → USDC swap
    logger.info("\n📋 Test 1: Get quote for SOL → USDC (0.01 SOL)");

    const quoteResult = await jupiter.getQuote({
      inputMint: asTokenMint(SOL_MINT),
      outputMint: asTokenMint(USDC_MINT),
      amount: "10000000", // 0.01 SOL
      userPublicKey: "vBXNsd5SRtTPpW7GWv3wREA6Ztm2jCWp5eqqTsVhyG5", // Dummy address for quote
      slippageBps: 50,
    });

    if (!quoteResult.success) {
      logger.error("❌ Failed to get quote", { error: quoteResult.error });
      throw new Error("Quote fetch failed");
    }

    const quote = quoteResult.value;

    logger.info("✅ Quote fetched successfully", {
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      inUsdValue: quote.inUsdValue,
      outUsdValue: quote.outUsdValue,
      priceImpact: (quote.priceImpact * 100).toFixed(4) + "%",
      router: quote.router,
      slippageBps: quote.slippageBps,
      requestId: quote.requestId,
    });

    // Validate quote response
    if (!quote.transaction) {
      logger.error("❌ No transaction in quote response");
      throw new Error("No transaction returned");
    }

    logger.info("✅ Transaction data present in quote");

    // Test 2: Get token price
    logger.info("\n📋 Test 2: Get SOL price");

    const priceResult = await jupiter.getTokenPrice(asTokenMint(SOL_MINT));

    if (!priceResult.success) {
      logger.error("❌ Failed to get token price", {
        error: priceResult.error,
      });
      throw new Error("Price fetch failed");
    }

    logger.info("✅ Token price fetched", {
      mint: SOL_MINT,
      price: priceResult.value.toFixed(2) + " USD",
    });

    // Test 3: Get quote for USDC → SOL swap
    logger.info("\n📋 Test 3: Get quote for USDC → SOL (1 USDC)");

    const reverseQuoteResult = await jupiter.getQuote({
      inputMint: asTokenMint(USDC_MINT),
      outputMint: asTokenMint(SOL_MINT),
      amount: "1000000", // 1 USDC (6 decimals)
      userPublicKey: "vBXNsd5SRtTPpW7GWv3wREA6Ztm2jCWp5eqqTsVhyG5",
      slippageBps: 50,
    });

    if (!reverseQuoteResult.success) {
      logger.error("❌ Failed to get reverse quote", {
        error: reverseQuoteResult.error,
      });
      throw new Error("Reverse quote fetch failed");
    }

    const reverseQuote = reverseQuoteResult.value;

    logger.info("✅ Reverse quote fetched successfully", {
      inputMint: reverseQuote.inputMint,
      outputMint: reverseQuote.outputMint,
      inAmount: reverseQuote.inAmount,
      outAmount: reverseQuote.outAmount,
      priceImpact: (reverseQuote.priceImpact * 100).toFixed(4) + "%",
      router: reverseQuote.router,
    });

    logger.info("\n🎉 All Jupiter tests passed!");

  } catch (error) {
    logger.error("Test failed", { error });
    throw error;
  }
}

testJupiter().catch((error) => {
  logger.error("Test suite failed", { error });
  process.exit(1);
});
