/**
 * Unit tests for Pump.fun Source (Token2022 + Legacy support)
 *
 * Comprehensive test coverage for both create_v2 (Token2022) and create (legacy) instructions.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { PumpFunSource } from "../../../../src/services/sniper/sources/PumpFunSource.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_FUN_PROGRAM } from "../../../../src/config/programs.js";

// ============================================================================
// Test Setup
// ============================================================================

const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";
const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";
const MAYHEM_PROGRAM_ID = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

/**
 * Create mock Pump.fun create_v2 transaction (Token2022 + Mayhem)
 */
function createMockPumpFunV2Transaction(
  mint: string,
  bondingCurve: string,
  blockTime: number | null = Math.floor(Date.now() / 1000)
) {
  const accountKeys = [
    new PublicKey(mint), // 0: mint
    new PublicKey("MetaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), // 1: metadata
    new PublicKey(bondingCurve), // 2: bonding_curve (pool)
    new PublicKey("11111111111111111111111111111111"), // 3: system program
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // 4: token program
    new PublicKey("SysvarRent111111111111111111111111111111111"), // 5: rent
    new PublicKey("ComputeBudget111111111111111111111111111111"), // 6: compute budget
    new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), // 7: token_2022
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), // 8: associated_token
    new PublicKey(MAYHEM_PROGRAM_ID), // 9: mayhem_program_id (create_v2)
    new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"), // 10: global_params
    new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // 11: user
    new PublicKey("So11111111111111111111111111111111111111112"), // 12: user_sol_ata
    new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), // 13: user_token_ata
    new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), // 14: fee_vault
    new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"), // 15: event_authority
  ];

  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      logMessages: [
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
        "Program log: Instruction: create_v2",
        "Program log: Bonding curve created with Token2022",
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P consumed 45000 compute units",
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
      ],
      postBalances: [],
      postTokenBalances: [],
      preBalances: [],
      preTokenBalances: [],
      rewards: [],
      status: { Ok: null },
    },
    slot: 567890123,
    transaction: {
      message: {
        staticAccountKeys: accountKeys,
        recentBlockhash: "55555555555555555555555555555555",
        compiledInstructions: [],
        addressTableLookups: [],
      },
      signatures: [],
    },
    version: 0,
  };
}

/**
 * Create mock Pump.fun create transaction (Legacy Metaplex)
 */
function createMockPumpFunLegacyTransaction(
  mint: string,
  bondingCurve: string,
  blockTime: number | null = Math.floor(Date.now() / 1000)
) {
  const accountKeys = [
    new PublicKey(mint), // 0: mint
    new PublicKey("MetaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), // 1: mint_authority
    new PublicKey(bondingCurve), // 2: bonding_curve (pool)
    new PublicKey("11111111111111111111111111111111"), // 3: system program
    new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"), // 4: global (config account)
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // 5: token program
    new PublicKey("SysvarRent111111111111111111111111111111111"), // 6: rent
    new PublicKey("ComputeBudget111111111111111111111111111111"), // 7: compute budget
    new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // 8: user
    new PublicKey("So11111111111111111111111111111111111111112"), // 9: user_sol_ata
    new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), // 10: user_token_ata
    new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), // 11: fee_vault
    new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"), // 12: metadata
    new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV"), // 13: metaplex
  ];

  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      logMessages: [
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
        "Program log: Instruction: create",
        "Program log: Bonding curve created with Metaplex",
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P consumed 42000 compute units",
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
      ],
      postBalances: [],
      postTokenBalances: [],
      preBalances: [],
      preTokenBalances: [],
      rewards: [],
      status: { Ok: null },
    },
    slot: 567890123,
    transaction: {
      message: {
        staticAccountKeys: accountKeys,
        recentBlockhash: "55555555555555555555555555555555",
        compiledInstructions: [],
        addressTableLookups: [],
      },
      signatures: [],
    },
    version: 0,
  };
}

// ============================================================================
// Test: Basic Getters
// ============================================================================

describe("PumpFunSource - Basic Properties", () => {
  test("should return correct programId", () => {
    const source = new PumpFunSource(createMockConnection());
    expect(source.programId).toBe(PUMP_FUN_PROGRAM);
  });

  test("should return correct sourceName", () => {
    const source = new PumpFunSource(createMockConnection());
    expect(source.sourceName).toBe("Pump.fun");
  });

  test("should return correct sourceType", () => {
    const source = new PumpFunSource(createMockConnection());
    expect(source.sourceType).toBe("pump_fun");
  });
});

// ============================================================================
// Test: isPoolInitLog
// ============================================================================

describe("PumpFunSource - isPoolInitLog", () => {
  let source: PumpFunSource;

  beforeEach(() => {
    source = new PumpFunSource(createMockConnection());
  });

  test("should detect 'create' pattern", () => {
    expect(source.isPoolInitLog("Program log: Instruction: create")).toBe(true);
  });

  test("should detect 'create_v2' pattern", () => {
    expect(source.isPoolInitLog("Program log: Instruction: create_v2")).toBe(true);
  });

  test("should detect 'Create' pattern", () => {
    expect(source.isPoolInitLog("Program log: Instruction: Create")).toBe(true);
  });

  test("should detect 'CreateBondingCurve' pattern", () => {
    expect(source.isPoolInitLog("Program log: CreateBondingCurve")).toBe(true);
  });

  test("should detect pattern in middle of log", () => {
    const log = "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P log: create_v2 executed";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should reject non-init logs", () => {
    expect(source.isPoolInitLog("Program log: buy")).toBe(false);
  });

  test("should reject sell logs", () => {
    expect(source.isPoolInitLog("Program log: sell")).toBe(false);
  });

  test("should reject empty log", () => {
    expect(source.isPoolInitLog("")).toBe(false);
  });
});

// ============================================================================
// Test: parsePoolInit - create_v2 (Token2022)
// ============================================================================

describe("PumpFunSource - parsePoolInit create_v2", () => {
  let source: PumpFunSource;

  beforeEach(() => {
    source = new PumpFunSource(createMockConnection());
  });

  test("should parse valid create_v2 bonding curve", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const bondingCurve = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const blockTime = Math.floor(Date.now() / 1000);
    const slot = 567890123;

    const mockTx = createMockPumpFunV2Transaction(mint, bondingCurve, blockTime);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(mint);
      expect(result.value.tokenMintB).toBe(SOL_MINT); // Always SOL
      expect(result.value.poolAddress).toBe(bondingCurve);
      expect(result.value.source).toBe("pump_fun");
      expect(result.value.signature).toBe(validSignature);
      expect(result.value.slot).toBe(slot);
      expect(result.value.blockTime).toBe(blockTime);
    }
  });

  test("should detect create_v2 by account count and Mayhem program", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const bondingCurve = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockPumpFunV2Transaction(mint, bondingCurve);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      // Verify Mayhem program is at position 9
      expect(mockTx.transaction.message.staticAccountKeys[9].toString()).toBe(MAYHEM_PROGRAM_ID);
    }
  });

  test("should handle null blockTime in create_v2", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const bondingCurve = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockPumpFunV2Transaction(mint, bondingCurve, null);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.blockTime).toBe(null);
    }
  });
});

// ============================================================================
// Test: parsePoolInit - create (Legacy)
// ============================================================================

describe("PumpFunSource - parsePoolInit create (legacy)", () => {
  let source: PumpFunSource;

  beforeEach(() => {
    source = new PumpFunSource(createMockConnection());
  });

  test("should parse valid legacy create bonding curve", async () => {
    const mint = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
    const bondingCurve = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
    const blockTime = Math.floor(Date.now() / 1000);
    const slot = 567890123;

    const mockTx = createMockPumpFunLegacyTransaction(mint, bondingCurve, blockTime);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(mint);
      expect(result.value.tokenMintB).toBe(SOL_MINT);
      expect(result.value.poolAddress).toBe(bondingCurve);
      expect(result.value.source).toBe("pump_fun");
      expect(result.value.slot).toBe(slot);
      expect(result.value.blockTime).toBe(blockTime);
    }
  });

  test("should detect legacy create by account count", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const bondingCurve = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockPumpFunLegacyTransaction(mint, bondingCurve);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      // Verify it has 14 accounts (not 16 like create_v2)
      expect(mockTx.transaction.message.staticAccountKeys.length).toBe(14);
    }
  });

  test("should handle null blockTime in legacy create", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const bondingCurve = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockPumpFunLegacyTransaction(mint, bondingCurve, null);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.blockTime).toBe(null);
    }
  });
});

// ============================================================================
// Test: parsePoolInit - Error Cases
// ============================================================================

describe("PumpFunSource - parsePoolInit Errors", () => {
  let source: PumpFunSource;

  beforeEach(() => {
    source = new PumpFunSource(createMockConnection());
  });

  test("should fail when transaction not found", async () => {
    const originalExecute = source["rpcCircuitBreaker"].execute;
    // @ts-expect-error - Mock circuit breaker execute method
    source["rpcCircuitBreaker"].execute = vi.fn(async () => undefined);

    const result = await source.parsePoolInit(validSignature);

    source["rpcCircuitBreaker"].execute = originalExecute;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Transaction not found");
    }
  });

  test("should fail when transaction data not available", async () => {
    const mockTx = {
      blockTime: null,
      meta: null,
      slot: 567890123,
      transaction: null,
      version: 0,
    };

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Transaction data not available");
    }
  });

  test("should fail with insufficient accounts (legacy)", async () => {
    const mockTx = createMockPumpFunLegacyTransaction(
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
    );

    // Truncate to only 2 accounts (need >= 5 for legacy)
    mockTx.transaction.message.staticAccountKeys =
      mockTx.transaction.message.staticAccountKeys.slice(0, 2);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Insufficient accounts");
    }
  });

  test("should handle RPC errors gracefully", async () => {
    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => {
      throw new Error("Connection timeout");
    });

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to parse Pump.fun token creation");
      expect(result.error).toContain("Connection timeout");
    }
  });
});

// ============================================================================
// Test: Account Index Correctness
// ============================================================================

describe("PumpFunSource - Account Index Validation", () => {
  let source: PumpFunSource;

  beforeEach(() => {
    source = new PumpFunSource(createMockConnection());
  });

  test("should extract mint from index 0 (create_v2)", async () => {
    const mint = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
    const bondingCurve = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockPumpFunV2Transaction(mint, bondingCurve);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(mint);
      expect(mockTx.transaction.message.staticAccountKeys[0].toString()).toBe(mint);
    }
  });

  test("should extract bonding curve from index 2 (create_v2)", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const bondingCurve = "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX";

    const mockTx = createMockPumpFunV2Transaction(mint, bondingCurve);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.poolAddress).toBe(bondingCurve);
      expect(mockTx.transaction.message.staticAccountKeys[2].toString()).toBe(bondingCurve);
    }
  });

  test("should extract mint from index 0 (legacy)", async () => {
    const mint = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
    const bondingCurve = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockPumpFunLegacyTransaction(mint, bondingCurve);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(mint);
      expect(mockTx.transaction.message.staticAccountKeys[0].toString()).toBe(mint);
    }
  });

  test("should always set tokenMintB to SOL", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const bondingCurve = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockPumpFunV2Transaction(mint, bondingCurve);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintB).toBe(SOL_MINT);
    }
  });
});
