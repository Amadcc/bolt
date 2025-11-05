import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { bot } from "./bot/index.js";
import { prisma } from "./utils/db.js";
import { redis } from "./utils/redis.js";
import { initializeSolana } from "./services/blockchain/solana.js";
import { initializeJupiter } from "./services/trading/jupiter.js";
import { initializeTradingExecutor } from "./services/trading/executor.js";
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

    // Start Fastify server
    await app.listen({
      port: Number(process.env.PORT) || 3000,
      host: "0.0.0.0",
    });
    console.log("✅ API server started on port", process.env.PORT || 3000);

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
