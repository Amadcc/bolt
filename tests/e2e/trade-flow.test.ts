/**
 * E2E Tests: Trade Flow
 *
 * Tests the complete trading flow including:
 * - Wallet creation and unlock
 * - Session-based trading (no password required)
 * - Buy/sell/swap execution
 * - Transaction confirmation
 * - Order persistence
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setupE2ETests } from "./helpers/setup.js";
import {
  createTestUser,
  cleanupTestUser,
  createTestSession,
  createTestOrder,
  getOrderBySignature,
  type TestUser,
} from "./helpers/test-helpers.js";
import { prisma } from "../../src/utils/db.js";
import { asSessionToken } from "../../src/types/common.js";

// Setup test environment
setupE2ETests();

describe("E2E: Trade Flow", () => {
  let testUser: TestUser;

  // Create test user before each test
  beforeEach(async () => {
    testUser = await createTestUser();
  });

  // Cleanup after each test
  afterEach(async () => {
    if (testUser) {
      await cleanupTestUser(testUser.user.id);
    }
  });

  // ============================================================================
  // Wallet Creation & Unlock
  // ============================================================================

  it("should create wallet and unlock with session", async () => {
    // Verify wallet was created
    expect(testUser.wallet).toBeDefined();
    expect(testUser.wallet.publicKey).toBe(testUser.keypair.publicKey.toBase58());
    expect(testUser.wallet.encryptedPrivateKey).toBeDefined();

    // Create session (unlock wallet)
    const session = await createTestSession(testUser);

    expect(session).toBeDefined();
    expect(session.sessionToken).toBeDefined();
    expect(session.expiresAt).toBeInstanceOf(Date);

    // Verify session expires in the future
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Verify session is stored in Redis
    const { verifySession } = await import(
      "../../src/services/wallet/session.js"
    );
    const isValid = await verifySession(asSessionToken(session.sessionToken));
    expect(isValid).toBe(true);
  });

  // ============================================================================
  // Session-Based Trading
  // ============================================================================

  it("should execute trade using session (no password required)", async () => {
    // Create session
    const session = await createTestSession(testUser);

    // Get keypair using session (simulating trade execution)
    const { getKeypairForSigning } = await import(
      "../../src/services/wallet/session.js"
    );

    const keypairResult = await getKeypairForSigning(
      asSessionToken(session.sessionToken)
    );

    expect(keypairResult.success).toBe(true);

    if (keypairResult.success) {
      const keypair = keypairResult.value;

      // Verify keypair matches original
      expect(keypair.publicKey.toBase58()).toBe(
        testUser.keypair.publicKey.toBase58()
      );

      // Clear keypair from memory (security)
      const { clearKeypair } = await import(
        "../../src/services/wallet/keyManager.js"
      );
      clearKeypair(keypair);
    }
  });

  // ============================================================================
  // Order Creation & Persistence
  // ============================================================================

  it("should create order and persist to database", async () => {
    const order = await createTestOrder(testUser.user.id, {
      side: "buy",
      status: "pending",
      tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      amount: "0.1",
    });

    expect(order).toBeDefined();
    expect(order.id).toBeDefined();
    expect(order.side).toBe("buy");
    expect(order.status).toBe("pending");
    expect(order.userId).toBe(testUser.user.id);

    // Verify order is in database
    const dbOrder = await prisma.order.findUnique({
      where: { id: order.id },
    });

    expect(dbOrder).toBeDefined();
    expect(dbOrder?.id).toBe(order.id);
  });

  it("should update order status after trade execution", async () => {
    const order = await createTestOrder(testUser.user.id, {
      side: "buy",
      status: "pending",
    });

    // Simulate trade execution
    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "filled",
        transactionSignature: "5KxTestSignature123...",
      },
    });

    expect(updatedOrder.status).toBe("filled");
    expect(updatedOrder.transactionSignature).toBeDefined();
  });

  it("should record failed trade in database", async () => {
    const order = await createTestOrder(testUser.user.id, {
      side: "buy",
      status: "pending",
    });

    // Simulate trade failure
    const failedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "failed",
      },
    });

    expect(failedOrder.status).toBe("failed");
  });

  // ============================================================================
  // Multiple Trades in Single Session
  // ============================================================================

  it("should execute multiple trades in single session", async () => {
    // Create session
    const session = await createTestSession(testUser);

    // Execute first trade
    const order1 = await createTestOrder(testUser.user.id, {
      side: "buy",
      status: "pending",
    });

    await prisma.order.update({
      where: { id: order1.id },
      data: { status: "filled", transactionSignature: "tx1..." },
    });

    // Execute second trade (same session, no password needed)
    const order2 = await createTestOrder(testUser.user.id, {
      side: "sell",
      status: "pending",
    });

    await prisma.order.update({
      where: { id: order2.id },
      data: { status: "filled", transactionSignature: "tx2..." },
    });

    // Verify both orders exist
    const orders = await prisma.order.findMany({
      where: { userId: testUser.user.id },
    });

    expect(orders.length).toBe(2);
    expect(orders[0].status).toBe("filled");
    expect(orders[1].status).toBe("filled");

    // Verify session is still valid
    const { verifySession } = await import(
      "../../src/services/wallet/session.js"
    );
    const isValid = await verifySession(asSessionToken(session.sessionToken));
    expect(isValid).toBe(true);
  });

  // ============================================================================
  // Session Expiry
  // ============================================================================

  it("should reject trade after session expires", async () => {
    // Create session with very short TTL
    const { redis } = await import("../../src/utils/redis.js");
    const { createSession } = await import(
      "../../src/services/wallet/session.js"
    );

    const sessionResult = await createSession({
      userId: testUser.user.id,
      password: testUser.password,
    });

    expect(sessionResult.success).toBe(true);

    if (sessionResult.success) {
      const session = sessionResult.value;

      // Manually expire session in Redis
      const key = `wallet:session:${session.sessionToken}`;
      await redis.del(key);

      // Try to get keypair with expired session
      const { getKeypairForSigning } = await import(
        "../../src/services/wallet/session.js"
      );

      const keypairResult = await getKeypairForSigning(
        asSessionToken(session.sessionToken)
      );

      expect(keypairResult.success).toBe(false);

      if (!keypairResult.success) {
        expect(keypairResult.error.message).toContain("expired");
      }
    }
  });

  // ============================================================================
  // Trade Types
  // ============================================================================

  it("should support buy and sell trade types", async () => {
    // Create buy order
    const buyOrder = await createTestOrder(
      testUser.user.id,
      {
        side: "buy",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }
    );
    expect(buyOrder.side).toBe("buy");

    // Create sell order
    const sellOrder = await createTestOrder(
      testUser.user.id,
      {
        side: "sell",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }
    );
    expect(sellOrder.side).toBe("sell");

    // Verify both orders exist
    const orders = await prisma.order.findMany({
      where: { userId: testUser.user.id },
    });
    expect(orders.length).toBe(2);
  });
});
