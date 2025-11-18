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
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
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
import { logger } from "../../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface CreateWalletParams {
  userId: string;
  password: string;
  label?: string | null;
  isPrimary?: boolean;
}

export interface CreateWalletResult {
  id: string; // Alias for walletId
  walletId: string;
  publicKey: SolanaAddress;
  encryptedPrivateKey: EncryptedPrivateKey;
  mnemonic: string; // DAY 11: Return mnemonic for user backup
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
  const { userId, password, label = null, isPrimary = false } = params;

  try {
    // Validate password
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.success) {
      return Err({
        type: "INVALID_PASSWORD",
        message: passwordValidation.error,
      });
    }

    // DAY 11: Removed single wallet check - now supports multi-wallet
    // WalletManager enforces the 10 wallet limit

    // DAY 11: Generate mnemonic first
    const mnemonic = generateMnemonic(wordlist);
    const seed = mnemonicToSeedSync(mnemonic);

    // Generate keypair from seed (use first 32 bytes as secret key)
    const keypair = Keypair.fromSeed(seed.slice(0, 32));
    const publicKey = keypair.publicKey.toBase58();
    const privateKey = keypair.secretKey; // Uint8Array(64)

    logger.info("Generated new keypair from mnemonic", {
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
        label,
        isPrimary,
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
      id: wallet.id, // Alias for walletId
      walletId: wallet.id,
      publicKey: asSolanaAddress(wallet.publicKey),
      encryptedPrivateKey: asEncryptedPrivateKey(wallet.encryptedPrivateKey),
      mnemonic, // DAY 11: Return for user backup
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

    // ✅ SECURITY FIX (CRITICAL-2): No longer store keypair in memory
    // Caller MUST clear keypair after use!

    return Ok({
      walletId: wallet.id,
      publicKey: asSolanaAddress(wallet.publicKey),
      keypair, // ⚠️ Caller MUST clear after use!
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
 * Note: Does not return mnemonic (not stored)
 */
export async function getWalletInfo(
  userId: string
): Promise<Result<Omit<CreateWalletResult, "mnemonic"> | null, WalletError>> {
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
      id: wallet.id,
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
 * Get keypair for specific wallet by public key
 * DAY 11: Used by WalletRotator to get keypair for rotated wallet
 */
export async function getKeypair(
  userId: string,
  password: string,
  publicKey: string
): Promise<Result<Keypair, WalletError>> {
  try {
    // Get wallet by public key
    const wallet = await prisma.wallet.findFirst({
      where: { userId, publicKey },
    });

    if (!wallet) {
      return Err({
        type: "WALLET_NOT_FOUND",
        userId,
      });
    }

    // Decrypt private key
    const decryptResult = await decryptPrivateKey(
      asEncryptedPrivateKey(wallet.encryptedPrivateKey),
      password
    );

    if (!decryptResult.success) {
      return Err({
        type: "DECRYPTION_FAILED",
        message: "Invalid password",
      });
    }

    const privateKey = decryptResult.value;

    // Reconstruct keypair
    const keypair = Keypair.fromSecretKey(privateKey);

    logger.debug("Keypair retrieved for wallet", {
      userId,
      publicKey,
    });

    return Ok(keypair);
  } catch (error) {
    logger.error("Failed to get keypair", { userId, publicKey, error });
    return Err({
      type: "UNKNOWN",
      message: `Failed to get keypair: ${error instanceof Error ? error.message : String(error)}`,
    });
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

/**
 * Generate wallet label for multi-wallet rotation
 *
 * @param walletNumber - Wallet number (1-indexed)
 * @returns Wallet label (e.g., "Wallet 1", "Wallet 2")
 */
export function generateWalletLabel(walletNumber: number): string {
  return `Wallet ${walletNumber}`;
}

// ============================================================================
// In-Memory Sessions REMOVED (CRITICAL-2 Security Fix)
// ============================================================================

/**
 * ✅ SECURITY FIX: All in-memory session functions removed
 *
 * REASON: Storing plaintext keypairs in memory for 30 minutes is a critical
 * security vulnerability. If the Node.js process is compromised (memory dump,
 * debugger, crash dump), all active private keys are exposed.
 *
 * NEW APPROACH: Password required for every trade OR use Redis-based sessions
 * from session.ts (which store ENCRYPTED keys, not plaintext).
 *
 * Removed functions:
 * - getSessionKeypair() - accessed plaintext keys from memory
 * - storeSessionKeypair() - stored plaintext keys in memory
 * - lockWallet() - cleared memory sessions
 * - getSessionStatus() - checked memory session status
 * - startSessionCleanup() - cleanup timer for memory sessions
 */
