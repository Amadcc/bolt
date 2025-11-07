/**
 * E2E Smoke Tests
 *
 * Basic sanity checks to verify the application can start and connect to services.
 * These tests work with current implementation WITHOUT modifications.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../../src/utils/db.js";
import { redis } from "../../src/utils/redis.js";

describe("E2E: Smoke Tests", () => {
  // ============================================================================
  // Database Tests
  // ============================================================================

  describe("Database Connection", () => {
    beforeAll(async () => {
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("should connect to PostgreSQL database", async () => {
      // Simple query to verify connection
      const result = await prisma.$queryRaw`SELECT 1 as test`;
      expect(result).toBeDefined();
    });

    it("should have User table", async () => {
      // Verify User model is accessible
      const count = await prisma.user.count();
      expect(typeof count).toBe("number");
    });

    it("should have Wallet table", async () => {
      const count = await prisma.wallet.count();
      expect(typeof count).toBe("number");
    });

    it("should have Order table", async () => {
      const count = await prisma.order.count();
      expect(typeof count).toBe("number");
    });

    it("should have HoneypotCheck table", async () => {
      const count = await prisma.honeypotCheck.count();
      expect(typeof count).toBe("number");
    });
  });

  // ============================================================================
  // Redis Tests
  // ============================================================================

  describe("Redis Connection", () => {
    it("should connect to Redis", async () => {
      const pong = await redis.ping();
      expect(pong).toBe("PONG");
    });

    it("should set and get values", async () => {
      const key = "test:smoke:key";
      const value = "test-value";

      await redis.set(key, value);
      const retrieved = await redis.get(key);

      expect(retrieved).toBe(value);

      // Cleanup
      await redis.del(key);
    });

    it("should handle TTL", async () => {
      const key = "test:smoke:ttl";
      const value = "expires-soon";

      await redis.setex(key, 10, value); // 10 seconds TTL

      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);

      // Cleanup
      await redis.del(key);
    });

    it("should handle hash operations", async () => {
      const key = "test:smoke:hash";

      await redis.hset(key, "field1", "value1");
      await redis.hset(key, "field2", "value2");

      const value1 = await redis.hget(key, "field1");
      const value2 = await redis.hget(key, "field2");

      expect(value1).toBe("value1");
      expect(value2).toBe("value2");

      // Cleanup
      await redis.del(key);
    });
  });

  // ============================================================================
  // Encryption Tests
  // ============================================================================

  describe("Encryption Service", () => {
    it("should encrypt and decrypt data", async () => {
      const { encryptPrivateKey, decryptPrivateKey } = await import(
        "../../src/services/wallet/encryption.js"
      );

      // Use 32 bytes (API requires 32 or 64 bytes)
      const testData = new Uint8Array(32);
      testData.set([1, 2, 3, 4, 5], 0); // Set first 5 bytes
      const password = "test-password-123";

      // Encrypt
      const encryptResult = await encryptPrivateKey(testData, password);
      expect(encryptResult.success).toBe(true);

      if (encryptResult.success) {
        const { encryptedData } = encryptResult.value;

        // Decrypt
        const decryptResult = await decryptPrivateKey(
          encryptedData,
          password
        );

        expect(decryptResult.success).toBe(true);

        if (decryptResult.success) {
          const decrypted = decryptResult.value;

          // Verify data matches
          expect(decrypted).toEqual(testData);
        }
      }
    });

    it("should fail with wrong password", async () => {
      const { encryptPrivateKey, decryptPrivateKey } = await import(
        "../../src/services/wallet/encryption.js"
      );

      // Use 32 bytes
      const testData = new Uint8Array(32);
      testData.set([1, 2, 3, 4, 5], 0);
      const password = "correct-password";
      const wrongPassword = "wrong-password";

      // Encrypt with correct password
      const encryptResult = await encryptPrivateKey(testData, password);
      expect(encryptResult.success).toBe(true);

      if (encryptResult.success) {
        const { encryptedData } = encryptResult.value;

        // Decrypt with wrong password
        const decryptResult = await decryptPrivateKey(
          encryptedData,
          wrongPassword
        );

        // Should fail
        expect(decryptResult.success).toBe(false);
      }
    });
  });

  // ============================================================================
  // Session Service Tests
  // ============================================================================

  describe("Session Service", () => {
    it("should load session service module", async () => {
      const sessionModule = await import("../../src/services/wallet/session.js");

      // Verify exports exist
      expect(sessionModule.createSession).toBeDefined();
      expect(sessionModule.getSession).toBeDefined();
      expect(sessionModule.destroySession).toBeDefined();
      expect(sessionModule.verifySession).toBeDefined();
      expect(sessionModule.extendSession).toBeDefined();

      expect(typeof sessionModule.createSession).toBe("function");
      expect(typeof sessionModule.getSession).toBe("function");
    });
  });

  // ============================================================================
  // Metrics Tests
  // ============================================================================

  describe("Metrics Service", () => {
    beforeAll(async () => {
      // Import metrics to initialize registry
      await import("../../src/utils/metrics.js");
    });

    it("should have Prometheus registry", async () => {
      const { register } = await import("prom-client");
      expect(register).toBeDefined();
    });

    it("should have registered metrics", async () => {
      const { register } = await import("prom-client");

      const metrics = await register.metrics();
      expect(metrics).toBeDefined();
      expect(typeof metrics).toBe("string");

      // Should contain our custom metrics
      expect(metrics).toContain("bolt_sniper_");
    });

    it("should have at least 50 metrics registered", async () => {
      const { register } = await import("prom-client");

      const metricsArray = register.getMetricsAsArray();
      expect(metricsArray.length).toBeGreaterThanOrEqual(50);
    });
  });

  // ============================================================================
  // Logger Tests
  // ============================================================================

  describe("Logger Service", () => {
    it("should initialize logger", async () => {
      const { logger } = await import("../../src/utils/logger.js");
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    it("should log without errors", async () => {
      const { logger } = await import("../../src/utils/logger.js");

      // These should not throw
      logger.info("Smoke test: info log");
      logger.debug("Smoke test: debug log");
      logger.warn("Smoke test: warn log");

      expect(true).toBe(true);
    });
  });

  // ============================================================================
  // Environment Tests
  // ============================================================================

  describe("Environment Configuration", () => {
    it("should have required environment variables", async () => {
      expect(process.env.DATABASE_URL).toBeDefined();
      expect(process.env.REDIS_URL).toBeDefined();
      expect(process.env.SESSION_MASTER_SECRET).toBeDefined();
    });

    it("should load environment config", async () => {
      const { validateEnv } = await import("../../src/config/env.js");
      const env = validateEnv();
      expect(env).toBeDefined();
      expect(env.DATABASE_URL).toBeDefined();
      expect(env.REDIS_URL).toBeDefined();
      // Accept any NODE_ENV since it's controlled by test runner
      expect(["test", "development"]).toContain(env.NODE_ENV);
    });
  });
});
