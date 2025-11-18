/**
 * DAY 11: Multi-Wallet Support - Wallet Manager Service
 *
 * Comprehensive wallet management for multi-wallet users.
 * Features:
 * - Create/update/delete wallets with validation
 * - Balance aggregation across all wallets
 * - Usage statistics and analytics
 * - Primary wallet management
 * - Max wallet limit enforcement (10 per user)
 * - Result<T> pattern for error handling
 * - Zero `as any` usage
 */

import type { Result } from "../../types/common";
import { Ok, Err } from "../../types/common";
import { asSolanaAddress } from "../../types/common";
import type {
  WalletId,
  WalletLabel,
  WalletCount,
  WalletInfo,
  WalletBalance,
  AggregatedBalance,
  WalletUsageStats,
  AggregatedUsageStats,
  CreateWalletParams,
  CreateWalletResult,
  UpdateWalletParams,
  DeleteWalletParams,
  WalletRotatorError,
} from "../../types/walletRotation";
import {
  asWalletId,
  asWalletLabel,
  asWalletCount,
  asUsageCount,
  isMaxWalletsReached,
  generateDefaultLabel,
  hasUniquelabel,
  findPrimaryWallet,
  getDaysSinceCreated,
  getDaysSinceLastUsed,
  MAX_WALLETS_PER_USER,
} from "../../types/walletRotation";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
  recordWalletCreation,
  recordWalletDeletion,
  setActiveWalletsCount,
  recordWalletsPerUser,
} from "../../utils/metrics";
import * as keyManager from "./keyManager";
import { SolanaService } from "../blockchain/solana";
import { PublicKey } from "@solana/web3.js";

// ============================================================================
// WALLET MANAGER SERVICE
// ============================================================================

export class WalletManager {
  constructor(private solanaService: SolanaService) {}

  // ==========================================================================
  // WALLET CREATION
  // ==========================================================================

  /**
   * Create a new wallet for user
   * Enforces max wallet limit (10 per user)
   */
  async createWallet(
    params: CreateWalletParams
  ): Promise<Result<CreateWalletResult, WalletRotatorError>> {
    try {
      const { userId, password, label, isPrimary } = params;

      // Check current wallet count
      const countResult = await this.getWalletCount(userId);
      if (!countResult.success) {
        return countResult;
      }

      const currentCount = countResult.value;

      // Enforce max limit
      if (isMaxWalletsReached(currentCount)) {
        recordWalletCreation("error");
        return Err({
          type: "MAX_WALLETS_REACHED",
          maxWallets: asWalletCount(MAX_WALLETS_PER_USER),
        });
      }

      // Generate or validate label
      let finalLabel: WalletLabel | null = null;
      if (label) {
        // Check for duplicate labels
        const wallets = await prisma.wallet.findMany({ where: { userId } });
        if (!hasUniquelabel(wallets.map((w) => this.mapPrismaToWalletInfo(w)), label)) {
          recordWalletCreation("error");
          return Err({
            type: "DUPLICATE_LABEL",
            label,
            userId,
          });
        }
        finalLabel = label;
      } else {
        // Generate default label
        finalLabel = generateDefaultLabel(currentCount);
      }

      // If this is the first wallet, make it primary
      const shouldBePrimary = isPrimary ?? (currentCount === 0);

      // Create keypair FIRST (before transaction, as it's crypto operations)
      const keypairResult = await keyManager.createWallet({ userId, password });
      if (!keypairResult.success) {
        recordWalletCreation("error");
        return Err({
          type: "ENCRYPTION_ERROR",
          message: "Failed to create wallet keypair",
          cause: keypairResult.error,
        });
      }

      const { walletId, mnemonic } = keypairResult.value;

      // Wrap wallet updates in transaction for atomicity
      const wallet = await prisma.$transaction(async (tx) => {
        // If setting as primary, clear other primary wallets
        if (shouldBePrimary) {
          await tx.wallet.updateMany({
            where: { userId, isPrimary: true },
            data: { isPrimary: false },
          });
        }

        // Update wallet with multi-wallet fields (label, isPrimary)
        return tx.wallet.update({
          where: { id: walletId },
          data: {
            label: finalLabel,
            isPrimary: shouldBePrimary,
            lastUsedAt: null,
          },
        });
      });

      // Update metrics
      recordWalletCreation("success");
      const newCount = asWalletCount(currentCount + 1);
      setActiveWalletsCount(userId, newCount);
      recordWalletsPerUser(newCount);

      logger.info("Wallet created", {
        userId,
        walletId: wallet.id,
        publicKey: wallet.publicKey,
        label: finalLabel,
        isPrimary: shouldBePrimary,
        totalWallets: newCount,
      });

      return Ok({
        wallet: this.mapPrismaToWalletInfo(wallet),
        mnemonic,
      });
    } catch (error) {
      logger.error("Failed to create wallet", { params, error });
      recordWalletCreation("error");
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to create wallet",
        cause: error,
      });
    }
  }

  // ==========================================================================
  // WALLET UPDATES
  // ==========================================================================

  /**
   * Update wallet properties
   */
  async updateWallet(
    params: UpdateWalletParams
  ): Promise<Result<WalletInfo, WalletRotatorError>> {
    try {
      const { walletId, label, isPrimary, isActive } = params;

      // Get current wallet
      const wallet = await prisma.wallet.findUnique({
        where: { id: walletId },
      });

      if (!wallet) {
        return Err({
          type: "WALLET_NOT_FOUND",
          walletId,
        });
      }

      const userId = wallet.userId;

      // Validate label uniqueness if changing
      if (label !== undefined && label !== wallet.label) {
        const wallets = await prisma.wallet.findMany({ where: { userId } });
        if (label && !hasUniquelabel(wallets.map((w) => this.mapPrismaToWalletInfo(w)), label, walletId)) {
          return Err({
            type: "DUPLICATE_LABEL",
            label,
            userId,
          });
        }
      }

      // Wrap wallet updates in transaction for atomicity
      const updated = await prisma.$transaction(async (tx) => {
        // If setting as primary, clear other primary wallets
        if (isPrimary === true) {
          await tx.wallet.updateMany({
            where: { userId, isPrimary: true, id: { not: walletId } },
            data: { isPrimary: false },
          });
        }

        // Update wallet
        return tx.wallet.update({
          where: { id: walletId },
          data: {
            label: label !== undefined ? label : undefined,
            isPrimary: isPrimary !== undefined ? isPrimary : undefined,
            isActive: isActive !== undefined ? isActive : undefined,
          },
        });
      });

      // Update active wallets count if isActive changed
      if (isActive !== undefined) {
        const count = await prisma.wallet.count({
          where: { userId, isActive: true },
        });
        setActiveWalletsCount(userId, count);
      }

      logger.info("Wallet updated", {
        userId,
        walletId,
        label,
        isPrimary,
        isActive,
      });

      return Ok(this.mapPrismaToWalletInfo(updated));
    } catch (error) {
      logger.error("Failed to update wallet", { params, error });
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to update wallet",
        cause: error,
      });
    }
  }

  // ==========================================================================
  // WALLET DELETION
  // ==========================================================================

  /**
   * Delete wallet with safety checks
   * Cannot delete:
   * - Primary wallet (must set another as primary first)
   * - Last remaining wallet
   */
  async deleteWallet(
    params: DeleteWalletParams
  ): Promise<Result<void, WalletRotatorError>> {
    try {
      const { walletId, userId } = params;

      // Get wallet
      const wallet = await prisma.wallet.findUnique({
        where: { id: walletId },
      });

      if (!wallet) {
        recordWalletDeletion("error");
        return Err({
          type: "WALLET_NOT_FOUND",
          walletId,
        });
      }

      // Verify ownership
      if (wallet.userId !== userId) {
        recordWalletDeletion("error");
        return Err({
          type: "WALLET_NOT_FOUND",
          walletId,
        });
      }

      // Check if last wallet FIRST (most restrictive)
      // If user has only 1 wallet, they can't delete it regardless of primary status
      const walletCount = await prisma.wallet.count({
        where: { userId },
      });

      if (walletCount === 1) {
        recordWalletDeletion("error");
        return Err({
          type: "CANNOT_DELETE_LAST_WALLET",
          walletId,
        });
      }

      // Check if primary (only matters if there are multiple wallets)
      if (wallet.isPrimary) {
        recordWalletDeletion("error");
        return Err({
          type: "CANNOT_DELETE_PRIMARY",
          walletId,
        });
      }

      // Delete wallet
      await prisma.wallet.delete({
        where: { id: walletId },
      });

      // Update metrics
      recordWalletDeletion("success");
      const newCount = walletCount - 1;
      const activeCount = await prisma.wallet.count({
        where: { userId, isActive: true },
      });
      setActiveWalletsCount(userId, activeCount);
      recordWalletsPerUser(newCount);

      logger.info("Wallet deleted", {
        userId,
        walletId,
        remainingWallets: newCount,
      });

      return Ok(undefined);
    } catch (error) {
      logger.error("Failed to delete wallet", { params, error });
      recordWalletDeletion("error");
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to delete wallet",
        cause: error,
      });
    }
  }

  // ==========================================================================
  // WALLET QUERIES
  // ==========================================================================

  /**
   * Get wallet count for user
   */
  async getWalletCount(
    userId: string
  ): Promise<Result<WalletCount, WalletRotatorError>> {
    try {
      const count = await prisma.wallet.count({
        where: { userId },
      });

      return Ok(asWalletCount(count));
    } catch (error) {
      logger.error("Failed to get wallet count", { userId, error });
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to get wallet count",
        cause: error,
      });
    }
  }

  /**
   * Get all wallets for user
   */
  async getAllWallets(
    userId: string
  ): Promise<Result<WalletInfo[], WalletRotatorError>> {
    try {
      const wallets = await prisma.wallet.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });

      if (wallets.length === 0) {
        return Err({
          type: "NO_WALLETS_FOUND",
          userId,
        });
      }

      return Ok(wallets.map((w) => this.mapPrismaToWalletInfo(w)));
    } catch (error) {
      logger.error("Failed to get all wallets", { userId, error });
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to get all wallets",
        cause: error,
      });
    }
  }

  /**
   * Get wallet by ID
   */
  async getWallet(
    walletId: WalletId
  ): Promise<Result<WalletInfo, WalletRotatorError>> {
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { id: walletId },
      });

      if (!wallet) {
        return Err({
          type: "WALLET_NOT_FOUND",
          walletId,
        });
      }

      return Ok(this.mapPrismaToWalletInfo(wallet));
    } catch (error) {
      logger.error("Failed to get wallet", { walletId, error });
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to get wallet",
        cause: error,
      });
    }
  }

  // ==========================================================================
  // BALANCE AGGREGATION
  // ==========================================================================

  /**
   * Get aggregated balance across all wallets
   */
  async getAggregatedBalance(
    userId: string
  ): Promise<Result<AggregatedBalance, WalletRotatorError>> {
    try {
      // Get all wallets
      const walletsResult = await this.getAllWallets(userId);
      if (!walletsResult.success) {
        return walletsResult;
      }

      const wallets = walletsResult.value;

      // SPRINT 2.3: Batch balance fetching with getMultipleAccountsInfo (100 wallets/request)
      // Old approach: N RPC calls for N wallets (e.g., 10 wallets = 10 calls = 2000ms)
      // New approach: 1 RPC call per 100 wallets (e.g., 10 wallets = 1 call = 200ms)
      const BATCH_SIZE = 100; // Solana RPC limit
      const balances: WalletBalance[] = [];

      // Process wallets in batches of 100
      for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
        const batch = wallets.slice(i, i + BATCH_SIZE);
        const pubkeys = batch.map((w) => new PublicKey(w.publicKey));

        try {
          // Single RPC call for entire batch
          const accounts = await this.solanaService.executeRequest(
            async (connection) => connection.getMultipleAccountsInfo(pubkeys)
          );

          // Map results back to WalletBalance objects
          const batchBalances = batch.map((wallet, index) => {
            const account = accounts[index];
            const lamports = account?.lamports ?? 0;

            return {
              walletId: wallet.id,
              publicKey: wallet.publicKey,
              label: wallet.label,
              balanceLamports: BigInt(lamports),
              balanceSol: lamports / 1e9,
            } as WalletBalance;
          });

          balances.push(...batchBalances);
        } catch (error) {
          logger.warn("Failed to fetch batch wallet balances", {
            batchStart: i,
            batchSize: batch.length,
            error,
          });

          // On error, add zero balances for this batch
          const zeroBatchBalances = batch.map((wallet) => ({
            walletId: wallet.id,
            publicKey: wallet.publicKey,
            label: wallet.label,
            balanceLamports: 0n,
            balanceSol: 0,
          })) as WalletBalance[];

          balances.push(...zeroBatchBalances);
        }
      }

      // Calculate totals
      const totalBalanceLamports = balances.reduce(
        (sum, b) => sum + b.balanceLamports,
        0n
      );
      const totalBalanceSol = Number(totalBalanceLamports) / 1e9;

      // Count active wallets
      const activeWallets = wallets.filter((w) => w.isActive).length;

      const aggregated: AggregatedBalance = {
        userId,
        totalWallets: asWalletCount(wallets.length),
        activeWallets: asWalletCount(activeWallets),
        totalBalanceLamports,
        totalBalanceSol,
        wallets: balances,
        fetchedAt: new Date(),
      };

      return Ok(aggregated);
    } catch (error) {
      logger.error("Failed to get aggregated balance", { userId, error });
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to get aggregated balance",
        cause: error,
      });
    }
  }

  // ==========================================================================
  // USAGE STATISTICS
  // ==========================================================================

  /**
   * Get usage statistics for all wallets
   */
  async getUsageStats(
    userId: string
  ): Promise<Result<AggregatedUsageStats, WalletRotatorError>> {
    try {
      // Get all wallets
      const walletsResult = await this.getAllWallets(userId);
      if (!walletsResult.success) {
        return walletsResult;
      }

      const wallets = walletsResult.value;

      // For now, we don't track total usages in DB
      // This would require a separate WalletUsage table
      // For MVP, we'll just use lastUsedAt as a proxy

      const walletStats: WalletUsageStats[] = wallets.map((wallet) => {
        const daysSinceCreated = getDaysSinceCreated(wallet.createdAt);
        const daysSinceLastUsed = getDaysSinceLastUsed(wallet.lastUsedAt);

        return {
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          label: wallet.label,
          totalUsages: asUsageCount(0), // Not tracked yet
          lastUsedAt: wallet.lastUsedAt,
          daysSinceCreated,
          daysSinceLastUsed,
          averageUsagesPerDay: 0, // Not tracked yet
        };
      });

      // Find most/least used
      const sortedByLastUsed = [...walletStats].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return 0;
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return b.lastUsedAt.getTime() - a.lastUsedAt.getTime();
      });

      const mostUsedWallet = sortedByLastUsed[0] || null;
      const leastUsedWallet = sortedByLastUsed[sortedByLastUsed.length - 1] || null;

      const aggregated: AggregatedUsageStats = {
        userId,
        totalWallets: asWalletCount(wallets.length),
        totalUsages: asUsageCount(0), // Not tracked yet
        mostUsedWallet,
        leastUsedWallet,
        wallets: walletStats,
      };

      return Ok(aggregated);
    } catch (error) {
      logger.error("Failed to get usage stats", { userId, error });
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to get usage stats",
        cause: error,
      });
    }
  }

  // ==========================================================================
  // HELPER FUNCTIONS
  // ==========================================================================

  /**
   * Map Prisma wallet to WalletInfo type
   */
  private mapPrismaToWalletInfo(wallet: {
    id: string;
    userId: string;
    publicKey: string;
    chain: string;
    label: string | null;
    isPrimary: boolean;
    isActive: boolean;
    lastUsedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): WalletInfo {
    return {
      id: asWalletId(wallet.id),
      userId: wallet.userId,
      publicKey: asSolanaAddress(wallet.publicKey),
      chain: wallet.chain,
      label: wallet.label ? asWalletLabel(wallet.label) : null,
      isPrimary: wallet.isPrimary,
      isActive: wallet.isActive,
      lastUsedAt: wallet.lastUsedAt,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Ensure user has at least one primary wallet
   * If no primary wallet exists, set oldest as primary
   */
  async ensurePrimaryWallet(userId: string): Promise<Result<void, WalletRotatorError>> {
    try {
      const wallets = await prisma.wallet.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });

      if (wallets.length === 0) {
        return Err({
          type: "NO_WALLETS_FOUND",
          userId,
        });
      }

      const primaryWallet = findPrimaryWallet(
        wallets.map((w) => this.mapPrismaToWalletInfo(w))
      );

      if (!primaryWallet) {
        // Set oldest wallet as primary
        await prisma.wallet.update({
          where: { id: wallets[0].id },
          data: { isPrimary: true },
        });

        logger.info("Set oldest wallet as primary", {
          userId,
          walletId: wallets[0].id,
        });
      }

      return Ok(undefined);
    } catch (error) {
      logger.error("Failed to ensure primary wallet", { userId, error });
      return Err({
        type: "DATABASE_ERROR",
        message: "Failed to ensure primary wallet",
        cause: error,
      });
    }
  }
}
