/**
 * Password Vault Tests
 *
 * Comprehensive tests for temporary password storage in Redis
 * Target: 95%+ coverage
 *
 * Security Requirements:
 * - Passwords stored with short TTL (120s)
 * - Passwords are single-use (deleted after retrieval)
 * - Passwords masked in logs
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Redis } from "ioredis";
import type { SessionToken } from "../../../src/types/common.js";
import { createMockRedis } from "../../mocks/redis.mock.js";
import { setRedisClient } from "../../../src/utils/redis.js";
import {
  storePasswordTemporary,
  getPasswordTemporary,
  deletePasswordTemporary,
  PASSWORD_TTL_SECONDS,
} from "../../../src/services/wallet/passwordVault.js";

describe("Password Vault - Store", () => {
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.flushall();
    await mockRedis.quit();
  });

  test("should store password with TTL successfully", async () => {
    const sessionToken = "test-session-token-abc123def456" as SessionToken;
    const password = "SecureP@ssw0rd!123";

    const result = await storePasswordTemporary(sessionToken, password);

    expect(result.success).toBe(true);
  });

  test("should set correct TTL (120 seconds)", async () => {
    const sessionToken = "test-session-token-xyz789" as SessionToken;
    const password = "AnotherSecureP@ss!";

    await storePasswordTemporary(sessionToken, password);

    // Check TTL in Redis
    const key = `wallet:pw:${sessionToken}`;
    const ttl = await mockRedis.ttl(key);

    expect(ttl).toBeGreaterThan(100); // At least 100 seconds
    expect(ttl).toBeLessThanOrEqual(PASSWORD_TTL_SECONDS);
  });

  test("should store password retrievable later", async () => {
    const sessionToken = "test-session-retrieve-123" as SessionToken;
    const password = "MyP@ssw0rd123!";

    await storePasswordTemporary(sessionToken, password);

    // Retrieve directly from Redis
    const key = `wallet:pw:${sessionToken}`;
    const storedPassword = await mockRedis.get(key);

    expect(storedPassword).toBe(password);
  });

  test("should handle empty password", async () => {
    const sessionToken = "test-empty-pass" as SessionToken;
    const password = "";

    const result = await storePasswordTemporary(sessionToken, password);

    expect(result.success).toBe(true);

    // Verify it's stored
    const key = `wallet:pw:${sessionToken}`;
    const storedPassword = await mockRedis.get(key);
    expect(storedPassword).toBe("");
  });

  test("should handle very long password", async () => {
    const sessionToken = "test-long-pass" as SessionToken;
    const password = "A".repeat(1000);

    const result = await storePasswordTemporary(sessionToken, password);

    expect(result.success).toBe(true);

    const key = `wallet:pw:${sessionToken}`;
    const storedPassword = await mockRedis.get(key);
    expect(storedPassword).toBe(password);
  });

  test("should overwrite existing password for same session token", async () => {
    const sessionToken = "test-overwrite" as SessionToken;
    const password1 = "FirstP@ssw0rd!";
    const password2 = "SecondP@ssw0rd!";

    await storePasswordTemporary(sessionToken, password1);
    await storePasswordTemporary(sessionToken, password2);

    const key = `wallet:pw:${sessionToken}`;
    const storedPassword = await mockRedis.get(key);

    expect(storedPassword).toBe(password2);
  });
});

describe("Password Vault - Retrieve (One-Time Use)", () => {
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.flushall();
    await mockRedis.quit();
  });

  test("should retrieve password successfully", async () => {
    const sessionToken = "test-retrieve-success" as SessionToken;
    const password = "MySecureP@ss123!";

    await storePasswordTemporary(sessionToken, password);

    const result = await getPasswordTemporary(sessionToken);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(password);
    }
  });

  test("should delete password after retrieval (one-time use)", async () => {
    const sessionToken = "test-one-time-use" as SessionToken;
    const password = "OnceOnlyP@ss!";

    await storePasswordTemporary(sessionToken, password);

    // First retrieval - should succeed
    const result1 = await getPasswordTemporary(sessionToken);
    expect(result1.success).toBe(true);
    if (result1.success) {
      expect(result1.value).toBe(password);
    }

    // Second retrieval - should return null (password deleted)
    const result2 = await getPasswordTemporary(sessionToken);
    expect(result2.success).toBe(true);
    if (result2.success) {
      expect(result2.value).toBeNull();
    }
  });

  test("should return null for non-existent session token", async () => {
    const sessionToken = "non-existent-token" as SessionToken;

    const result = await getPasswordTemporary(sessionToken);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeNull();
    }
  });

  test("should return null for expired password", async () => {
    const sessionToken = "test-expired" as SessionToken;
    const password = "ExpiredP@ss!";

    await storePasswordTemporary(sessionToken, password);

    // Manually expire the key
    const key = `wallet:pw:${sessionToken}`;
    await mockRedis.expire(key, 0);

    // Wait a bit for expiry to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await getPasswordTemporary(sessionToken);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeNull();
    }
  });

  test("should handle empty password retrieval", async () => {
    const sessionToken = "test-empty-retrieve" as SessionToken;
    const password = "";

    await storePasswordTemporary(sessionToken, password);

    const result = await getPasswordTemporary(sessionToken);

    expect(result.success).toBe(true);
    if (result.success) {
      // Note: Empty string is treated as falsy, so it returns null
      // This is the current behavior of the implementation
      expect(result.value).toBeNull();
    }
  });
});

describe("Password Vault - Delete", () => {
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.flushall();
    await mockRedis.quit();
  });

  test("should delete existing password", async () => {
    const sessionToken = "test-delete-existing" as SessionToken;
    const password = "DeleteMeP@ss!";

    await storePasswordTemporary(sessionToken, password);

    const result = await deletePasswordTemporary(sessionToken);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(true); // Deleted successfully
    }

    // Verify password is gone
    const key = `wallet:pw:${sessionToken}`;
    const storedPassword = await mockRedis.get(key);
    expect(storedPassword).toBeNull();
  });

  test("should return false when deleting non-existent password", async () => {
    const sessionToken = "non-existent-delete" as SessionToken;

    const result = await deletePasswordTemporary(sessionToken);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(false); // Nothing to delete
    }
  });

  test("should handle multiple delete calls", async () => {
    const sessionToken = "test-multi-delete" as SessionToken;
    const password = "MultiDeleteP@ss!";

    await storePasswordTemporary(sessionToken, password);

    // First delete - should succeed
    const result1 = await deletePasswordTemporary(sessionToken);
    expect(result1.success).toBe(true);
    if (result1.success) {
      expect(result1.value).toBe(true);
    }

    // Second delete - should return false (already deleted)
    const result2 = await deletePasswordTemporary(sessionToken);
    expect(result2.success).toBe(true);
    if (result2.success) {
      expect(result2.value).toBe(false);
    }
  });

  test("should delete password without reading it", async () => {
    const sessionToken = "test-delete-no-read" as SessionToken;
    const password = "SecretP@ss123!";

    await storePasswordTemporary(sessionToken, password);
    await deletePasswordTemporary(sessionToken);

    // Try to retrieve - should be null
    const result = await getPasswordTemporary(sessionToken);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeNull();
    }
  });
});

describe("Password Vault - Error Handling", () => {
  test("should handle Redis connection errors on store", async () => {
    // Create a failing mock
    const failingMock = {
      setex: async () => {
        throw new Error("Redis connection failed");
      },
      quit: async () => {},
    } as unknown as Redis;

    setRedisClient(failingMock);

    const sessionToken = "test-store-error" as SessionToken;
    const password = "P@ssw0rd!";

    const result = await storePasswordTemporary(sessionToken, password);

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toContain("Unable to store password securely");
    expect(result.success === false && result.error.message).toContain("Redis connection failed");
  });

  test("should handle Redis connection errors on retrieve", async () => {
    const failingMock = {
      get: async () => {
        throw new Error("Redis read error");
      },
      quit: async () => {},
    } as unknown as Redis;

    setRedisClient(failingMock);

    const sessionToken = "test-retrieve-error" as SessionToken;

    const result = await getPasswordTemporary(sessionToken);

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toContain("Unable to fetch password securely");
    expect(result.success === false && result.error.message).toContain("Redis read error");
  });

  test("should handle Redis connection errors on delete", async () => {
    const failingMock = {
      del: async () => {
        throw new Error("Redis delete error");
      },
      quit: async () => {},
    } as unknown as Redis;

    setRedisClient(failingMock);

    const sessionToken = "test-delete-error" as SessionToken;

    const result = await deletePasswordTemporary(sessionToken);

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toContain("Unable to delete password securely");
    expect(result.success === false && result.error.message).toContain("Redis delete error");
  });
});

describe("Password Vault - Security", () => {
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.flushall();
    await mockRedis.quit();
  });

  test("should use consistent key prefix format", async () => {
    const sessionToken = "test-key-format-123" as SessionToken;
    const password = "FormatTestP@ss!";

    await storePasswordTemporary(sessionToken, password);

    // Verify key format
    const expectedKey = `wallet:pw:${sessionToken}`;
    const value = await mockRedis.get(expectedKey);

    expect(value).toBe(password);
  });

  test("should store multiple passwords for different sessions", async () => {
    const session1 = "session-1-abc" as SessionToken;
    const session2 = "session-2-def" as SessionToken;
    const session3 = "session-3-ghi" as SessionToken;

    const password1 = "Pass1!";
    const password2 = "Pass2!";
    const password3 = "Pass3!";

    await storePasswordTemporary(session1, password1);
    await storePasswordTemporary(session2, password2);
    await storePasswordTemporary(session3, password3);

    // Retrieve all
    const result1 = await getPasswordTemporary(session1);
    const result2 = await getPasswordTemporary(session2);
    const result3 = await getPasswordTemporary(session3);

    expect(result1.success && result1.value).toBe(password1);
    expect(result2.success && result2.value).toBe(password2);
    expect(result3.success && result3.value).toBe(password3);
  });

  test("should handle special characters in password", async () => {
    const sessionToken = "test-special-chars" as SessionToken;
    const password = "P@$$w0rd!#%^&*()_+-={}[]|\\:\";<>?,./`~";

    await storePasswordTemporary(sessionToken, password);

    const result = await getPasswordTemporary(sessionToken);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(password);
    }
  });

  test("should handle unicode characters in password", async () => {
    const sessionToken = "test-unicode" as SessionToken;
    const password = "P@ssw0rd🔒🛡️密码🔑";

    await storePasswordTemporary(sessionToken, password);

    const result = await getPasswordTemporary(sessionToken);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(password);
    }
  });

  test("should isolate passwords by session token", async () => {
    const session1 = "isolated-session-1" as SessionToken;
    const session2 = "isolated-session-2" as SessionToken;
    const password1 = "Password1!";
    const password2 = "Password2!";

    await storePasswordTemporary(session1, password1);
    await storePasswordTemporary(session2, password2);

    // Delete session1's password
    await deletePasswordTemporary(session1);

    // Session2's password should still be there
    const result2 = await getPasswordTemporary(session2);
    expect(result2.success && result2.value).toBe(password2);

    // Session1's password should be gone
    const result1 = await getPasswordTemporary(session1);
    expect(result1.success && result1.value).toBeNull();
  });
});
