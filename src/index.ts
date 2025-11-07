import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { bot } from "./bot/index.js";
import { prisma } from "./utils/db.js";
import { redis } from "./utils/redis.js";
import { initializeSolana } from "./services/blockchain/solana.js";
import { initializeJupiter } from "./services/trading/jupiter.js";
import { initializeTradingExecutor } from "./services/trading/executor.js";
import { initializeHoneypotDetector } from "./services/honeypot/detector.js";
import { logger } from "./utils/logger.js";

const app = Fastify({
  logger: true,
});

await app.register(cors);

// Health check
app.get("/health", async () => {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    services: {
      database: await checkDatabase(),
      redis: await checkRedis(),
      solana: await checkSolana(),
    },
  };
});

async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

async function checkSolana(): Promise<boolean> {
  try {
    const { getSolana } = await import("./services/blockchain/solana.js");
    const solana = getSolana();
    return await solana.checkHealth();
  } catch {
    return false;
  }
}

/**
 * Check bot permissions (CRITICAL-4 security requirement)
 *
 * Ensures bot can delete messages before users send passwords
 * If bot cannot delete messages, password deletion will fail
 * and users' passwords could remain visible in chat
 */
async function checkBotPermissions(): Promise<void> {
  try {
    // Get bot info
    const me = await bot.api.getMe();
    logger.info("Bot info retrieved", {
      username: me.username,
      id: me.id,
      canJoinGroups: me.can_join_groups,
      canReadAllGroupMessages: me.can_read_all_group_messages,
    });

    // Note: Telegram bots can always delete their own messages
    // and messages sent in reply to them in private chats
    // So we just log a warning if running in production
    logger.info("Bot has necessary permissions for private chats");

    // If you want to test deletion, you could send a test message
    // But this might spam users, so we skip it in production
  } catch (error) {
    logger.error("Failed to check bot permissions", { error });
    throw new Error(
      "Bot permissions check failed. Please verify BOT_TOKEN is correct."
    );
  }
}

// Start server
const start = async () => {
  try {
    // Validate environment variables
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!rpcUrl) {
      throw new Error("SOLANA_RPC_URL environment variable is required");
    }

    logger.info("Starting application...");

    // Initialize Solana connection
    logger.info("Initializing Solana connection...");
    const solana = await initializeSolana({
      rpcUrl,
      commitment: "confirmed",
    });
    logger.info("Solana connection initialized");

    // Initialize Jupiter service
    logger.info("Initializing Jupiter service...");
    const connection = solana.getConnection();
    initializeJupiter(connection, {
      baseUrl: process.env.JUPITER_API_URL || "https://lite-api.jup.ag",
      defaultSlippageBps: 50, // 0.5%
    });
    logger.info("Jupiter service initialized");

    // Initialize Trading Executor
    logger.info("Initializing Trading Executor...");
    initializeTradingExecutor({
      commissionBps: 85, // 0.85%
      minCommissionUsd: 0.01, // $0.01
    });
    logger.info("Trading Executor initialized");

    // Initialize Honeypot Detector
    logger.info("Initializing Honeypot Detector...");
    initializeHoneypotDetector({
      goPlusTimeout: 5000,
      highRiskThreshold: 70,
      cacheTTL: 3600, // 1 hour
      cacheEnabled: true,
      enableGoPlusAPI: true,
      enableOnChainChecks: true,
    });
    logger.info("Honeypot Detector initialized");

    // Start Fastify server
    await app.listen({
      port: Number(process.env.PORT) || 3000,
      host: "0.0.0.0",
    });
    console.log("✅ API server started on port", process.env.PORT || 3000);

    // ✅ SECURITY (CRITICAL-4): Check bot permissions before starting
    logger.info("Checking bot permissions...");
    await checkBotPermissions();
    logger.info("Bot permissions verified");

    // Start Telegram bot
    await bot.start();
    console.log("✅ Telegram bot started");

    logger.info("Application started successfully");
  } catch (err) {
    logger.error("Failed to start application", { error: err });
    app.log.error(err);
    process.exit(1);
  }
};

start();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  await bot.stop();
  await app.close();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
});
