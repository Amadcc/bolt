import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { redis } from "../../utils/redis.js";
import { logger } from "../../utils/logger.js";
import { Err, Ok, type Result } from "../../types/common.js";

interface StoredLease {
  walletId: string;
  payload: string;
  expiresAt: number;
}

const LEASE_KEY_PREFIX = "snipe:lease:";
const DEFAULT_TTL_SECONDS = Number(process.env.SNIPE_AUTOMATION_TTL ?? "900"); // 15 minutes
const MASTER_SECRET = process.env.SESSION_MASTER_SECRET;

// Validate master secret strength
function validateMasterSecret(secret: string | undefined): void {
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_MASTER_SECRET must be at least 32 characters. " +
        "Generate with: openssl rand -base64 32"
    );
  }

  // Check for basic entropy - secret should not be all same character or simple pattern
  const uniqueChars = new Set(secret.split("")).size;
  if (uniqueChars < 16) {
    throw new Error(
      "SESSION_MASTER_SECRET has insufficient entropy (too few unique characters). " +
        "Generate with: openssl rand -base64 32"
    );
  }

  // Warn if secret looks like a weak pattern (e.g., "aaaaaaaaaa...")
  const consecutiveChars = /(.)\1{5,}/.test(secret);
  if (consecutiveChars) {
    logger.warn(
      "SESSION_MASTER_SECRET may have weak entropy (repeated characters). " +
        "Consider regenerating with: openssl rand -base64 32"
    );
  }
}

validateMasterSecret(MASTER_SECRET);

// Derive 32-byte key deterministically from master secret
const MASTER_KEY = createHash("sha256")
  .update(`${MASTER_SECRET}:snipe-automation`)
  .digest();

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 12; // Recommended for GCM

function buildKey(userId: string): string {
  return `${LEASE_KEY_PREFIX}${userId}`;
}

function serialize(iv: Buffer, authTag: Buffer, ciphertext: Buffer): string {
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

function deserialize(payload: string): { iv: Buffer; authTag: Buffer; ciphertext: Buffer } | null {
  const parts = payload.split(":");
  if (parts.length !== 3) {
    return null;
  }

  try {
    return {
      iv: Buffer.from(parts[0], "base64"),
      authTag: Buffer.from(parts[1], "base64"),
      ciphertext: Buffer.from(parts[2], "base64"),
    };
  } catch (error) {
    logger.error("Failed to deserialize automation payload", { error });
    return null;
  }
}

function encryptPrivateKey(privateKey: Uint8Array): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, MASTER_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey)),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return serialize(iv, authTag, ciphertext);
}

function decryptPrivateKey(payload: string): Uint8Array {
  const data = deserialize(payload);
  if (!data) {
    throw new Error("Invalid automation payload");
  }

  const decipher = createDecipheriv(ALGORITHM, MASTER_KEY, data.iv);
  decipher.setAuthTag(data.authTag);

  const decrypted = Buffer.concat([
    decipher.update(data.ciphertext),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}

export async function storeAutomationLease(
  userId: string,
  walletId: string,
  privateKey: Uint8Array,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<Result<Date, string>> {
  try {
    const payload = encryptPrivateKey(privateKey);
    privateKey.fill(0); // Clear caller buffer

    const expiresAt = Date.now() + ttlSeconds * 1000;
    const lease: StoredLease = {
      walletId,
      payload,
      expiresAt,
    };

    await redis.setex(buildKey(userId), ttlSeconds, JSON.stringify(lease));

    logger.info("Stored snipe automation lease", {
      userId,
      walletId,
      ttlSeconds,
    });

    return Ok(new Date(expiresAt));
  } catch (error) {
    logger.error("Failed to store automation lease", { userId, error });
    return Err("Failed to store automation lease");
  }
}

export async function loadAutomationLease(
  userId: string
): Promise<Result<{ walletId: string; privateKey: Uint8Array; expiresAt: Date }, string>> {
  try {
    const raw = await redis.get(buildKey(userId));

    if (!raw) {
      return Err("Automation lease not found");
    }

    const lease = JSON.parse(raw) as StoredLease;

    if (lease.expiresAt < Date.now()) {
      await redis.del(buildKey(userId));
      return Err("Automation lease expired");
    }

    const privateKey = decryptPrivateKey(lease.payload);

    return Ok({
      walletId: lease.walletId,
      privateKey,
      expiresAt: new Date(lease.expiresAt),
    });
  } catch (error) {
    logger.error("Failed to load automation lease", { userId, error });
    return Err("Failed to load automation lease");
  }
}

export async function clearAutomationLease(userId: string): Promise<void> {
  await redis.del(buildKey(userId));
  logger.info("Cleared snipe automation lease", { userId });
}

export async function hasAutomationLease(userId: string): Promise<boolean> {
  return (await redis.exists(buildKey(userId))) === 1;
}

export async function batchHasAutomationLease(
  userIds: string[]
): Promise<Map<string, boolean>> {
  if (userIds.length === 0) {
    return new Map();
  }

  // Use Redis MGET for batch check (much faster than N individual EXISTS calls)
  const keys = userIds.map((id) => buildKey(id));
  const results = await redis.mget(...keys);

  const leaseMap = new Map<string, boolean>();
  userIds.forEach((userId, index) => {
    leaseMap.set(userId, results[index] !== null);
  });

  return leaseMap;
}
