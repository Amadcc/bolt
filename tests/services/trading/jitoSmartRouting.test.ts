/**
 * DAY 8: Jito Smart Routing Tests
 *
 * Test coverage:
 * - Dynamic tip calculation based on trade size
 * - Smart routing (MEV_TURBO / MEV_SECURE modes)
 * - Race condition between Jito and direct RPC
 * - Anti-sandwich protection with jitodontfront
 * - RPC fallback mechanism
 * - Metrics integration
 */

import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { JitoService } from "../../../src/services/trading/jito.js";
import type { SolanaService } from "../../../src/services/blockchain/solana.js";
import * as metricsModule from "../../../src/utils/metrics.js";

// ============================================================================
// Mocks
// ============================================================================

// Create mock functions
const mockMetrics = {
  recordJitoBundleSubmission: vi.fn(),
  recordJitoBundleSuccess: vi.fn(),
  recordJitoBundleFailure: vi.fn(),
  recordJitoTip: vi.fn(),
  recordSmartRoutingWinner: vi.fn(),
  recordAntiSandwich: vi.fn(),
  recordJitoRpcFallback: vi.fn(),
};

// Spy on metrics module
beforeEach(() => {
  vi.spyOn(metricsModule, "recordJitoBundleSubmission").mockImplementation(mockMetrics.recordJitoBundleSubmission);
  vi.spyOn(metricsModule, "recordJitoBundleSuccess").mockImplementation(mockMetrics.recordJitoBundleSuccess);
  vi.spyOn(metricsModule, "recordJitoBundleFailure").mockImplementation(mockMetrics.recordJitoBundleFailure);
  vi.spyOn(metricsModule, "recordJitoTip").mockImplementation(mockMetrics.recordJitoTip);
  vi.spyOn(metricsModule, "recordSmartRoutingWinner").mockImplementation(mockMetrics.recordSmartRoutingWinner);
  vi.spyOn(metricsModule, "recordAntiSandwich").mockImplementation(mockMetrics.recordAntiSandwich);
  vi.spyOn(metricsModule, "recordJitoRpcFallback").mockImplementation(mockMetrics.recordJitoRpcFallback);
});

// ============================================================================
// Test Utilities
// ============================================================================

function createMockSolanaService(): SolanaService {
  // Valid base58 signature (87 chars)
  const validSignature = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

  const mockConnection = {
    sendRawTransaction: vi.fn(async () => validSignature),
    confirmTransaction: vi.fn(async () => ({
      value: { err: null },
    })),
    getSlot: vi.fn(async () => 12345678),
    getRecentBlockhash: vi.fn(async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 12345678,
    })),
  } as unknown as Connection;

  return {
    getConnection: vi.fn(async () => mockConnection),
    getHealth: vi.fn(() => ({
      healthy: true,
      lastCheck: new Date(),
    })),
  } as unknown as SolanaService;
}

// Helper to create valid serialized transaction
function createValidSerializedTransaction(): string {
  const keypair = Keypair.generate();
  const toPublicKey = Keypair.generate().publicKey;

  const transaction = new (require("@solana/web3.js").Transaction)();
  transaction.add(
    require("@solana/web3.js").SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: toPublicKey,
      lamports: 1000,
    })
  );
  transaction.recentBlockhash = "11111111111111111111111111111111";
  transaction.feePayer = keypair.publicKey;

  // Compile to versioned transaction
  const message = transaction.compileMessage();
  const versionedTx = new (require("@solana/web3.js").VersionedTransaction)(message);
  versionedTx.sign([keypair]);

  return Buffer.from(versionedTx.serialize()).toString("base64");
}

// ============================================================================
// Tests
// ============================================================================

describe("JitoService - Day 8: Smart Routing", () => {
  let jitoService: JitoService;
  let mockSolanaService: SolanaService;
  let testKeypair: Keypair;

  beforeEach(() => {
    mockSolanaService = createMockSolanaService();
    jitoService = new JitoService(mockSolanaService, {
      blockEngineUrls: ["https://test.block-engine.jito.wtf"],
      timeout: 5000,
      confirmationTimeout: 10000,
      tipLamports: BigInt(100_000),
      enabled: true,
      useAntiSandwich: false,
    });

    testKeypair = Keypair.generate();

    // Clear all mock metrics
    Object.values(mockMetrics).forEach((mock) => mock.mockClear());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Dynamic Tip Calculation Tests
  // ==========================================================================

  describe("calculateOptimalTip", () => {
    test("should calculate 10k lamports for small trades (<0.1 SOL)", () => {
      const tip = jitoService.calculateOptimalTip(0.05);
      expect(tip).toBe(BigInt(10_000));
    });

    test("should calculate 10k lamports for 0.09 SOL", () => {
      const tip = jitoService.calculateOptimalTip(0.09);
      expect(tip).toBe(BigInt(10_000));
    });

    test("should calculate 50k lamports for medium trades (0.1-1 SOL)", () => {
      const tip = jitoService.calculateOptimalTip(0.5);
      expect(tip).toBe(BigInt(50_000));
    });

    test("should calculate 50k lamports for 0.99 SOL", () => {
      const tip = jitoService.calculateOptimalTip(0.99);
      expect(tip).toBe(BigInt(50_000));
    });

    test("should calculate 100k lamports for large trades (1-5 SOL)", () => {
      const tip = jitoService.calculateOptimalTip(2.5);
      expect(tip).toBe(BigInt(100_000));
    });

    test("should calculate 100k lamports for 4.99 SOL", () => {
      const tip = jitoService.calculateOptimalTip(4.99);
      expect(tip).toBe(BigInt(100_000));
    });

    test("should calculate 200k lamports for very large trades (>5 SOL)", () => {
      const tip = jitoService.calculateOptimalTip(10);
      expect(tip).toBe(BigInt(200_000));
    });

    test("should calculate 200k lamports for 100 SOL", () => {
      const tip = jitoService.calculateOptimalTip(100);
      expect(tip).toBe(BigInt(200_000));
    });

    test("should enforce MIN_TIP_LAMPORTS (1000)", () => {
      // Edge case: Even if calculated tip is below minimum, should return MIN
      const tip = jitoService.calculateOptimalTip(0.0001);
      expect(tip).toBeGreaterThanOrEqual(BigInt(1_000));
    });

    test("should enforce MAX_TIP_LAMPORTS (100M)", () => {
      // Even for massive trades, should not exceed MAX
      const tip = jitoService.calculateOptimalTip(10000);
      expect(tip).toBeLessThanOrEqual(BigInt(100_000_000));
    });
  });

  // ==========================================================================
  // Smart Routing Tests
  // ==========================================================================

  describe("executeSmartRouting", () => {
    const mockSignedTx = Buffer.from("mock-transaction").toString("base64");

    test("should record bundle submission metric", async () => {
      // Mock submitBundleFromBase64 to return success
      vi.spyOn(jitoService as any, "submitBundleFromBase64").mockResolvedValue({
        success: true,
        value: {
          bundleId: "test-bundle",
          status: "Landed",
          signatures: ["mock-sig"],
          slot: 12345,
        },
      });

      await jitoService.executeSmartRouting(mockSignedTx, testKeypair, {
        mode: "MEV_TURBO",
        tradeSizeSol: 0.5,
      });

      expect(mockMetrics.recordJitoBundleSubmission).toHaveBeenCalledWith("MEV_TURBO");
    });

    test("should record dynamic tip metric", async () => {
      vi.spyOn(jitoService as any, "submitBundleFromBase64").mockResolvedValue({
        success: true,
        value: {
          bundleId: "test-bundle",
          status: "Landed",
          signatures: ["mock-sig"],
          slot: 12345,
        },
      });

      await jitoService.executeSmartRouting(mockSignedTx, testKeypair, {
        mode: "MEV_TURBO",
        tradeSizeSol: 0.5, // Should calculate 50k tip
      });

      expect(mockMetrics.recordJitoTip).toHaveBeenCalledWith(BigInt(50_000), "dynamic");
    });

    test("MEV_TURBO mode should use Jito only", async () => {
      const submitBundleSpy = vi
        .spyOn(jitoService as any, "submitBundleFromBase64")
        .mockResolvedValue({
          success: true,
          value: {
            bundleId: "test-bundle",
            status: "Landed",
            signatures: ["mock-sig"],
            slot: 12345,
          },
        });

      const executeRaceSpy = vi.spyOn(jitoService as any, "executeRaceCondition");

      const result = await jitoService.executeSmartRouting(mockSignedTx, testKeypair, {
        mode: "MEV_TURBO",
        tradeSizeSol: 1.0,
        bundleTimeout: 5000,
      });

      expect(submitBundleSpy).toHaveBeenCalled();
      expect(executeRaceSpy).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test("MEV_SECURE mode should use race condition", async () => {
      const executeRaceSpy = vi
        .spyOn(jitoService as any, "executeRaceCondition")
        .mockResolvedValue({
          success: true,
          value: {
            method: "jito",
            signature: "mock-sig",
            slot: 12345,
            bundleId: "test-bundle",
            confirmationTimeMs: 1000,
          },
        });

      const result = await jitoService.executeSmartRouting(mockSignedTx, testKeypair, {
        mode: "MEV_SECURE",
        tradeSizeSol: 1.0,
      });

      expect(executeRaceSpy).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test("should record success metrics on successful bundle", async () => {
      vi.spyOn(jitoService as any, "submitBundleFromBase64").mockResolvedValue({
        success: true,
        value: {
          bundleId: "test-bundle",
          status: "Landed",
          signatures: ["mock-sig"],
          slot: 12345,
        },
      });

      const result = await jitoService.executeSmartRouting(mockSignedTx, testKeypair, {
        mode: "MEV_TURBO",
        tradeSizeSol: 1.0,
      });

      expect(result.success).toBe(true);
      expect(mockMetrics.recordJitoBundleSuccess).toHaveBeenCalledWith(
        "MEV_TURBO",
        expect.any(Number)
      );
      expect(mockMetrics.recordSmartRoutingWinner).toHaveBeenCalledWith("jito");
    });

    test("should record failure metrics on failed bundle", async () => {
      vi.spyOn(jitoService as any, "submitBundleFromBase64").mockResolvedValue({
        success: false,
        error: {
          type: "BUNDLE_TIMEOUT",
          message: "Bundle timeout",
        },
      });

      const result = await jitoService.executeSmartRouting(mockSignedTx, testKeypair, {
        mode: "MEV_TURBO",
        tradeSizeSol: 1.0,
      });

      expect(result.success).toBe(false);
      expect(mockMetrics.recordJitoBundleFailure).toHaveBeenCalledWith(
        "MEV_TURBO",
        "BUNDLE_TIMEOUT"
      );
    });

    test("should use custom bundle timeout", async () => {
      const submitBundleSpy = vi
        .spyOn(jitoService as any, "submitBundleFromBase64")
        .mockResolvedValue({
          success: true,
          value: {
            bundleId: "test-bundle",
            status: "Landed",
            signatures: ["mock-sig"],
            slot: 12345,
          },
        });

      // Access private config to verify timeout was changed
      const originalTimeout = (jitoService as any).config.confirmationTimeout;

      await jitoService.executeSmartRouting(mockSignedTx, testKeypair, {
        mode: "MEV_TURBO",
        tradeSizeSol: 1.0,
        bundleTimeout: 3000, // Custom 3s timeout
      });

      // Timeout should be restored after execution
      const restoredTimeout = (jitoService as any).config.confirmationTimeout;
      expect(restoredTimeout).toBe(originalTimeout);
    });
  });

  // ==========================================================================
  // Race Condition Tests
  // ==========================================================================

  describe("executeRaceCondition", () => {
    test("should record winner when Jito wins", async () => {
      const mockSignedTx = Buffer.from("mock-transaction").toString("base64");

      // Mock Jito to win (faster)
      vi.spyOn(jitoService as any, "submitBundleFromBase64").mockResolvedValue({
        success: true,
        value: {
          bundleId: "test-bundle",
          status: "Landed",
          signatures: ["jito-sig"],
          slot: 12345,
        },
      });

      // Mock RPC to be slower
      vi.spyOn(jitoService as any, "sendViaDirectRPC").mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  success: true,
                  value: {
                    bundleId: "rpc-direct",
                    status: "Landed",
                    signatures: ["rpc-sig"],
                    slot: 12346,
                  },
                }),
              100
            )
          )
      );

      const result = await (jitoService as any).executeRaceCondition(
        mockSignedTx,
        testKeypair,
        "base",
        5000,
        Date.now()
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.method).toBe("jito");
        expect(mockMetrics.recordSmartRoutingWinner).toHaveBeenCalledWith("jito");
      }
    });

    test("should record winner when RPC wins", async () => {
      const mockSignedTx = Buffer.from("mock-transaction").toString("base64");

      // Mock Jito to be slower
      vi.spyOn(jitoService as any, "submitBundleFromBase64").mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  success: true,
                  value: {
                    bundleId: "test-bundle",
                    status: "Landed",
                    signatures: ["jito-sig"],
                    slot: 12345,
                  },
                }),
              100
            )
          )
      );

      // Mock RPC to win (faster)
      vi.spyOn(jitoService as any, "sendViaDirectRPC").mockResolvedValue({
        success: true,
        value: {
          bundleId: "rpc-direct",
          status: "Landed",
          signatures: ["rpc-sig"],
          slot: 12345,
        },
      });

      const result = await (jitoService as any).executeRaceCondition(
        mockSignedTx,
        testKeypair,
        "base",
        5000,
        Date.now()
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.method).toBe("rpc");
        expect(mockMetrics.recordSmartRoutingWinner).toHaveBeenCalledWith("rpc");
      }
    });

    test("should try fallback when winner fails", async () => {
      const mockSignedTx = Buffer.from("mock-transaction").toString("base64");

      // Mock Jito to win but fail
      vi.spyOn(jitoService as any, "submitBundleFromBase64")
        .mockResolvedValueOnce({
          success: false,
          error: { type: "BUNDLE_TIMEOUT", message: "Timeout" },
        })
        .mockResolvedValueOnce({
          success: true,
          value: {
            bundleId: "test-bundle-retry",
            status: "Landed",
            signatures: ["jito-sig-retry"],
            slot: 12345,
          },
        });

      // Mock RPC to be slower (loses race)
      vi.spyOn(jitoService as any, "sendViaDirectRPC")
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    success: true,
                    value: {
                      bundleId: "rpc-direct",
                      status: "Landed",
                      signatures: ["rpc-sig"],
                      slot: 12345,
                    },
                  }),
                100
              )
            )
        )
        .mockResolvedValueOnce({
          success: true,
          value: {
            bundleId: "rpc-direct-fallback",
            status: "Landed",
            signatures: ["rpc-sig-fallback"],
            slot: 12345,
          },
        });

      const result = await (jitoService as any).executeRaceCondition(
        mockSignedTx,
        testKeypair,
        "base",
        5000,
        Date.now()
      );

      expect(result.success).toBe(true);
      expect(mockMetrics.recordJitoRpcFallback).toHaveBeenCalled();
    });

    test("should return error when both methods fail", async () => {
      const mockSignedTx = Buffer.from("mock-transaction").toString("base64");

      // Mock both to fail
      vi.spyOn(jitoService as any, "submitBundleFromBase64").mockResolvedValue({
        success: false,
        error: { type: "BUNDLE_TIMEOUT", message: "Jito timeout" },
      });

      vi.spyOn(jitoService as any, "sendViaDirectRPC").mockResolvedValue({
        success: false,
        error: { type: "NETWORK_ERROR", message: "RPC error" },
      });

      const result = await (jitoService as any).executeRaceCondition(
        mockSignedTx,
        testKeypair,
        "base",
        5000,
        Date.now()
      );

      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // Direct RPC Fallback Tests
  // ==========================================================================

  describe("sendViaDirectRPC", () => {
    test("should successfully send transaction via RPC", async () => {
      const mockSignedTx = createValidSerializedTransaction();

      const result = await (jitoService as any).sendViaDirectRPC(mockSignedTx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.bundleId).toBe("rpc-direct");
        expect(result.value.status).toBe("Landed");
        expect(result.value.signatures).toHaveLength(1);
        expect(result.value.slot).toBe(12345678);
      }
    });

    test("should handle RPC confirmation errors", async () => {
      const mockSignedTx = createValidSerializedTransaction();

      // Mock confirmation to return error
      const mockConnection = await mockSolanaService.getConnection();
      vi.spyOn(mockConnection, "confirmTransaction").mockResolvedValue({
        value: { err: { InstructionError: [0, "Custom error"] } },
      } as any);

      const result = await (jitoService as any).sendViaDirectRPC(mockSignedTx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("BUNDLE_SUBMISSION_FAILED");
      }
    });

    test("should handle RPC network errors", async () => {
      const mockSignedTx = createValidSerializedTransaction();

      // Mock sendRawTransaction to throw
      const mockConnection = await mockSolanaService.getConnection();
      vi.spyOn(mockConnection, "sendRawTransaction").mockRejectedValue(
        new Error("Network error")
      );

      const result = await (jitoService as any).sendViaDirectRPC(mockSignedTx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("NETWORK_ERROR");
      }
    });
  });

  // ==========================================================================
  // Anti-Sandwich Protection Tests
  // ==========================================================================

  describe("Anti-Sandwich Protection", () => {
    test("should record anti-sandwich metric when enabled", async () => {
      // Create service with anti-sandwich enabled
      const jitoWithAntiSandwich = new JitoService(mockSolanaService, {
        blockEngineUrls: ["https://test.block-engine.jito.wtf"],
        timeout: 5000,
        confirmationTimeout: 10000,
        tipLamports: BigInt(100_000),
        enabled: true,
        useAntiSandwich: true, // Enable anti-sandwich
      });

      // Call createTipTransaction (private method)
      await (jitoWithAntiSandwich as any).createTipTransaction(
        testKeypair,
        "base",
        "11111111111111111111111111111111", // Valid blockhash
        true // useAntiSandwich
      );

      // Metric should be recorded
      expect(mockMetrics.recordAntiSandwich).toHaveBeenCalled();
    });

    test("should NOT record anti-sandwich metric when disabled", async () => {
      // Clear mocks
      Object.values(mockMetrics).forEach((mock) => mock.mockClear());

      // Call createTipTransaction without anti-sandwich
      await (jitoService as any).createTipTransaction(
        testKeypair,
        "base",
        "11111111111111111111111111111111", // Valid blockhash
        false // useAntiSandwich = false
      );

      // Metric should NOT be recorded
      expect(mockMetrics.recordAntiSandwich).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Helper Function Tests
  // ==========================================================================

  describe("getTipLevelFromAmount", () => {
    test("should return 'base' for 10k lamports", () => {
      const level = (jitoService as any).getTipLevelFromAmount(BigInt(10_000));
      expect(level).toBe("base");
    });

    test("should return 'base' for 50k lamports", () => {
      const level = (jitoService as any).getTipLevelFromAmount(BigInt(50_000));
      expect(level).toBe("base");
    });

    test("should return 'competitive' for 100k lamports", () => {
      const level = (jitoService as any).getTipLevelFromAmount(BigInt(100_000));
      expect(level).toBe("competitive");
    });

    test("should return 'high' for 200k+ lamports", () => {
      const level = (jitoService as any).getTipLevelFromAmount(BigInt(200_000));
      expect(level).toBe("high");
    });

    test("should return 'high' for 1M lamports", () => {
      const level = (jitoService as any).getTipLevelFromAmount(BigInt(1_000_000));
      expect(level).toBe("high");
    });
  });
});
