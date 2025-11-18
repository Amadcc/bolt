/**
 * Test Utility Functions
 *
 * Common helpers for all test files to reduce duplication and improve consistency.
 */

import type { Redis } from "ioredis";
import { createMockRedis } from "../mocks/redis.mock";
import { createMockJupiter } from "../mocks/jupiter.mock";

/**
 * Get mock Redis instance for tests
 * Uses global mock if available, otherwise creates new instance
 */
export function getMockRedis(): Redis {
  const globalMock = (globalThis as any).__TEST_REDIS_MOCK__;
  if (globalMock) {
    return globalMock;
  }
  return createMockRedis();
}

/**
 * Get mock Jupiter instance for tests
 */
export function getMockJupiter() {
  const globalMock = (globalThis as any).__TEST_JUPITER_MOCK__;
  if (globalMock) {
    return globalMock;
  }
  return createMockJupiter();
}

/**
 * Inject mock Redis into redis module for testing
 *
 * Usage:
 * ```typescript
 * import { injectMockRedis } from "../../helpers/testUtils";
 *
 * beforeEach(() => {
 *   injectMockRedis();
 * });
 * ```
 */
export async function injectMockRedis(): Promise<Redis> {
  const mockRedis = getMockRedis();

  // Clear any existing data
  await mockRedis.flushall();

  // Inject mock Redis using the setRedisClient function
  const { setRedisClient } = await import("../../src/utils/redis.js");
  setRedisClient(mockRedis);

  return mockRedis;
}

/**
 * Create test user in database
 */
export async function createTestUser(userId: string, telegramId: bigint) {
  const { prisma } = await import("../../src/utils/db.js");

  return prisma.user.create({
    data: {
      id: userId,
      telegramId,
      username: `test_user_${userId}`,
      subscriptionTier: "free",
    },
  });
}

/**
 * Clean up test user from database
 */
export async function cleanupTestUser(userId: string) {
  const { prisma } = await import("../../src/utils/db.js");

  // Delete in order of foreign key constraints
  await prisma.sniperPosition.deleteMany({ where: { userId } });
  await prisma.sniperOrder.deleteMany({ where: { userId } });
  await prisma.wallet.deleteMany({ where: { userId } });
  await prisma.sniperFilterPreference.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

/**
 * Sleep helper for async tests
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate random test ID
 */
export function randomTestId(prefix: string = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Wait for condition to be true (with timeout)
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: {
    timeout?: number;
    interval?: number;
    timeoutMessage?: string;
  } = {}
): Promise<void> {
  const {
    timeout = 5000,
    interval = 100,
    timeoutMessage = "Timeout waiting for condition",
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(timeoutMessage);
}

/**
 * Mock Keypair for testing
 */
export function createMockKeypair() {
  const { Keypair } = require("@solana/web3.js");
  return Keypair.generate();
}

/**
 * Suppress console warnings during test
 */
export function suppressConsole(fn: () => void | Promise<void>) {
  return async () => {
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};

    try {
      await fn();
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  };
}
