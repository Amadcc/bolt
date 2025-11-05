/**
 * Encryption Service Tests
 * Tests Argon2id + AES-256-GCM encryption
 */

import { describe, it, expect } from 'vitest';
import {
  encryptPrivateKey,
  decryptPrivateKey,
  validatePassword,
  isValidEncryptedFormat,
} from '../../../src/services/wallet/encryption.js';
import { randomBytes } from 'crypto';

describe('EncryptionService', () => {
  const validPassword = 'TestPass123';
  const testPrivateKey = new Uint8Array(randomBytes(32)); // 32 bytes for Ed25519

  describe('encryptPrivateKey', () => {
    it('should encrypt and decrypt successfully', async () => {
      const encryptResult = await encryptPrivateKey(testPrivateKey, validPassword);

      expect(encryptResult.success).toBe(true);
      if (!encryptResult.success) return;

      const decryptResult = await decryptPrivateKey(
        encryptResult.value.encryptedData,
        validPassword
      );

      expect(decryptResult.success).toBe(true);
      if (!decryptResult.success) return;

      expect(decryptResult.value).toEqual(testPrivateKey);
    });

    it('should fail with wrong password', async () => {
      const encryptResult = await encryptPrivateKey(testPrivateKey, validPassword);
      expect(encryptResult.success).toBe(true);
      if (!encryptResult.success) return;

      const decryptResult = await decryptPrivateKey(
        encryptResult.value.encryptedData,
        'WrongPassword123'
      );

      expect(decryptResult.success).toBe(false);
      if (decryptResult.success) return;

      expect(decryptResult.error.message).toContain('Invalid password');
    });

    it('should produce different ciphertexts for same input', async () => {
      const result1 = await encryptPrivateKey(testPrivateKey, validPassword);
      const result2 = await encryptPrivateKey(testPrivateKey, validPassword);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      if (!result1.success || !result2.success) return;

      // Different salt and IV should produce different ciphertexts
      expect(result1.value.encryptedData).not.toEqual(result2.value.encryptedData);
      expect(result1.value.salt).not.toEqual(result2.value.salt);
    });

    it('should take time to encrypt (Argon2id intentionally slow)', async () => {
      const start = Date.now();
      const result = await encryptPrivateKey(testPrivateKey, validPassword);
      const duration = Date.now() - start;

      expect(result.success).toBe(true);
      // Argon2id should take at least 30ms (modern hardware is fast)
      // On slower systems or with higher timeCost, this will be >1s
      expect(duration).toBeGreaterThan(30);
    });

    it('should reject invalid private key length', async () => {
      const invalidKey = new Uint8Array(16); // Wrong length
      const result = await encryptPrivateKey(invalidKey, validPassword);

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.message).toContain('Invalid private key length');
    });

    it('should reject short password', async () => {
      const result = await encryptPrivateKey(testPrivateKey, 'short');

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.message).toContain('at least 8 characters');
    });

    it('should handle 64-byte private keys (Solana keypair format)', async () => {
      const key64 = new Uint8Array(randomBytes(64));
      const result = await encryptPrivateKey(key64, validPassword);

      expect(result.success).toBe(true);
      if (!result.success) return;

      const decryptResult = await decryptPrivateKey(
        result.value.encryptedData,
        validPassword
      );

      expect(decryptResult.success).toBe(true);
      if (!decryptResult.success) return;

      expect(decryptResult.value).toEqual(key64);
    });
  });

  describe('decryptPrivateKey', () => {
    it('should fail with invalid encrypted format', async () => {
      const invalidData = 'invalid:format:here' as any;
      const result = await decryptPrivateKey(invalidData, validPassword);

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.message).toContain('Invalid encrypted data format');
    });

    it('should fail with tampered ciphertext', async () => {
      const encryptResult = await encryptPrivateKey(testPrivateKey, validPassword);
      expect(encryptResult.success).toBe(true);
      if (!encryptResult.success) return;

      // Tamper with the encrypted data
      const parts = encryptResult.value.encryptedData.split(':');
      parts[3] = Buffer.from('tampered').toString('base64'); // Tamper with ciphertext
      const tamperedData = parts.join(':') as any;

      const decryptResult = await decryptPrivateKey(tamperedData, validPassword);

      expect(decryptResult.success).toBe(false);
      if (decryptResult.success) return;

      // Should detect tampering via auth tag
      expect(decryptResult.error.message).toContain('Invalid password or tampered data');
    });
  });

  describe('validatePassword', () => {
    it('should accept valid password', () => {
      const result = validatePassword('ValidPass123');
      expect(result.success).toBe(true);
    });

    it('should reject short password', () => {
      const result = validatePassword('short');
      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('at least 8 characters');
    });

    it('should reject password without letters', () => {
      const result = validatePassword('12345678');
      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('letters and numbers');
    });

    it('should reject password without numbers', () => {
      const result = validatePassword('onlyletters');
      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('letters and numbers');
    });

    it('should reject empty password', () => {
      const result = validatePassword('');
      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('at least 8 characters');
    });

    it('should reject too long password', () => {
      const longPassword = 'a'.repeat(129) + '1';
      const result = validatePassword(longPassword);
      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('at most 128 characters');
    });

    it('should accept password with special characters', () => {
      const result = validatePassword('Pass@123!');
      expect(result.success).toBe(true);
    });
  });

  describe('isValidEncryptedFormat', () => {
    it('should validate correct encrypted format', async () => {
      const encryptResult = await encryptPrivateKey(testPrivateKey, validPassword);
      expect(encryptResult.success).toBe(true);
      if (!encryptResult.success) return;

      const isValid = isValidEncryptedFormat(encryptResult.value.encryptedData);
      expect(isValid).toBe(true);
    });

    it('should reject invalid format (wrong number of parts)', () => {
      const invalid = 'part1:part2:part3'; // Only 3 parts, should be 4
      const isValid = isValidEncryptedFormat(invalid);
      expect(isValid).toBe(false);
    });

    it('should reject format with wrong component lengths', () => {
      // Create format with wrong salt length
      const shortSalt = Buffer.from('short').toString('base64');
      const validIv = randomBytes(16).toString('base64');
      const validTag = randomBytes(16).toString('base64');
      const validCipher = randomBytes(32).toString('base64');

      const invalid = `${shortSalt}:${validIv}:${validTag}:${validCipher}`;
      const isValid = isValidEncryptedFormat(invalid);
      expect(isValid).toBe(false);
    });

    it('should reject non-base64 data', () => {
      const invalid = 'not:base64:data:here!!!';
      const isValid = isValidEncryptedFormat(invalid);
      expect(isValid).toBe(false);
    });
  });

  describe('Security Properties', () => {
    it('should use Argon2id (check salt length)', async () => {
      const result = await encryptPrivateKey(testPrivateKey, validPassword);
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Argon2id salt should be 32 bytes (64 hex chars)
      expect(result.value.salt).toHaveLength(64);
    });

    it('should never expose plaintext in encrypted data', async () => {
      const result = await encryptPrivateKey(testPrivateKey, validPassword);
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Encrypted data should not contain any plaintext bytes
      const encryptedString = result.value.encryptedData;
      const keyHex = Buffer.from(testPrivateKey).toString('hex');

      expect(encryptedString).not.toContain(keyHex);
      expect(encryptedString).not.toContain(validPassword);
    });

    it('should produce authentication tag (GCM)', async () => {
      const result = await encryptPrivateKey(testPrivateKey, validPassword);
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Format is salt:iv:authTag:ciphertext
      const parts = result.value.encryptedData.split(':');
      expect(parts).toHaveLength(4);

      // AuthTag (part 3) should be 16 bytes when decoded
      const authTag = Buffer.from(parts[2], 'base64');
      expect(authTag).toHaveLength(16);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty password (should fail)', async () => {
      const result = await encryptPrivateKey(testPrivateKey, '');
      expect(result.success).toBe(false);
    });

    it('should handle very long password', async () => {
      const longPassword = 'a'.repeat(100) + '123';
      const result = await encryptPrivateKey(testPrivateKey, longPassword);
      expect(result.success).toBe(true);
    });

    it('should handle unicode characters in password', async () => {
      const unicodePassword = 'Пароль123🔐';
      const result = await encryptPrivateKey(testPrivateKey, unicodePassword);
      expect(result.success).toBe(true);

      if (!result.success) return;

      const decryptResult = await decryptPrivateKey(
        result.value.encryptedData,
        unicodePassword
      );
      expect(decryptResult.success).toBe(true);
    });

    it('should be deterministic with same password and salt (but we use random salt)', async () => {
      // This test verifies that different salts produce different results
      const result1 = await encryptPrivateKey(testPrivateKey, validPassword);
      const result2 = await encryptPrivateKey(testPrivateKey, validPassword);

      expect(result1.success && result2.success).toBe(true);
      if (!result1.success || !result2.success) return;

      // Should be different due to random salt/IV
      expect(result1.value.encryptedData).not.toEqual(result2.value.encryptedData);
    });
  });
});
