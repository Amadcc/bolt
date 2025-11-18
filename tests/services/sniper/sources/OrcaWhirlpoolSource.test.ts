/**
 * Unit tests for Orca Whirlpool Source
 *
 * Tests pool detection and parsing for Orca Whirlpool (CLMM) pools.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { OrcaWhirlpoolSource } from "../../../../src/services/sniper/sources/OrcaWhirlpoolSource.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { ORCA_WHIRLPOOL_PROGRAM } from "../../../../src/config/programs.js";

// ============================================================================
// Test Setup
// ============================================================================

const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

/**
 * Create mock Orca Whirlpool transaction response
 */
function createMockOrcaWhirlpoolTransaction(
  tokenMintA: string,
  tokenMintB: string,
  poolAddress: string,
  blockTime: number | null = Math.floor(Date.now() / 1000)
) {
  const accountKeys = [
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // 0: Token program
    new PublicKey(tokenMintA), // 1: token_mint_a
    new PublicKey(tokenMintB), // 2: token_mint_b
    new PublicKey("11111111111111111111111111111111"), // 3: System program
    new PublicKey(poolAddress), // 4: whirlpool (pool address)
    new PublicKey("SysvarRent111111111111111111111111111111111"), // 5: Rent
  ];

  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      logMessages: [
        "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [1]",
        "Program log: Instruction: InitializePool",
        "Program log: Whirlpool created successfully",
        "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc consumed 45000 compute units",
        "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success",
      ],
      postBalances: [],
      postTokenBalances: [],
      preBalances: [],
      preTokenBalances: [],
      rewards: [],
      status: { Ok: null },
    },
    slot: 345678901,
    transaction: {
      message: {
        staticAccountKeys: accountKeys,
        recentBlockhash: "33333333333333333333333333333333",
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

describe("OrcaWhirlpoolSource - Basic Properties", () => {
  test("should return correct programId", () => {
    const source = new OrcaWhirlpoolSource(createMockConnection());
    expect(source.programId).toBe(ORCA_WHIRLPOOL_PROGRAM);
  });

  test("should return correct sourceName", () => {
    const source = new OrcaWhirlpoolSource(createMockConnection());
    expect(source.sourceName).toBe("Orca Whirlpool");
  });

  test("should return correct sourceType", () => {
    const source = new OrcaWhirlpoolSource(createMockConnection());
    expect(source.sourceType).toBe("orca_whirlpool");
  });
});

// ============================================================================
// Test: isPoolInitLog
// ============================================================================

describe("OrcaWhirlpoolSource - isPoolInitLog", () => {
  let source: OrcaWhirlpoolSource;

  beforeEach(() => {
    source = new OrcaWhirlpoolSource(createMockConnection());
  });

  test("should detect 'InitializePool' pattern", () => {
    const log = "Program log: Instruction: InitializePool";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect 'initialize_pool' pattern", () => {
    const log = "Program log: Instruction: initialize_pool";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect 'InitializePoolV2' pattern", () => {
    const log = "Program log: Instruction: InitializePoolV2";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect pattern in middle of log", () => {
    const log = "Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc log: InitializePool executed";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should reject non-init logs", () => {
    const log = "Program log: Instruction: swap";
    expect(source.isPoolInitLog(log)).toBe(false);
  });

  test("should reject swap logs", () => {
    const log = "Program log: Instruction: Swap";
    expect(source.isPoolInitLog(log)).toBe(false);
  });

  test("should reject empty log", () => {
    const log = "";
    expect(source.isPoolInitLog(log)).toBe(false);
  });
});

// ============================================================================
// Test: parsePoolInit - Success Cases
// ============================================================================

describe("OrcaWhirlpoolSource - parsePoolInit Success", () => {
  let source: OrcaWhirlpoolSource;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new OrcaWhirlpoolSource(createMockConnection());
  });

  test("should parse valid pool initialization", async () => {
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
    const tokenMintB = "So11111111111111111111111111111111111111112"; // SOL
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const blockTime = Math.floor(Date.now() / 1000);
    const slot = 345678901;

    const mockTx = createMockOrcaWhirlpoolTransaction(
      tokenMintA,
      tokenMintB,
      poolAddress,
      blockTime
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      const detection = result.value;
      expect(detection.poolAddress).toBe(poolAddress);
      expect(detection.tokenMintA).toBe(tokenMintA);
      expect(detection.tokenMintB).toBe(tokenMintB);
      expect(detection.source).toBe("orca_whirlpool");
      expect(detection.signature).toBe(validSignature);
      expect(detection.slot).toBe(slot);
      expect(detection.blockTime).toBe(blockTime);
    }
  });

  test("should handle null blockTime correctly", async () => {
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintB = "So11111111111111111111111111111111111111112";
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockOrcaWhirlpoolTransaction(
      tokenMintA,
      tokenMintB,
      poolAddress,
      null
    );

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

  test("should parse pool with USDC/USDT pair", async () => {
    const tokenMintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const tokenMintB = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // USDT
    const poolAddress = "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX";

    const mockTx = createMockOrcaWhirlpoolTransaction(
      tokenMintA,
      tokenMintB,
      poolAddress
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(tokenMintA);
      expect(result.value.tokenMintB).toBe(tokenMintB);
    }
  });
});

// ============================================================================
// Test: parsePoolInit - Error Cases
// ============================================================================

describe("OrcaWhirlpoolSource - parsePoolInit Errors", () => {
  let source: OrcaWhirlpoolSource;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new OrcaWhirlpoolSource(createMockConnection());
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
      slot: 345678901,
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

  test("should fail with insufficient accounts", async () => {
    const mockTx = createMockOrcaWhirlpoolTransaction(
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112",
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
    );

    // Truncate to only 3 accounts (need >= 5)
    mockTx.transaction.message.staticAccountKeys =
      mockTx.transaction.message.staticAccountKeys.slice(0, 3);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Insufficient accounts");
      expect(result.error).toContain("need >= 5");
    }
  });

  test("should fail with exactly 4 accounts (need 5)", async () => {
    const mockTx = createMockOrcaWhirlpoolTransaction(
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112",
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
    );

    mockTx.transaction.message.staticAccountKeys =
      mockTx.transaction.message.staticAccountKeys.slice(0, 4);

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
      throw new Error("Network timeout");
    });

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to parse Orca Whirlpool pool init");
      expect(result.error).toContain("Network timeout");
    }
  });
});

// ============================================================================
// Test: Account Index Correctness
// ============================================================================

describe("OrcaWhirlpoolSource - Account Index Validation", () => {
  let source: OrcaWhirlpoolSource;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new OrcaWhirlpoolSource(createMockConnection());
  });

  test("should extract tokenMintA from index 1", async () => {
    const tokenMintA = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"; // mSOL
    const tokenMintB = "So11111111111111111111111111111111111111112";
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockOrcaWhirlpoolTransaction(
      tokenMintA,
      tokenMintB,
      poolAddress
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(tokenMintA);
      expect(mockTx.transaction.message.staticAccountKeys[1].toString()).toBe(
        tokenMintA
      );
    }
  });

  test("should extract tokenMintB from index 2", async () => {
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintB = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const mockTx = createMockOrcaWhirlpoolTransaction(
      tokenMintA,
      tokenMintB,
      poolAddress
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintB).toBe(tokenMintB);
      expect(mockTx.transaction.message.staticAccountKeys[2].toString()).toBe(
        tokenMintB
      );
    }
  });

  test("should extract pool address from index 4", async () => {
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintB = "So11111111111111111111111111111111111111112";
    const poolAddress = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";

    const mockTx = createMockOrcaWhirlpoolTransaction(
      tokenMintA,
      tokenMintB,
      poolAddress
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.poolAddress).toBe(poolAddress);
      expect(mockTx.transaction.message.staticAccountKeys[4].toString()).toBe(
        poolAddress
      );
    }
  });
});
