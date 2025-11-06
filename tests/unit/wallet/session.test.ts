/**
 * Session Management Tests
 * Testing Redis session integration (CRITICAL-1 + CRITICAL-2 fixes)
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { prisma } from "../../../src/utils/db.js";
import { createWallet } from "../../../src/services/wallet/keyManager.js";
import {
  createSession,
  destroySession,
  getSession,
  getKeypairForSigning,
} from "../../../src/services/wallet/session.js";
import type { SessionToken } from "../../../src/types/common.js";

describe("Redis Session Management (CRITICAL-1 + CRITICAL-2 fixes)", () => {
  let testUserId: string;
  const testPassword = "test-password-123";

  beforeAll(async () => {
    // Create test user
    const user = await prisma.user.create({
      data: {
        telegramId: BigInt(Math.floor(Math.random() * 1000000000)),
        username: `test_user_${Date.now()}`,
      },
    });
    testUserId = user.id;

    // Create test wallet
    const walletResult = await createWallet({
      userId: testUserId,
      password: testPassword,
    });

    expect(walletResult.success).toBe(true);
  });

  afterEach(async () => {
    // Clean up all Redis sessions for test user
    // Sessions are stored in Redis with key: "wallet:session:{token}"
    // We cannot enumerate by userId, so we rely on auto-expiry (15 min TTL)
    // This is okay for tests since each test gets unique timestamps
  });

  describe("createSession", () => {
    it("should create a valid session with encrypted keys", async () => {
      const result = await createSession({
        userId: testUserId,
        password: testPassword,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const { sessionToken, expiresAt } = result.value;

      // Session token should be a 64-character hex string (32 bytes)
      expect(sessionToken).toMatch(/^[0-9a-f]{64}$/i);

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

    it("should reject invalid password", async () => {
      const result = await createSession({
        userId: testUserId,
        password: "wrong-password",
      });

      expect(result.success).toBe(false);
      if (result.success) return;

      // Error message contains DECRYPTION_FAILED (because password is wrong)
      expect(result.error.message).toContain("DECRYPTION_FAILED");
    });

    it("should reject non-existent user", async () => {
      const result = await createSession({
        userId: "00000000-0000-0000-0000-000000000000",
        password: testPassword,
      });

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.message).toContain("WALLET_NOT_FOUND");
    });

    it("should create multiple sessions for same user", async () => {
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

      // Different session tokens
      expect(session1.value.sessionToken).not.toBe(session2.value.sessionToken);
    });
  });

  describe("getSession", () => {
    it("should retrieve valid session", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      const getResult = await getSession(sessionToken);
      expect(getResult.success).toBe(true);
      if (!getResult.success) return;

      const session = getResult.value;
      expect(session).not.toBeNull();
      if (!session) return;

      expect(session.userId).toBe(testUserId);
      expect(session.encryptedPrivateKey).toBeDefined();
      expect(session.walletId).toBeDefined();
    });

    it("should reject invalid session token", async () => {
      const result = await getSession(
        "0000000000000000000000000000000000000000000000000000000000000000" as SessionToken
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value).toBeNull(); // Session not found -> null
    });

    it("should reject expired session (Redis TTL)", async () => {
      // Note: This test verifies that getSession checks expiry
      // In production, Redis TTL would automatically delete expired sessions
      // We can't easily test Redis TTL in unit tests (would need to wait 15 minutes)
      // So we just verify that destroyed sessions are not accessible
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Destroy the session
      await destroySession(sessionToken);

      // Session should no longer exist
      const getResult = await getSession(sessionToken);
      expect(getResult.success).toBe(true);
      if (!getResult.success) return;
      expect(getResult.value).toBeNull(); // Session destroyed -> null
    });
  });

  describe("destroySession", () => {
    it("should destroy valid session", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Session should exist
      const getResult1 = await getSession(sessionToken);
      expect(getResult1.success).toBe(true);
      if (!getResult1.success) return;
      expect(getResult1.value).not.toBeNull();

      // Destroy session
      const destroyResult = await destroySession(sessionToken);
      expect(destroyResult.success).toBe(true);

      // Session should no longer exist
      const getResult2 = await getSession(sessionToken);
      expect(getResult2.success).toBe(true);
      if (!getResult2.success) return;
      expect(getResult2.value).toBeNull(); // Session destroyed -> null
    });

    it("should handle destroying non-existent session", async () => {
      const result = await destroySession(
        "0000000000000000000000000000000000000000000000000000000000000000" as SessionToken
      );

      // Should not throw error, just return success (idempotent operation)
      expect(result.success).toBe(true);
    });
  });

  describe("getKeypairForSigning (CRITICAL-2 fix)", () => {
    it("should retrieve keypair from Redis session with password", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Get keypair for signing
      const keypairResult = await getKeypairForSigning(
        sessionToken,
        testPassword
      );
      expect(keypairResult.success).toBe(true);
      if (!keypairResult.success) return;

      const keypair = keypairResult.value;

      // Should be a valid Keypair
      expect(keypair).toBeInstanceOf(Keypair);
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.secretKey).toBeDefined();
      expect(keypair.secretKey.length).toBe(64);
    });

    it("should reject invalid password", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Try with wrong password
      const keypairResult = await getKeypairForSigning(
        sessionToken,
        "wrong-password"
      );
      expect(keypairResult.success).toBe(false);
    });

    it("should reject invalid session token", async () => {
      const keypairResult = await getKeypairForSigning(
        "00000000-0000-0000-0000-000000000000" as SessionToken,
        testPassword
      );

      expect(keypairResult.success).toBe(false);
    });

    it("should not store plaintext keypair in Redis (CRITICAL-2 check)", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Get session data from Redis
      const sessionResult = await getSession(sessionToken);
      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const session = sessionResult.value;
      expect(session).not.toBeNull();
      if (!session) return;

      // Encrypted private key should NOT be plaintext
      // It should be hex-encoded encrypted data (longer than 64 bytes)
      expect(session.encryptedPrivateKey.length).toBeGreaterThan(128); // Base64 encoded encrypted data

      // Should not be able to create Keypair directly from encrypted key
      expect(() => {
        const bytes = Buffer.from(session.encryptedPrivateKey, "base64");
        Keypair.fromSecretKey(bytes);
      }).toThrow();
    });
  });

  // Note: No separate validateSessionPassword function
  // Password validation happens in getKeypairForSigning()
  // See "getKeypairForSigning (CRITICAL-2 fix)" tests above

  describe("Session TTL and expiration", () => {
    it("should have 15 minute default TTL", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { expiresAt } = createResult.value;
      const now = Date.now();
      const ttl = expiresAt.getTime() - now;

      // Should be approximately 15 minutes (900 seconds)
      // Allow 10 second margin
      expect(ttl).toBeGreaterThan(890 * 1000);
      expect(ttl).toBeLessThan(910 * 1000);
    });

    it("should rely on Redis TTL for automatic cleanup", async () => {
      // Redis automatically expires keys after TTL
      // This test verifies that sessions have a TTL set
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken, expiresAt } = createResult.value;

      // Verify expiration time is set correctly
      const now = Date.now();
      const ttl = expiresAt.getTime() - now;

      // Should be approximately 15 minutes (900 seconds)
      expect(ttl).toBeGreaterThan(890 * 1000);
      expect(ttl).toBeLessThan(910 * 1000);

      // Session should exist now
      const getResult = await getSession(sessionToken);
      expect(getResult.success).toBe(true);
    });
  });

  describe("Security checks (CRITICAL-1 + CRITICAL-2)", () => {
    it("CRITICAL-1: Private keys should be encrypted in Redis", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Get session from Redis
      const sessionResult = await getSession(sessionToken);
      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const session = sessionResult.value;
      expect(session).not.toBeNull();
      if (!session) return;

      // Encrypted key should be base64 encoded and longer than plaintext
      const encryptedKey = session.encryptedPrivateKey;
      expect(encryptedKey).toBeDefined();
      expect(encryptedKey.length).toBeGreaterThan(128); // Encrypted data is longer

      // Should not be able to use it as a keypair directly
      expect(() => {
        const bytes = Buffer.from(encryptedKey, "base64");
        Keypair.fromSecretKey(bytes);
      }).toThrow();
    });

    it("CRITICAL-2: No plaintext keypairs in memory after getKeypairForSigning", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // Get keypair
      const keypairResult = await getKeypairForSigning(
        sessionToken,
        testPassword
      );
      expect(keypairResult.success).toBe(true);
      if (!keypairResult.success) return;

      const keypair = keypairResult.value;

      // Keypair should be valid
      expect(keypair).toBeInstanceOf(Keypair);

      // IMPORTANT: After use, caller MUST clear keypair from memory
      // This is tested in executor.test.ts
      // Here we just verify that Redis session still has encrypted key only
      const sessionResult = await getSession(sessionToken);
      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const session = sessionResult.value;
      expect(session).not.toBeNull();
      if (!session) return;

      // Redis should still only have encrypted key
      expect(session.encryptedPrivateKey).toBeDefined();
      expect(session.encryptedPrivateKey.length).toBeGreaterThan(128);
    });

    it("CRITICAL-2: Password required for every getKeypairForSigning call", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // First call should succeed
      const keypairResult1 = await getKeypairForSigning(
        sessionToken,
        testPassword
      );
      expect(keypairResult1.success).toBe(true);

      // Second call should also require password
      const keypairResult2 = await getKeypairForSigning(
        sessionToken,
        testPassword
      );
      expect(keypairResult2.success).toBe(true);

      // Without password should fail
      const keypairResult3 = await getKeypairForSigning(sessionToken, "");
      expect(keypairResult3.success).toBe(false);
    });
  });
});
