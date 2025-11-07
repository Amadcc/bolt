/**
 * Session-Layer Encryption Utilities
 *
 * Security Model (Variant C+):
 * - Session key is DERIVED from session token (not stored in Redis)
 * - Private key is re-encrypted with derived session key
 * - Session expires after TTL, making encrypted data useless
 * - User password is NEVER stored, only used once during unlock
 *
 * Cryptographic Flow:
 * 1. User unlocks wallet with password
 * 2. Decrypt private key from DB (with user password)
 * 3. Derive session key from session token (HKDF)
 * 4. Re-encrypt private key with session key
 * 5. Store re-encrypted key in Redis (WITHOUT session key)
 * 6. On trade: derive session key again from token, decrypt
 *
 * Why this is secure:
 * - Session key is never stored anywhere
 * - Redis compromise: attacker gets encrypted key but NOT the session key
 * - Session key can only be derived from session token (which is in user's Telegram)
 * - Even if Redis is compromised, need both: encrypted key + session token
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from "node:crypto";
import { logger } from "../../utils/logger.js";
import type { Result, SessionToken } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";

// ============================================================================
// Constants
// ============================================================================

const ALGORITHM = "aes-256-gcm" as const;
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 16; // 128 bits

// Master secret for HKDF (should be in env, but for MVP we use hardcoded)
// In production: process.env.SESSION_MASTER_SECRET
const SESSION_MASTER_SECRET =
  process.env.SESSION_MASTER_SECRET ||
  "bolt-sniper-session-master-secret-change-in-production";

// Info string for HKDF (domain separation)
const HKDF_INFO = "bolt-sniper-session-key-derivation-v1";

// ============================================================================
// Types
// ============================================================================

/**
 * Session-encrypted private key
 * This is stored in Redis during active session
 */
export interface SessionEncryptedKey {
  /** Ciphertext of the private key */
  ciphertext: string; // hex
  /** Initialization vector */
  iv: string; // hex
  /** Authentication tag (GCM) */
  authTag: string; // hex
  /** Salt used for key derivation */
  salt: string; // hex
}

export interface SessionEncryptionError {
  type:
    | "ENCRYPTION_FAILED"
    | "DECRYPTION_FAILED"
    | "INVALID_KEY"
    | "INVALID_DATA";
  message: string;
}

// ============================================================================
// Session Key Derivation (HKDF)
// ============================================================================

/**
 * Derive a session-specific encryption key from session token
 *
 * Uses HMAC-based Key Derivation Function (HKDF):
 * sessionKey = HKDF(masterSecret, salt, sessionToken, info)
 *
 * This ensures:
 * - Each session has unique encryption key
 * - Key can be deterministically re-derived from token
 * - Key is NOT stored anywhere (derived on-demand)
 * - Salt provides additional entropy
 *
 * @param sessionToken - Unique session identifier
 * @param salt - Random salt (stored with encrypted data)
 * @returns 32-byte encryption key
 */
function deriveSessionKey(sessionToken: SessionToken, salt: Buffer): Buffer {
  // HKDF-Extract: extract pseudorandom key from master secret
  const prk = createHmac("sha256", Buffer.from(salt))
    .update(SESSION_MASTER_SECRET)
    .update(sessionToken)
    .digest();

  // HKDF-Expand: expand to desired key length
  const info = Buffer.from(HKDF_INFO, "utf8");
  const okm = createHmac("sha256", prk)
    .update(info)
    .update(Buffer.from([0x01])) // Counter for first block
    .digest();

  // Return first KEY_LENGTH bytes
  return okm.subarray(0, KEY_LENGTH);
}

// ============================================================================
// Session-Layer Encryption
// ============================================================================

/**
 * Encrypt private key with session-derived key
 *
 * Flow:
 * 1. Generate random salt and IV
 * 2. Derive session key from token + salt (HKDF)
 * 3. Encrypt private key with AES-256-GCM
 * 4. Return encrypted data (WITHOUT session key)
 *
 * Security:
 * - Session key is NOT stored, only salt
 * - Attacker needs both: encrypted data + session token
 * - GCM provides authenticated encryption (integrity + confidentiality)
 *
 * @param privateKey - Raw private key bytes (64 bytes for Ed25519)
 * @param sessionToken - Session identifier
 * @returns Encrypted private key (can be stored in Redis)
 */
export function encryptWithSessionKey(
  privateKey: Uint8Array,
  sessionToken: SessionToken
): Result<SessionEncryptedKey, SessionEncryptionError> {
  try {
    // Validate input
    if (privateKey.length !== 64) {
      return Err({
        type: "INVALID_KEY",
        message: `Invalid private key length: ${privateKey.length} (expected 64)`,
      });
    }

    // Generate random salt and IV
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);

    // Derive session-specific encryption key
    const sessionKey = deriveSessionKey(sessionToken, salt);

    // Create cipher
    const cipher = createCipheriv(ALGORITHM, sessionKey, iv);

    // Encrypt
    const ciphertext = Buffer.concat([
      cipher.update(privateKey),
      cipher.final(),
    ]);

    // Get authentication tag
    const authTag = cipher.getAuthTag();

    // Clear session key from memory
    sessionKey.fill(0);

    logger.debug("Private key encrypted with session key", {
      saltLength: salt.length,
      ivLength: iv.length,
      ciphertextLength: ciphertext.length,
      authTagLength: authTag.length,
    });

    return Ok({
      ciphertext: ciphertext.toString("hex"),
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      salt: salt.toString("hex"),
    });
  } catch (error) {
    logger.error("Session encryption failed", { error });
    return Err({
      type: "ENCRYPTION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Decrypt private key with session-derived key
 *
 * Flow:
 * 1. Derive session key from token + salt (same HKDF)
 * 2. Decrypt ciphertext with AES-256-GCM
 * 3. Verify authentication tag
 * 4. Return plaintext private key
 *
 * Security:
 * - Session key is re-derived (not retrieved from storage)
 * - GCM auth tag ensures data integrity
 * - Returns plaintext key (caller MUST clear immediately!)
 *
 * @param encrypted - Encrypted private key from Redis
 * @param sessionToken - Session identifier (for key derivation)
 * @returns Raw private key bytes (MUST be cleared after use!)
 */
export function decryptWithSessionKey(
  encrypted: SessionEncryptedKey,
  sessionToken: SessionToken
): Result<Uint8Array, SessionEncryptionError> {
  try {
    // Parse encrypted data
    const ciphertext = Buffer.from(encrypted.ciphertext, "hex");
    const iv = Buffer.from(encrypted.iv, "hex");
    const authTag = Buffer.from(encrypted.authTag, "hex");
    const salt = Buffer.from(encrypted.salt, "hex");

    // Validate lengths
    if (iv.length !== IV_LENGTH) {
      return Err({
        type: "INVALID_DATA",
        message: `Invalid IV length: ${iv.length} (expected ${IV_LENGTH})`,
      });
    }

    if (authTag.length !== AUTH_TAG_LENGTH) {
      return Err({
        type: "INVALID_DATA",
        message: `Invalid auth tag length: ${authTag.length} (expected ${AUTH_TAG_LENGTH})`,
      });
    }

    if (salt.length !== SALT_LENGTH) {
      return Err({
        type: "INVALID_DATA",
        message: `Invalid salt length: ${salt.length} (expected ${SALT_LENGTH})`,
      });
    }

    // Derive session key (same as encryption)
    const sessionKey = deriveSessionKey(sessionToken, salt);

    // Create decipher
    const decipher = createDecipheriv(ALGORITHM, sessionKey, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    const privateKey = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    // Clear session key from memory
    sessionKey.fill(0);

    // Validate decrypted key length
    if (privateKey.length !== 64) {
      // Clear potentially corrupted data
      privateKey.fill(0);
      return Err({
        type: "DECRYPTION_FAILED",
        message: `Decrypted key has invalid length: ${privateKey.length} (expected 64)`,
      });
    }

    logger.debug("Private key decrypted with session key", {
      privateKeyLength: privateKey.length,
    });

    // Return as Uint8Array (caller MUST clear!)
    return Ok(new Uint8Array(privateKey));
  } catch (error) {
    logger.error("Session decryption failed", { error });
    return Err({
      type: "DECRYPTION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Securely clear session-encrypted data from memory
 * (Best effort - JS/TS doesn't guarantee memory clearing)
 */
export function clearSessionEncryptedKey(encrypted: SessionEncryptedKey): void {
  // Overwrite strings (doesn't guarantee memory clear in JS, but we try)
  try {
    encrypted.ciphertext = "0".repeat(encrypted.ciphertext.length);

    encrypted.iv = "0".repeat(encrypted.iv.length);

    encrypted.authTag = "0".repeat(encrypted.authTag.length);

    encrypted.salt = "0".repeat(encrypted.salt.length);
  } catch (error) {
    logger.warn("Failed to clear session encrypted key", { error });
  }
}
