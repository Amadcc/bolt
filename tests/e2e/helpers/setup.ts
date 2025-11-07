/**
 * E2E Test Setup
 *
 * Global setup and teardown for E2E tests
 */

import { beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { prisma } from "../../../src/utils/db.js";
import { redis } from "../../../src/utils/redis.js";
import {
  cleanupAllTestUsers,
  clearTestRedisData,
} from "./test-helpers.js";

// ============================================================================
// Global Setup
// ============================================================================

export function setupE2ETests() {
  beforeAll(async () => {
    console.log("🚀 Setting up E2E test environment...");

    // Verify database connection
    try {
      await prisma.$connect();
      console.log("✅ Database connected");
    } catch (error) {
      console.error("❌ Failed to connect to database:", error);
      throw error;
    }

    // Verify Redis connection
    try {
      await redis.ping();
      console.log("✅ Redis connected");
    } catch (error) {
      console.error("❌ Failed to connect to Redis:", error);
      throw error;
    }

    // Clean up any leftover test data
    await cleanupAllTestUsers();
    await clearTestRedisData();

    console.log("✅ E2E test environment ready");
  });

  afterAll(async () => {
    console.log("🧹 Cleaning up E2E test environment...");

    // Clean up all test data
    await cleanupAllTestUsers();
    await clearTestRedisData();

    // Disconnect
    await prisma.$disconnect();
    await redis.quit();

    console.log("✅ E2E test environment cleaned up");
  });

  beforeEach(async () => {
    // Optional: Log test start
    // console.log(`\n▶️  Starting test...`);
  });

  afterEach(async () => {
    // Optional: Clean up after each test
    // This can be customized based on test isolation requirements
  });
}

// ============================================================================
// Test Environment Verification
// ============================================================================

export async function verifyTestEnvironment(): Promise<void> {
  // Check if we're in test mode
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "E2E tests must run with NODE_ENV=test to prevent accidental production data modification"
    );
  }

  // Check required environment variables
  const required = [
    "DATABASE_URL",
    "REDIS_URL",
    "SESSION_MASTER_SECRET",
  ];

  for (const envVar of required) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  // Verify database is test database
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl.includes("test") && !databaseUrl.includes("localhost")) {
    throw new Error(
      "DATABASE_URL must point to a test database (should contain 'test' or 'localhost')"
    );
  }

  console.log("✅ Test environment verified");
}
