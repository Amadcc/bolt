import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { bot } from "./bot/index.js";
import { prisma } from "./utils/db.js";
import { redis } from "./utils/redis.js";

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

// Start server
const start = async () => {
  try {
    await app.listen({
      port: Number(process.env.PORT) || 3000,
      host: "0.0.0.0",
    });
    console.log("✅ API server started");

    // Start bot
    await bot.start();
    console.log("✅ Telegram bot started");
  } catch (err) {
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
