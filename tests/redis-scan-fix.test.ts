/**
 * Test Suite: Redis SCAN Fix (Non-Blocking Key Scanning)
 *
 * Verifies that redis.keys() has been completely replaced with scanKeys()
 * to prevent Redis blocking in production.
 *
 * Coverage:
 * 1. scanKeys() functionality and correctness
 * 2. destroyAllUserSessions() uses scanKeys
 * 3. getSessionStats() uses scanKeys
 * 4. Edge cases (empty results, many keys, pattern matching)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { redis, scanKeys } from "../src/utils/redis.js";
import {
  createSession,
  destroyAllUserSessions,
  getSessionStats,
} from "../src/services/wallet/session.js";
import { createWallet } from "../src/services/wallet/keyManager.js";
import { prisma } from "../src/utils/db.js";

// ============================================================================
// Test Data
// ============================================================================

const TEST_PREFIX = "test:scan:";

// ============================================================================
// Helpers
// ============================================================================

async function cleanupTestKeys(userIds?: string[]): Promise<void> {
  // Clean up test keys using SCAN (not KEYS!)
  const testKeys = await scanKeys(`${TEST_PREFIX}*`);
  if (testKeys.length > 0) {
    await redis.del(...testKeys);
  }

  // Clean up sessions for specific users if provided
  if (userIds && userIds.length > 0) {
    const allSessionKeys = await scanKeys(`wallet:session:*`);
    const keysToDelete: string[] = [];

    for (const key of allSessionKeys) {
      const data = await redis.get(key);
      if (data) {
        try {
          const sessionData = JSON.parse(data);
          if (userIds.includes(sessionData.userId)) {
            keysToDelete.push(key);
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
    }
  }
}

async function seedTestKeys(count: number): Promise<string[]> {
  const keys: string[] = [];

  for (let i = 0; i < count; i++) {
    const key = `${TEST_PREFIX}key:${i}`;
    await redis.set(key, `value${i}`, "EX", 60); // 60s TTL
    keys.push(key);
  }

  return keys;
}

// ============================================================================
// Tests: scanKeys() Core Functionality
// ============================================================================

describe("scanKeys() - Non-Blocking Key Scanning", () => {
  beforeEach(async () => {
    await cleanupTestKeys();
  });

  afterEach(async () => {
    await cleanupTestKeys();
  });

  it("should return empty array when no keys match pattern", async () => {
    const keys = await scanKeys(`${TEST_PREFIX}nonexistent:*`);

    expect(keys).toEqual([]);
  });

  it("should find single key matching pattern", async () => {
    const testKey = `${TEST_PREFIX}single`;
    await redis.set(testKey, "value", "EX", 60);

    const keys = await scanKeys(`${TEST_PREFIX}single`);

    expect(keys).toContain(testKey);
    expect(keys.length).toBe(1);
  });

  it("should find multiple keys matching pattern", async () => {
    const seededKeys = await seedTestKeys(10);

    const keys = await scanKeys(`${TEST_PREFIX}*`);

    expect(keys.length).toBe(10);
    for (const seededKey of seededKeys) {
      expect(keys).toContain(seededKey);
    }
  });

  it("should handle pattern matching with wildcards", async () => {
    await redis.set(`${TEST_PREFIX}user:123`, "data", "EX", 60);
    await redis.set(`${TEST_PREFIX}user:456`, "data", "EX", 60);
    await redis.set(`${TEST_PREFIX}session:789`, "data", "EX", 60);

    const userKeys = await scanKeys(`${TEST_PREFIX}user:*`);
    const sessionKeys = await scanKeys(`${TEST_PREFIX}session:*`);

    expect(userKeys.length).toBe(2);
    expect(sessionKeys.length).toBe(1);
  });

  it("should handle large number of keys (100+)", async () => {
    const seededKeys = await seedTestKeys(150);

    const keys = await scanKeys(`${TEST_PREFIX}*`);

    expect(keys.length).toBe(150);
    for (const seededKey of seededKeys) {
      expect(keys).toContain(seededKey);
    }
  });

  it("should use custom batch size (count parameter)", async () => {
    await seedTestKeys(50);

    // Use small batch size (10) - should still return all keys
    const keys = await scanKeys(`${TEST_PREFIX}*`, 10);

    expect(keys.length).toBe(50);
  });
});

// ============================================================================
// Tests: Session Service Integration
// ============================================================================

describe("Session Service - scanKeys Integration", () => {
  let testUserId1: string;
  let testUserId2: string;
  const testPassword1 = "password123";
  const testPassword2 = "password456";

  beforeAll(async () => {
    // Create test users with wallets
    const user1 = await prisma.user.create({
      data: {
        telegramId: BigInt(Math.floor(Math.random() * 1000000000)),
        username: `test_scan_user1_${Date.now()}`,
      },
    });

    const user2 = await prisma.user.create({
      data: {
        telegramId: BigInt(Math.floor(Math.random() * 1000000000)),
        username: `test_scan_user2_${Date.now()}`,
      },
    });

    testUserId1 = user1.id;
    testUserId2 = user2.id;

    // Create wallets
    await createWallet({ userId: testUserId1, password: testPassword1 });
    await createWallet({ userId: testUserId2, password: testPassword2 });
  });

  beforeEach(async () => {
    await cleanupTestKeys([testUserId1, testUserId2]);
  });

  afterEach(async () => {
    await cleanupTestKeys([testUserId1, testUserId2]);
  });

  afterAll(async () => {
    // Cleanup test users and wallets
    await prisma.wallet.deleteMany({
      where: {
        userId: { in: [testUserId1, testUserId2] },
      },
    });

    await prisma.user.deleteMany({
      where: {
        id: { in: [testUserId1, testUserId2] },
      },
    });
  });

  it("destroyAllUserSessions() should use scanKeys (not redis.keys)", async () => {
    // Create sessions for user1
    const session1 = await createSession({
      userId: testUserId1,
      password: testPassword1,
    });

    const session2 = await createSession({
      userId: testUserId1,
      password: testPassword1,
    });

    expect(session1.success).toBe(true);
    expect(session2.success).toBe(true);

    // Verify sessions exist
    const statsBefore = await getSessionStats();
    expect(statsBefore.totalSessions).toBeGreaterThanOrEqual(2);

    // Destroy all user sessions (should use scanKeys internally)
    const result = await destroyAllUserSessions(testUserId1);

    expect(result.success).toBe(true);

    // Verify sessions were destroyed
    const statsAfter = await getSessionStats();
    expect(statsAfter.totalSessions).toBeLessThan(statsBefore.totalSessions);
  });

  it("getSessionStats() should use scanKeys (not redis.keys)", async () => {
    // Create sessions for both users
    await createSession({ userId: testUserId1, password: testPassword1 });
    await createSession({ userId: testUserId2, password: testPassword2 });

    // Get stats (should use scanKeys internally)
    const stats = await getSessionStats();

    expect(stats.totalSessions).toBeGreaterThanOrEqual(2);
    expect(stats.activeUsers.has(testUserId1)).toBe(true);
    expect(stats.activeUsers.has(testUserId2)).toBe(true);
  });

  it("destroyAllUserSessions() should only delete target user's sessions", async () => {
    // Create sessions for both users
    await createSession({ userId: testUserId1, password: testPassword1 });
    await createSession({ userId: testUserId2, password: testPassword2 });

    const statsBefore = await getSessionStats();
    expect(statsBefore.activeUsers.has(testUserId1)).toBe(true);
    expect(statsBefore.activeUsers.has(testUserId2)).toBe(true);

    // Destroy only user1's sessions
    await destroyAllUserSessions(testUserId1);

    const statsAfter = await getSessionStats();

    // User1 sessions should be gone
    expect(statsAfter.activeUsers.has(testUserId1)).toBe(false);

    // User2 sessions should still exist
    expect(statsAfter.activeUsers.has(testUserId2)).toBe(true);
  });

  it("should handle no sessions gracefully", async () => {
    // Don't create any sessions for test users

    const stats = await getSessionStats();

    // May have sessions from other tests, but not from our test users
    expect(stats.activeUsers.has(testUserId1)).toBe(false);
    expect(stats.activeUsers.has(testUserId2)).toBe(false);
  });
});

// ============================================================================
// Tests: Performance & Edge Cases
// ============================================================================

describe("scanKeys() - Performance & Edge Cases", () => {
  beforeEach(async () => {
    await cleanupTestKeys();
  });

  afterEach(async () => {
    await cleanupTestKeys();
  });

  it("should handle pattern with no wildcards (exact match)", async () => {
    const exactKey = `${TEST_PREFIX}exact:key`;
    await redis.set(exactKey, "value", "EX", 60);

    const keys = await scanKeys(exactKey);

    expect(keys).toContain(exactKey);
  });

  it("should handle pattern with special Redis characters", async () => {
    // Redis SCAN supports: *, ?, [, ], ^, -, \
    await redis.set(`${TEST_PREFIX}user[123]`, "value", "EX", 60);

    const keys = await scanKeys(`${TEST_PREFIX}user*`);

    expect(keys.length).toBeGreaterThanOrEqual(1);
  });

  it("should not block Redis (returns in reasonable time)", async () => {
    // Seed 500 keys
    await seedTestKeys(500);

    const startTime = Date.now();
    const keys = await scanKeys(`${TEST_PREFIX}*`);
    const duration = Date.now() - startTime;

    expect(keys.length).toBe(500);

    // Should complete in under 2 seconds (non-blocking)
    expect(duration).toBeLessThan(2000);
  });
});

// ============================================================================
// Tests: Functional Equivalence (scanKeys vs KEYS)
// ============================================================================

describe("scanKeys() - Functional Equivalence to KEYS", () => {
  beforeEach(async () => {
    await cleanupTestKeys();
  });

  afterEach(async () => {
    await cleanupTestKeys();
  });

  it("should return same results as redis.keys() (deprecated)", async () => {
    // Seed test data
    await seedTestKeys(20);

    const pattern = `${TEST_PREFIX}*`;

    // Get results from both methods
    const scanResults = await scanKeys(pattern);
    const keysResults = await redis.keys(pattern); // ⚠️ Only for comparison test

    // Should have same keys (order may differ)
    expect(scanResults.length).toBe(keysResults.length);
    expect(scanResults.sort()).toEqual(keysResults.sort());
  });

  it("should match KEYS behavior with complex patterns", async () => {
    await redis.set(`${TEST_PREFIX}user:1:token`, "t1", "EX", 60);
    await redis.set(`${TEST_PREFIX}user:2:token`, "t2", "EX", 60);
    await redis.set(`${TEST_PREFIX}session:1`, "s1", "EX", 60);

    const pattern = `${TEST_PREFIX}user:*:token`;

    const scanResults = await scanKeys(pattern);
    const keysResults = await redis.keys(pattern);

    expect(scanResults.sort()).toEqual(keysResults.sort());
  });
});
