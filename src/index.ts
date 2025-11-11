import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { bot } from "./bot/index.js";
import { prisma } from "./utils/db.js";
import { checkRedisHealth, closeRedis } from "./utils/redis.js";
import { initializeSolana } from "./services/blockchain/solana.js";
import { initializeJupiter } from "./services/trading/jupiter.js";
import { initializeTradingExecutor } from "./services/trading/executor.js";
import { initializeHoneypotDetector } from "./services/honeypot/detector.js";
import { initializeJitoService } from "./services/trading/jito.js";
import { logger } from "./utils/logger.js";
import { getMetrics, metricsRegistry } from "./utils/metrics.js";

const app = Fastify({
  logger: true,
});

// ============================================================================
// CORS Configuration with Origin Whitelist
// ============================================================================

// Parse allowed origins from environment variable
const ALLOWED_ORIGINS =
  process.env.ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()) || [];

logger.info("CORS configuration initialized", {
  allowedOriginsCount: ALLOWED_ORIGINS.length,
  allowedOrigins: ALLOWED_ORIGINS,
});

await app.register(cors, {
  // Origin validation callback
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman, etc.)
    if (!origin) {
      callback(null, true);
      return;
    }

    // Check if origin is in whitelist
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }

    // Block origin and log
    logger.warn("CORS blocked origin", {
      origin,
      allowedOrigins: ALLOWED_ORIGINS,
    });

    callback(new Error("Not allowed by CORS"), false);
  },

  // Security settings
  credentials: true, // Allow cookies and authorization headers

  // Restrict HTTP methods
  methods: ["GET", "POST"],

  // Restrict headers
  allowedHeaders: ["Content-Type", "Authorization"],

  // Cache preflight requests for 1 hour
  maxAge: 3600,
});

// Health check
app.get("/health", async () => {
  // Run all health checks in parallel for faster response
  const [database, redisHealth, solana] = await Promise.all([
    checkDatabase(),
    checkRedisHealth(),
    checkSolana(),
  ]);

  // Determine overall status
  const allHealthy = database && redisHealth.healthy && solana;
  const status = allHealthy ? "ok" : "degraded";

  return {
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: {
        healthy: database,
      },
      redis: {
        healthy: redisHealth.healthy,
        latencyMs: redisHealth.latencyMs,
        serverInfo: redisHealth.serverInfo,
        error: redisHealth.error,
      },
      solana: {
        healthy: solana,
      },
    },
  };
});

app.get("/metrics", async (_, reply) => {
  reply.header("Content-Type", metricsRegistry.contentType);
  return getMetrics();
});

async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function checkSolana(): Promise<boolean> {
  try {
    const { getSolana } = await import("./services/blockchain/solana.js");
    const solana = getSolana();
    const health = await solana.checkHealth();
    return health.healthy > 0;
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
    const connection = await solana.getConnection();
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

    // Initialize Jito MEV Protection
    logger.info("Initializing Jito MEV Protection...");
    // AUDIT FIX: Support multiple Block Engine URLs for failover
    const jitoUrls = process.env.JITO_BLOCK_ENGINE_URL
      ? process.env.JITO_BLOCK_ENGINE_URL.split(",").map((url) => url.trim())
      : undefined; // Will use defaults if not specified

    // AUDIT FIX: Pass SolanaService instead of Connection for RPCPool integration
    initializeJitoService(solana, {
      ...(jitoUrls && { blockEngineUrls: jitoUrls }),
      tipLamports: BigInt(process.env.JITO_TIP_LAMPORTS || "100000"),
      // AUDIT FIX: Enable by default, allow explicit disable
      enabled: process.env.JITO_ENABLED !== "false",
    });
    logger.info("Jito MEV Protection initialized");

    // Start Fastify server
    await app.listen({
      port: Number(process.env.PORT) || 3000,
      host: "0.0.0.0",
    });
    console.log("✅ API server started on port", process.env.PORT || 3000);

    // Start Telegram bot
    logger.info("Starting Telegram bot...");
    await bot.start();

    // Note: bot.start() is a long-running operation (long polling)
    // so this line won't be reached until the bot stops
    logger.info("Telegram bot stopped");
  } catch (err) {
    logger.error("Failed to start application", { error: err });
    app.log.error(err);
    process.exit(1);
  }
};

start();

// Graceful shutdown
process.on("SIGINT", async () => {
  logger.info("Received SIGINT, shutting down gracefully...");

  try {
    // Stop accepting new requests
    await bot.stop();
    logger.info("Telegram bot stopped");

    await app.close();
    logger.info("Fastify server closed");

    // Close database connection
    await prisma.$disconnect();
    logger.info("Database disconnected");

    // Close Redis connection gracefully
    await closeRedis();

    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
});

// Handle SIGTERM for Docker/Kubernetes
process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, shutting down gracefully...");

  try {
    await bot.stop();
    await app.close();
    await prisma.$disconnect();
    await closeRedis();

    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
});
