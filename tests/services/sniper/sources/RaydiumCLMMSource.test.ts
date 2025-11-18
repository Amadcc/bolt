/**
 * Unit tests for Raydium CLMM Source
 *
 * Tests pool detection and parsing for Raydium Concentrated Liquidity pools.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { RaydiumCLMMSource } from "../../../../src/services/sniper/sources/RaydiumCLMMSource.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { RAYDIUM_CLMM_PROGRAM } from "../../../../src/config/programs.js";

// ============================================================================
// Test Setup
// ============================================================================

const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

/**
 * Create mock Raydium CLMM transaction response
 */
function createMockRaydiumCLMMTransaction(
  poolAddress: string,
  tokenMint0: string,
  tokenMint1: string,
  blockTime: number | null = Math.floor(Date.now() / 1000)
) {
  const accountKeys = [
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // 0: Token program
    new PublicKey("11111111111111111111111111111111"), // 1: System program
    new PublicKey(poolAddress), // 2: pool_state (pool address)
    new PublicKey(tokenMint0), // 3: token_mint_0
    new PublicKey(tokenMint1), // 4: token_mint_1
    new PublicKey("SysvarRent111111111111111111111111111111111"), // 5: Rent
    new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"), // 6: Authority
  ];

  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      logMessages: [
        "Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK invoke [1]",
        "Program log: Instruction: CreatePool",
        "Program log: CLMM pool created successfully",
        "Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK consumed 48000 compute units",
        "Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success",
      ],
      postBalances: [],
      postTokenBalances: [],
      preBalances: [],
      preTokenBalances: [],
      rewards: [],
      status: { Ok: null },
    },
    slot: 234567890,
    transaction: {
      message: {
        staticAccountKeys: accountKeys,
        recentBlockhash: "22222222222222222222222222222222",
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

describe("RaydiumCLMMSource - Basic Properties", () => {
  test("should return correct programId", () => {
    const source = new RaydiumCLMMSource(createMockConnection());
    expect(source.programId).toBe(RAYDIUM_CLMM_PROGRAM);
  });

  test("should return correct sourceName", () => {
    const source = new RaydiumCLMMSource(createMockConnection());
    expect(source.sourceName).toBe("Raydium CLMM");
  });

  test("should return correct sourceType", () => {
    const source = new RaydiumCLMMSource(createMockConnection());
    expect(source.sourceType).toBe("raydium_clmm");
  });
});

// ============================================================================
// Test: isPoolInitLog
// ============================================================================

describe("RaydiumCLMMSource - isPoolInitLog", () => {
  let source: RaydiumCLMMSource;

  beforeEach(() => {
    source = new RaydiumCLMMSource(createMockConnection());
  });

  test("should detect 'CreatePool' pattern", () => {
    const log = "Program log: Instruction: CreatePool";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect 'create_pool' pattern", () => {
    const log = "Program log: Instruction: create_pool";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect 'Initialize' pattern", () => {
    const log = "Program log: Instruction: Initialize";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect pattern in middle of log", () => {
    const log = "Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK log: CreatePool executed";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should reject non-init logs", () => {
    const log = "Program log: Instruction: swap";
    expect(source.isPoolInitLog(log)).toBe(false);
  });

  test("should reject deposit logs", () => {
    const log = "Program log: Instruction: DecreaseLiquidity";
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

describe("RaydiumCLMMSource - parsePoolInit Success", () => {
  let source: RaydiumCLMMSource;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new RaydiumCLMMSource(createMockConnection());
  });

  test("should parse valid pool creation", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"; // Valid pool
    const tokenMint0 = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
    const tokenMint1 = "So11111111111111111111111111111111111111112"; // SOL
    const blockTime = Math.floor(Date.now() / 1000);
    const slot = 234567890;

    const mockTx = createMockRaydiumCLMMTransaction(
      poolAddress,
      tokenMint0,
      tokenMint1,
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
      expect(detection.tokenMintA).toBe(tokenMint0);
      expect(detection.tokenMintB).toBe(tokenMint1);
      expect(detection.source).toBe("raydium_clmm");
      expect(detection.signature).toBe(validSignature);
      expect(detection.slot).toBe(slot);
      expect(detection.blockTime).toBe(blockTime);
    }
  });

  test("should handle null blockTime correctly", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMint0 = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMint1 = "So11111111111111111111111111111111111111112";

    const mockTx = createMockRaydiumCLMMTransaction(
      poolAddress,
      tokenMint0,
      tokenMint1,
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
    const poolAddress = "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX"; // Valid pool
    const tokenMint0 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const tokenMint1 = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // USDT

    const mockTx = createMockRaydiumCLMMTransaction(
      poolAddress,
      tokenMint0,
      tokenMint1
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(tokenMint0);
      expect(result.value.tokenMintB).toBe(tokenMint1);
    }
  });
});

// ============================================================================
// Test: parsePoolInit - Error Cases
// ============================================================================

describe("RaydiumCLMMSource - parsePoolInit Errors", () => {
  let source: RaydiumCLMMSource;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new RaydiumCLMMSource(createMockConnection());
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
      slot: 234567890,
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
    const mockTx = createMockRaydiumCLMMTransaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
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
    const mockTx = createMockRaydiumCLMMTransaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
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
      throw new Error("RPC connection timeout");
    });

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to parse Raydium CLMM pool creation");
      expect(result.error).toContain("RPC connection timeout");
    }
  });
});

// ============================================================================
// Test: Account Index Correctness
// ============================================================================

describe("RaydiumCLMMSource - Account Index Validation", () => {
  let source: RaydiumCLMMSource;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new RaydiumCLMMSource(createMockConnection());
  });

  test("should extract pool address from index 2", async () => {
    const poolAddress = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT"; // Valid pool
    const tokenMint0 = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMint1 = "So11111111111111111111111111111111111111112";

    const mockTx = createMockRaydiumCLMMTransaction(
      poolAddress,
      tokenMint0,
      tokenMint1
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.poolAddress).toBe(poolAddress);
      expect(mockTx.transaction.message.staticAccountKeys[2].toString()).toBe(
        poolAddress
      );
    }
  });

  test("should extract tokenMint0 from index 3", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMint0 = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"; // mSOL
    const tokenMint1 = "So11111111111111111111111111111111111111112";

    const mockTx = createMockRaydiumCLMMTransaction(
      poolAddress,
      tokenMint0,
      tokenMint1
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(tokenMint0);
      expect(mockTx.transaction.message.staticAccountKeys[3].toString()).toBe(
        tokenMint0
      );
    }
  });

  test("should extract tokenMint1 from index 4", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMint0 = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

    const mockTx = createMockRaydiumCLMMTransaction(
      poolAddress,
      tokenMint0,
      tokenMint1
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintB).toBe(tokenMint1);
      expect(mockTx.transaction.message.staticAccountKeys[4].toString()).toBe(
        tokenMint1
      );
    }
  });
});
