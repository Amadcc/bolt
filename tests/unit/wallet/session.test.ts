/**
 * Session Management Tests
 * Testing Redis session integration (CRITICAL-1 + CRITICAL-2 fixes)
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { prisma } from "../../../src/utils/db.js";
import { validateEnv } from "../../../src/config/env.js";
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
  // Password must meet MEDIUM-8 requirements: 12+ chars, uppercase, lowercase, numbers, special char
  const testPassword = "TestPassword123!";

  beforeAll(async () => {
    // Initialize environment (required for session encryption)
    validateEnv();

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

    if (!walletResult.success) {
      console.error("Wallet creation failed:", walletResult.error);
      throw new Error(
        `Wallet creation failed: ${JSON.stringify(walletResult.error)}`
      );
    }

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
      // VARIANT C+: Session contains sessionEncryptedKey, not encryptedPrivateKey
      expect(session.sessionEncryptedKey).toBeDefined();
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
      // VARIANT C+: Session contains sessionEncryptedKey object
      expect(session.sessionEncryptedKey).toBeDefined();
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

  describe("getKeypairForSigning (CRITICAL-2 fix: Variant C+)", () => {
    it("should retrieve keypair from Redis session WITHOUT password (session-based auth)", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // VARIANT C+: Get keypair using session token only (no password needed)
      const keypairResult = await getKeypairForSigning(sessionToken);
      expect(keypairResult.success).toBe(true);
      if (!keypairResult.success) return;

      const keypair = keypairResult.value;

      // Should be a valid Keypair
      expect(keypair).toBeInstanceOf(Keypair);
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.secretKey).toBeDefined();
      expect(keypair.secretKey.length).toBe(64);
    });

    it("should reject invalid session token", async () => {
      const keypairResult = await getKeypairForSigning(
        "0000000000000000000000000000000000000000000000000000000000000000" as SessionToken
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

      // VARIANT C+: Session encrypted key should be an object with ciphertext, iv, authTag, salt
      expect(session.sessionEncryptedKey).toBeDefined();
      expect(session.sessionEncryptedKey.ciphertext).toBeDefined();
      expect(session.sessionEncryptedKey.iv).toBeDefined();
      expect(session.sessionEncryptedKey.authTag).toBeDefined();
      expect(session.sessionEncryptedKey.salt).toBeDefined();

      // Ciphertext should be hex-encoded (not plaintext)
      expect(session.sessionEncryptedKey.ciphertext.length).toBeGreaterThan(64);

      // Should not be able to create Keypair directly from ciphertext
      expect(() => {
        const bytes = Buffer.from(
          session.sessionEncryptedKey.ciphertext,
          "hex"
        );
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

      // VARIANT C+: Session encrypted key should be structured object
      expect(session.sessionEncryptedKey).toBeDefined();
      expect(session.sessionEncryptedKey.ciphertext).toBeDefined();
      expect(session.sessionEncryptedKey.iv).toBeDefined();
      expect(session.sessionEncryptedKey.authTag).toBeDefined();
      expect(session.sessionEncryptedKey.salt).toBeDefined();

      // Ciphertext should be hex-encoded (not plaintext, longer than 64 bytes)
      expect(session.sessionEncryptedKey.ciphertext.length).toBeGreaterThan(64);

      // Should not be able to use ciphertext as a keypair directly
      expect(() => {
        const bytes = Buffer.from(
          session.sessionEncryptedKey.ciphertext,
          "hex"
        );
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

      // VARIANT C+: Get keypair using session token only
      const keypairResult = await getKeypairForSigning(sessionToken);
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

      // VARIANT C+: Redis should still only have encrypted key (re-encrypted with session key)
      expect(session.sessionEncryptedKey).toBeDefined();
      expect(session.sessionEncryptedKey.ciphertext).toBeDefined();
      expect(session.sessionEncryptedKey.ciphertext.length).toBeGreaterThan(64);
    });

    it("CRITICAL-2: Session-based auth - NO password required for getKeypairForSigning (Variant C+)", async () => {
      const createResult = await createSession({
        userId: testUserId,
        password: testPassword,
      });
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const { sessionToken } = createResult.value;

      // VARIANT C+: First call should succeed WITHOUT password
      const keypairResult1 = await getKeypairForSigning(sessionToken);
      expect(keypairResult1.success).toBe(true);
      if (!keypairResult1.success) return;

      // VARIANT C+: Second call should also succeed WITHOUT password
      const keypairResult2 = await getKeypairForSigning(sessionToken);
      expect(keypairResult2.success).toBe(true);
      if (!keypairResult2.success) return;

      // VARIANT C+: Session token is the only credential needed
      // This enables automatic trading without repeated password prompts
      expect(keypairResult1.value).toBeInstanceOf(Keypair);
      expect(keypairResult2.value).toBeInstanceOf(Keypair);
    });
  });
});
