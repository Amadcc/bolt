/**
 * DAY 11: WalletManager Integration Tests
 *
 * Comprehensive tests for multi-wallet CRUD operations, safety checks, and edge cases.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WalletManager } from "../../../src/services/wallet/walletManager";
import { SolanaService } from "../../../src/services/blockchain/solana";
import { prisma } from "../../../src/utils/db";
import { asWalletLabel, asWalletId } from "../../../src/types/walletRotation";

// Test user ID
const TEST_USER_ID = "test-user-multi-wallet";
const TEST_PASSWORD = "SecurePassword123!";

// Mock SolanaService
class MockSolanaService extends SolanaService {
  constructor() {
    super({
      rpcEndpoints: ["http://localhost:8899"],
      commitment: "confirmed",
    });
  }

  async executeRequest<T>(requestFn: (connection: any) => Promise<T>): Promise<T> {
    // Mock getBalance to return 1 SOL
    return Promise.resolve(1_000_000_000 as any);
  }
}

describe("WalletManager Integration Tests", () => {
  let manager: WalletManager;
  let solanaService: MockSolanaService;

  beforeEach(async () => {
    // Clean up test data
    await prisma.wallet.deleteMany({
      where: { userId: TEST_USER_ID },
    });
    await prisma.user.deleteMany({
      where: { telegramId: BigInt(123456789) },
    });

    // Create test user
    await prisma.user.create({
      data: {
        id: TEST_USER_ID,
        telegramId: BigInt(123456789),
        username: "test_user",
        subscriptionTier: "free",
      },
    });

    // Initialize services
    solanaService = new MockSolanaService();
    manager = new WalletManager(solanaService);
  });

  afterEach(async () => {
    // Clean up after tests
    await prisma.wallet.deleteMany({
      where: { userId: TEST_USER_ID },
    });
    await prisma.user.deleteMany({
      where: { id: TEST_USER_ID },
    });
  });

  // ==========================================================================
  // WALLET CREATION
  // ==========================================================================

  describe("Wallet Creation", () => {
    test("should create first wallet successfully", async () => {
      const result = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Main"),
        isPrimary: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.wallet.label).toBe("Main");
        expect(result.value.wallet.isPrimary).toBe(true);
        expect(result.value.mnemonic).toBeDefined();
        expect(result.value.mnemonic.split(" ")).toHaveLength(12);
      }
    });

    test("should create multiple wallets (up to 10)", async () => {
      const results = [];

      for (let i = 1; i <= 10; i++) {
        const result = await manager.createWallet({
          userId: TEST_USER_ID,
          password: TEST_PASSWORD,
          label: asWalletLabel(`Wallet ${i}`),
          isPrimary: i === 1,
        });
        results.push(result);
      }

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);

      // Verify count
      const countResult = await manager.getWalletCount(TEST_USER_ID);
      expect(countResult.success).toBe(true);
      if (countResult.success) {
        expect(countResult.value).toBe(10);
      }
    });

    test("should reject 11th wallet (max limit)", async () => {
      // Create 10 wallets
      for (let i = 1; i <= 10; i++) {
        await manager.createWallet({
          userId: TEST_USER_ID,
          password: TEST_PASSWORD,
          label: asWalletLabel(`Wallet ${i}`),
        });
      }

      // Try to create 11th
      const result = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Wallet 11"),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("MAX_WALLETS_REACHED");
      }
    });

    test("should auto-set first wallet as primary", async () => {
      const result = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("First"),
        // isPrimary not specified
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.wallet.isPrimary).toBe(true);
      }
    });

    test("should reject duplicate labels", async () => {
      // Create first wallet
      await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Trading"),
      });

      // Try to create second with same label
      const result = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Trading"),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("DUPLICATE_LABEL");
      }
    });

    test("should generate default labels", async () => {
      // Create without label
      const result1 = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
      });

      const result2 = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      if (result1.success && result2.success) {
        expect(result1.value.wallet.label).toBe("Main");
        expect(result2.value.wallet.label).toBe("Wallet 2");
      }
    });
  });

  // ==========================================================================
  // WALLET UPDATES
  // ==========================================================================

  describe("Wallet Updates", () => {
    test("should update wallet label", async () => {
      // Create wallet
      const createResult = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Old Label"),
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const walletId = createResult.value.wallet.id;

      // Update label
      const updateResult = await manager.updateWallet({
        walletId,
        label: asWalletLabel("New Label"),
      });

      expect(updateResult.success).toBe(true);
      if (updateResult.success) {
        expect(updateResult.value.label).toBe("New Label");
      }
    });

    test("should update isPrimary and clear other primary wallets", async () => {
      // Create 2 wallets
      const wallet1 = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Wallet 1"),
        isPrimary: true,
      });

      const wallet2 = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Wallet 2"),
        isPrimary: false,
      });

      if (!wallet1.success || !wallet2.success) return;

      // Set wallet 2 as primary
      await manager.updateWallet({
        walletId: wallet2.value.wallet.id,
        isPrimary: true,
      });

      // Verify wallet 1 is no longer primary
      const wallet1Updated = await manager.getWallet(wallet1.value.wallet.id);
      expect(wallet1Updated.success).toBe(true);
      if (wallet1Updated.success) {
        expect(wallet1Updated.value.isPrimary).toBe(false);
      }

      // Verify wallet 2 is now primary
      const wallet2Updated = await manager.getWallet(wallet2.value.wallet.id);
      expect(wallet2Updated.success).toBe(true);
      if (wallet2Updated.success) {
        expect(wallet2Updated.value.isPrimary).toBe(true);
      }
    });

    test("should deactivate wallet", async () => {
      const createResult = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Test"),
      });

      if (!createResult.success) return;

      const updateResult = await manager.updateWallet({
        walletId: createResult.value.wallet.id,
        isActive: false,
      });

      expect(updateResult.success).toBe(true);
      if (updateResult.success) {
        expect(updateResult.value.isActive).toBe(false);
      }
    });
  });

  // ==========================================================================
  // WALLET DELETION
  // ==========================================================================

  describe("Wallet Deletion", () => {
    test("should delete non-primary wallet", async () => {
      // Create 2 wallets
      await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Primary"),
        isPrimary: true,
      });

      const wallet2 = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Secondary"),
      });

      if (!wallet2.success) return;

      // Delete secondary
      const deleteResult = await manager.deleteWallet({
        walletId: wallet2.value.wallet.id,
        userId: TEST_USER_ID,
      });

      expect(deleteResult.success).toBe(true);

      // Verify deleted
      const getResult = await manager.getWallet(wallet2.value.wallet.id);
      expect(getResult.success).toBe(false);
      if (!getResult.success) {
        expect(getResult.error.type).toBe("WALLET_NOT_FOUND");
      }
    });

    test("should reject deleting primary wallet", async () => {
      // Create 2 wallets so primary is NOT the last wallet
      const wallet1 = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Primary"),
        isPrimary: true,
      });

      const wallet2 = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Secondary"),
        isPrimary: false,
      });

      if (!wallet1.success || !wallet2.success) return;

      // Try to delete primary wallet (should fail with CANNOT_DELETE_PRIMARY)
      const deleteResult = await manager.deleteWallet({
        walletId: wallet1.value.wallet.id,
        userId: TEST_USER_ID,
      });

      expect(deleteResult.success).toBe(false);
      if (!deleteResult.success) {
        expect(deleteResult.error.type).toBe("CANNOT_DELETE_PRIMARY");
      }
    });

    test("should reject deleting last wallet", async () => {
      const createResult = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Only Wallet"),
      });

      if (!createResult.success) return;

      const deleteResult = await manager.deleteWallet({
        walletId: createResult.value.wallet.id,
        userId: TEST_USER_ID,
      });

      expect(deleteResult.success).toBe(false);
      if (!deleteResult.success) {
        expect(deleteResult.error.type).toBe("CANNOT_DELETE_LAST_WALLET");
      }
    });
  });

  // ==========================================================================
  // WALLET RETRIEVAL
  // ==========================================================================

  describe("Wallet Retrieval", () => {
    test("should get all wallets", async () => {
      // Create 3 wallets
      for (let i = 1; i <= 3; i++) {
        await manager.createWallet({
          userId: TEST_USER_ID,
          password: TEST_PASSWORD,
          label: asWalletLabel(`Wallet ${i}`),
        });
      }

      const result = await manager.getAllWallets(TEST_USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toHaveLength(3);
      }
    });

    test("should return error for user with no wallets", async () => {
      const result = await manager.getAllWallets("non-existent-user");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("NO_WALLETS_FOUND");
      }
    });
  });

  // ==========================================================================
  // BALANCE AGGREGATION
  // ==========================================================================

  describe("Balance Aggregation", () => {
    test("should aggregate balance across multiple wallets", async () => {
      // Create 3 wallets
      for (let i = 1; i <= 3; i++) {
        await manager.createWallet({
          userId: TEST_USER_ID,
          password: TEST_PASSWORD,
          label: asWalletLabel(`Wallet ${i}`),
        });
      }

      const result = await manager.getAggregatedBalance(TEST_USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.totalWallets).toBe(3);
        expect(result.value.wallets).toHaveLength(3);
        // Mock returns 1 SOL per wallet
        expect(result.value.totalBalanceSol).toBe(3);
      }
    });
  });
});
