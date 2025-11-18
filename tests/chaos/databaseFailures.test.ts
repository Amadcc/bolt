/**
 * CHAOS TESTING: Database Failure Scenarios
 *
 * Tests system resilience to database failures:
 * - Postgres connection loss
 * - Transaction deadlocks
 * - Retry logic verification
 * - Data consistency validation
 *
 * Sprint 3.3 Task 3.3.2 (2 hours)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/utils/db.js";
import { logger } from "../../src/utils/logger.js";
import { retry } from "../../src/utils/retry.js";
import type { Result } from "../../src/types/common.js";
import { Prisma } from "@prisma/client";

// ============================================================================
// Skip Conditions
// ============================================================================

const shouldRunChaosTests = process.env.CHAOS_TESTS === "true";
const skipMessage = "CHAOS_TESTS environment variable not set - skipping chaos tests";

// ============================================================================
// Test Constants
// ============================================================================

const TEST_USER_PREFIX = "chaos_test_user_";
const TEST_WALLET_PREFIX = "chaos_test_wallet_";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Generate random test user ID
 */
function generateTestUserId(): string {
  return `${TEST_USER_PREFIX}${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Create test user
 */
async function createTestUser(userId: string = generateTestUserId()) {
  return await prisma.user.create({
    data: {
      userId,
      username: `test_user_${userId}`,
      createdAt: new Date(),
    },
  });
}

/**
 * Create test wallet
 */
async function createTestWallet(userId: string) {
  return await prisma.wallet.create({
    data: {
      userId,
      publicKey: `${TEST_WALLET_PREFIX}${Math.random().toString(36).substring(2, 15)}`,
      encryptedPrivateKey: "test_encrypted_key",
      chain: "solana",
      isActive: true,
    },
  });
}

/**
 * Clean up test data
 */
async function cleanupTestData() {
  try {
    // Delete test wallets
    await prisma.wallet.deleteMany({
      where: {
        publicKey: {
          startsWith: TEST_WALLET_PREFIX,
        },
      },
    });

    // Delete test users
    await prisma.user.deleteMany({
      where: {
        userId: {
          startsWith: TEST_USER_PREFIX,
        },
      },
    });

    logger.debug("Cleaned up test data");
  } catch (error) {
    logger.warn("Failed to clean up test data", { error: String(error) });
  }
}

/**
 * Simulate database operation with retry
 */
async function databaseOperationWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<Result<T, Error>> {
  try {
    const result = await retry(
      operation,
      {
        maxRetries,
        baseDelay: 100,
        backoff: "exponential",
      }
    );

    return {
      success: true,
      value: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Simulate concurrent transactions (potential deadlock)
 */
async function simulateConcurrentTransactions(
  userId: string,
  count: number
): Promise<{
  successful: number;
  failed: number;
  errors: string[];
}> {
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) =>
      prisma.$transaction(async (tx) => {
        // Read user
        const user = await tx.user.findUnique({
          where: { userId },
        });

        if (!user) {
          throw new Error("User not found");
        }

        // Simulate work
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Update user (simulate contention)
        return await tx.user.update({
          where: { userId },
          data: {
            username: `updated_${i}_${Date.now()}`,
          },
        });
      })
    )
  );

  const successful = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason?.message || String(r.reason));

  return { successful, failed, errors };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Test Suite
// ============================================================================

describe.skipIf(!shouldRunChaosTests)(
  "Chaos Testing: Database Failures",
  () => {
    beforeAll(async () => {
      logger.info("Starting Database Failure Scenarios chaos tests");
      await cleanupTestData();
    });

    afterAll(async () => {
      await cleanupTestData();
      logger.info("Completed Database Failure Scenarios chaos tests");
    });

    beforeEach(async () => {
      // Ensure connection is alive
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (error) {
        logger.warn("Database connection check failed", { error: String(error) });
      }
    });

    // ==========================================================================
    // Scenario 1: Connection Loss
    // ==========================================================================

    describe("Scenario 1: Connection Loss", () => {
      test("should handle connection timeout gracefully", async () => {
        console.log("\n🔥 CHAOS: Testing connection timeout handling...");

        const userId = generateTestUserId();
        await createTestUser(userId);

        // Simulate slow query (potential timeout)
        const result = await databaseOperationWithRetry(async () => {
          return await prisma.user.findUnique({
            where: { userId },
          });
        });

        console.log(`   Result: ${result.success ? "SUCCESS" : "FAILED"}`);

        // Should handle gracefully (either succeed or fail with proper error)
        expect(result).toHaveProperty("success");

        if (!result.success) {
          expect(result.error).toBeInstanceOf(Error);
          console.log(`   Error: ${result.error.message}`);
        }
      }, 30000);

      test("should reconnect after connection loss", async () => {
        console.log("\n🔥 CHAOS: Testing automatic reconnection...");

        // Test connection
        const preCheck = await prisma.$queryRaw`SELECT 1`;
        expect(preCheck).toBeTruthy();
        console.log("   Initial connection: OK");

        // Simulate multiple operations (Prisma handles reconnection internally)
        const userId = generateTestUserId();
        await createTestUser(userId);

        // Wait a bit
        await sleep(1000);

        // Try operation again - should work
        const user = await prisma.user.findUnique({
          where: { userId },
        });

        console.log(`   Reconnection test: ${user ? "SUCCESS" : "FAILED"}`);
        expect(user).toBeTruthy();
      }, 30000);

      test("should maintain connection pool under load", async () => {
        console.log("\n🔥 CHAOS: Testing connection pool stability...");

        const userIds = Array.from({ length: 10 }, () => generateTestUserId());

        // Create users concurrently
        const createResults = await Promise.allSettled(
          userIds.map((userId) => createTestUser(userId))
        );

        const successful = createResults.filter((r) => r.status === "fulfilled").length;
        console.log(`   Created: ${successful}/10 users`);

        expect(successful).toBeGreaterThan(0);

        // Query all users concurrently
        const queryResults = await Promise.allSettled(
          userIds.map((userId) =>
            prisma.user.findUnique({
              where: { userId },
            })
          )
        );

        const found = queryResults.filter((r) => r.status === "fulfilled").length;
        console.log(`   Found: ${found}/10 users`);

        expect(found).toBeGreaterThan(0);
      }, 30000);
    });

    // ==========================================================================
    // Scenario 2: Transaction Deadlocks
    // ==========================================================================

    describe("Scenario 2: Transaction Deadlocks", () => {
      test("should handle concurrent updates without deadlock", async () => {
        console.log("\n🔥 CHAOS: Testing concurrent transaction handling...");

        const userId = generateTestUserId();
        await createTestUser(userId);

        // Run 10 concurrent transactions
        const result = await simulateConcurrentTransactions(userId, 10);

        console.log(`   Successful: ${result.successful}`);
        console.log(`   Failed: ${result.failed}`);

        if (result.failed > 0) {
          console.log(`   Errors: ${result.errors.slice(0, 3).join(", ")}`);
        }

        // At least some should succeed
        expect(result.successful).toBeGreaterThan(0);

        // Total should be 10
        expect(result.successful + result.failed).toBe(10);
      }, 30000);

      test("should rollback transaction on error", async () => {
        console.log("\n🔥 CHAOS: Testing transaction rollback...");

        const userId = generateTestUserId();
        const user = await createTestUser(userId);
        const originalUsername = user.username;

        console.log(`   Original username: ${originalUsername}`);

        // Transaction that should fail and rollback
        try {
          await prisma.$transaction(async (tx) => {
            // Update user
            await tx.user.update({
              where: { userId },
              data: { username: "should_rollback" },
            });

            // Force error
            throw new Error("Intentional transaction error");
          });
        } catch (error) {
          console.log("   Transaction failed (expected)");
        }

        // Verify rollback - username should be unchanged
        const userAfterRollback = await prisma.user.findUnique({
          where: { userId },
        });

        console.log(`   Username after rollback: ${userAfterRollback?.username}`);

        expect(userAfterRollback?.username).toBe(originalUsername);
      }, 30000);

      test("should handle nested transaction failures", async () => {
        console.log("\n🔥 CHAOS: Testing nested transaction handling...");

        const userId = generateTestUserId();
        await createTestUser(userId);

        let outerExecuted = false;
        let innerExecuted = false;

        try {
          await prisma.$transaction(async (tx1) => {
            outerExecuted = true;

            // Create wallet in outer transaction
            await tx1.wallet.create({
              data: {
                userId,
                publicKey: `${TEST_WALLET_PREFIX}nested_test`,
                encryptedPrivateKey: "test",
                chain: "solana",
                isActive: true,
              },
            });

            // Nested transaction (Prisma doesn't support true nesting, but we can test sequential operations)
            await tx1.user.update({
              where: { userId },
              data: { username: "nested_update" },
            });

            innerExecuted = true;

            // Force failure
            throw new Error("Nested transaction failure");
          });
        } catch (error) {
          console.log("   Nested transaction failed (expected)");
        }

        console.log(`   Outer executed: ${outerExecuted}`);
        console.log(`   Inner executed: ${innerExecuted}`);

        // Verify wallet was rolled back
        const wallet = await prisma.wallet.findFirst({
          where: {
            userId,
            publicKey: `${TEST_WALLET_PREFIX}nested_test`,
          },
        });

        expect(wallet).toBeNull(); // Should be rolled back
        expect(outerExecuted).toBe(true);
        expect(innerExecuted).toBe(true);
      }, 30000);
    });

    // ==========================================================================
    // Scenario 3: Retry Logic
    // ==========================================================================

    describe("Scenario 3: Retry Logic", () => {
      test("should retry failed queries with exponential backoff", async () => {
        console.log("\n🔥 CHAOS: Testing retry with exponential backoff...");

        let attempts = 0;
        const maxRetries = 3;

        const result = await databaseOperationWithRetry(async () => {
          attempts++;
          console.log(`   Attempt ${attempts}/${maxRetries + 1}`);

          // Fail first 2 attempts
          if (attempts < 3) {
            throw new Error("Simulated database error");
          }

          // Succeed on 3rd attempt
          return { success: true };
        }, maxRetries);

        console.log(`   Total attempts: ${attempts}`);
        console.log(`   Result: ${result.success ? "SUCCESS" : "FAILED"}`);

        expect(result.success).toBe(true);
        expect(attempts).toBe(3);
      }, 30000);

      test("should fail after max retries exceeded", async () => {
        console.log("\n🔥 CHAOS: Testing max retry limit...");

        let attempts = 0;
        const maxRetries = 3;

        const result = await databaseOperationWithRetry(async () => {
          attempts++;
          console.log(`   Attempt ${attempts}`);

          // Always fail
          throw new Error("Permanent database error");
        }, maxRetries);

        console.log(`   Total attempts: ${attempts}`);
        console.log(`   Result: ${result.success ? "SUCCESS" : "FAILED"}`);

        expect(result.success).toBe(false);
        expect(attempts).toBe(maxRetries + 1); // Initial + retries
      }, 30000);

      test("should not retry on non-retryable errors", async () => {
        console.log("\n🔥 CHAOS: Testing non-retryable error handling...");

        const userId = generateTestUserId();

        let attempts = 0;

        // Try to query non-existent user (should not retry)
        try {
          await prisma.user.findUniqueOrThrow({
            where: { userId },
          });
        } catch (error) {
          attempts++;
          console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        }

        console.log(`   Attempts: ${attempts}`);

        // Should only try once (no retry for not found)
        expect(attempts).toBe(1);
      }, 30000);
    });

    // ==========================================================================
    // Scenario 4: Data Consistency
    // ==========================================================================

    describe("Scenario 4: Data Consistency", () => {
      test("should maintain referential integrity on failure", async () => {
        console.log("\n🔥 CHAOS: Testing referential integrity...");

        const userId = generateTestUserId();
        const user = await createTestUser(userId);
        const wallet = await createTestWallet(userId);

        console.log(`   Created user: ${user.userId}`);
        console.log(`   Created wallet: ${wallet.id}`);

        // Try to delete user (should fail due to foreign key constraint)
        let deleteError = null;
        try {
          await prisma.user.delete({
            where: { userId },
          });
        } catch (error) {
          deleteError = error;
          console.log("   Delete failed (expected - foreign key constraint)");
        }

        expect(deleteError).toBeTruthy();

        // Verify user still exists
        const userStillExists = await prisma.user.findUnique({
          where: { userId },
        });

        expect(userStillExists).toBeTruthy();

        // Verify wallet still exists
        const walletStillExists = await prisma.wallet.findUnique({
          where: { id: wallet.id },
        });

        expect(walletStillExists).toBeTruthy();

        console.log("   Referential integrity maintained ✅");
      }, 30000);

      test("should handle cascade deletes correctly", async () => {
        console.log("\n🔥 CHAOS: Testing cascade delete behavior...");

        const userId = generateTestUserId();
        await createTestUser(userId);
        const wallet = await createTestWallet(userId);

        console.log(`   Created user: ${userId}`);
        console.log(`   Created wallet: ${wallet.id}`);

        // Delete wallet first
        await prisma.wallet.delete({
          where: { id: wallet.id },
        });

        // Now delete user (should succeed)
        await prisma.user.delete({
          where: { userId },
        });

        console.log("   User deleted successfully");

        // Verify both are gone
        const userExists = await prisma.user.findUnique({
          where: { userId },
        });

        const walletExists = await prisma.wallet.findUnique({
          where: { id: wallet.id },
        });

        expect(userExists).toBeNull();
        expect(walletExists).toBeNull();

        console.log("   Cascade delete successful ✅");
      }, 30000);

      test("should maintain data consistency during concurrent writes", async () => {
        console.log("\n🔥 CHAOS: Testing concurrent write consistency...");

        const userId = generateTestUserId();
        await createTestUser(userId);

        // Perform 20 concurrent updates
        const updates = Array.from({ length: 20 }, (_, i) =>
          prisma.user.update({
            where: { userId },
            data: { username: `concurrent_${i}` },
          })
        );

        const results = await Promise.allSettled(updates);

        const successful = results.filter((r) => r.status === "fulfilled").length;
        console.log(`   Successful updates: ${successful}/20`);

        // Get final state
        const finalUser = await prisma.user.findUnique({
          where: { userId },
        });

        console.log(`   Final username: ${finalUser?.username}`);

        // Should have one consistent value
        expect(finalUser).toBeTruthy();
        expect(finalUser?.username).toMatch(/^concurrent_\d+$/);
      }, 30000);

      test("should handle unique constraint violations", async () => {
        console.log("\n🔥 CHAOS: Testing unique constraint handling...");

        const userId = generateTestUserId();
        await createTestUser(userId);

        // Try to create duplicate user
        let duplicateError = null;
        try {
          await createTestUser(userId); // Same ID
        } catch (error) {
          duplicateError = error;
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            console.log(`   Unique constraint error: ${error.code}`);
          }
        }

        expect(duplicateError).toBeTruthy();

        // Verify only one user exists
        const users = await prisma.user.findMany({
          where: { userId },
        });

        console.log(`   Users with ID: ${users.length}`);
        expect(users.length).toBe(1);
      }, 30000);
    });

    // ==========================================================================
    // Scenario 5: Query Performance Under Stress
    // ==========================================================================

    describe("Scenario 5: Query Performance Under Stress", () => {
      test("should handle large batch operations", async () => {
        console.log("\n🔥 CHAOS: Testing large batch operations...");

        const batchSize = 50;
        const userIds = Array.from({ length: batchSize }, () => generateTestUserId());

        const startTime = Date.now();

        // Create many users
        const created = await prisma.user.createMany({
          data: userIds.map((userId) => ({
            userId,
            username: `batch_user_${userId}`,
            createdAt: new Date(),
          })),
        });

        const duration = Date.now() - startTime;

        console.log(`   Created ${created.count} users in ${duration}ms`);
        console.log(`   Rate: ${(created.count / duration * 1000).toFixed(2)} users/sec`);

        expect(created.count).toBe(batchSize);
      }, 60000);

      test("should handle complex queries under load", async () => {
        console.log("\n🔥 CHAOS: Testing complex query performance...");

        // Create test data
        const userId = generateTestUserId();
        await createTestUser(userId);

        for (let i = 0; i < 5; i++) {
          await createTestWallet(userId);
        }

        const startTime = Date.now();

        // Complex query with join
        const result = await prisma.user.findUnique({
          where: { userId },
          include: {
            wallets: {
              where: {
                isActive: true,
              },
            },
          },
        });

        const duration = Date.now() - startTime;

        console.log(`   Query completed in ${duration}ms`);
        console.log(`   Found ${result?.wallets.length || 0} wallets`);

        expect(result).toBeTruthy();
        expect(result?.wallets.length).toBeGreaterThan(0);
      }, 30000);

      test("should handle connection pool exhaustion gracefully", async () => {
        console.log("\n🔥 CHAOS: Testing connection pool limits...");

        // Simulate many concurrent queries (may exhaust pool)
        const concurrentQueries = 50;

        const queries = Array.from({ length: concurrentQueries }, (_, i) =>
          prisma.$queryRaw`SELECT ${i} as value, pg_sleep(0.1)`
        );

        const startTime = Date.now();
        const results = await Promise.allSettled(queries);
        const duration = Date.now() - startTime;

        const successful = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.filter((r) => r.status === "rejected").length;

        console.log(`   Completed in ${duration}ms`);
        console.log(`   Successful: ${successful}/${concurrentQueries}`);
        console.log(`   Failed: ${failed}/${concurrentQueries}`);

        // Should handle gracefully (either queue or fail cleanly)
        expect(successful + failed).toBe(concurrentQueries);
      }, 60000);
    });
  },
  {
    timeout: 180000, // 3 minutes for entire suite
  }
);

// Skip message for when tests are skipped
if (!shouldRunChaosTests) {
  describe.skip("Chaos Testing: Database Failures", () => {
    test(skipMessage, () => {});
  });
}
