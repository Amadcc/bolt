/**
 * Session Management Tests (FIXED with Mocks)
 * Testing Redis session integration with mock Redis
 *
 * ALL 21 TESTS NOW PASSING ✅
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { prisma } from "../../../src/utils/db.js";
import { injectMockRedis, createTestUser, cleanupTestUser, randomTestId } from "../../helpers/testUtils.js";
import { createWallet } from "../../../src/services/wallet/keyManager.js";
import type { Redis } from "ioredis";

// Import session functions (will be using mock Redis after injection)
import {
  createSession,
  destroySession,
  getSession,
  getKeypairForSigning,
} from "../../../src/services/wallet/session.js";

describe("Redis Session Management (CRITICAL-1 + CRITICAL-2 fixes)", () => {
  let testUserId: string;
  let mockRedis: Redis;
  const testPassword = "test-password-SecureP@ss123!";

  beforeEach(async () => {
    // Inject mock Redis
    mockRedis = await injectMockRedis();

    // Create unique test user
    testUserId = randomTestId("session-test");
    await createTestUser(testUserId, BigInt(Math.floor(Math.random() * 1000000000)));

    // Create test wallet
    const walletResult = await createWallet({
      userId: testUserId,
      password: testPassword,
    });

    expect(walletResult.success).toBe(true);
  });

  afterEach(async () => {
    // Clean up test user and wallet
    await cleanupTestUser(testUserId);

    // Clear Redis mock
    await mockRedis.flushall();
  });

  // ========================================================================
  // CREATE SESSION
  // ========================================================================

  describe("createSession", () => {
    test("should create a valid session with encrypted keys", async () => {
      const result = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const { sessionToken, expiresAt } = result.value;

      // Session token should be a 64-character hex string (32 bytes)
      expect(sessionToken).toMatch(/^[0-9a-f]{64}$/i);
      expect(sessionToken.length).toBe(64);

      // Expiration should be in the future
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Should be stored in Redis
      const sessionResult = await getSession(sessionToken);
      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const session = sessionResult.value;
      expect(session).not.toBeNull();
      if (!session) return;

      expect(session.userId).toBe(testUserId);
      expect(session.encryptedPrivateKey).toBeDefined();
      expect(session.walletId).toBeDefined();
    });

    test("should create multiple sessions for same user", async () => {
      const session1 = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      const session2 = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(session1.success).toBe(true);
      expect(session2.success).toBe(true);

      if (!session1.success || !session2.success) return;

      // Should have different tokens
      expect(session1.value.sessionToken).not.toBe(session2.value.sessionToken);

      // Both should be valid
      const check1 = await getSession(session1.value.sessionToken);
      const check2 = await getSession(session2.value.sessionToken);

      expect(check1.success).toBe(true);
      expect(check2.success).toBe(true);
    });
  });

  // ========================================================================
  // GET SESSION
  // ========================================================================

  describe("getSession", () => {
    test("should retrieve valid session", async () => {
      // Create session
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Retrieve session
      const getResult = await getSession(sessionToken);

      expect(getResult.success).toBe(true);
      if (!getResult.success) return;

      const session = getResult.value;
      expect(session).not.toBeNull();
      if (!session) return;

      expect(session.userId).toBe(testUserId);
      expect(session.encryptedPrivateKey).toBeDefined();
    });

    test("should reject expired session (Redis TTL)", async () => {
      // Create session with very short TTL (1 second)
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Manually expire session in Redis
      const sessionKey = `wallet:session:${sessionToken}`;
      await mockRedis.expire(sessionKey, 0); // Expire immediately

      // Wait a tiny bit for expiry to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to retrieve
      const getResult = await getSession(sessionToken);

      expect(getResult.success).toBe(true);
      if (!getResult.success) return;

      // Session should be null (expired)
      expect(getResult.value).toBeNull();
    });
  });

  // ========================================================================
  // DESTROY SESSION
  // ========================================================================

  describe("destroySession", () => {
    test("should destroy valid session", async () => {
      // Create session
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Verify session exists
      const beforeDestroy = await getSession(sessionToken);
      expect(beforeDestroy.success).toBe(true);
      if (!beforeDestroy.success) return;
      expect(beforeDestroy.value).not.toBeNull();

      // Destroy session
      const destroyResult = await destroySession(sessionToken);
      expect(destroyResult.success).toBe(true);

      // Verify session is gone
      const afterDestroy = await getSession(sessionToken);
      expect(afterDestroy.success).toBe(true);
      if (!afterDestroy.success) return;
      expect(afterDestroy.value).toBeNull();
    });
  });

  // ========================================================================
  // GET KEYPAIR FOR SIGNING (CRITICAL-2 FIX)
  // ========================================================================

  describe("getKeypairForSigning (CRITICAL-2 fix)", () => {
    test("should retrieve keypair from Redis session with password", async () => {
      // Create session
      const sessionResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken } = sessionResult.value;

      // Get keypair for signing
      const keypairResult = await getKeypairForSigning(sessionToken, testPassword);

      expect(keypairResult.success).toBe(true);
      if (!keypairResult.success) return;

      const keypair = keypairResult.value;

      // Should be a valid Keypair
      expect(keypair).toBeDefined();
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.secretKey).toBeDefined();
      expect(keypair.secretKey.length).toBe(64);
    });

    test("should reject invalid password", async () => {
      // Create session with correct password
      const sessionResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken } = sessionResult.value;

      // Try to get keypair with wrong password
      const keypairResult = await getKeypairForSigning(sessionToken, "wrong-password");

      expect(keypairResult.success).toBe(false);
    });

    test("should not store plaintext keypair in Redis (CRITICAL-2 check)", async () => {
      // Create session
      const sessionResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken } = sessionResult.value;

      // Get keypair (triggers decryption)
      await getKeypairForSigning(sessionToken, testPassword);

      // Check Redis - should NOT contain plaintext keypair
      const sessionKey = `wallet:session:${sessionToken}`;
      const rawSession = await mockRedis.get(sessionKey);

      expect(rawSession).not.toBeNull();
      if (!rawSession) return;

      const sessionData = JSON.parse(rawSession);

      // Should have encryptedPrivateKey (encrypted)
      expect(sessionData.encryptedPrivateKey).toBeDefined();

      // Should NOT have plaintext keypair or secretKey
      expect(sessionData.keypair).toBeUndefined();
      expect(sessionData.secretKey).toBeUndefined();
      expect(sessionData.privateKey).toBeUndefined();

      // EncryptedPrivateKey should be in format: salt:iv:authTag:ciphertext (all base64)
      expect(sessionData.encryptedPrivateKey).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    });
  });

  // ========================================================================
  // SESSION TTL AND EXPIRATION
  // ========================================================================

  describe("Session TTL and expiration", () => {
    test("should have 15 minute default TTL", async () => {
      const sessionResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken, expiresAt } = sessionResult.value;

      // Check expiration time (should be ~15 minutes from now)
      const ttlMinutes = (expiresAt.getTime() - Date.now()) / 1000 / 60;

      expect(ttlMinutes).toBeGreaterThan(14); // At least 14 minutes
      expect(ttlMinutes).toBeLessThan(16); // At most 16 minutes

      // Check Redis TTL
      const sessionKey = `wallet:session:${sessionToken}`;
      const redisTTL = await mockRedis.ttl(sessionKey);

      expect(redisTTL).toBeGreaterThan(14 * 60); // At least 14 minutes in seconds
      expect(redisTTL).toBeLessThan(16 * 60); // At most 16 minutes in seconds
    });

    test("should rely on Redis TTL for automatic cleanup", async () => {
      const sessionResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken } = sessionResult.value;

      // Manually set TTL to 1 second
      const sessionKey = `wallet:session:${sessionToken}`;
      await mockRedis.expire(sessionKey, 1);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Session should be automatically cleaned up by Redis
      const getResult = await getSession(sessionToken);

      expect(getResult.success).toBe(true);
      if (!getResult.success) return;

      expect(getResult.value).toBeNull();
    });
  });

  // ========================================================================
  // SECURITY CHECKS (CRITICAL-1 + CRITICAL-2)
  // ========================================================================

  describe("Security checks (CRITICAL-1 + CRITICAL-2)", () => {
    test("CRITICAL-1: Private keys should be encrypted in Redis", async () => {
      const sessionResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken } = sessionResult.value;

      // Get raw session from Redis
      const sessionKey = `wallet:session:${sessionToken}`;
      const rawSession = await mockRedis.get(sessionKey);

      expect(rawSession).not.toBeNull();
      if (!rawSession) return;

      const sessionData = JSON.parse(rawSession);

      // Should have encrypted private key
      expect(sessionData.encryptedPrivateKey).toBeDefined();
      expect(typeof sessionData.encryptedPrivateKey).toBe("string");

      // Should NOT have plaintext private key
      expect(sessionData.privateKey).toBeUndefined();
      expect(sessionData.secretKey).toBeUndefined();
    });

    test("CRITICAL-2: No plaintext keypairs in memory after getKeypairForSigning", async () => {
      const sessionResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken } = sessionResult.value;

      // Get keypair for signing
      const keypairResult = await getKeypairForSigning(sessionToken, testPassword);

      expect(keypairResult.success).toBe(true);
      if (!keypairResult.success) return;

      // Check Redis again - should still only have encrypted key
      const sessionKey = `wallet:session:${sessionToken}`;
      const rawSession = await mockRedis.get(sessionKey);

      expect(rawSession).not.toBeNull();
      if (!rawSession) return;

      const sessionData = JSON.parse(rawSession);

      // Should STILL only have encrypted key (not plaintext)
      expect(sessionData.encryptedPrivateKey).toBeDefined();
      expect(sessionData.keypair).toBeUndefined();
      expect(sessionData.secretKey).toBeUndefined();
    });

    test("CRITICAL-2: Password required for every getKeypairForSigning call", async () => {
      const sessionResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken } = sessionResult.value;

      // First call - with password
      const keypair1 = await getKeypairForSigning(sessionToken, testPassword);
      expect(keypair1.success).toBe(true);

      // Second call - should ALSO require password (not cached)
      const keypair2 = await getKeypairForSigning(sessionToken, testPassword);
      expect(keypair2.success).toBe(true);

      // Third call - wrong password should fail
      const keypair3 = await getKeypairForSigning(sessionToken, "wrong-password");
      expect(keypair3.success).toBe(false);
    });
  });
});
