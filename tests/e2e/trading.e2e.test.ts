import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import {
  PublicKey,
  type Connection,
  type ParsedAccountData,
} from "@solana/web3.js";
import { prisma } from "../../src/utils/db.js";
import { createWallet } from "../../src/services/wallet/keyManager.js";
import {
  createSession,
  destroyAllUserSessions,
} from "../../src/services/wallet/session.js";
import { storePasswordTemporary } from "../../src/services/wallet/passwordVault.js";
import { initializeSolana } from "../../src/services/blockchain/solana.js";
import { initializeJupiter } from "../../src/services/trading/jupiter.js";
import {
  getTradingExecutor,
  initializeTradingExecutor,
} from "../../src/services/trading/executor.js";
import { initializeJitoService } from "../../src/services/trading/jito.js";
import {
  ensureDevnetEnv,
  ensureDevnetBalance,
  confirmSignature,
  shouldRunTradingTests,
} from "./helpers/devnet.js";
import {
  asTokenMint,
  solToLamports,
  type SessionToken,
} from "../../src/types/common.js";
import { resolveTokenSymbol, SOL_MINT } from "../../src/config/tokens.js";

const runTradingSuite = shouldRunTradingTests();
const tradingDescribe = runTradingSuite ? describe : describe.skip;
const devnetConfig = runTradingSuite ? ensureDevnetEnv() : null;

tradingDescribe("Trading Executor E2E (devnet)", () => {
  const swapAmountLamports = solToLamports(0.05).toString(); // 0.05 SOL

  let connection: Connection;
  let userId: string;
  let walletPublicKey: string;
  let sessionToken: SessionToken;
  const testPassword = `E2E-Trade-${Date.now()}`;

  beforeAll(async () => {
    if (!devnetConfig) {
      throw new Error("Devnet configuration not available");
    }

    const config = devnetConfig!;

    const solanaService = await initializeSolana({
      rpcUrl: config.rpcUrl,
      commitment: "confirmed",
    });

    connection = await solanaService.getConnection();

    initializeJupiter(connection, {
      baseUrl: process.env.JUPITER_API_URL || "https://lite-api.jup.ag",
      defaultSlippageBps: 100,
    });

    initializeTradingExecutor();

    initializeJitoService(solanaService, {
      enabled: process.env.JITO_ENABLED !== "false",
      ...(process.env.JITO_BLOCK_ENGINE_URL && {
        blockEngineUrls: process
          .env
          .JITO_BLOCK_ENGINE_URL.split(",")
          .map((url) => url.trim())
          .filter(Boolean),
      }),
    });

    const user = await prisma.user.create({
      data: {
        telegramId: BigInt(Date.now()),
        username: `e2e_trader_${Date.now()}`,
      },
    });

    userId = user.id;

    const walletResult = await createWallet({
      userId,
      password: testPassword,
    });

    if (!walletResult.success) {
      throw new Error(walletResult.error.message);
    }

    walletPublicKey = walletResult.value.publicKey;

    await ensureDevnetBalance(
      connection,
      new PublicKey(walletPublicKey),
      config.minAirdropLamports
    );

    const sessionResult = await createSession({
      userId,
      password: testPassword,
    });

    if (!sessionResult.success) {
      throw new Error(sessionResult.error.message);
    }

    sessionToken = sessionResult.value.sessionToken;

    const passwordStore = await storePasswordTemporary(
      sessionToken,
      testPassword
    );

    if (!passwordStore.success) {
      throw new Error(passwordStore.error.message);
    }
  });

  afterAll(async () => {
    if (sessionToken) {
      await destroyAllUserSessions(userId);
    }

    await prisma.order.deleteMany({ where: { userId } });
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it(
    "swaps SOL to USDC and confirms transaction",
    async () => {
      const executor = getTradingExecutor();

      const usdcMintResult = resolveTokenSymbol("USDC");
      if (!usdcMintResult.success) {
        throw new Error(usdcMintResult.error);
      }

      const inputMint = asTokenMint(SOL_MINT);
      const outputMint = usdcMintResult.value;

      const solBefore = await connection.getBalance(
        new PublicKey(walletPublicKey),
        "confirmed"
      );
      const usdcBefore = await getTokenBalance(
        connection,
        walletPublicKey,
        outputMint
      );

      const tradeResult = await executor.executeTrade(
        {
          userId,
          inputMint,
          outputMint,
          amount: swapAmountLamports,
          slippageBps: 100,
        },
        undefined,
        sessionToken
      );

      expect(tradeResult.success).toBe(true);

      if (!tradeResult.success) {
        throw new Error(tradeResult.error.message);
      }

      await confirmSignature(connection, tradeResult.value.signature);

      const solAfter = await connection.getBalance(
        new PublicKey(walletPublicKey),
        "confirmed"
      );
      const usdcAfter = await getTokenBalance(
        connection,
        walletPublicKey,
        outputMint
      );

      expect(solAfter).toBeLessThan(solBefore);
      expect(usdcAfter).toBeGreaterThan(usdcBefore);
      expect(tradeResult.value.outputAmount).toBeGreaterThan(0n);
      expect(tradeResult.value.commissionUsd).toBeGreaterThanOrEqual(0);
    }
  );
});

async function getTokenBalance(
  connection: Connection,
  owner: string,
  mint: string
): Promise<bigint> {
  const accounts = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(owner),
    { mint: new PublicKey(mint) }
  );

  return accounts.value.reduce((total, accountInfo) => {
    const data = accountInfo.account.data as ParsedAccountData;
    const amount = BigInt(data.parsed.info.tokenAmount.amount as string);
    return total + amount;
  }, 0n);
}
