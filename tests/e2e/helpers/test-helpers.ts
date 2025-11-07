/**
 * E2E Test Helpers
 *
 * Utilities for end-to-end testing of the Telegram bot
 */

import { prisma } from "../../../src/utils/db.js";
import { redis } from "../../../src/utils/redis.js";
import { Keypair } from "@solana/web3.js";
import { encryptPrivateKey } from "../../../src/services/wallet/encryption.js";
import { asEncryptedPrivateKey } from "../../../src/types/common.js";
import type { User, Wallet } from "@prisma/client";

// ============================================================================
// Test User Management
// ============================================================================

export interface TestUser {
  user: User;
  wallet: Wallet;
  password: string;
  keypair: Keypair;
}

/**
 * Create a test user with wallet
 */
export async function createTestUser(
  telegramId?: number,
  password: string = "testpassword123"
): Promise<TestUser> {
  const id = telegramId || Math.floor(Math.random() * 1000000000);

  // Create user in database
  const user = await prisma.user.create({
    data: {
      telegramId: id,
      username: `testuser_${id}`,
    },
  });

  // Generate keypair
  const keypair = Keypair.generate();

  // Encrypt private key
  const encryptResult = await encryptPrivateKey(keypair.secretKey, password);

  if (!encryptResult.success) {
    throw new Error(`Failed to encrypt key: ${encryptResult.error.message}`);
  }

  const { encryptedData } = encryptResult.value;

  // Create wallet
  const wallet = await prisma.wallet.create({
    data: {
      userId: user.id,
      publicKey: keypair.publicKey.toBase58(),
      encryptedPrivateKey: encryptedData,
    },
  });

  return {
    user,
    wallet,
    password,
    keypair,
  };
}

/**
 * Cleanup test user and all associated data
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  // Delete orders
  await prisma.order.deleteMany({
    where: { userId },
  });

  // Delete wallet
  await prisma.wallet.deleteMany({
    where: { userId },
  });

  // Delete user
  await prisma.user.delete({
    where: { id: userId },
  });

  // Clean up Redis sessions
  const pattern = `wallet:session:*`;
  const { redisScan } = await import("../../../src/utils/redis.js");
  const scanResult = await redisScan(pattern);

  if (scanResult.success) {
    for (const key of scanResult.value) {
      const data = await redis.get(key);
      if (data) {
        const sessionData = JSON.parse(data);
        if (sessionData.userId === userId) {
          await redis.del(key);
        }
      }
    }
  }

  // Clean up rate limiting
  await redis.del(`rl:bot:${userId}`);
}

/**
 * Clean up all test users (for test suite cleanup)
 */
export async function cleanupAllTestUsers(): Promise<void> {
  // Find all test users
  const testUsers = await prisma.user.findMany({
    where: {
      username: {
        startsWith: "testuser_",
      },
    },
  });

  // Clean up each test user
  for (const user of testUsers) {
    try {
      await cleanupTestUser(user.id);
    } catch (error) {
      console.warn(`Failed to cleanup test user ${user.id}:`, error);
    }
  }
}

// ============================================================================
// Session Helpers
// ============================================================================

export interface TestSession {
  sessionToken: string;
  expiresAt: Date;
}

/**
 * Create a test session for user
 */
export async function createTestSession(
  testUser: TestUser
): Promise<TestSession> {
  const { createSession } = await import(
    "../../../src/services/wallet/session.js"
  );

  const result = await createSession({
    userId: testUser.user.id,
    password: testUser.password,
  });

  if (!result.success) {
    throw new Error(`Failed to create session: ${result.error.message}`);
  }

  return result.value;
}

/**
 * Verify session exists in Redis
 */
export async function verifySessionExists(sessionToken: string): Promise<boolean> {
  const key = `wallet:session:${sessionToken}`;
  const data = await redis.get(key);
  return data !== null;
}

// ============================================================================
// Order Helpers
// ============================================================================

/**
 * Create a test order
 */
export async function createTestOrder(
  userId: string,
  overrides: Partial<{
    side: "buy" | "sell";
    status: string;
    tokenMint: string;
    amount: string;
    transactionSignature: string;
  }> = {}
) {
  return prisma.order.create({
    data: {
      userId,
      tokenMint: overrides.tokenMint || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      side: overrides.side || "buy",
      amount: overrides.amount || "0.001",
      status: overrides.status || "pending",
      transactionSignature: overrides.transactionSignature,
    },
  });
}

/**
 * Get order by transaction signature
 */
export async function getOrderBySignature(signature: string) {
  return prisma.order.findFirst({
    where: {
      transactionSignature: signature,
    },
  });
}

// ============================================================================
// Redis Helpers
// ============================================================================

/**
 * Clear all test data from Redis
 */
export async function clearTestRedisData(): Promise<void> {
  const patterns = [
    "wallet:session:*",
    "rl:bot:*",
    "cache:quote:*",
    "cache:honeypot:*",
  ];

  for (const pattern of patterns) {
    const { redisScan } = await import("../../../src/utils/redis.js");
    const scanResult = await redisScan(pattern);

    if (scanResult.success) {
      for (const key of scanResult.value) {
        await redis.del(key);
      }
    }
  }
}

// ============================================================================
// Time Helpers
// ============================================================================

/**
 * Wait for specified milliseconds
 */
export async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until condition is true or timeout
 */
export async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number = 10000,
  intervalMs: number = 100
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await wait(intervalMs);
  }

  return false;
}

// ============================================================================
// Mock Helpers
// ============================================================================

/**
 * Mock successful Jupiter quote
 */
export function mockSuccessfulQuote() {
  return {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inAmount: "1000000",
    outAmount: "100000",
    otherAmountThreshold: "99000",
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: 0.01,
    routePlan: [],
  };
}

/**
 * Mock honeypot detection result
 */
export function mockHoneypotResult(isHoneypot: boolean = false, score: number = 0) {
  return {
    isHoneypot,
    riskScore: score,
    reasons: isHoneypot ? ["High risk detected"] : [],
    checks: {
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      isGoPlus: false,
    },
  };
}
