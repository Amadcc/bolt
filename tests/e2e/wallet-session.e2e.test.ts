import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  afterAll,
} from "vitest";
import { prisma } from "../../src/utils/db.js";
import { createWallet } from "../../src/services/wallet/keyManager.js";
import {
  createSession,
  destroyAllUserSessions,
  getSession,
} from "../../src/services/wallet/session.js";
import { redis } from "../../src/utils/redis.js";
import { ensureDevnetEnv } from "./helpers/devnet.js";

ensureDevnetEnv(); // Fail fast if devnet env is missing

describe("Wallet + Session E2E (devnet)", () => {
  let userId: string;
  let walletId: string;
  let walletPublicKey: string;
  let encryptedPrivateKey: string;
  const testPassword = `E2E!Passw0rd@${Date.now()}`;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        telegramId: BigInt(Date.now()),
        username: `e2e_devnet_${Date.now()}`,
      },
    });

    userId = user.id;

    const walletResult = await createWallet({
      userId,
      password: testPassword,
    });

    if (!walletResult.success) {
      throw new Error(
        `Failed to create wallet for E2E test: ${walletResult.error.message}`
      );
    }

    walletId = walletResult.value.walletId;
    walletPublicKey = walletResult.value.publicKey;

    const walletRow = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!walletRow) {
      throw new Error("Wallet row missing after creation");
    }

    encryptedPrivateKey = walletRow.encryptedPrivateKey;
  });

  afterEach(async () => {
    const result = await destroyAllUserSessions(userId);
    if (!result.success) {
      throw new Error(`Failed to cleanup sessions: ${result.error.message}`);
    }
  });

  afterAll(async () => {
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it("persists encrypted wallet data for the devnet user", async () => {
    const walletRow = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    expect(walletRow).not.toBeNull();
    if (!walletRow) return;

    expect(walletRow.userId).toBe(userId);
    expect(walletRow.publicKey).toBe(walletPublicKey);
    expect(walletRow.encryptedPrivateKey).toBe(encryptedPrivateKey);
    expect(walletRow.encryptedPrivateKey.length).toBeGreaterThan(32);
  });

  it(
    "creates sessions that only store encrypted private keys in Redis",
    { timeout: 20000 },
    async () => {
      const sessionResult = await createSession({
        userId,
        password: testPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) return;

      const { sessionToken } = sessionResult.value;
      const redisKey = `wallet:session:${sessionToken}`;
      const storedPayload = await redis.get(redisKey);

      expect(storedPayload).toBeTruthy();
      if (!storedPayload) return;

      const parsed = JSON.parse(storedPayload);
      expect(parsed.userId).toBe(userId);
      expect(parsed.walletId).toBe(walletId);
      expect(parsed.encryptedPrivateKey).toBe(encryptedPrivateKey);
      expect(parsed.password).toBeUndefined();

      const sessionLookup = await getSession(sessionToken);
      expect(sessionLookup.success).toBe(true);
      expect(sessionLookup.value).not.toBeNull();
      if (!sessionLookup.success || !sessionLookup.value) return;
      expect(sessionLookup.value.userId).toBe(userId);
    }
  );

  it(
    "destroys all active sessions via destroyAllUserSessions",
    { timeout: 20000 },
    async () => {
      const sessionTokens: string[] = [];
      for (let i = 0; i < 2; i++) {
        const session = await createSession({
          userId,
          password: testPassword,
        });
        expect(session.success).toBe(true);
        if (session.success) {
          sessionTokens.push(session.value.sessionToken);
        }
      }

      const destroyResult = await destroyAllUserSessions(userId);
      expect(destroyResult.success).toBe(true);

      for (const token of sessionTokens) {
        const lookup = await getSession(token);
        expect(lookup.success).toBe(true);
        expect(lookup.value).toBeNull();
      }
    }
  );
});
