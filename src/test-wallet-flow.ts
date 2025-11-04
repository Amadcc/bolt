/**
 * End-to-end test for wallet creation flow
 */

import "dotenv/config";
import { prisma } from "./utils/db.js";
import { redis } from "./utils/redis.js";
import {
  createWallet,
  unlockWallet,
  getWalletInfo,
  hasWallet,
  clearKeypair,
} from "./services/wallet/keyManager.js";
import {
  createSession,
  getSession,
  destroySession,
} from "./services/wallet/session.js";
import { logger } from "./utils/logger.js";

async function testWalletFlow() {
  logger.info("🧪 Starting end-to-end wallet test...");

  // Create test user
  const testUser = await prisma.user.upsert({
    where: { telegramId: 999999999n },
    update: {},
    create: {
      telegramId: 999999999n,
      username: "test_user",
    },
  });

  logger.info("Test user created/found", { userId: testUser.id });

  const userId = testUser.id;
  const password = "TestPassword123";

  try {
    // Test 1: Check if wallet exists
    logger.info("\n📋 Test 1: Check wallet existence");
    const walletExists = await hasWallet(userId);
    logger.info(`Wallet exists: ${walletExists}`);

    // Clean up any existing wallet
    if (walletExists) {
      await prisma.wallet.deleteMany({ where: { userId } });
      logger.info("Cleaned up existing test wallet");
    }

    // Test 2: Create wallet
    logger.info("\n📋 Test 2: Create wallet");
    const createResult = await createWallet({ userId, password });

    if (!createResult.success) {
      logger.error("❌ Wallet creation failed", { error: createResult.error });
      throw new Error("Wallet creation failed");
    }

    logger.info("✅ Wallet created successfully", {
      walletId: createResult.value.walletId,
      publicKey: createResult.value.publicKey,
    });

    // Test 3: Get wallet info
    logger.info("\n📋 Test 3: Get wallet info");
    const walletInfo = await getWalletInfo(userId);

    if (!walletInfo.success || !walletInfo.value) {
      logger.error("❌ Failed to get wallet info");
      throw new Error("Failed to get wallet info");
    }

    logger.info("✅ Wallet info retrieved", {
      publicKey: walletInfo.value.publicKey,
    });

    // Test 4: Unlock wallet with correct password
    logger.info("\n📋 Test 4: Unlock wallet (correct password)");
    const unlockResult = await unlockWallet({ userId, password });

    if (!unlockResult.success) {
      logger.error("❌ Unlock failed", { error: unlockResult.error });
      throw new Error("Unlock failed");
    }

    logger.info("✅ Wallet unlocked successfully", {
      publicKey: unlockResult.value.publicKey,
    });

    // Clear keypair from memory
    clearKeypair(unlockResult.value.keypair);

    // Test 5: Unlock wallet with wrong password
    logger.info("\n📋 Test 5: Unlock wallet (wrong password)");
    const wrongUnlock = await unlockWallet({
      userId,
      password: "WrongPassword123",
    });

    if (!wrongUnlock.success) {
      logger.info("✅ Wrong password correctly rejected", {
        errorType: wrongUnlock.error.type,
      });
    } else {
      logger.error("❌ Wrong password was accepted - SECURITY ISSUE!");
      throw new Error("Wrong password accepted");
    }

    // Test 6: Create session
    logger.info("\n📋 Test 6: Create session");
    const sessionResult = await createSession({ userId, password });

    if (!sessionResult.success) {
      logger.error("❌ Session creation failed", {
        error: sessionResult.error,
      });
      throw new Error("Session creation failed");
    }

    logger.info("✅ Session created", {
      expiresAt: sessionResult.value.expiresAt.toISOString(),
    });

    const sessionToken = sessionResult.value.sessionToken;

    // Test 7: Get session
    logger.info("\n📋 Test 7: Get session");
    const getSessionResult = await getSession(sessionToken);

    if (!getSessionResult.success || !getSessionResult.value) {
      logger.error("❌ Failed to get session");
      throw new Error("Failed to get session");
    }

    logger.info("✅ Session retrieved", {
      userId: getSessionResult.value.userId,
      walletId: getSessionResult.value.walletId,
    });

    // Test 8: Destroy session
    logger.info("\n📋 Test 8: Destroy session");
    const destroyResult = await destroySession(sessionToken);

    if (!destroyResult.success) {
      logger.error("❌ Failed to destroy session");
      throw new Error("Failed to destroy session");
    }

    logger.info("✅ Session destroyed");

    // Test 9: Verify session is destroyed
    logger.info("\n📋 Test 9: Verify session destroyed");
    const verifyDestroyed = await getSession(sessionToken);

    if (verifyDestroyed.success && verifyDestroyed.value === null) {
      logger.info("✅ Session verified as destroyed");
    } else {
      logger.error("❌ Session still exists after destroy");
      throw new Error("Session still exists");
    }

    logger.info("\n🎉 All tests passed!");
  } catch (error) {
    logger.error("Test failed", { error });
    throw error;
  } finally {
    // Cleanup
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    await redis.quit();
    logger.info("✅ Cleanup completed");
  }
}

testWalletFlow().catch((error) => {
  logger.error("Test suite failed", { error });
  process.exit(1);
});
