import { describe, it, expect, vi } from "vitest";

const passwordStore = new Map<
  string,
  { value: string; expiresAt?: number }
>();

vi.mock("../../../src/utils/redis.js", () => {
  const redisMock = {
    async setex(key: string, ttlSeconds: number, value: string) {
      passwordStore.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    },
    async get(key: string) {
      const entry = passwordStore.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        passwordStore.delete(key);
        return null;
      }
      return entry.value;
    },
    async del(key: string) {
      return passwordStore.delete(key) ? 1 : 0;
    },
    async pexpire(key: string, ttlMs: number) {
      const entry = passwordStore.get(key);
      if (!entry) {
        return 0;
      }
      entry.expiresAt = Date.now() + ttlMs;
      passwordStore.set(key, entry);
      return 1;
    },
  };

  return { redis: redisMock };
});

import { asSessionToken } from "../../../src/types/common.js";
import {
  storePasswordTemporary,
  getPasswordTemporary,
  deletePasswordTemporary,
} from "../../../src/services/wallet/passwordVault.js";
import { redis } from "../../../src/utils/redis.js";

const PREFIX = "wallet:pw:";

describe("Temporary Password Vault", () => {
  it("stores password with TTL and returns it once", async () => {
    const token = asSessionToken(`test-session-${Date.now()}-a`);
    const password = "S3cureP@ssw0rd";

    const storeResult = await storePasswordTemporary(token, password);
    expect(storeResult.success).toBe(true);

    const firstFetch = await getPasswordTemporary(token);
    expect(firstFetch.success).toBe(true);
    expect(firstFetch.value).toBe(password);

    const secondFetch = await getPasswordTemporary(token);
    expect(secondFetch.success).toBe(true);
    expect(secondFetch.value).toBeNull();
  });

  it("expires password automatically", async () => {
    const token = asSessionToken(`test-session-${Date.now()}-b`);

    const storeResult = await storePasswordTemporary(token, "temp-secret");
    expect(storeResult.success).toBe(true);

    await redis.pexpire(`${PREFIX}${token}`, 50);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const fetchResult = await getPasswordTemporary(token);
    expect(fetchResult.success).toBe(true);
    expect(fetchResult.value).toBeNull();
  });

  it("deletes password without reading", async () => {
    const token = asSessionToken(`test-session-${Date.now()}-c`);

    await storePasswordTemporary(token, "temp-secret");
    const deleteResult = await deletePasswordTemporary(token);
    expect(deleteResult.success).toBe(true);
    expect(deleteResult.value).toBe(true);

    const fetchResult = await getPasswordTemporary(token);
    expect(fetchResult.success).toBe(true);
    expect(fetchResult.value).toBeNull();
  });
});
