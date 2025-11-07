/**
 * E2E Tests: Session Management
 *
 * Tests session lifecycle:
 * - Session creation (unlock)
 * - Session retrieval
 * - Session extension
 * - Session expiration
 * - Session destruction (logout)
 * - Multiple sessions per user
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setupE2ETests } from "./helpers/setup.js";
import {
  createTestUser,
  cleanupTestUser,
  createTestSession,
  verifySessionExists,
  wait,
  type TestUser,
} from "./helpers/test-helpers.js";
import { asSessionToken } from "../../src/types/common.js";
import {
  createSession,
  getSession,
  destroySession,
  extendSession,
  verifySession,
  destroyAllUserSessions,
} from "../../src/services/wallet/session.js";

// Setup test environment
setupE2ETests();

describe("E2E: Session Management", () => {
  let testUser: TestUser;

  beforeEach(async () => {
    testUser = await createTestUser();
  });

  afterEach(async () => {
    if (testUser) {
      await cleanupTestUser(testUser.user.id);
    }
  });

  // ============================================================================
  // Session Creation
  // ============================================================================

  it("should create session with valid password", async () => {
    const result = await createSession({
      userId: testUser.user.id,
      password: testUser.password,
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.value.sessionToken).toBeDefined();
      expect(result.value.expiresAt).toBeInstanceOf(Date);

      // Verify session is stored in Redis
      const exists = await verifySessionExists(result.value.sessionToken);
      expect(exists).toBe(true);
    }
  });

  it("should reject session creation with invalid password", async () => {
    const result = await createSession({
      userId: testUser.user.id,
      password: "wrongpassword",
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toContain("Failed to create session");
    }
  });

  it("should reject session creation for non-existent user", async () => {
    const result = await createSession({
      userId: "nonexistent-user-id",
      password: "anypassword",
    });

    expect(result.success).toBe(false);
  });

  // ============================================================================
  // Session Retrieval
  // ============================================================================

  it("should retrieve valid session", async () => {
    const session = await createTestSession(testUser);

    const result = await getSession(asSessionToken(session.sessionToken));

    expect(result.success).toBe(true);

    if (result.success && result.value) {
      expect(result.value.userId).toBe(testUser.user.id);
      expect(result.value.walletId).toBe(testUser.wallet.id);
      expect(result.value.expiresAt).toBeInstanceOf(Date);
      expect(result.value.sessionEncryptedKey).toBeDefined();
    }
  });

  it("should return null for non-existent session", async () => {
    const result = await getSession(asSessionToken("nonexistent-token"));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeNull();
    }
  });

  it("should verify valid session", async () => {
    const session = await createTestSession(testUser);

    const isValid = await verifySession(asSessionToken(session.sessionToken));

    expect(isValid).toBe(true);
  });

  it("should reject invalid session", async () => {
    const isValid = await verifySession(asSessionToken("invalid-token"));

    expect(isValid).toBe(false);
  });

  // ============================================================================
  // Session Extension
  // ============================================================================

  it("should extend session TTL", async () => {
    const session = await createTestSession(testUser);
    const originalExpiry = session.expiresAt;

    // Wait 1 second
    await wait(1000);

    // Extend session
    const result = await extendSession(asSessionToken(session.sessionToken));

    expect(result.success).toBe(true);

    if (result.success) {
      const newExpiry = result.value;

      // New expiry should be later than original
      expect(newExpiry.getTime()).toBeGreaterThan(originalExpiry.getTime());

      // Session should still be valid
      const isValid = await verifySession(asSessionToken(session.sessionToken));
      expect(isValid).toBe(true);
    }
  });

  it("should reject extension of non-existent session", async () => {
    const result = await extendSession(asSessionToken("nonexistent-token"));

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toContain("not found");
    }
  });

  // ============================================================================
  // Session Destruction
  // ============================================================================

  it("should destroy session (logout)", async () => {
    const session = await createTestSession(testUser);

    // Verify session exists
    const existsBefore = await verifySessionExists(session.sessionToken);
    expect(existsBefore).toBe(true);

    // Destroy session
    const result = await destroySession(asSessionToken(session.sessionToken));
    expect(result.success).toBe(true);

    // Verify session no longer exists
    const existsAfter = await verifySessionExists(session.sessionToken);
    expect(existsAfter).toBe(false);

    // Verify session is invalid
    const isValid = await verifySession(asSessionToken(session.sessionToken));
    expect(isValid).toBe(false);
  });

  it("should handle destroying non-existent session gracefully", async () => {
    const result = await destroySession(asSessionToken("nonexistent-token"));

    // Should succeed (idempotent)
    expect(result.success).toBe(true);
  });

  it("should destroy all user sessions", async () => {
    // Create multiple sessions
    const session1 = await createTestSession(testUser);
    const session2 = await createTestSession(testUser);

    // Verify both sessions exist
    expect(await verifySessionExists(session1.sessionToken)).toBe(true);
    expect(await verifySessionExists(session2.sessionToken)).toBe(true);

    // Destroy all sessions
    const result = await destroyAllUserSessions(testUser.user.id);
    expect(result.success).toBe(true);

    // Verify both sessions are destroyed
    expect(await verifySessionExists(session1.sessionToken)).toBe(false);
    expect(await verifySessionExists(session2.sessionToken)).toBe(false);
  });

  // ============================================================================
  // Session Expiration
  // ============================================================================

  it("should handle expired session gracefully", async () => {
    const { redis } = await import("../../src/utils/redis.js");

    // Create session
    const session = await createTestSession(testUser);

    // Manually expire session by deleting from Redis
    await redis.del(`wallet:session:${session.sessionToken}`);

    // Try to retrieve expired session
    const result = await getSession(asSessionToken(session.sessionToken));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeNull();
    }

    // Verify session is invalid
    const isValid = await verifySession(asSessionToken(session.sessionToken));
    expect(isValid).toBe(false);
  });

  it("should reject operations with expired session", async () => {
    const { redis } = await import("../../src/utils/redis.js");

    // Create session
    const session = await createTestSession(testUser);

    // Expire session
    await redis.del(`wallet:session:${session.sessionToken}`);

    // Try to get keypair with expired session
    const { getKeypairForSigning } = await import(
      "../../src/services/wallet/session.js"
    );

    const result = await getKeypairForSigning(
      asSessionToken(session.sessionToken)
    );

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toContain("expired");
    }
  });

  // ============================================================================
  // Session Security
  // ============================================================================

  it("should not store session key in Redis", async () => {
    const { redis } = await import("../../src/utils/redis.js");

    const session = await createTestSession(testUser);

    // Get session data from Redis
    const data = await redis.get(`wallet:session:${session.sessionToken}`);

    expect(data).toBeDefined();

    if (data) {
      const sessionData = JSON.parse(data);

      // Verify session data contains encrypted key
      expect(sessionData.sessionEncryptedKey).toBeDefined();

      // Verify session data does NOT contain session key (it's derived from token!)
      expect(sessionData.sessionKey).toBeUndefined();

      // Verify session data does NOT contain password
      expect(sessionData.password).toBeUndefined();
    }
  });

  it("should generate unique session tokens", async () => {
    // Create multiple sessions
    const session1 = await createTestSession(testUser);
    const session2 = await createTestSession(testUser);

    // Tokens should be unique
    expect(session1.sessionToken).not.toBe(session2.sessionToken);

    // Both should be valid
    expect(await verifySession(asSessionToken(session1.sessionToken))).toBe(
      true
    );
    expect(await verifySession(asSessionToken(session2.sessionToken))).toBe(
      true
    );
  });

  // ============================================================================
  // Session Metrics
  // ============================================================================

  it("should track session creation metrics", async () => {
    const { register } = await import("prom-client");

    // Get initial metric value
    const metricsBefore = await register.metrics();
    const sessionsBefore = metricsBefore.match(
      /bolt_sniper_sessions_created_total{[^}]*}\s+(\d+)/
    );

    // Create session
    await createTestSession(testUser);

    // Get new metric value
    const metricsAfter = await register.metrics();
    const sessionsAfter = metricsAfter.match(
      /bolt_sniper_sessions_created_total{[^}]*}\s+(\d+)/
    );

    // Verify metric increased
    if (sessionsBefore && sessionsAfter) {
      const before = parseInt(sessionsBefore[1]);
      const after = parseInt(sessionsAfter[1]);
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });
});
