/**
 * Unit tests for Raydium V4 AMM Source
 *
 * Tests pool detection and parsing for Raydium V4 AMM.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { RaydiumV4Source } from "../../../../src/services/sniper/sources/RaydiumV4Source.js";
import { Connection, PublicKey } from "@solana/web3.js";
import type { RawPoolDetection } from "../../../../src/services/sniper/sources/BaseSource.js";
import { RAYDIUM_V4_PROGRAM } from "../../../../src/config/programs.js";

// ============================================================================
// Test Setup
// ============================================================================

const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

/**
 * Create mock Raydium V4 transaction response
 */
function createMockRaydiumV4Transaction(
  poolAddress: string,
  tokenMintA: string,
  tokenMintB: string,
  blockTime: number | null = Math.floor(Date.now() / 1000)
) {
  const accountKeys = [
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // 0: Token program
    new PublicKey("11111111111111111111111111111111"), // 1: System program
    new PublicKey("SysvarRent111111111111111111111111111111111"), // 2: Rent
    new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"), // 3: AMM program
    new PublicKey(poolAddress), // 4: Pool address (AMM account)
    new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"), // 5: Authority
    new PublicKey("J8u8nTHYtvudyqwLrXZboziN95LpaHFHpd97Jm5vtbkW"), // 6: Open orders
    new PublicKey("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"), // 7: LP mint
    new PublicKey(tokenMintA), // 8: Coin mint (base token)
    new PublicKey(tokenMintB), // 9: PC mint (quote token)
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), // 10: Associated token program
  ];

  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      logMessages: [
        "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
        "Program log: Instruction: initialize2",
        "Program log: Pool initialized successfully",
        "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 consumed 52000 compute units",
        "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
      ],
      postBalances: [],
      postTokenBalances: [],
      preBalances: [],
      preTokenBalances: [],
      rewards: [],
      status: { Ok: null },
    },
    slot: 123456789,
    transaction: {
      message: {
        staticAccountKeys: accountKeys,
        recentBlockhash: "11111111111111111111111111111111",
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

describe("RaydiumV4Source - Basic Properties", () => {
  test("should return correct programId", () => {
    const source = new RaydiumV4Source(createMockConnection());
    expect(source.programId).toBe(RAYDIUM_V4_PROGRAM);
  });

  test("should return correct sourceName", () => {
    const source = new RaydiumV4Source(createMockConnection());
    expect(source.sourceName).toBe("Raydium V4 AMM");
  });

  test("should return correct sourceType", () => {
    const source = new RaydiumV4Source(createMockConnection());
    expect(source.sourceType).toBe("raydium_v4");
  });
});

// ============================================================================
// Test: isPoolInitLog
// ============================================================================

describe("RaydiumV4Source - isPoolInitLog", () => {
  let source: RaydiumV4Source;

  beforeEach(() => {
    source = new RaydiumV4Source(createMockConnection());
  });

  test("should detect 'initialize' pattern", () => {
    const log = "Program log: Instruction: initialize";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect 'InitializePool' pattern", () => {
    const log = "Program log: Instruction: InitializePool";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect 'initialize2' pattern", () => {
    const log = "Program log: Instruction: initialize2";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should detect pattern in middle of log", () => {
    const log = "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 log: initialize2 pool created";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should reject non-init logs", () => {
    const log = "Program log: Instruction: swap";
    expect(source.isPoolInitLog(log)).toBe(false);
  });

  test("should reject swap logs", () => {
    const log = "Program log: Instruction: SwapBaseIn";
    expect(source.isPoolInitLog(log)).toBe(false);
  });

  test("should reject deposit logs", () => {
    const log = "Program log: Instruction: deposit";
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

describe("RaydiumV4Source - parsePoolInit Success", () => {
  let source: RaydiumV4Source;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new RaydiumV4Source(createMockConnection());
  });

  test("should parse valid pool initialization", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
    const tokenMintB = "So11111111111111111111111111111111111111112"; // SOL
    const blockTime = Math.floor(Date.now() / 1000);
    const slot = 123456789;

    const mockTx = createMockRaydiumV4Transaction(
      poolAddress,
      tokenMintA,
      tokenMintB,
      blockTime
    );

    // Mock getTransaction
    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    // Restore
    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      const detection = result.value;
      expect(detection.poolAddress).toBe(poolAddress);
      expect(detection.tokenMintA).toBe(tokenMintA);
      expect(detection.tokenMintB).toBe(tokenMintB);
      expect(detection.source).toBe("raydium_v4");
      expect(detection.signature).toBe(validSignature);
      expect(detection.slot).toBe(slot);
      expect(detection.blockTime).toBe(blockTime);
    }
  });

  test("should handle null blockTime correctly", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintB = "So11111111111111111111111111111111111111112";

    const mockTx = createMockRaydiumV4Transaction(
      poolAddress,
      tokenMintA,
      tokenMintB,
      null // null blockTime
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

  test("should parse pool with different token mints", async () => {
    const poolAddress = "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX"; // Valid pool address
    const tokenMintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const tokenMintB = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // USDT

    const mockTx = createMockRaydiumV4Transaction(
      poolAddress,
      tokenMintA,
      tokenMintB
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

describe("RaydiumV4Source - parsePoolInit Errors", () => {
  let source: RaydiumV4Source;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new RaydiumV4Source(createMockConnection());
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
      slot: 123456789,
      transaction: null, // No transaction data
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
    const mockTx = createMockRaydiumV4Transaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );

    // Truncate to only 5 accounts (need >= 10)
    mockTx.transaction.message.staticAccountKeys =
      mockTx.transaction.message.staticAccountKeys.slice(0, 5);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Insufficient accounts");
      expect(result.error).toContain("need >= 10");
    }
  });

  test("should fail with exactly 9 accounts (need 10)", async () => {
    const mockTx = createMockRaydiumV4Transaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );

    // Truncate to 9 accounts (index 9 = tokenMintB requires 10 accounts)
    mockTx.transaction.message.staticAccountKeys =
      mockTx.transaction.message.staticAccountKeys.slice(0, 9);

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
      throw new Error("RPC connection failed");
    });

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to parse Raydium V4 pool init");
      expect(result.error).toContain("RPC connection failed");
    }
  });
});

// ============================================================================
// Test: Account Index Correctness
// ============================================================================

describe("RaydiumV4Source - Account Index Validation", () => {
  let source: RaydiumV4Source;
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  beforeEach(() => {
    source = new RaydiumV4Source(createMockConnection());
  });

  test("should extract pool address from index 4", async () => {
    const poolAddress = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT"; // Valid pool
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
    const tokenMintB = "So11111111111111111111111111111111111111112"; // SOL

    const mockTx = createMockRaydiumV4Transaction(
      poolAddress,
      tokenMintA,
      tokenMintB
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      // Verify pool address matches account at index 4
      expect(result.value.poolAddress).toBe(poolAddress);
      expect(mockTx.transaction.message.staticAccountKeys[4].toString()).toBe(
        poolAddress
      );
    }
  });

  test("should extract tokenMintA from index 8", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintA = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"; // mSOL
    const tokenMintB = "So11111111111111111111111111111111111111112"; // SOL

    const mockTx = createMockRaydiumV4Transaction(
      poolAddress,
      tokenMintA,
      tokenMintB
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(tokenMintA);
      expect(mockTx.transaction.message.staticAccountKeys[8].toString()).toBe(
        tokenMintA
      );
    }
  });

  test("should extract tokenMintB from index 9", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
    const tokenMintB = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

    const mockTx = createMockRaydiumV4Transaction(
      poolAddress,
      tokenMintA,
      tokenMintB
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintB).toBe(tokenMintB);
      expect(mockTx.transaction.message.staticAccountKeys[9].toString()).toBe(
        tokenMintB
      );
    }
  });
});
