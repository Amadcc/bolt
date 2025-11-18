/**
 * DAY 11: WalletRotator Integration Tests
 *
 * Comprehensive tests for wallet rotation strategies and selection logic.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WalletRotator } from "../../../src/services/wallet/walletRotator";
import { WalletManager } from "../../../src/services/wallet/walletManager";
import { SolanaService } from "../../../src/services/blockchain/solana";
import { prisma } from "../../../src/utils/db";
import {
  asWalletLabel,
  asWalletId,
  type RotationStrategy,
} from "../../../src/types/walletRotation";

// Test user ID
const TEST_USER_ID = "test-user-rotation";
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

describe("WalletRotator Integration Tests", () => {
  let rotator: WalletRotator;
  let manager: WalletManager;
  let solanaService: MockSolanaService;

  beforeEach(async () => {
    // Clean up test data
    await prisma.wallet.deleteMany({
      where: { userId: TEST_USER_ID },
    });
    await prisma.user.deleteMany({
      where: { telegramId: BigInt(987654321) },
    });

    // Create test user
    await prisma.user.create({
      data: {
        id: TEST_USER_ID,
        telegramId: BigInt(987654321),
        username: "rotation_test_user",
        subscriptionTier: "free",
      },
    });

    // Initialize services
    solanaService = new MockSolanaService();
    manager = new WalletManager(solanaService);
    rotator = new WalletRotator(solanaService);
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
  // ROTATION CONFIGURATION
  // ==========================================================================

  describe("Rotation Configuration", () => {
    test("should return default config for new user", async () => {
      const result = await rotator.getRotationConfig(TEST_USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.strategy.type).toBe("ROUND_ROBIN");
        expect(result.value.enabled).toBe(false);
      }
    });

    test("should set custom rotation config", async () => {
      const strategy: RotationStrategy = { type: "LEAST_USED" };
      const setResult = await rotator.setRotationConfig(
        TEST_USER_ID,
        strategy,
        true
      );

      expect(setResult.success).toBe(true);

      // Verify config was saved
      const getResult = await rotator.getRotationConfig(TEST_USER_ID);
      expect(getResult.success).toBe(true);
      if (getResult.success) {
        expect(getResult.value.strategy.type).toBe("LEAST_USED");
        expect(getResult.value.enabled).toBe(true);
      }
    });

    test("should update existing config", async () => {
      // Set initial config
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "ROUND_ROBIN" },
        true
      );

      // Update to RANDOM
      const updateResult = await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "RANDOM" },
        true
      );

      expect(updateResult.success).toBe(true);

      const getResult = await rotator.getRotationConfig(TEST_USER_ID);
      expect(getResult.success).toBe(true);
      if (getResult.success) {
        expect(getResult.value.strategy.type).toBe("RANDOM");
      }
    });
  });

  // ==========================================================================
  // ROUND ROBIN STRATEGY
  // ==========================================================================

  describe("Round Robin Strategy", () => {
    beforeEach(async () => {
      // Create 3 wallets
      for (let i = 1; i <= 3; i++) {
        await manager.createWallet({
          userId: TEST_USER_ID,
          password: TEST_PASSWORD,
          label: asWalletLabel(`Wallet ${i}`),
          isPrimary: i === 1,
        });
      }

      // Set rotation to ROUND_ROBIN
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "ROUND_ROBIN" },
        true
      );
    });

    test("should rotate through wallets sequentially", async () => {
      const selections = [];

      // Select 6 times (2 full cycles)
      for (let i = 0; i < 6; i++) {
        const result = await rotator.selectWallet(TEST_USER_ID);
        expect(result.success).toBe(true);
        if (result.success) {
          selections.push(result.value.label);
        }
      }

      // Should cycle: Wallet 1, Wallet 2, Wallet 3, Wallet 1, Wallet 2, Wallet 3
      expect(selections).toEqual([
        "Wallet 1",
        "Wallet 2",
        "Wallet 3",
        "Wallet 1",
        "Wallet 2",
        "Wallet 3",
      ]);
    });

    test("should update usage count after selection", async () => {
      // Select first wallet
      const result = await rotator.selectWallet(TEST_USER_ID);
      expect(result.success).toBe(true);

      if (result.success) {
        // Verify usage was updated
        const wallet = await prisma.wallet.findUnique({
          where: { id: result.value.id },
        });

        expect(wallet).not.toBeNull();
        expect(wallet?.lastUsedAt).not.toBeNull();
      }
    });
  });

  // ==========================================================================
  // LEAST USED STRATEGY
  // ==========================================================================

  describe("Least Used Strategy", () => {
    beforeEach(async () => {
      // Create 3 wallets
      for (let i = 1; i <= 3; i++) {
        await manager.createWallet({
          userId: TEST_USER_ID,
          password: TEST_PASSWORD,
          label: asWalletLabel(`Wallet ${i}`),
          isPrimary: i === 1,
        });
      }

      // Set rotation to LEAST_USED
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "LEAST_USED" },
        true
      );
    });

    test("should select never-used wallets first", async () => {
      // All wallets are never-used, should pick first one
      const result1 = await rotator.selectWallet(TEST_USER_ID);
      expect(result1.success).toBe(true);

      // Second selection should pick a different wallet (next never-used)
      const result2 = await rotator.selectWallet(TEST_USER_ID);
      expect(result2.success).toBe(true);

      if (result1.success && result2.success) {
        expect(result1.value.id).not.toBe(result2.value.id);
      }
    });

    test("should balance usage across wallets", async () => {
      const usageCounts = new Map<string, number>();

      // Select 12 times (should distribute evenly: 4 uses per wallet)
      for (let i = 0; i < 12; i++) {
        const result = await rotator.selectWallet(TEST_USER_ID);
        expect(result.success).toBe(true);

        if (result.success) {
          const label = result.value.label || "unknown";
          usageCounts.set(label, (usageCounts.get(label) || 0) + 1);
        }
      }

      // Each wallet should be used 4 times
      expect(usageCounts.get("Wallet 1")).toBe(4);
      expect(usageCounts.get("Wallet 2")).toBe(4);
      expect(usageCounts.get("Wallet 3")).toBe(4);
    });
  });

  // ==========================================================================
  // RANDOM STRATEGY
  // ==========================================================================

  describe("Random Strategy", () => {
    beforeEach(async () => {
      // Create 3 wallets
      for (let i = 1; i <= 3; i++) {
        await manager.createWallet({
          userId: TEST_USER_ID,
          password: TEST_PASSWORD,
          label: asWalletLabel(`Wallet ${i}`),
          isPrimary: i === 1,
        });
      }

      // Set rotation to RANDOM
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "RANDOM" },
        true
      );
    });

    test("should select random wallets", async () => {
      const selections = new Set<string>();

      // Select 10 times, should see multiple different wallets
      for (let i = 0; i < 10; i++) {
        const result = await rotator.selectWallet(TEST_USER_ID);
        expect(result.success).toBe(true);

        if (result.success) {
          selections.add(result.value.label || "");
        }
      }

      // Should have selected at least 2 different wallets
      expect(selections.size).toBeGreaterThanOrEqual(2);
    });
  });

  // ==========================================================================
  // SPECIFIC WALLET STRATEGY
  // ==========================================================================

  describe("Specific Wallet Strategy", () => {
    test("should select specific wallet by ID", async () => {
      // Create wallet
      const createResult = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Target Wallet"),
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const targetWalletId = asWalletId(createResult.value.wallet.id);

      // Set rotation to SPECIFIC
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "SPECIFIC", walletId: targetWalletId },
        true
      );

      // Select wallet
      const result = await rotator.selectWallet(TEST_USER_ID);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.value.id).toBe(targetWalletId);
        expect(result.value.label).toBe("Target Wallet");
      }
    });

    test("should fail if specific wallet not found", async () => {
      const fakeWalletId = asWalletId("550e8400-e29b-41d4-a716-446655440000");

      // Set rotation to non-existent wallet
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "SPECIFIC", walletId: fakeWalletId },
        true
      );

      // Should fail to select
      const result = await rotator.selectWallet(TEST_USER_ID);
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // PRIMARY ONLY STRATEGY
  // ==========================================================================

  describe("Primary Only Strategy", () => {
    beforeEach(async () => {
      // Create 3 wallets (first is primary)
      for (let i = 1; i <= 3; i++) {
        await manager.createWallet({
          userId: TEST_USER_ID,
          password: TEST_PASSWORD,
          label: asWalletLabel(`Wallet ${i}`),
          isPrimary: i === 1,
        });
      }

      // Set rotation to PRIMARY_ONLY
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "PRIMARY_ONLY" },
        true
      );
    });

    test("should always select primary wallet", async () => {
      // Select 5 times
      for (let i = 0; i < 5; i++) {
        const result = await rotator.selectWallet(TEST_USER_ID);
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.value.label).toBe("Wallet 1");
          expect(result.value.isPrimary).toBe(true);
        }
      }
    });
  });

  // ==========================================================================
  // ERROR CASES
  // ==========================================================================

  describe("Error Handling", () => {
    test("should fail if user has no wallets", async () => {
      const result = await rotator.selectWallet(TEST_USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("NO_WALLETS_FOUND");
      }
    });

    test("should fail if all wallets are inactive", async () => {
      // Create wallet
      const createResult = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Inactive Wallet"),
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      // Deactivate wallet
      await manager.updateWallet({
        walletId: asWalletId(createResult.value.wallet.id),
        isActive: false,
      });

      // Try to select
      const result = await rotator.selectWallet(TEST_USER_ID);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("NO_ACTIVE_WALLETS");
      }
    });

    test("should fallback to primary wallet if rotation is disabled", async () => {
      // Create wallet
      const createResult = await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Main Wallet"),
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      // Set rotation to disabled
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "ROUND_ROBIN" },
        false
      );

      // Should succeed and return primary wallet
      const result = await rotator.selectWallet(TEST_USER_ID);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.label).toBe("Main Wallet");
        expect(result.value.isPrimary).toBe(true);
      }
    });
  });

  // ==========================================================================
  // WALLET UNLOCKING
  // ==========================================================================

  describe("Wallet Unlocking", () => {
    test("should unlock selected wallet with password", async () => {
      // Create wallet
      await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Test Wallet"),
      });

      // Enable rotation
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "PRIMARY_ONLY" },
        true
      );

      // Select and unlock wallet
      const result = await rotator.selectAndUnlockWallet(
        TEST_USER_ID,
        TEST_PASSWORD
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.publicKey).toBeDefined();
        expect(result.value.keypair).toBeDefined();

        // Clean up keypair
        result.value.keypair.secretKey.fill(0);
      }
    });

    test("should fail to unlock with wrong password", async () => {
      // Create wallet
      await manager.createWallet({
        userId: TEST_USER_ID,
        password: TEST_PASSWORD,
        label: asWalletLabel("Test Wallet"),
      });

      // Enable rotation
      await rotator.setRotationConfig(
        TEST_USER_ID,
        { type: "PRIMARY_ONLY" },
        true
      );

      // Try to unlock with wrong password
      const result = await rotator.selectAndUnlockWallet(
        TEST_USER_ID,
        "WrongPassword123!"
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("ENCRYPTION_ERROR");
      }
    });
  });
});
