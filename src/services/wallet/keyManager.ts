/**
 * Non-Custodial Key Manager
 *
 * Security Guarantees:
 * ✅ Private keys NEVER stored in plaintext
 * ✅ Private keys NEVER logged
 * ✅ Password NEVER stored
 * ✅ Keys only decrypted in-memory for signing
 * ✅ Memory cleared after use (best effort)
 *
 * Architecture:
 * - Generate keypair → Encrypt with user password → Store in DB
 * - User provides password → Decrypt in-memory → Sign → Clear memory
 * - Session-based auth for temporary access (separate module)
 */

import { Keypair } from "@solana/web3.js";
import { prisma } from "../../utils/db.js";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  validatePassword,
} from "./encryption.js";
import {
  asSolanaAddress,
  asEncryptedPrivateKey,
  type Result,
  Ok,
  Err,
  type SolanaAddress,
  type EncryptedPrivateKey,
} from "../../types/common.js";
import type { WalletError } from "../../types/solana.js";
import { WalletError as WalletErrorClass } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface CreateWalletParams {
  userId: string;
  password: string;
}

export interface CreateWalletResult {
  walletId: string;
  publicKey: SolanaAddress;
  encryptedPrivateKey: EncryptedPrivateKey;
}

export interface UnlockWalletParams {
  userId: string;
  password: string;
}

export interface UnlockedWallet {
  walletId: string;
  publicKey: SolanaAddress;
  keypair: Keypair; // ⚠️ SENSITIVE - clear after use
}

// ============================================================================
// Wallet Creation
// ============================================================================

/**
 * Create new wallet for user
 *
 * Flow:
 * 1. Validate password
 * 2. Generate new Solana keypair
 * 3. Encrypt private key with password
 * 4. Store in database
 * 5. Return public info only
 */
export async function createWallet(
  params: CreateWalletParams
): Promise<Result<CreateWalletResult, WalletError>> {
  const { userId, password } = params;

  try {
    // Validate password
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.success) {
      return Err({
        type: "INVALID_PASSWORD",
        message: passwordValidation.error,
      });
    }

    // Check if user already has a wallet
    const existingWallet = await prisma.wallet.findFirst({
      where: {
        userId,
        isActive: true,
      },
    });

    if (existingWallet) {
      logger.warn("User already has an active wallet", { userId });
      return Err({
        type: "UNKNOWN",
        message: "User already has an active wallet",
      });
    }

    // Generate new Solana keypair
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const privateKey = keypair.secretKey; // Uint8Array(64)

    logger.info("Generated new keypair", {
      userId,
      publicKey,
      privateKeyLength: privateKey.length,
    });

    // Encrypt private key with password
    const encryptionResult = await encryptPrivateKey(privateKey, password);

    if (!encryptionResult.success) {
      return Err({
        type: "ENCRYPTION_FAILED",
        message: encryptionResult.error.message,
      });
    }

    const { encryptedData } = encryptionResult.value;

    // Store in database
    const wallet = await prisma.wallet.create({
      data: {
        userId,
        publicKey,
        encryptedPrivateKey: encryptedData,
        chain: "solana",
        isActive: true,
      },
    });

    logger.info("Wallet created successfully", {
      userId,
      walletId: wallet.id,
      publicKey: wallet.publicKey,
    });

    // Clear sensitive data from memory (best effort)
    keypair.secretKey.fill(0);

    return Ok({
      walletId: wallet.id,
      publicKey: asSolanaAddress(wallet.publicKey),
      encryptedPrivateKey: asEncryptedPrivateKey(wallet.encryptedPrivateKey),
    });
  } catch (error) {
    logger.error("Failed to create wallet", { userId, error });
    return Err({
      type: "UNKNOWN",
      message: `Failed to create wallet: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ============================================================================
// Wallet Unlocking (Decryption)
// ============================================================================

/**
 * Unlock wallet by decrypting private key with password
 *
 * ⚠️ SECURITY: Caller MUST clear keypair.secretKey after use!
 *
 * Flow:
 * 1. Fetch encrypted wallet from DB
 * 2. Decrypt private key with password
 * 3. Reconstruct Keypair
 * 4. Return unlocked wallet
 */
export async function unlockWallet(
  params: UnlockWalletParams
): Promise<Result<UnlockedWallet, WalletError>> {
  const { userId, password } = params;

  try {
    // Fetch wallet from database
    const wallet = await prisma.wallet.findFirst({
      where: {
        userId,
        isActive: true,
      },
    });

    if (!wallet) {
      logger.warn("Wallet not found", { userId });
      return Err({
        type: "WALLET_NOT_FOUND",
        userId,
      });
    }

    // Decrypt private key
    const decryptionResult = await decryptPrivateKey(
      asEncryptedPrivateKey(wallet.encryptedPrivateKey),
      password
    );

    if (!decryptionResult.success) {
      logger.warn("Failed to decrypt wallet", {
        userId,
        walletId: wallet.id,
      });
      return Err({
        type: "DECRYPTION_FAILED",
        message: decryptionResult.error.message,
      });
    }

    const privateKey = decryptionResult.value;

    // Reconstruct Keypair from decrypted private key
    const keypair = Keypair.fromSecretKey(privateKey);

    // Verify public key matches
    const reconstructedPublicKey = keypair.publicKey.toBase58();
    if (reconstructedPublicKey !== wallet.publicKey) {
      logger.error("Public key mismatch after decryption", {
        userId,
        walletId: wallet.id,
        expected: wallet.publicKey,
        actual: reconstructedPublicKey,
      });

      // Clear sensitive data
      keypair.secretKey.fill(0);

      return Err({
        type: "DECRYPTION_FAILED",
        message: "Decryption verification failed",
      });
    }

    logger.info("Wallet unlocked successfully", {
      userId,
      walletId: wallet.id,
      publicKey: wallet.publicKey,
    });

    return Ok({
      walletId: wallet.id,
      publicKey: asSolanaAddress(wallet.publicKey),
      keypair, // ⚠️ Caller must clear after use!
    });
  } catch (error) {
    logger.error("Failed to unlock wallet", { userId, error });
    return Err({
      type: "UNKNOWN",
      message: `Failed to unlock wallet: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ============================================================================
// Wallet Queries
// ============================================================================

/**
 * Get wallet info (public data only)
 */
export async function getWalletInfo(
  userId: string
): Promise<Result<CreateWalletResult | null, WalletError>> {
  try {
    const wallet = await prisma.wallet.findFirst({
      where: {
        userId,
        isActive: true,
      },
    });

    if (!wallet) {
      return Ok(null);
    }

    return Ok({
      walletId: wallet.id,
      publicKey: asSolanaAddress(wallet.publicKey),
      encryptedPrivateKey: asEncryptedPrivateKey(wallet.encryptedPrivateKey),
    });
  } catch (error) {
    logger.error("Failed to get wallet info", { userId, error });
    return Err({
      type: "UNKNOWN",
      message: `Failed to get wallet info: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Check if user has a wallet
 */
export async function hasWallet(userId: string): Promise<boolean> {
  try {
    const count = await prisma.wallet.count({
      where: {
        userId,
        isActive: true,
      },
    });

    return count > 0;
  } catch (error) {
    logger.error("Failed to check wallet existence", { userId, error });
    return false;
  }
}

/**
 * Deactivate wallet (soft delete)
 */
export async function deactivateWallet(
  userId: string
): Promise<Result<void, WalletError>> {
  try {
    await prisma.wallet.updateMany({
      where: {
        userId,
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });

    logger.info("Wallet deactivated", { userId });
    return Ok(undefined);
  } catch (error) {
    logger.error("Failed to deactivate wallet", { userId, error });
    return Err({
      type: "UNKNOWN",
      message: `Failed to deactivate wallet: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ============================================================================
// Security Utilities
// ============================================================================

/**
 * Clear sensitive data from memory (best effort)
 * TypeScript/JavaScript doesn't guarantee memory clearing,
 * but we do our best
 */
export function clearKeypair(keypair: Keypair): void {
  try {
    keypair.secretKey.fill(0);
  } catch (error) {
    logger.error("Failed to clear keypair from memory", { error });
  }
}

/**
 * Verify password for wallet without unlocking
 * Useful for re-authentication
 */
export async function verifyWalletPassword(
  userId: string,
  password: string
): Promise<Result<boolean, WalletError>> {
  const result = await unlockWallet({ userId, password });

  if (!result.success) {
    if (result.error.type === "DECRYPTION_FAILED") {
      return Ok(false); // Wrong password
    }
    return Err(result.error); // Other error
  }

  // Clear sensitive data immediately
  clearKeypair(result.value.keypair);

  return Ok(true);
}
