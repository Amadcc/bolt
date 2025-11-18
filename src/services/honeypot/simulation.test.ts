/**
 * Unit tests for SimulationService
 *
 * Tests transaction simulation for honeypot detection
 */

import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { SimulationService } from "./simulation.js";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { JupiterService } from "../trading/jupiter.js";
import { asTokenMint, Ok, Err } from "../../types/common.js";
import type { JupiterQuoteResponse } from "../../types/jupiter.js";
import type { SimulationResult } from "../../types/honeypot.js";

// ============================================================================
// Test Configuration
// ============================================================================

const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";
// Use a valid base58 public key
const MOCK_TOKEN_MINT = asTokenMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC mint
const SOL_MINT = asTokenMint("So11111111111111111111111111111111111111112");

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

function createMockJupiterService(): JupiterService {
  const connection = createMockConnection();
  return new JupiterService(connection);
}

function createMockJupiterQuote(
  inputMint: string,
  outputMint: string,
  inAmount: string,
  outAmount: string,
  priceImpact: number = 0.01
): JupiterQuoteResponse {
  return {
    mode: "ExactIn",
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    inUsdValue: 100,
    outUsdValue: 99,
    priceImpact,
    swapUsdValue: 100,
    otherAmountThreshold: outAmount,
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: (priceImpact * 100).toString(),
    routePlan: [
      {
        swapInfo: {
          ammKey: "amm123",
          label: "Raydium",
          inputMint,
          outputMint,
          inAmount,
          outAmount,
          feeAmount: "50000", // 0.05%
          feeMint: inputMint,
        },
        percent: 100,
        bps: 10000,
      },
    ],
    feeMint: inputMint,
    feeBps: 50,
    platformFee: {
      amount: "0",
      feeBps: 0,
    },
    signatureFeeLamports: 5000,
    signatureFeePayer: null,
    prioritizationFeeLamports: 0,
    prioritizationFeePayer: null,
    rentFeeLamports: 0,
    rentFeePayer: null,
    transaction: "SGVsbG8gV29ybGQ=", // Base64: "Hello World"
    gasless: false,
    requestId: "req123",
    router: "iris",
    swapType: "ExactIn",
    taker: null,
    maker: null,
    quoteId: "quote123",
    expireAt: new Date(Date.now() + 60000).toISOString(),
    totalTime: 100,
  };
}

// ============================================================================
// Test Suite: SimulationService Construction
// ============================================================================

describe("SimulationService", () => {
  let connection: Connection;
  let jupiterService: JupiterService;
  let simulationService: SimulationService;

  beforeEach(() => {
    connection = createMockConnection();
    jupiterService = createMockJupiterService();
    simulationService = new SimulationService(connection, jupiterService);
  });

  // ==========================================================================
  // Test: toLayerResult
  // ==========================================================================

  describe("toLayerResult", () => {
    test("should convert simulation result to layer result (no honeypot)", () => {
      const simulationResult: SimulationResult = {
        canBuy: true,
        canSell: true,
        buyTax: 1.0,
        sellTax: 1.0,
        buyPriceImpact: 0.5,
        sellPriceImpact: 0.5,
        isHoneypot: false,
        top10HoldersPct: 30,
        developerHoldingsPct: 10,
        totalHolders: 100,
        simulationTimeMs: 1500,
      };

      const layerResult = simulationService.toLayerResult(simulationResult);

      expect(layerResult.canBuy).toBe(true);
      expect(layerResult.canSell).toBe(true);
      expect(layerResult.buyTax).toBe(1.0);
      expect(layerResult.sellTax).toBe(1.0);
      expect(layerResult.score).toBe(0); // No flags = 0 score
      expect(layerResult.flags).toHaveLength(0);
      expect(layerResult.timeMs).toBe(1500);
    });

    test("should detect SELL_SIMULATION_FAILED flag", () => {
      const simulationResult: SimulationResult = {
        canBuy: true,
        canSell: false, // ← HONEYPOT!
        buyTax: 1.0,
        sellTax: 1.0,
        buyPriceImpact: 0.5,
        sellPriceImpact: 0.5,
        isHoneypot: true,
        honeypotReason: "Sell fails",
        top10HoldersPct: 30,
        developerHoldingsPct: 10,
        totalHolders: 100,
        simulationTimeMs: 1500,
      };

      const layerResult = simulationService.toLayerResult(simulationResult);

      expect(layerResult.score).toBe(70);
      expect(layerResult.flags).toContain("SELL_SIMULATION_FAILED");
    });

    test("should detect HIGH_SELL_TAX flag", () => {
      const simulationResult: SimulationResult = {
        canBuy: true,
        canSell: true,
        buyTax: 1.0,
        sellTax: 60.0, // ← HIGH TAX!
        buyPriceImpact: 0.5,
        sellPriceImpact: 0.5,
        isHoneypot: false,
        top10HoldersPct: 30,
        developerHoldingsPct: 10,
        totalHolders: 100,
        simulationTimeMs: 1500,
      };

      const layerResult = simulationService.toLayerResult(simulationResult);

      expect(layerResult.score).toBe(40);
      expect(layerResult.flags).toContain("HIGH_SELL_TAX");
    });

    test("should detect CENTRALIZED flag", () => {
      const simulationResult: SimulationResult = {
        canBuy: true,
        canSell: true,
        buyTax: 1.0,
        sellTax: 1.0,
        buyPriceImpact: 0.5,
        sellPriceImpact: 0.5,
        isHoneypot: false,
        top10HoldersPct: 85, // ← CENTRALIZED!
        developerHoldingsPct: 40,
        totalHolders: 100,
        simulationTimeMs: 1500,
      };

      const layerResult = simulationService.toLayerResult(simulationResult);

      expect(layerResult.score).toBe(20);
      expect(layerResult.flags).toContain("CENTRALIZED");
    });

    test("should detect SINGLE_HOLDER_MAJORITY flag", () => {
      const simulationResult: SimulationResult = {
        canBuy: true,
        canSell: true,
        buyTax: 1.0,
        sellTax: 1.0,
        buyPriceImpact: 0.5,
        sellPriceImpact: 0.5,
        isHoneypot: false,
        top10HoldersPct: 70,
        developerHoldingsPct: 60, // ← SINGLE HOLDER MAJORITY!
        totalHolders: 100,
        simulationTimeMs: 1500,
      };

      const layerResult = simulationService.toLayerResult(simulationResult);

      expect(layerResult.score).toBe(30);
      expect(layerResult.flags).toContain("SINGLE_HOLDER_MAJORITY");
    });

    test("should detect UNLOCKED_LIQUIDITY flag", () => {
      const simulationResult: SimulationResult = {
        canBuy: true,
        canSell: true,
        buyTax: 1.0,
        sellTax: 1.0,
        buyPriceImpact: 0.5,
        sellPriceImpact: 0.5,
        isHoneypot: false,
        top10HoldersPct: 30,
        developerHoldingsPct: 10,
        totalHolders: 100,
        hasLiquidityLock: false, // ← UNLOCKED!
        simulationTimeMs: 1500,
      };

      const layerResult = simulationService.toLayerResult(simulationResult);

      expect(layerResult.score).toBe(30);
      expect(layerResult.flags).toContain("UNLOCKED_LIQUIDITY");
    });

    test("should accumulate multiple flags and cap score at 100", () => {
      const simulationResult: SimulationResult = {
        canBuy: true,
        canSell: false, // +70
        buyTax: 1.0,
        sellTax: 60.0, // +40
        buyPriceImpact: 0.5,
        sellPriceImpact: 0.5,
        isHoneypot: true,
        honeypotReason: "Multiple issues",
        top10HoldersPct: 85, // +20
        developerHoldingsPct: 60, // +30
        totalHolders: 100,
        hasLiquidityLock: false, // +30
        simulationTimeMs: 1500,
      };

      const layerResult = simulationService.toLayerResult(simulationResult);

      // Total would be 190, but capped at 100
      expect(layerResult.score).toBe(100);
      expect(layerResult.flags).toHaveLength(5);
      expect(layerResult.flags).toContain("SELL_SIMULATION_FAILED");
      expect(layerResult.flags).toContain("HIGH_SELL_TAX");
      expect(layerResult.flags).toContain("CENTRALIZED");
      expect(layerResult.flags).toContain("SINGLE_HOLDER_MAJORITY");
      expect(layerResult.flags).toContain("UNLOCKED_LIQUIDITY");
    });
  });

  // ==========================================================================
  // Test: simulate (integration-style tests with mocks)
  // ==========================================================================

  describe("simulate", () => {
    test("should successfully simulate safe token (buy and sell work)", async () => {
      // Mock Jupiter getQuote
      const getQuoteMock = mock(() =>
        Promise.resolve(
          Ok(
            createMockJupiterQuote(
              SOL_MINT,
              MOCK_TOKEN_MINT,
              "100000000",
              "1000000000",
              0.01
            )
          )
        )
      );
      jupiterService.getQuote = getQuoteMock as any;

      // Mock VersionedTransaction.deserialize to avoid "Reached end of buffer" error
      const mockTx = {} as VersionedTransaction;
      spyOn(VersionedTransaction, "deserialize").mockReturnValue(mockTx);

      // Mock simulateTransaction
      const simulateMock = mock(() =>
        Promise.resolve({
          context: { slot: 123456 },
          value: {
            err: null, // Success
            logs: ["Program log: Success"],
            accounts: null,
            unitsConsumed: 50000,
            returnData: null,
          },
        })
      );
      connection.simulateTransaction = simulateMock as any;

      // Mock getTokenLargestAccounts
      const getLargestMock = mock(() =>
        Promise.resolve({
          context: { slot: 123456 },
          value: [
            { address: PublicKey.default, amount: "1000000", decimals: 6 },
            { address: PublicKey.default, amount: "500000", decimals: 6 },
          ],
        })
      );
      connection.getTokenLargestAccounts = getLargestMock as any;

      // Mock getParsedAccountInfo (for mint info)
      const getParsedMock = mock(() =>
        Promise.resolve({
          context: { slot: 123456 },
          value: {
            data: {
              parsed: {
                type: "mint",
                info: {
                  supply: "10000000",
                  decimals: 6,
                },
              },
            },
            executable: false,
            lamports: 1000000,
            owner: PublicKey.default,
            rentEpoch: 0,
          },
        })
      );
      connection.getParsedAccountInfo = getParsedMock as any;

      const result = await simulationService.simulate(MOCK_TOKEN_MINT);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.canBuy).toBe(true);
        expect(result.value.canSell).toBe(true);
        expect(result.value.isHoneypot).toBe(false);
        expect(result.value.buyTax).toBeGreaterThan(0);
        expect(result.value.sellTax).toBeGreaterThan(0);
        expect(result.value.top10HoldersPct).toBeGreaterThan(0);
        expect(result.value.simulationTimeMs).toBeGreaterThan(0);
      }
    });

    test("should detect honeypot when sell fails but buy succeeds", async () => {
      // Mock Jupiter getQuote
      const getQuoteMock = mock(() =>
        Promise.resolve(
          Ok(
            createMockJupiterQuote(
              SOL_MINT,
              MOCK_TOKEN_MINT,
              "100000000",
              "1000000000",
              0.01
            )
          )
        )
      );
      jupiterService.getQuote = getQuoteMock as any;

      // Mock VersionedTransaction.deserialize
      const mockTx = {} as VersionedTransaction;
      spyOn(VersionedTransaction, "deserialize").mockReturnValue(mockTx);

      // Mock simulateTransaction - buy succeeds, sell fails
      let callCount = 0;
      const simulateMock = mock(() => {
        callCount++;
        if (callCount === 1) {
          // Buy succeeds
          return Promise.resolve({
            context: { slot: 123456 },
            value: {
              err: null,
              logs: ["Program log: Buy success"],
              accounts: null,
              unitsConsumed: 50000,
              returnData: null,
            },
          });
        } else {
          // Sell fails
          return Promise.resolve({
            context: { slot: 123456 },
            value: {
              err: { InstructionError: [0, "Custom error"] }, // ← ERROR!
              logs: ["Program log: Sell failed"],
              accounts: null,
              unitsConsumed: 0,
              returnData: null,
            },
          });
        }
      });
      connection.simulateTransaction = simulateMock as any;

      // Mock holder analysis
      connection.getTokenLargestAccounts = mock(() =>
        Promise.resolve({
          context: { slot: 123456 },
          value: [
            { address: new PublicKey("11111111111111111111111111111111"), amount: "1000000", decimals: 6 },
          ],
        })
      ) as any;

      connection.getParsedAccountInfo = mock(() =>
        Promise.resolve({
          context: { slot: 123456 },
          value: {
            data: {
              parsed: {
                type: "mint",
                info: {
                  supply: "10000000",
                  decimals: 6,
                },
              },
            },
            executable: false,
            lamports: 1000000,
            owner: PublicKey.default,
            rentEpoch: 0,
          },
        })
      ) as any;

      const result = await simulationService.simulate(MOCK_TOKEN_MINT);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.canBuy).toBe(true);
        expect(result.value.canSell).toBe(false);
        expect(result.value.isHoneypot).toBe(true);
        expect(result.value.honeypotReason).toContain("Sell transaction fails");
      }
    });

    test("should handle timeout gracefully", async () => {
      // Mock Jupiter to be very slow
      jupiterService.getQuote = mock(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(Ok(createMockJupiterQuote(SOL_MINT, MOCK_TOKEN_MINT, "100000000", "1000000000"))), 5000);
          })
      ) as any;

      const result = await simulationService.simulate(MOCK_TOKEN_MINT, { timeout: 100 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("timeout");
      }
    });

    test("should handle buy quote failure", async () => {
      // Mock Jupiter to return error
      jupiterService.getQuote = mock(() =>
        Promise.resolve(Err({ type: "NO_ROUTE", message: "No route found" }))
      ) as any;

      const result = await simulationService.simulate(MOCK_TOKEN_MINT);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Buy quote failed");
      }
    });

    test("should handle missing transaction in quote", async () => {
      // Mock Jupiter to return quote without transaction
      const quoteWithoutTx = createMockJupiterQuote(
        SOL_MINT,
        MOCK_TOKEN_MINT,
        "100000000",
        "1000000000"
      );
      quoteWithoutTx.transaction = null; // ← No transaction!

      jupiterService.getQuote = mock(() => Promise.resolve(Ok(quoteWithoutTx))) as any;

      const result = await simulationService.simulate(MOCK_TOKEN_MINT);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("missing transaction field");
      }
    });

    test("should skip holder analysis when configured", async () => {
      // Mock Jupiter getQuote
      jupiterService.getQuote = mock(() =>
        Promise.resolve(
          Ok(
            createMockJupiterQuote(
              SOL_MINT,
              MOCK_TOKEN_MINT,
              "100000000",
              "1000000000"
            )
          )
        )
      ) as any;

      // Mock simulateTransaction
      connection.simulateTransaction = mock(() =>
        Promise.resolve({
          context: { slot: 123456 },
          value: {
            err: null,
            logs: ["Program log: Success"],
            accounts: null,
            unitsConsumed: 50000,
            returnData: null,
          },
        })
      ) as any;

      // Mock should NOT be called
      const holderMock = mock(() => Promise.resolve({ context: { slot: 0 }, value: [] }));
      connection.getTokenLargestAccounts = holderMock as any;

      const result = await simulationService.simulate(MOCK_TOKEN_MINT, {
        skipHolderAnalysis: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.top10HoldersPct).toBe(0);
        expect(result.value.developerHoldingsPct).toBe(0);
        expect(result.value.totalHolders).toBe(0);
      }
      // Holder mock should not be called
      expect(holderMock).not.toHaveBeenCalled();
    });
  });
});
