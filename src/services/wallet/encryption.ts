/**
 * Encryption Service - Argon2id + AES-256-GCM
 *
 * Security Model:
 * - Argon2id for password hashing (memory-hard, GPU-resistant)
 * - AES-256-GCM for symmetric encryption (authenticated encryption)
 * - NEVER stores plaintext private keys
 * - Password never leaves this module
 *
 * Format: {salt}:{iv}:{authTag}:{ciphertext}
 */

import argon2 from "argon2";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import type { EncryptedPrivateKey } from "../../types/common.js";
import {
  asEncryptedPrivateKey,
  type Result,
  Ok,
  Err,
} from "../../types/common.js";
import { EncryptionError, DecryptionError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Constants - Production-grade security parameters
// ============================================================================

const ALGORITHM = "aes-256-gcm" as const;
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits (recommended for GCM)
const SALT_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16; // 128 bits

// Argon2id parameters (OWASP recommended minimums)
const ARGON2_CONFIG = {
  type: argon2.argon2id, // Hybrid - resistant to GPU and side-channel attacks
  memoryCost: 65536, // 64 MiB (OWASP minimum: 46 MiB, we use more)
  timeCost: 3, // iterations (OWASP minimum: 1, we use more)
  parallelism: 4, // threads
  hashLength: KEY_LENGTH,
} as const;

// ============================================================================
// Types
// ============================================================================

interface EncryptionResult {
  encryptedData: EncryptedPrivateKey;
  salt: string; // For verification/display only
}

interface EncryptedPayload {
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

// ============================================================================
// Core Encryption Functions
// ============================================================================

/**
 * Encrypt private key with password using Argon2id + AES-256-GCM
 *
 * @param privateKey - Raw private key bytes (32 bytes for Ed25519)
 * @param password - User password (will be hashed with Argon2id)
 * @returns Result with encrypted data or error
 */
export async function encryptPrivateKey(
  privateKey: Uint8Array,
  password: string
): Promise<Result<EncryptionResult, EncryptionError>> {
  try {
    // Validate inputs
    if (privateKey.length !== 32 && privateKey.length !== 64) {
      return Err(
        new EncryptionError(
          `Invalid private key length: ${privateKey.length} (expected 32 or 64)`
        )
      );
    }

    if (!password || password.length < 8) {
      return Err(
        new EncryptionError("Password must be at least 8 characters")
      );
    }

    // Generate random salt for Argon2
    const salt = randomBytes(SALT_LENGTH);

    // Derive encryption key from password using Argon2id
    const derivedKey = await deriveKey(password, salt);

    // Generate random IV for AES-GCM
    const iv = randomBytes(IV_LENGTH);

    // Create cipher
    const cipher = createCipheriv(ALGORITHM, derivedKey, iv);

    // Encrypt private key
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(privateKey)),
      cipher.final(),
    ]);

    // Get authentication tag (GCM provides authenticated encryption)
    const authTag = cipher.getAuthTag();

    // Serialize to base64 format: {salt}:{iv}:{authTag}:{ciphertext}
    const encryptedData = serializeEncrypted({
      salt,
      iv,
      authTag,
      ciphertext,
    });

    logger.debug("Private key encrypted successfully", {
      saltLength: salt.length,
      ivLength: iv.length,
      authTagLength: authTag.length,
      ciphertextLength: ciphertext.length,
    });

    return Ok({
      encryptedData: asEncryptedPrivateKey(encryptedData),
      salt: salt.toString("hex"),
    });
  } catch (error) {
    logger.error("Encryption failed", { error });
    return Err(
      new EncryptionError(
        `Encryption failed: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

/**
 * Decrypt private key with password
 *
 * @param encryptedData - Encrypted private key from database
 * @param password - User password
 * @returns Result with decrypted private key or error
 */
export async function decryptPrivateKey(
  encryptedData: EncryptedPrivateKey,
  password: string
): Promise<Result<Uint8Array, DecryptionError>> {
  try {
    // Parse encrypted payload
    const payload = deserializeEncrypted(encryptedData);
    if (!payload) {
      return Err(new DecryptionError("Invalid encrypted data format"));
    }

    // Derive encryption key from password using same salt
    const derivedKey = await deriveKey(password, payload.salt);

    // Create decipher
    const decipher = createDecipheriv(ALGORITHM, derivedKey, payload.iv);

    // Set authentication tag for verification
    decipher.setAuthTag(payload.authTag);

    // Decrypt and verify
    const decrypted = Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(), // Throws if authentication fails
    ]);

    logger.debug("Private key decrypted successfully", {
      decryptedLength: decrypted.length,
    });

    return Ok(new Uint8Array(decrypted));
  } catch (error) {
    // Authentication tag verification failure = wrong password or tampered data
    if (
      error instanceof Error &&
      error.message.includes("Unsupported state or unable to authenticate data")
    ) {
      logger.warn("Decryption failed - invalid password or tampered data");
      return Err(new DecryptionError("Invalid password or tampered data"));
    }

    logger.error("Decryption failed", { error });
    return Err(
      new DecryptionError(
        `Decryption failed: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive encryption key from password using Argon2id
 * Memory-hard, GPU-resistant key derivation
 */
async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const hash = await argon2.hash(password, {
    ...ARGON2_CONFIG,
    salt,
    raw: true, // Return raw hash bytes, not encoded string
  });

  return hash;
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize encrypted payload to base64 string
 * Format: {salt}:{iv}:{authTag}:{ciphertext}
 */
function serializeEncrypted(payload: EncryptedPayload): string {
  const parts = [
    payload.salt.toString("base64"),
    payload.iv.toString("base64"),
    payload.authTag.toString("base64"),
    payload.ciphertext.toString("base64"),
  ];

  return parts.join(":");
}

/**
 * Deserialize encrypted payload from base64 string
 */
function deserializeEncrypted(data: string): EncryptedPayload | null {
  try {
    const parts = data.split(":");
    if (parts.length !== 4) {
      return null;
    }

    const [saltB64, ivB64, authTagB64, ciphertextB64] = parts;

    return {
      salt: Buffer.from(saltB64, "base64"),
      iv: Buffer.from(ivB64, "base64"),
      authTag: Buffer.from(authTagB64, "base64"),
      ciphertext: Buffer.from(ciphertextB64, "base64"),
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Common weak passwords to reject (MEDIUM-8: Enhanced security)
 */
const COMMON_PASSWORDS = new Set([
  "password", "Password1", "password1", "password123", "Password123",
  "12345678", "123456789", "1234567890",
  "qwerty123", "Qwerty123", "qwertyuiop",
  "letmein", "welcome", "Welcome1",
  "admin", "admin123", "Admin123",
  "changeme", "changeme123",
  "solana", "solana123", "Solana123",
  "wallet", "wallet123", "Wallet123",
]);

/**
 * Verify password meets production-grade security requirements (MEDIUM-8)
 *
 * Requirements:
 * - Minimum 12 characters (was 8)
 * - Must contain: lowercase, uppercase, number, special character
 * - Cannot be a common/weak password
 * - Maximum 128 characters
 */
export function validatePassword(password: string): Result<void, string> {
  // Length checks
  if (!password || password.length < 12) {
    return Err("Password must be at least 12 characters");
  }

  if (password.length > 128) {
    return Err("Password must be at most 128 characters");
  }

  // MEDIUM-8: Enhanced complexity requirements
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

  if (!hasLowercase) {
    return Err("Password must contain at least one lowercase letter");
  }

  if (!hasUppercase) {
    return Err("Password must contain at least one uppercase letter");
  }

  if (!hasNumber) {
    return Err("Password must contain at least one number");
  }

  if (!hasSpecial) {
    return Err("Password must contain at least one special character (!@#$%^&*...)");
  }

  // Check against common passwords (case-insensitive)
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return Err("This password is too common. Please choose a stronger password");
  }

  // Check for repeated characters (e.g., "aaaaaa")
  if (/(.)\1{5,}/.test(password)) {
    return Err("Password cannot contain 6 or more repeated characters");
  }

  return Ok(undefined);
}

/**
 * Verify encrypted data format is valid
 */
export function isValidEncryptedFormat(data: string): boolean {
  const payload = deserializeEncrypted(data);
  if (!payload) return false;

  // Verify component lengths
  return (
    payload.salt.length === SALT_LENGTH &&
    payload.iv.length === IV_LENGTH &&
    payload.authTag.length === AUTH_TAG_LENGTH &&
    payload.ciphertext.length > 0
  );
}
