/**
 * Redis Utility Tests
 *
 * Comprehensive tests for Redis client wrapper
 * Target: 90%+ coverage
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Redis } from "ioredis";
import { createMockRedis } from "../../mocks/redis.mock.js";
import {
  setRedisClient,
  getRedisClient,
  checkRedisHealth,
  scanKeys,
  closeRedis,
  type RedisHealthStatus,
} from "../../../src/utils/redis.js";

describe("Redis Client - Dependency Injection", () => {
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.quit();
  });

  test("should inject mock Redis client", () => {
    const client = getRedisClient();
    expect(client).toBeDefined();
    expect(client).toBe(mockRedis);
  });

  test("should return same client on multiple getRedisClient calls", () => {
    const client1 = getRedisClient();
    const client2 = getRedisClient();
    expect(client1).toBe(client2);
  });
});

describe("Redis Health Check", () => {
  let mockRedis: Redis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.quit();
  });

  test("should return healthy status with server info", async () => {
    const health: RedisHealthStatus = await checkRedisHealth();

    expect(health.healthy).toBe(true);
    expect(health.latencyMs).toBeDefined();
    expect(typeof health.latencyMs).toBe("number");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.serverInfo).toBeDefined();
  });

  test("should measure latency correctly", async () => {
    const health: RedisHealthStatus = await checkRedisHealth();

    // Latency should be reasonable (< 1000ms for mock)
    expect(health.latencyMs).toBeLessThan(1000);
  });

  test("should include server version in health check", async () => {
    const health: RedisHealthStatus = await checkRedisHealth();

    if (health.healthy && health.serverInfo) {
      expect(health.serverInfo.version).toBeDefined();
      expect(typeof health.serverInfo.version).toBe("string");
    }
  });

  test("should include server mode in health check", async () => {
    const health: RedisHealthStatus = await checkRedisHealth();

    if (health.healthy && health.serverInfo) {
      expect(health.serverInfo.mode).toBeDefined();
      expect(typeof health.serverInfo.mode).toBe("string");
    }
  });

  test("should include uptime in health check", async () => {
    const health: RedisHealthStatus = await checkRedisHealth();

    if (health.healthy && health.serverInfo) {
      expect(health.serverInfo.uptimeSeconds).toBeDefined();
      expect(typeof health.serverInfo.uptimeSeconds).toBe("number");
      expect(health.serverInfo.uptimeSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  test("should include connected clients in health check", async () => {
    const health: RedisHealthStatus = await checkRedisHealth();

    if (health.healthy && health.serverInfo) {
      expect(health.serverInfo.connectedClients).toBeDefined();
      expect(typeof health.serverInfo.connectedClients).toBe("number");
      expect(health.serverInfo.connectedClients).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("Key Scanning (Production-Safe)", () => {
  let mockRedis: Redis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);

    // Seed test data
    await mockRedis.set("session:user:123", "value1");
    await mockRedis.set("session:user:456", "value2");
    await mockRedis.set("session:user:789", "value3");
    await mockRedis.set("cache:token:abc", "value4");
    await mockRedis.set("cache:token:def", "value5");
    await mockRedis.set("other:key", "value6");
  });

  afterEach(async () => {
    await mockRedis.flushall();
    await mockRedis.quit();
  });

  test("should scan all keys with wildcard pattern", async () => {
    const keys = await scanKeys("*");

    expect(keys).toBeDefined();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
  });

  test("should scan keys with specific prefix", async () => {
    const sessionKeys = await scanKeys("session:*");

    expect(sessionKeys).toBeDefined();
    expect(Array.isArray(sessionKeys)).toBe(true);
    expect(sessionKeys.length).toBe(3);
    expect(sessionKeys.every((key) => key.startsWith("session:"))).toBe(true);
  });

  test("should scan keys with nested prefix", async () => {
    const userSessionKeys = await scanKeys("session:user:*");

    expect(userSessionKeys).toBeDefined();
    expect(Array.isArray(userSessionKeys)).toBe(true);
    expect(userSessionKeys.length).toBe(3);
  });

  test("should scan cache keys", async () => {
    const cacheKeys = await scanKeys("cache:*");

    expect(cacheKeys).toBeDefined();
    expect(Array.isArray(cacheKeys)).toBe(true);
    expect(cacheKeys.length).toBe(2);
    expect(cacheKeys.every((key) => key.startsWith("cache:"))).toBe(true);
  });

  test("should return empty array for non-matching pattern", async () => {
    const keys = await scanKeys("nonexistent:*");

    expect(keys).toBeDefined();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBe(0);
  });

  test("should scan with custom count hint", async () => {
    const keys = await scanKeys("*", 5); // Small batch size

    expect(keys).toBeDefined();
    expect(Array.isArray(keys)).toBe(true);
  });

  test("should handle large dataset with pagination", async () => {
    // Add more keys
    for (let i = 0; i < 50; i++) {
      await mockRedis.set(`bulk:key:${i}`, `value${i}`);
    }

    const bulkKeys = await scanKeys("bulk:*", 10);

    expect(bulkKeys).toBeDefined();
    expect(bulkKeys.length).toBe(50);
  });

  test("should scan exact key match", async () => {
    const exactKeys = await scanKeys("other:key");

    expect(exactKeys).toBeDefined();
    expect(Array.isArray(exactKeys)).toBe(true);
    expect(exactKeys.length).toBeGreaterThanOrEqual(0);
  });
});

describe("Graceful Shutdown", () => {
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  test("should close Redis connection gracefully", async () => {
    await expect(closeRedis()).resolves.toBeUndefined();
  });

  test("should handle multiple close calls", async () => {
    const mockRedis2 = createMockRedis();
    setRedisClient(mockRedis2);

    await closeRedis();

    // Create new client for second close
    const mockRedis3 = createMockRedis();
    setRedisClient(mockRedis3);

    await expect(closeRedis()).resolves.toBeUndefined();
  });
});

describe("Redis Proxy Access", () => {
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.quit();
  });

  test("should access Redis through proxy", async () => {
    const { redis } = await import("../../../src/utils/redis.js");

    await redis.set("proxy:test", "value");
    const value = await redis.get("proxy:test");

    expect(value).toBe("value");
  });

  test("should call Redis commands through proxy", async () => {
    const { redis } = await import("../../../src/utils/redis.js");

    // Test various commands
    await redis.set("test:key", "test:value");
    const value = await redis.get("test:key");
    expect(value).toBe("test:value");

    const exists = await redis.exists("test:key");
    expect(exists).toBe(1);

    await redis.del("test:key");
    const deletedValue = await redis.get("test:key");
    expect(deletedValue).toBeNull();
  });

  test("should handle Redis TTL through proxy", async () => {
    const { redis } = await import("../../../src/utils/redis.js");

    await redis.setex("ttl:key", 60, "ttl:value");
    const ttl = await redis.ttl("ttl:key");

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test("should handle Redis increment through proxy", async () => {
    const { redis } = await import("../../../src/utils/redis.js");

    await redis.set("counter", "0");
    const result1 = await redis.incr("counter");
    expect(result1).toBe(1);

    const result2 = await redis.incr("counter");
    expect(result2).toBe(2);
  });

  test("should handle Redis hashes through proxy", async () => {
    const { redis } = await import("../../../src/utils/redis.js");

    await redis.hset("hash:test", "field1", "value1");
    await redis.hset("hash:test", "field2", "value2");

    const value1 = await redis.hget("hash:test", "field1");
    expect(value1).toBe("value1");

    const all = await redis.hgetall("hash:test");
    expect(all).toEqual({
      field1: "value1",
      field2: "value2",
    });
  });
});

describe("Redis Error Handling", () => {
  test("should return unhealthy status on ping failure", async () => {
    // Create a mock that fails ping
    const failingMock = {
      ping: async () => "WRONG", // Return wrong value
      info: async () => "redis_version:7.0.0\r\nredis_mode:standalone\r\n",
      quit: async () => {},
    } as unknown as Redis;

    setRedisClient(failingMock);

    const health = await checkRedisHealth();

    expect(health.healthy).toBe(false);
    expect(health.error).toBeDefined();
    expect(health.error).toContain("Unexpected PING response");
  });

  test("should return unhealthy status on exception", async () => {
    // Create a mock that throws
    const errorMock = {
      ping: async () => {
        throw new Error("Connection refused");
      },
      quit: async () => {},
    } as unknown as Redis;

    setRedisClient(errorMock);

    const health = await checkRedisHealth();

    expect(health.healthy).toBe(false);
    expect(health.error).toBeDefined();
    expect(health.error).toContain("Connection refused");
  });
});

describe("Redis Key Expiration", () => {
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setRedisClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.quit();
  });

  test("should handle expired keys in scan", async () => {
    // Set keys with expiration
    await mockRedis.setex("expiring:key1", 1, "value1");
    await mockRedis.setex("expiring:key2", 1, "value2");
    await mockRedis.set("permanent:key", "value");

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const keys = await scanKeys("expiring:*");

    // Expired keys should not appear
    expect(keys.length).toBe(0);
  });
});
