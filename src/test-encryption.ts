/**
 * Simple test script to verify encryption/decryption works
 */

import { Keypair } from "@solana/web3.js";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  validatePassword,
} from "./services/wallet/encryption.js";
import { logger } from "./utils/logger.js";

async function testEncryption() {
  logger.info("Starting encryption test...");

  // Test 1: Password validation
  logger.info("Test 1: Password validation");
  const weakPassword = validatePassword("weak");
  const shortPassword = validatePassword("1234567");
  const validPassword = validatePassword("StrongPass123");

  if (!weakPassword.success) {
    logger.info("✅ Weak password rejected", { error: weakPassword.error });
  }

  if (!shortPassword.success) {
    logger.info("✅ Short password rejected", { error: shortPassword.error });
  }

  if (validPassword.success) {
    logger.info("✅ Valid password accepted");
  }

  // Test 2: Encrypt/Decrypt cycle
  logger.info("\nTest 2: Encrypt/Decrypt cycle");

  const keypair = Keypair.generate();
  const privateKey = keypair.secretKey;
  const publicKey = keypair.publicKey.toBase58();
  const password = "TestPassword123";

  logger.info("Generated keypair", {
    publicKey,
    privateKeyLength: privateKey.length,
  });

  // Encrypt
  const encryptResult = await encryptPrivateKey(privateKey, password);

  if (!encryptResult.success) {
    logger.error("❌ Encryption failed", { error: encryptResult.error });
    return;
  }

  logger.info("✅ Encryption successful", {
    encryptedLength: encryptResult.value.encryptedData.length,
    saltPreview: encryptResult.value.salt.substring(0, 16) + "...",
  });

  // Decrypt
  const decryptResult = await decryptPrivateKey(
    encryptResult.value.encryptedData,
    password
  );

  if (!decryptResult.success) {
    logger.error("❌ Decryption failed", { error: decryptResult.error });
    return;
  }

  logger.info("✅ Decryption successful", {
    decryptedLength: decryptResult.value.length,
  });

  // Verify decrypted key matches original
  const decryptedKeypair = Keypair.fromSecretKey(decryptResult.value);
  const decryptedPublicKey = decryptedKeypair.publicKey.toBase58();

  if (decryptedPublicKey === publicKey) {
    logger.info("✅ Decrypted key matches original!");
  } else {
    logger.error("❌ Decrypted key does NOT match original", {
      original: publicKey,
      decrypted: decryptedPublicKey,
    });
  }

  // Test 3: Wrong password
  logger.info("\nTest 3: Wrong password");

  const wrongPasswordResult = await decryptPrivateKey(
    encryptResult.value.encryptedData,
    "WrongPassword123"
  );

  if (!wrongPasswordResult.success) {
    logger.info("✅ Wrong password correctly rejected", {
      error: wrongPasswordResult.error.message,
    });
  } else {
    logger.error("❌ Wrong password was accepted - SECURITY ISSUE!");
  }

  logger.info("\n🎉 All tests passed!");
}

testEncryption().catch((error) => {
  logger.error("Test failed", { error });
  process.exit(1);
});
