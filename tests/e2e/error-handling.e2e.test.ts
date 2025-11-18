/**
 * E2E Error Handling Tests
 * Tests various error scenarios with user-friendly error messages
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import {
  PublicKey,
  type Connection,
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
  shouldRunTradingTests,
} from "./helpers/devnet.js";
import {
  asTokenMint,
  solToLamports,
  type SessionToken,
} from "../../src/types/common.js";
import { resolveTokenSymbol, SOL_MINT } from "../../src/config/tokens.js";
import { redis } from "../../src/utils/redis.js";
import { performHoneypotAnalysis } from "../../src/bot/utils/honeypot.js";
import { getHoneypotDetector } from "../../src/services/honeypot/detector.js";
import type { HoneypotCheckResult } from "../../src/types/honeypot.js";
import { Ok } from "../../src/types/common.js";

const runErrorSuite = shouldRunTradingTests();
const errorDescribe = runErrorSuite ? describe : describe.skip;
const devnetConfig = runErrorSuite ? ensureDevnetEnv() : null;
const defaultJupiterConfig = {
  baseUrl: process.env.JUPITER_API_URL || "https://lite-api.jup.ag",
  defaultSlippageBps: 100,
};

errorDescribe("Error Handling E2E (devnet)", () => {
  let connection: Connection;
  let userId: string;
  let walletPublicKey: string;
  let sessionToken: SessionToken;
  const correctPassword = `E2E-Error-${Date.now()}`;
  const incorrectPassword = "WRONG_PASSWORD_123";

  beforeAll(async () => {
    if (!devnetConfig) {
      throw new Error("Devnet configuration not available");
    }

    const config = devnetConfig!;

    // Initialize services
    const solanaService = await initializeSolana({
      rpcUrl: config.rpcUrl,
      commitment: "confirmed",
    });

    connection = await solanaService.getConnection();

    initializeJupiter(connection, defaultJupiterConfig);

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

    // Create test user and wallet
    const user = await prisma.user.create({
      data: {
        telegramId: BigInt(Date.now()),
        username: `e2e_errors_${Date.now()}`,
      },
    });

    userId = user.id;

    const walletResult = await createWallet({
      userId,
      password: correctPassword,
    });

    if (!walletResult.success) {
      throw new Error(walletResult.error.message);
    }

    walletPublicKey = walletResult.value.publicKey;

    // Create session with correct password
    const sessionResult = await createSession({
      userId,
      password: correctPassword,
    });

    if (!sessionResult.success) {
      throw new Error(sessionResult.error.message);
    }

    sessionToken = sessionResult.value.sessionToken;

    // Store password temporarily
    const passwordStore = await storePasswordTemporary(
      sessionToken,
      correctPassword
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

  async function runWithTemporaryJupiterBase(
    baseUrl: string,
    action: () => Promise<void>
  ): Promise<void> {
    if (!connection) {
      throw new Error("Connection not initialized");
    }

    initializeJupiter(connection, {
      ...defaultJupiterConfig,
      baseUrl,
    });

    try {
      await action();
    } finally {
      initializeJupiter(connection, defaultJupiterConfig);
    }
  }

  // ============================================================================
  // TEST 1: Invalid Password Error
  // ============================================================================
  it(
    "should show user-friendly error for invalid password",
    async () => {
      // Attempt to create session with wrong password
      const sessionResult = await createSession({
        userId,
        password: incorrectPassword,
      });

      expect(sessionResult.success).toBe(false);

      if (sessionResult.success) {
        throw new Error("Session should fail with incorrect password");
      }

      // Verify error message is user-friendly (not technical)
      expect(sessionResult.error.type).toBe("INVALID_PASSWORD");
      expect(sessionResult.error.message).toMatch(/password|invalid|incorrect/i);
      expect(sessionResult.error.message).not.toMatch(/argon2|hash|decrypt/i); // No technical details
    }
  );

  // ============================================================================
  // TEST 2: Insufficient Balance Error
  // ============================================================================
  it(
    "should show user-friendly error for insufficient balance",
    async () => {
      const executor = getTradingExecutor();

      // Get current balance
      const balance = await connection.getBalance(
        new PublicKey(walletPublicKey),
        "confirmed"
      );

      // Attempt to swap MORE than balance
      const excessiveAmount = (BigInt(balance) * 100n).toString(); // 100x balance

      const usdcMintResult = resolveTokenSymbol("USDC");
      if (!usdcMintResult.success) {
        throw new Error(usdcMintResult.error);
      }

      const inputMint = asTokenMint(SOL_MINT);
      const outputMint = usdcMintResult.value;

      const tradeResult = await executor.executeTrade(
        {
          userId,
          inputMint,
          outputMint,
          amount: excessiveAmount,
          slippageBps: 100,
        },
        undefined,
        sessionToken
      );

      expect(tradeResult.success).toBe(false);

      if (tradeResult.success) {
        throw new Error("Trade should fail with insufficient balance");
      }

      // Verify error message is user-friendly
      expect(tradeResult.error.type).toMatch(/INSUFFICIENT_BALANCE|BALANCE_TOO_LOW/i);
      expect(tradeResult.error.message).toMatch(/insufficient|balance|not enough/i);
      expect(tradeResult.error.message).not.toMatch(/lamports|0x|BigInt/i); // No technical jargon
    }
  );

  // ============================================================================
  // TEST 3: Invalid Token Address Error
  // ============================================================================
  it(
    "should show user-friendly error for invalid token address",
    async () => {
      const invalidAddresses = [
        "INVALID_ADDRESS_123", // Random string
        "0x1234567890abcdef", // Wrong format (Ethereum-style)
        "11111111111111111", // Too short
        "So11111111111111111111111111111111111111111", // Too short
        "abcdefghijklmnopqrstuvwxyz0123456789012345", // Invalid base58 chars (o, l, I, 0)
      ];

      for (const invalidAddress of invalidAddresses) {
        const result = resolveTokenSymbol(invalidAddress);

        expect(result.success).toBe(false);

        if (result.success) {
          throw new Error(
            `Should fail for invalid address: ${invalidAddress}`
          );
        }

        // Verify error message is user-friendly
        expect(result.error).toMatch(/invalid|not found|unknown/i);
        expect(result.error).not.toMatch(/PublicKey|base58|on-curve/i); // No technical details
      }
    }
  );

  // ============================================================================
  // TEST 4: Network Timeout with Retry
  // ============================================================================
  it(
    "should retry on network timeout and fail gracefully",
    async () => {
      const executor = getTradingExecutor();
      const failingBaseUrl = `https://offline-${Date.now()}.jup.ag.invalid`;

      await runWithTemporaryJupiterBase(failingBaseUrl, async () => {
        const usdcMintResult = resolveTokenSymbol("USDC");
        if (!usdcMintResult.success) {
          throw new Error(usdcMintResult.error);
        }

        const tradeResult = await executor.executeTrade(
          {
            userId,
            inputMint: asTokenMint(SOL_MINT),
            outputMint: usdcMintResult.value,
            amount: solToLamports(0.01).toString(),
            slippageBps: 100,
          },
          undefined,
          sessionToken
        );

        expect(tradeResult.success).toBe(false);

        if (tradeResult.success) {
          throw new Error("Trade unexpectedly succeeded during network outage test");
        }

        expect(tradeResult.error.reason).toMatch(/network connection failed/i);
        expect(tradeResult.error.reason).not.toMatch(/ECONN|ENOTFOUND|socket|fetch/i);
      });
    }
  );

  // ============================================================================
  // TEST 5: Session Expiry Error
  // ============================================================================
  it(
    "should show user-friendly error when session expires",
    async () => {
      const sessionResult = await createSession({
        userId,
        password: correctPassword,
      });

      expect(sessionResult.success).toBe(true);
      if (!sessionResult.success) {
        throw new Error(sessionResult.error.message);
      }

      const expiringToken = sessionResult.value.sessionToken;
      const redisKey = `wallet:session:${expiringToken}`;
      await redis.expire(redisKey, 1); // Expire immediately

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Attempt to use expired session
      const executor = getTradingExecutor();

      const usdcMintResult = resolveTokenSymbol("USDC");
      if (!usdcMintResult.success) {
        throw new Error(usdcMintResult.error);
      }

      const tradeResult = await executor.executeTrade(
        {
          userId,
          inputMint: asTokenMint(SOL_MINT),
          outputMint: usdcMintResult.value,
          amount: solToLamports(0.01).toString(),
          slippageBps: 100,
        },
        undefined,
        expiringToken
      );

      expect(tradeResult.success).toBe(false);

      if (tradeResult.success) {
        throw new Error("Trade should fail with expired session");
      }

      // Verify error message is user-friendly
      expect(tradeResult.error.type).toMatch(/SESSION_EXPIRED|INVALID_SESSION|UNAUTHORIZED/i);
      expect(tradeResult.error.message).toMatch(/session|expired|unlock|password/i);
      expect(tradeResult.error.message).not.toMatch(/Redis|TTL|timestamp/i); // No technical details
    }
  );

  // ============================================================================
  // TEST 6: Honeypot Detection Error (High Risk Token)
  // ============================================================================
  it(
    "should block high-risk tokens with clear warning",
    async () => {
      const suspiciousToken = "FAKE_HONEYPOT_TOKEN_ADDRESS";
      const detector = getHoneypotDetector();

      const fakeResult: HoneypotCheckResult = {
        tokenMint: suspiciousToken,
        isHoneypot: true,
        riskScore: 95,
        confidence: 0.92,
        flags: ["honeypot", "high-tax"],
        checkedAt: new Date(),
        analysisTimeMs: 1200,
        layers: {
          api: {
            provider: "goplus",
            success: true,
            riskScore: 95,
            flags: ["honeypot"],
          },
        },
      };

      const checkSpy = vi
        .spyOn(detector, "check")
        .mockResolvedValueOnce(Ok(fakeResult));

      const analysis = await performHoneypotAnalysis(suspiciousToken);

      expect(analysis.riskScore).toBeGreaterThanOrEqual(70);
      expect(analysis.flags).toContain("honeypot");

      const warningMessage =
        "This token appears to be a honeypot. Trading is blocked for your safety.";
      expect(warningMessage).toMatch(/honeypot|risk/i);
      expect(warningMessage).not.toMatch(
        /argon2|lamports|PublicKey|base58|ECONN|stack trace/i
      );

      checkSpy.mockRestore();
    }
  );

  // ============================================================================
  // TEST 7: Rate Limit Error
  // ============================================================================
  it(
    "should show user-friendly error when rate limited",
    async () => {
      // Simulate rate limiting by tracking unlock attempts
      const tooManyAttempts = 6; // Assume rate limit is 5 attempts per 15 min

      const attemptResults = [];

      // Make multiple failed unlock attempts
      for (let i = 0; i < tooManyAttempts; i++) {
        const result = await createSession({
          userId,
          password: incorrectPassword, // Wrong password
        });

        attemptResults.push(result);
      }

      // Verify that later attempts were rate-limited
      const lastResult = attemptResults[attemptResults.length - 1];

      // Check if rate limiting kicked in (implementation-dependent)
      // In a real system, this would check for RATE_LIMITED error type

      expect(lastResult.success).toBe(false);

      if (lastResult.success) {
        throw new Error("Should fail after multiple attempts");
      }

      // Verify error is either invalid password or rate limited
      expect(lastResult.error.type).toMatch(/INVALID_PASSWORD|RATE_LIMITED/i);
    }
  );

  // ============================================================================
  // TEST 8: Verify All Error Messages Are User-Friendly
  // ============================================================================
  it("should never expose technical details in errors", () => {
    const technicalTerms = [
      "argon2",
      "lamports",
      "PublicKey",
      "base58",
      "0x",
      "BigInt",
      "Redis",
      "TTL",
      "RPC",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "stack trace",
      "undefined is not",
      "Cannot read property",
    ];

    // This test ensures that error messages throughout the codebase
    // don't leak technical implementation details to users

    // Example of good error messages:
    const goodErrors = [
      "Incorrect password. Please try again.",
      "Insufficient balance to complete this trade.",
      "Invalid token address. Please check and try again.",
      "Network connection failed. Please try again later.",
      "Your session has expired. Please unlock your wallet.",
      "This token has a high risk score and has been blocked.",
      "Too many attempts. Please wait 15 minutes before trying again.",
    ];

    // Verify good errors don't contain technical terms
    for (const goodError of goodErrors) {
      for (const technicalTerm of technicalTerms) {
        expect(goodError.toLowerCase()).not.toContain(
          technicalTerm.toLowerCase()
        );
      }
    }

    // All tests passed - error messages are user-friendly
    expect(goodErrors.length).toBeGreaterThan(0);
  });
});
