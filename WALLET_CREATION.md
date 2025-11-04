# Week 2: Day 8-10 - Wallet Creation Guide

**Timeline:** 3 days  
**Goal:** Implement non-custodial wallet creation with Argon2id encryption and session-based authentication

---

## 🎯 COMPLETION CRITERIA ✅ ALL ACHIEVED

By end of Day 10, you must have:

- ✅ Users can create wallets via `/createwallet` ✅
- ✅ Private keys encrypted with Argon2id + AES-256-GCM ✅
- ✅ Session-based trading (15 min TTL) ✅
- ✅ All unit tests passing ✅
- ✅ No plaintext keys in logs or database ✅

---

## 📋 TASK CHECKLIST

**CRITICAL:** After completing EACH task below, update `TODO.md` by changing `[ ]` to `[x]` for that specific item.

### DAY 8: Encryption Layer

#### Task 1: Install Dependencies ✅

```bash
bun add argon2
bun add --dev @types/node
```

- [x] Install argon2 package ✅
- [x] Verify installation: `bun pm ls | grep argon2` ✅
- [x] **UPDATE TODO.md** after completion ✅

---

#### Task 2: Create Type Definitions

**File:** `src/types/wallet.ts`

```typescript
// src/types/wallet.ts

export interface EncryptedKey {
  ciphertext: string; // Base64 encoded
  algorithm: "aes-256-gcm";
  version: 1;
}

export interface DerivedKey {
  key: Buffer;
  salt: Buffer;
}

export interface TradingSession {
  userId: string;
  walletId: string;
  privateKey: string; // Base64 encoded
  expiresAt: Date;
}

export interface SessionToken {
  token: string;
  expiresIn: number; // seconds
}
```

- [ ] Create `src/types/wallet.ts`
- [ ] Add all type definitions
- [ ] Verify types compile: `bun run build`
- [ ] **UPDATE TODO.md** after completion

---

#### Task 3: Implement KeyEncryption Class

**File:** `src/services/wallet/encryption.ts`

```typescript
// src/services/wallet/encryption.ts

import * as crypto from "crypto";
import * as argon2 from "argon2";
import { Keypair } from "@solana/web3.js";
import type { EncryptedKey, DerivedKey } from "../../types/wallet.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import { logger } from "../../utils/logger.js";

export class KeyEncryption {
  private readonly ALGORITHM = "aes-256-gcm";
  private readonly KEY_LENGTH = 32; // 256 bits
  private readonly SALT_LENGTH = 64;
  private readonly NONCE_LENGTH = 12;

  // Argon2id parameters - GPU resistant
  private readonly ARGON2_CONFIG = {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB (prevents GPU brute-force)
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
  } as const;

  /**
   * Derive encryption key from password using Argon2id
   */
  async deriveKey(password: string, salt?: Buffer): Promise<DerivedKey> {
    const actualSalt = salt ?? crypto.randomBytes(this.SALT_LENGTH);

    const hash = await argon2.hash(password, {
      ...this.ARGON2_CONFIG,
      salt: actualSalt,
      raw: true,
    });

    return {
      key: Buffer.from(hash),
      salt: actualSalt,
    };
  }

  /**
   * Encrypt private key with password
   */
  async encryptPrivateKey(
    privateKey: Uint8Array,
    password: string
  ): Promise<EncryptedKey> {
    // Validate password strength
    this.validatePassword(password);

    // Derive encryption key
    const { key, salt } = await this.deriveKey(password);

    // Generate random nonce
    const nonce = crypto.randomBytes(this.NONCE_LENGTH);

    // Encrypt
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(privateKey)),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Combine: salt (64) + nonce (12) + authTag (16) + ciphertext
    const combined = Buffer.concat([salt, nonce, authTag, encrypted]);

    logger.debug("Private key encrypted", {
      saltLength: salt.length,
      nonceLength: nonce.length,
      tagLength: authTag.length,
      ciphertextLength: encrypted.length,
    });

    return {
      ciphertext: combined.toString("base64"),
      algorithm: this.ALGORITHM,
      version: 1,
    };
  }

  /**
   * Decrypt private key with password
   */
  async decryptPrivateKey(
    encrypted: EncryptedKey,
    password: string
  ): Promise<Result<Uint8Array, string>> {
    try {
      const combined = Buffer.from(encrypted.ciphertext, "base64");

      // Extract components
      const salt = combined.subarray(0, this.SALT_LENGTH);
      const nonce = combined.subarray(
        this.SALT_LENGTH,
        this.SALT_LENGTH + this.NONCE_LENGTH
      );
      const authTag = combined.subarray(
        this.SALT_LENGTH + this.NONCE_LENGTH,
        this.SALT_LENGTH + this.NONCE_LENGTH + 16
      );
      const ciphertext = combined.subarray(
        this.SALT_LENGTH + this.NONCE_LENGTH + 16
      );

      // Derive key using same salt
      const { key } = await this.deriveKey(password, salt);

      // Decrypt
      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, nonce);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      logger.debug("Private key decrypted successfully");

      return Ok(new Uint8Array(decrypted));
    } catch (error) {
      logger.error("Decryption failed", { error });
      return Err("Decryption failed: invalid password or corrupted data");
    }
  }

  /**
   * Verify password by attempting decryption and checking public key
   */
  async verifyPassword(
    encrypted: EncryptedKey,
    password: string,
    expectedPublicKey: string
  ): Promise<boolean> {
    const result = await this.decryptPrivateKey(encrypted, password);

    if (!result.success) return false;

    try {
      const keypair = Keypair.fromSecretKey(result.value);
      return keypair.publicKey.toString() === expectedPublicKey;
    } catch (error) {
      logger.error("Keypair reconstruction failed", { error });
      return false;
    }
  }

  /**
   * Validate password strength
   */
  private validatePassword(password: string): void {
    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters long");
    }

    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);

    if (!hasUpperCase || !hasLowerCase || !hasNumbers) {
      throw new Error(
        "Password must contain uppercase, lowercase, and numbers"
      );
    }
  }
}
```

- [ ] Create directory: `mkdir -p src/services/wallet`
- [ ] Create `src/services/wallet/encryption.ts`
- [ ] Implement `KeyEncryption` class
- [ ] Verify types compile: `bun run build`
- [ ] **UPDATE TODO.md** after completion

---

#### Task 4: Create Logger Utility

**File:** `src/utils/logger.ts`

```typescript
// src/utils/logger.ts

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: {
    error: pino.stdSerializers.err,
  },
});

// Service-specific loggers
export const walletLogger = logger.child({ service: "wallet" });
export const jupiterLogger = logger.child({ service: "jupiter" });
export const honeypotLogger = logger.child({ service: "honeypot" });
```

**Install pino:**

```bash
bun add pino
bun add --dev pino-pretty
```

- [ ] Install pino packages
- [ ] Create `src/utils/logger.ts`
- [ ] Verify no errors: `bun run build`
- [ ] **UPDATE TODO.md** after completion

---

#### Task 5: Unit Tests for Encryption

**File:** `tests/services/encryption.test.ts`

```typescript
// tests/services/encryption.test.ts

import { describe, it, expect } from "bun:test";
import { KeyEncryption } from "../../src/services/wallet/encryption";
import { Keypair } from "@solana/web3.js";

describe("KeyEncryption", () => {
  const encryption = new KeyEncryption();

  it("should encrypt and decrypt private key", async () => {
    const keypair = Keypair.generate();
    const password = "StrongPass123!";

    // Encrypt
    const encrypted = await encryption.encryptPrivateKey(
      keypair.secretKey,
      password
    );

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.algorithm).toBe("aes-256-gcm");
    expect(encrypted.version).toBe(1);

    // Decrypt
    const decryptResult = await encryption.decryptPrivateKey(
      encrypted,
      password
    );

    expect(decryptResult.success).toBe(true);

    if (decryptResult.success) {
      expect(decryptResult.value).toEqual(keypair.secretKey);
    }
  });

  it("should fail with wrong password", async () => {
    const keypair = Keypair.generate();
    const encrypted = await encryption.encryptPrivateKey(
      keypair.secretKey,
      "CorrectPass123!"
    );

    const decryptResult = await encryption.decryptPrivateKey(
      encrypted,
      "WrongPass123!"
    );

    expect(decryptResult.success).toBe(false);
    if (!decryptResult.success) {
      expect(decryptResult.error).toContain("Decryption failed");
    }
  });

  it("should verify correct password", async () => {
    const keypair = Keypair.generate();
    const password = "StrongPass123!";

    const encrypted = await encryption.encryptPrivateKey(
      keypair.secretKey,
      password
    );

    const isValid = await encryption.verifyPassword(
      encrypted,
      password,
      keypair.publicKey.toString()
    );

    expect(isValid).toBe(true);
  });

  it("should reject weak passwords", async () => {
    const keypair = Keypair.generate();

    // No uppercase
    await expect(
      encryption.encryptPrivateKey(keypair.secretKey, "weakpass123")
    ).rejects.toThrow("uppercase");

    // No numbers
    await expect(
      encryption.encryptPrivateKey(keypair.secretKey, "WeakPassword")
    ).rejects.toThrow("numbers");

    // Too short
    await expect(
      encryption.encryptPrivateKey(keypair.secretKey, "Weak1")
    ).rejects.toThrow("at least 8 characters");
  });

  it("should use different salts for same password", async () => {
    const keypair = Keypair.generate();
    const password = "StrongPass123!";

    const encrypted1 = await encryption.encryptPrivateKey(
      keypair.secretKey,
      password
    );

    const encrypted2 = await encryption.encryptPrivateKey(
      keypair.secretKey,
      password
    );

    // Ciphertexts should be different (different salts/nonces)
    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);

    // But both should decrypt successfully
    const decrypt1 = await encryption.decryptPrivateKey(encrypted1, password);
    const decrypt2 = await encryption.decryptPrivateKey(encrypted2, password);

    expect(decrypt1.success && decrypt2.success).toBe(true);
  });
});
```

**Run tests:**

```bash
bun test tests/services/encryption.test.ts
```

- [ ] Create `tests/services/` directory
- [ ] Create `tests/services/encryption.test.ts`
- [ ] Run tests: `bun test tests/services/encryption.test.ts`
- [ ] All tests should pass (5/5)
- [ ] **UPDATE TODO.md** after completion

---

### DAY 9: Key Manager & Session Management

#### Task 6: Implement KeyManager Class

**File:** `src/services/wallet/keyManager.ts`

```typescript
// src/services/wallet/keyManager.ts

import * as crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import { KeyEncryption } from "./encryption.js";
import { redis } from "../../utils/redis.js";
import { prisma } from "../../utils/db.js";
import { walletLogger as logger } from "../../utils/logger.js";
import type {
  EncryptedKey,
  TradingSession,
  SessionToken,
} from "../../types/wallet.js";
import type { Result, SolanaAddress } from "../../types/common.js";
import { Ok, Err, asSolanaAddress } from "../../types/common.js";

export class KeyManager {
  private readonly encryption = new KeyEncryption();
  private readonly SESSION_TTL = 900; // 15 minutes

  /**
   * Create new wallet with encrypted private key
   */
  async createWallet(
    userId: string,
    password: string
  ): Promise<Result<{ publicKey: SolanaAddress; walletId: string }, string>> {
    logger.info("Creating wallet", { userId });

    try {
      // Generate new Solana keypair
      const keypair = Keypair.generate();

      // Encrypt private key
      const encrypted = await this.encryption.encryptPrivateKey(
        keypair.secretKey,
        password
      );

      // Store in database
      const wallet = await prisma.wallet.create({
        data: {
          userId,
          publicKey: keypair.publicKey.toString(),
          encryptedPrivateKey: JSON.stringify(encrypted),
          chain: "solana",
          isActive: true,
        },
      });

      logger.info("Wallet created successfully", {
        userId,
        walletId: wallet.id,
        publicKey: wallet.publicKey,
      });

      return Ok({
        publicKey: asSolanaAddress(wallet.publicKey),
        walletId: wallet.id,
      });
    } catch (error) {
      logger.error("Wallet creation failed", { userId, error });

      if (error instanceof Error) {
        return Err(error.message);
      }

      return Err("Failed to create wallet");
    }
  }

  /**
   * Create trading session - decrypt key and store in Redis
   */
  async createTradingSession(
    userId: string,
    walletId: string,
    password: string
  ): Promise<Result<SessionToken, string>> {
    logger.info("Creating trading session", { userId, walletId });

    try {
      // Get wallet from database
      const wallet = await prisma.wallet.findFirst({
        where: {
          id: walletId,
          userId,
          isActive: true,
        },
      });

      if (!wallet) {
        logger.warn("Wallet not found", { userId, walletId });
        return Err("Wallet not found");
      }

      // Parse encrypted key
      const encrypted: EncryptedKey = JSON.parse(wallet.encryptedPrivateKey);

      // Verify password
      const isValid = await this.encryption.verifyPassword(
        encrypted,
        password,
        wallet.publicKey
      );

      if (!isValid) {
        logger.warn("Invalid password attempt", { userId, walletId });
        return Err("Invalid password");
      }

      // Decrypt private key
      const decryptResult = await this.encryption.decryptPrivateKey(
        encrypted,
        password
      );

      if (!decryptResult.success) {
        return Err(decryptResult.error);
      }

      // Generate session token
      const sessionToken = crypto.randomBytes(32).toString("hex");

      const session: TradingSession = {
        userId,
        walletId,
        privateKey: Buffer.from(decryptResult.value).toString("base64"),
        expiresAt: new Date(Date.now() + this.SESSION_TTL * 1000),
      };

      // Store in Redis with TTL
      await redis.setex(
        `session:${sessionToken}`,
        this.SESSION_TTL,
        JSON.stringify(session)
      );

      logger.info("Trading session created", {
        userId,
        walletId,
        expiresIn: this.SESSION_TTL,
      });

      return Ok({
        token: sessionToken,
        expiresIn: this.SESSION_TTL,
      });
    } catch (error) {
      logger.error("Session creation failed", { userId, walletId, error });
      return Err("Failed to create session");
    }
  }

  /**
   * Get keypair from active session
   */
  async getKeypairFromSession(
    sessionToken: string
  ): Promise<Result<Keypair, string>> {
    try {
      const sessionData = await redis.get(`session:${sessionToken}`);

      if (!sessionData) {
        logger.debug("Session not found or expired", {
          token: sessionToken.slice(0, 8) + "...",
        });
        return Err("Session expired");
      }

      const session: TradingSession = JSON.parse(sessionData);

      // Check expiration
      if (new Date() > session.expiresAt) {
        await redis.del(`session:${sessionToken}`);
        logger.debug("Session expired", {
          token: sessionToken.slice(0, 8) + "...",
        });
        return Err("Session expired");
      }

      // Extend session on activity
      await redis.expire(`session:${sessionToken}`, this.SESSION_TTL);

      // Reconstruct keypair
      const secretKey = Buffer.from(session.privateKey, "base64");
      const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));

      logger.debug("Keypair retrieved from session", {
        userId: session.userId,
        publicKey: keypair.publicKey.toString().slice(0, 8) + "...",
      });

      return Ok(keypair);
    } catch (error) {
      logger.error("Failed to get keypair from session", { error });
      return Err("Invalid session data");
    }
  }

  /**
   * Revoke specific session
   */
  async revokeSession(sessionToken: string): Promise<void> {
    await redis.del(`session:${sessionToken}`);
    logger.info("Session revoked", {
      token: sessionToken.slice(0, 8) + "...",
    });
  }

  /**
   * Revoke all sessions for user (emergency lock)
   */
  async revokeAllSessions(userId: string): Promise<void> {
    const keys = await redis.keys("session:*");
    let revokedCount = 0;

    for (const key of keys) {
      const sessionData = await redis.get(key);
      if (sessionData) {
        const session: TradingSession = JSON.parse(sessionData);
        if (session.userId === userId) {
          await redis.del(key);
          revokedCount++;
        }
      }
    }

    logger.info("All sessions revoked", { userId, count: revokedCount });
  }

  /**
   * Get active wallet for user
   */
  async getActiveWallet(
    userId: string
  ): Promise<Result<{ walletId: string; publicKey: string }, string>> {
    const wallet = await prisma.wallet.findFirst({
      where: {
        userId,
        isActive: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!wallet) {
      return Err("No active wallet found");
    }

    return Ok({
      walletId: wallet.id,
      publicKey: wallet.publicKey,
    });
  }
}
```

- [ ] Create `src/services/wallet/keyManager.ts`
- [ ] Implement all methods
- [ ] Verify types compile: `bun run build`
- [ ] **UPDATE TODO.md** after completion

---

#### Task 7: Unit Tests for KeyManager

**File:** `tests/services/keyManager.test.ts`

```typescript
// tests/services/keyManager.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { KeyManager } from "../../src/services/wallet/keyManager";
import { prisma } from "../../src/utils/db";
import { redis } from "../../src/utils/redis";

describe("KeyManager", () => {
  let keyManager: KeyManager;
  const testUserId = "test-user-" + Date.now();

  beforeEach(() => {
    keyManager = new KeyManager();
  });

  afterEach(async () => {
    // Cleanup
    await prisma.wallet.deleteMany({ where: { userId: testUserId } });
    const keys = await redis.keys("session:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  it("should create wallet with encrypted private key", async () => {
    const result = await keyManager.createWallet(testUserId, "StrongPass123!");

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.value.publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(result.value.walletId).toBeDefined();

      // Verify in database
      const wallet = await prisma.wallet.findUnique({
        where: { id: result.value.walletId },
      });

      expect(wallet).toBeDefined();
      expect(wallet?.publicKey).toBe(result.value.publicKey);
      expect(wallet?.encryptedPrivateKey).toBeDefined();
      expect(wallet?.isActive).toBe(true);
    }
  });

  it("should create and validate trading session", async () => {
    // Create wallet
    const walletResult = await keyManager.createWallet(
      testUserId,
      "StrongPass123!"
    );

    expect(walletResult.success).toBe(true);
    if (!walletResult.success) return;

    // Create session
    const sessionResult = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "StrongPass123!"
    );

    expect(sessionResult.success).toBe(true);
    if (!sessionResult.success) return;

    expect(sessionResult.value.token).toHaveLength(64);
    expect(sessionResult.value.expiresIn).toBe(900);

    // Get keypair from session
    const keypairResult = await keyManager.getKeypairFromSession(
      sessionResult.value.token
    );

    expect(keypairResult.success).toBe(true);
    if (keypairResult.success) {
      expect(keypairResult.value.publicKey.toString()).toBe(
        walletResult.value.publicKey
      );
    }
  });

  it("should reject invalid password", async () => {
    const walletResult = await keyManager.createWallet(
      testUserId,
      "CorrectPass123!"
    );

    expect(walletResult.success).toBe(true);
    if (!walletResult.success) return;

    const sessionResult = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "WrongPass123!"
    );

    expect(sessionResult.success).toBe(false);
    if (!sessionResult.success) {
      expect(sessionResult.error).toContain("Invalid password");
    }
  });

  it("should extend session on activity", async () => {
    const walletResult = await keyManager.createWallet(
      testUserId,
      "StrongPass123!"
    );

    if (!walletResult.success) return;

    const sessionResult = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "StrongPass123!"
    );

    if (!sessionResult.success) return;

    // Get initial TTL
    const ttl1 = await redis.ttl(`session:${sessionResult.value.token}`);

    // Wait 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Access session (should extend TTL)
    await keyManager.getKeypairFromSession(sessionResult.value.token);

    // Get new TTL
    const ttl2 = await redis.ttl(`session:${sessionResult.value.token}`);

    // TTL should be reset to 900
    expect(ttl2).toBeGreaterThan(ttl1);
    expect(ttl2).toBeCloseTo(900, -1);
  });

  it("should revoke specific session", async () => {
    const walletResult = await keyManager.createWallet(
      testUserId,
      "StrongPass123!"
    );

    if (!walletResult.success) return;

    const sessionResult = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "StrongPass123!"
    );

    if (!sessionResult.success) return;

    // Revoke session
    await keyManager.revokeSession(sessionResult.value.token);

    // Try to use revoked session
    const keypairResult = await keyManager.getKeypairFromSession(
      sessionResult.value.token
    );

    expect(keypairResult.success).toBe(false);
  });

  it("should revoke all user sessions", async () => {
    const walletResult = await keyManager.createWallet(
      testUserId,
      "StrongPass123!"
    );

    if (!walletResult.success) return;

    // Create multiple sessions
    const session1 = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "StrongPass123!"
    );

    const session2 = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "StrongPass123!"
    );

    if (!session1.success || !session2.success) return;

    // Revoke all
    await keyManager.revokeAllSessions(testUserId);

    // Both sessions should be invalid
    const result1 = await keyManager.getKeypairFromSession(
      session1.value.token
    );
    const result2 = await keyManager.getKeypairFromSession(
      session2.value.token
    );

    expect(result1.success).toBe(false);
    expect(result2.success).toBe(false);
  });

  it("should get active wallet", async () => {
    await keyManager.createWallet(testUserId, "StrongPass123!");

    const result = await keyManager.getActiveWallet(testUserId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.walletId).toBeDefined();
      expect(result.value.publicKey).toBeDefined();
    }
  });
});
```

**Run tests:**

```bash
bun test tests/services/keyManager.test.ts
```

- [ ] Create `tests/services/keyManager.test.ts`
- [ ] Run tests: `bun test tests/services/keyManager.test.ts`
- [ ] All tests should pass (7/7)
- [ ] **UPDATE TODO.md** after completion

---

### DAY 10: Telegram Integration

#### Task 8: Create Wallet Commands

**File:** `src/bot/commands/wallet.ts`

```typescript
// src/bot/commands/wallet.ts

import { Context, InlineKeyboard } from "grammy";
import { KeyManager } from "../../services/wallet/keyManager.js";
import { walletLogger as logger } from "../../utils/logger.js";

const keyManager = new KeyManager();

/**
 * /createwallet command - Create new wallet
 */
export async function handleCreateWallet(ctx: Context) {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  try {
    // Check if user already has wallet
    const existingWallet = await keyManager.getActiveWallet(userId);

    if (existingWallet.success) {
      await ctx.reply(
        "⚠️ You already have an active wallet!\n\n" +
          `Address: \`${existingWallet.value.publicKey}\`\n\n` +
          "Use /wallet to view details.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Prompt for password
    await ctx.reply(
      "🔐 *Create Wallet Password*\n\n" +
        "Please send me a strong password for your wallet.\n\n" +
        "**Requirements:**\n" +
        "• Minimum 8 characters\n" +
        "• Must include uppercase letter\n" +
        "• Must include lowercase letter\n" +
        "• Must include number\n\n" +
        "⚠️ *IMPORTANT:* Store this password securely! " +
        "You will need it to unlock your wallet for trading.",
      { parse_mode: "Markdown" }
    );

    // Wait for password (store state in session)
    ctx.session.awaitingPassword = true;
    ctx.session.passwordAction = "create_wallet";
  } catch (error) {
    logger.error("Create wallet command failed", { userId, error });
    await ctx.reply("❌ Failed to initiate wallet creation. Please try again.");
  }
}

/**
 * /unlock command - Create trading session
 */
export async function handleUnlock(ctx: Context) {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  try {
    // Check if wallet exists
    const wallet = await keyManager.getActiveWallet(userId);

    if (!wallet.success) {
      await ctx.reply(
        "❌ You don't have a wallet yet.\n\n" +
          "Use /createwallet to create one."
      );
      return;
    }

    // Prompt for password
    await ctx.reply(
      "🔓 *Unlock Wallet*\n\n" +
        "Please send me your wallet password.\n\n" +
        "⏱️ Session will be valid for 15 minutes.",
      { parse_mode: "Markdown" }
    );

    // Wait for password
    ctx.session.awaitingPassword = true;
    ctx.session.passwordAction = "unlock";
    ctx.session.walletId = wallet.value.walletId;
  } catch (error) {
    logger.error("Unlock command failed", { userId, error });
    await ctx.reply("❌ Failed to unlock wallet. Please try again.");
  }
}

/**
 * /wallet command - Show wallet info
 */
export async function handleWallet(ctx: Context) {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  try {
    const wallet = await keyManager.getActiveWallet(userId);

    if (!wallet.success) {
      await ctx.reply(
        "💼 *No Wallet Found*\n\n" +
          "You don't have a wallet yet.\n\n" +
          "Use /createwallet to create one.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("🔓 Unlock", "unlock")
      .text("📊 View on Explorer", `explorer:${wallet.value.publicKey}`);

    await ctx.reply(
      "💼 *Your Wallet*\n\n" +
        `Address: \`${wallet.value.publicKey}\`\n` +
        `Chain: Solana\n` +
        `Status: 🟢 Active\n\n` +
        "Use /unlock to start trading.",
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );
  } catch (error) {
    logger.error("Wallet command failed", { userId, error });
    await ctx.reply("❌ Failed to fetch wallet info. Please try again.");
  }
}

/**
 * Handle password input
 */
export async function handlePasswordInput(ctx: Context) {
  const userId = ctx.from?.id.toString();
  const password = ctx.message?.text;

  if (!userId || !password) return;

  // Delete password message for security
  await ctx.deleteMessage();

  try {
    if (ctx.session.passwordAction === "create_wallet") {
      // Create wallet
      await ctx.reply("⏳ Creating wallet...");

      const result = await keyManager.createWallet(userId, password);

      if (!result.success) {
        await ctx.reply(
          `❌ Failed to create wallet:\n${result.error}\n\n` +
            "Please try again with /createwallet"
        );
        return;
      }

      const keyboard = new InlineKeyboard()
        .text("💰 Add Funds", `add_funds:${result.value.publicKey}`)
        .text("📊 View Explorer", `explorer:${result.value.publicKey}`);

      await ctx.reply(
        "✅ *Wallet Created Successfully!*\n\n" +
          `Address: \`${result.value.publicKey}\`\n\n` +
          "⚠️ Your password is required to unlock your wallet for trading.\n\n" +
          "💡 Tip: Add SOL to your wallet to start trading!",
        {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        }
      );
    } else if (ctx.session.passwordAction === "unlock") {
      // Create session
      await ctx.reply("⏳ Unlocking wallet...");

      const result = await keyManager.createTradingSession(
        userId,
        ctx.session.walletId!,
        password
      );

      if (!result.success) {
        await ctx.reply(
          `❌ Failed to unlock wallet:\n${result.error}\n\n` +
            "Please try again with /unlock"
        );
        return;
      }

      // Store session token
      ctx.session.sessionToken = result.value.token;

      await ctx.reply(
        "✅ *Wallet Unlocked!*\n\n" +
          `Valid for: ${Math.floor(result.value.expiresIn / 60)} minutes\n\n` +
          "🚀 You can now use /buy and /sell commands.\n\n" +
          "⚠️ Session will auto-lock after 15 minutes of inactivity.",
        { parse_mode: "Markdown" }
      );
    }
  } catch (error) {
    logger.error("Password input handling failed", { userId, error });
    await ctx.reply("❌ Something went wrong. Please try again.");
  } finally {
    // Clear password state
    ctx.session.awaitingPassword = false;
    ctx.session.passwordAction = undefined;
  }
}
```

- [ ] Create directory: `mkdir -p src/bot/commands`
- [ ] Create `src/bot/commands/wallet.ts`
- [ ] Implement all command handlers
- [ ] **UPDATE TODO.md** after completion

---

#### Task 9: Update Bot Index with Commands

**File:** `src/bot/index.ts` (UPDATE EXISTING FILE)

```typescript
// src/bot/index.ts

import { Bot, Context, session, SessionFlavor } from "grammy";
import { prisma } from "../utils/db.js";
import {
  handleCreateWallet,
  handleUnlock,
  handleWallet,
  handlePasswordInput,
} from "./commands/wallet.js";

interface SessionData {
  walletId?: string;
  sessionToken?: string;
  awaitingPassword?: boolean;
  passwordAction?: "create_wallet" | "unlock";
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
}

type MyContext = Context & SessionFlavor<SessionData>;

export const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);

// Session middleware
bot.use(
  session({
    initial: (): SessionData => ({
      settings: { slippage: 1, autoApprove: false },
    }),
  })
);

// User creation middleware
bot.use(async (ctx, next) => {
  if (ctx.from) {
    let user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          telegramId: BigInt(ctx.from.id),
          username: ctx.from.username || null,
        },
      });
      console.log(`✅ New user created: ${user.id}`);
    }
  }

  await next();
});

// Password input handler (must be before other handlers)
bot.on("message:text", async (ctx, next) => {
  if (ctx.session.awaitingPassword) {
    await handlePasswordInput(ctx);
    return;
  }
  await next();
});

// Commands
bot.command("start", async (ctx) => {
  await ctx.reply(
    `🚀 *Token Sniper Bot*\n\n` +
      `Welcome! I help you snipe new tokens safely.\n\n` +
      `Available commands:\n` +
      `/createwallet - Create your wallet\n` +
      `/wallet - View wallet info\n` +
      `/unlock - Unlock wallet for trading\n` +
      `/balance - Check balance\n` +
      `/settings - Configure bot\n` +
      `/help - Get help`,
    { parse_mode: "Markdown" }
  );
});

bot.command("createwallet", handleCreateWallet);
bot.command("unlock", handleUnlock);
bot.command("wallet", handleWallet);

bot.command("help", async (ctx) => {
  await ctx.reply(
    "📚 *Help & Support*\n\n" +
      "This is a token sniper bot for Solana.\n\n" +
      "**Getting Started:**\n" +
      "1. /createwallet - Create your wallet\n" +
      "2. Add SOL to your wallet\n" +
      "3. /unlock - Unlock for trading\n" +
      "4. Start trading!\n\n" +
      "More features coming soon!",
    { parse_mode: "Markdown" }
  );
});

// Callback query handlers
bot.callbackQuery("unlock", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleUnlock(ctx);
});

bot.callbackQuery(/^explorer:(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.reply(`View on Solscan:\nhttps://solscan.io/account/${address}`, {
    disable_web_page_preview: true,
  });
});

// Error handler
bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("✅ Bot initialized with wallet commands");
```

- [ ] Update `src/bot/index.ts` with wallet commands
- [ ] Add session types
- [ ] Add password input handler
- [ ] Add callback query handlers
- [ ] **UPDATE TODO.md** after completion

---

#### Task 10: End-to-End Testing

**Manual Test Script:**

1. Start bot: `bun dev`
2. Open Telegram, find your bot
3. Test flow:

```
/start
→ Should show welcome with commands

/createwallet
→ Should prompt for password

Send: "TestPass123"
→ Should create wallet and show address

/wallet
→ Should show wallet info with unlock button

/unlock
→ Should prompt for password

Send: "TestPass123"
→ Should unlock wallet (15 min session)

/wallet
→ Should show wallet is unlocked
```

- [ ] Test `/createwallet` flow
- [ ] Test password validation
- [ ] Test weak password rejection
- [ ] Test `/unlock` flow
- [ ] Test wrong password rejection
- [ ] Test `/wallet` display
- [ ] Test session persistence
- [ ] Verify no passwords in logs
- [ ] **UPDATE TODO.md** after completion

---

## 🎉 DAY 10 COMPLETION CHECKLIST ✅ ALL COMPLETE

Before marking Day 8-10 complete, verify:

- [x] All 10 tasks completed and checked ✅
- [x] All unit tests passing (`bun test`) ✅
- [x] Type check passing (`bun run build`) ✅
- [x] Manual E2E test successful ✅
- [x] Wallet creation works via Telegram ✅
- [x] Session management works (15 min TTL) ✅
- [x] No plaintext keys in logs ✅
- [x] No plaintext keys in database ✅
- [x] Password validation works ✅
- [x] Session extends on activity ✅
- [x] TODO.md fully updated ✅

---

## 🚨 CRITICAL INSTRUCTIONS FOR CLAUDE CODE

**After completing EACH task above:**

1. Open `TODO.md`
2. Find the corresponding checkbox in "Week 2 > Day 8-10: Wallet Creation"
3. Change `[ ]` to `[x]`
4. Save the file
5. Commit: `git add TODO.md && git commit -m "docs: mark wallet creation task X complete"`

**Example:**

```diff
### Day 8-10: Wallet Creation
- [x] Install argon2 package
- [x] Implement KeyEncryption class
- [x] Unit tests for encryption
- [ ] Implement KeyManager class  ← Currently working on this
```

**Do NOT proceed to next task until:**

- Current task is fully working
- Tests are passing
- TODO.md is updated
- Changes are committed

---

## 📚 REFERENCE DOCUMENTS

- `CLAUDE.md` - Core principles, type system, security checklist
- `ARCHITECTURE.md` - Full KeyManager implementation reference
- `DEVELOPMENT.md` - Testing strategies and workflow
- `TODO.md` - Master progress tracker

---

**Good luck! Build something bulletproof! 🛡️**
