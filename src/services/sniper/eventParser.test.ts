/**
 * Unit tests for Pool Event Parser
 *
 * Tests transaction parsing and token mint extraction
 */

import { describe, test, expect, mock } from "bun:test";
import { PoolEventParser, determineBaseAndQuote } from "./eventParser.js";
import { Connection, PublicKey } from "@solana/web3.js";
import type { TokenMint } from "../../types/common.js";

// Mock RPC endpoint (not actually used in unit tests)
const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";

// ============================================================================
// Helper - Create Mock Connection
// ============================================================================

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

// ============================================================================
// Helper - Create Mock Transaction Response
// ============================================================================

function createMockRaydiumV4Transaction(
  poolAddress: string,
  tokenMintA: string,
  tokenMintB: string,
  blockTime: number | null = Date.now() / 1000
) {
  const accountKeys = [
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // 0: Token program
    new PublicKey("11111111111111111111111111111111"), // 1: System program
    new PublicKey("SysvarRent111111111111111111111111111111111"), // 2: Rent
    new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"), // 3: AMM program
    new PublicKey(poolAddress), // 4: Pool address
    new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"), // 5: Authority
    new PublicKey("J8u8nTHYtvudyqwLrXZboziN95LpaHFHpd97Jm5vtbkW"), // 6: Open orders
    new PublicKey("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"), // 7: LP mint
    new PublicKey(tokenMintA), // 8: Coin mint (base token)
    new PublicKey(tokenMintB), // 9: PC mint (quote token)
    // ... more accounts would follow
  ];

  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      logMessages: [
        "Program log: Instruction: InitializePool",
        "Program log: Pool initialized successfully",
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
// Test: isPoolInitTransaction
// ============================================================================

describe("PoolEventParser.isPoolInitTransaction", () => {
  test("should detect Raydium initialize pattern", () => {
    const logs = [
      "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
      "Program log: Instruction: InitializePool",
      "Program log: Pool initialized successfully",
      "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 consumed 52000 compute units",
      "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
    ];

    const result = PoolEventParser.isPoolInitTransaction(logs);
    expect(result).toBe(true);
  });

  test("should detect initialize2 pattern", () => {
    const logs = [
      "Program log: Instruction: initialize2",
      "Program log: Pool created",
    ];

    const result = PoolEventParser.isPoolInitTransaction(logs);
    expect(result).toBe(true);
  });

  test("should detect Orca InitializePoolV2 pattern", () => {
    const logs = [
      "Program log: Instruction: InitializePoolV2",
      "Program log: Whirlpool initialized",
    ];

    const result = PoolEventParser.isPoolInitTransaction(logs);
    expect(result).toBe(true);
  });

  test("should detect Meteora InitializeLbPair pattern", () => {
    const logs = [
      "Program log: Instruction: InitializeLbPair",
      "Program log: DLMM pool created",
    ];

    const result = PoolEventParser.isPoolInitTransaction(logs);
    expect(result).toBe(true);
  });

  test("should detect Pump.fun create pattern", () => {
    const logs = [
      "Program log: Instruction: create",
      "Program log: Bonding curve created",
    ];

    const result = PoolEventParser.isPoolInitTransaction(logs);
    expect(result).toBe(true);
  });

  test("should reject non-pool-init logs", () => {
    const logs = [
      "Program log: Instruction: swap",
      "Program log: Swap executed successfully",
    ];

    const result = PoolEventParser.isPoolInitTransaction(logs);
    expect(result).toBe(false);
  });

  test("should reject empty logs", () => {
    const logs: string[] = [];

    const result = PoolEventParser.isPoolInitTransaction(logs);
    expect(result).toBe(false);
  });
});

// ============================================================================
// Test: extractInstructionName
// ============================================================================

describe("PoolEventParser.extractInstructionName", () => {
  test("should extract InitializePool", () => {
    const log = "Program log: Instruction: InitializePool";
    const result = PoolEventParser.extractInstructionName(log);
    expect(result).toBe("InitializePool");
  });

  test("should extract initialize2", () => {
    const log = "Program log: Instruction: initialize2";
    const result = PoolEventParser.extractInstructionName(log);
    expect(result).toBe("initialize2");
  });

  test("should extract CreateBondingCurve", () => {
    const log = "Program log: Instruction: CreateBondingCurve";
    const result = PoolEventParser.extractInstructionName(log);
    expect(result).toBe("CreateBondingCurve");
  });

  test("should return null for logs without instruction", () => {
    const log = "Program log: Pool initialized successfully";
    const result = PoolEventParser.extractInstructionName(log);
    expect(result).toBe(null);
  });

  test("should return null for empty log", () => {
    const log = "";
    const result = PoolEventParser.extractInstructionName(log);
    expect(result).toBe(null);
  });
});

// ============================================================================
// Test: determineBaseAndQuote
// ============================================================================

describe("determineBaseAndQuote", () => {
  const SOL_MINT = "So11111111111111111111111111111111111111112" as TokenMint;
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as TokenMint;
  const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" as TokenMint;

  test("should use SOL as quote when SOL is tokenB", () => {
    const result = determineBaseAndQuote(BONK_MINT, SOL_MINT);
    expect(result.base).toBe(BONK_MINT);
    expect(result.quote).toBe(SOL_MINT);
  });

  test("should use SOL as quote when SOL is tokenA", () => {
    const result = determineBaseAndQuote(SOL_MINT, BONK_MINT);
    expect(result.base).toBe(BONK_MINT);
    expect(result.quote).toBe(SOL_MINT);
  });

  test("should use USDC as quote when USDC is tokenB (no SOL)", () => {
    const result = determineBaseAndQuote(BONK_MINT, USDC_MINT);
    expect(result.base).toBe(BONK_MINT);
    expect(result.quote).toBe(USDC_MINT);
  });

  test("should use USDC as quote when USDC is tokenA (no SOL)", () => {
    const result = determineBaseAndQuote(USDC_MINT, BONK_MINT);
    expect(result.base).toBe(BONK_MINT);
    expect(result.quote).toBe(USDC_MINT);
  });

  test("should prefer SOL over USDC as quote", () => {
    const result = determineBaseAndQuote(USDC_MINT, SOL_MINT);
    expect(result.base).toBe(USDC_MINT);
    expect(result.quote).toBe(SOL_MINT);
  });

  test("should use alphabetical order when no SOL or USDC", () => {
    const TOKEN_A = "2222222222222222222222222222222222222222222" as TokenMint;
    const TOKEN_B = "9999999999999999999999999999999999999999999" as TokenMint;

    const result = determineBaseAndQuote(TOKEN_A, TOKEN_B);
    expect(result.base).toBe(TOKEN_A);
    expect(result.quote).toBe(TOKEN_B);
  });

  test("should use alphabetical order (reversed)", () => {
    const TOKEN_A = "9999999999999999999999999999999999999999999" as TokenMint;
    const TOKEN_B = "2222222222222222222222222222222222222222222" as TokenMint;

    const result = determineBaseAndQuote(TOKEN_A, TOKEN_B);
    expect(result.base).toBe(TOKEN_B);
    expect(result.quote).toBe(TOKEN_A);
  });
});

// ============================================================================
// Test: PoolEventParser.parsePoolInit (Raydium V4)
// ============================================================================

describe("PoolEventParser.parsePoolInit - Raydium V4", () => {
  test("should parse valid Raydium V4 pool initialization", async () => {
    const parser = new PoolEventParser(createMockConnection());

    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
    const tokenMintB = "So11111111111111111111111111111111111111112"; // SOL
    const blockTime = Math.floor(Date.now() / 1000);

    // Mock getTransaction response
    const mockTx = createMockRaydiumV4Transaction(
      poolAddress,
      tokenMintA,
      tokenMintB,
      blockTime
    );

    // Mock Connection.getTransaction
    const originalGetTransaction = parser["connection"].getTransaction;
    // @ts-expect-error - Mock type doesn't match exactly but works at runtime
    parser["connection"].getTransaction = mock(async () => mockTx);

    const signature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

    const result = await parser.parsePoolInit(signature, "raydium_v4");

    // Restore original
    parser["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.poolAddress as string).toBe(poolAddress);
      expect(result.value.tokenMintA as string).toBe(tokenMintA);
      expect(result.value.tokenMintB as string).toBe(tokenMintB);
      expect(result.value.source).toBe("raydium_v4");
      expect(result.value.blockTime).toBe(blockTime);
    }
  });

  test("should fail when transaction not found", async () => {
    const parser = new PoolEventParser(createMockConnection());

    // Mock getTransaction to return null
    const originalGetTransaction = parser["connection"].getTransaction;
    // @ts-ignore - Mock type doesn't match exactly but works at runtime
    parser["connection"].getTransaction = mock(async () => null);

    // Use valid base58 signature (87-88 chars)
    const signature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

    const result = await parser.parsePoolInit(signature, "raydium_v4");

    // Restore original
    parser["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Transaction not found");
    }
  });

  test("should fail when insufficient accounts", async () => {
    const parser = new PoolEventParser(createMockConnection());

    // Create transaction with insufficient accounts
    const mockTx = createMockRaydiumV4Transaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );

    // Truncate accounts to only 5 (need >= 10)
    mockTx.transaction.message.staticAccountKeys = mockTx.transaction.message.staticAccountKeys.slice(0, 5);

    // Mock getTransaction
    const originalGetTransaction = parser["connection"].getTransaction;
    // @ts-expect-error - Mock type doesn't match exactly but works at runtime
    parser["connection"].getTransaction = mock(async () => mockTx);

    // Use valid base58 signature
    const signature = "2nBhEBYYvfaAe16UMNqRHre4YNSskvuYgx3M6E4JP1oDYvZEJHvoPzyUidNgNX5r9sTyN1J9UxtbCXy2rqYcuyuv";

    const result = await parser.parsePoolInit(signature, "raydium_v4");

    // Restore original
    parser["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Insufficient accounts");
    }
  });
});

// ============================================================================
// Test: PoolEventParser.parsePoolInit (Other DEXs)
// ============================================================================

describe("PoolEventParser.parsePoolInit - Other DEXs", () => {
  // Valid signature for all tests
  const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

  test("should fail for Raydium CLMM (not implemented)", async () => {
    const parser = new PoolEventParser(createMockConnection());

    // Mock getTransaction to return a valid transaction
    const mockTx = createMockRaydiumV4Transaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );
    const originalGetTransaction = parser["connection"].getTransaction;
    // @ts-expect-error - Mock type doesn't match exactly but works at runtime
    parser["connection"].getTransaction = mock(async () => mockTx);

    const result = await parser.parsePoolInit(validSignature, "raydium_clmm");

    parser["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not implemented");
    }
  });

  test("should fail for Orca Whirlpool (not implemented)", async () => {
    const parser = new PoolEventParser(createMockConnection());

    const mockTx = createMockRaydiumV4Transaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );
    const originalGetTransaction = parser["connection"].getTransaction;
    // @ts-expect-error - Mock type doesn't match exactly but works at runtime
    parser["connection"].getTransaction = mock(async () => mockTx);

    const result = await parser.parsePoolInit(validSignature, "orca_whirlpool");

    parser["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not implemented");
    }
  });

  test("should fail for Meteora (not implemented)", async () => {
    const parser = new PoolEventParser(createMockConnection());

    const mockTx = createMockRaydiumV4Transaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );
    const originalGetTransaction = parser["connection"].getTransaction;
    // @ts-expect-error - Mock type doesn't match exactly but works at runtime
    parser["connection"].getTransaction = mock(async () => mockTx);

    const result = await parser.parsePoolInit(validSignature, "meteora");

    parser["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not implemented");
    }
  });

  test("should fail for Pump.fun (not implemented)", async () => {
    const parser = new PoolEventParser(createMockConnection());

    const mockTx = createMockRaydiumV4Transaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );
    const originalGetTransaction = parser["connection"].getTransaction;
    // @ts-expect-error - Mock type doesn't match exactly but works at runtime
    parser["connection"].getTransaction = mock(async () => mockTx);

    const result = await parser.parsePoolInit(validSignature, "pump_fun");

    parser["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not implemented");
    }
  });
});
