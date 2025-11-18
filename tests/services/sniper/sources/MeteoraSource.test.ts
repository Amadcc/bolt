/**
 * Unit tests for Meteora DLMM Source (with Anti-Sniper detection)
 *
 * Comprehensive test coverage for Meteora pool detection and parsing.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { MeteoraSource } from "../../../../src/services/sniper/sources/MeteoraSource.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM } from "../../../../src/config/programs.js";

// ============================================================================
// Test Setup
// ============================================================================

const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";
const validSignature = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia";

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

/**
 * Create mock Meteora DLMM transaction response
 */
function createMockMeteoraTransaction(
  poolAddress: string,
  tokenMintX: string,
  tokenMintY: string,
  blockTime: number | null = Math.floor(Date.now() / 1000)
) {
  const accountKeys = [
    new PublicKey(poolAddress), // 0: lb_pair (pool)
    new PublicKey("11111111111111111111111111111111"), // 1: bin_array_bitmap_extension
    new PublicKey(tokenMintX), // 2: token_mint_x
    new PublicKey(tokenMintY), // 3: token_mint_y
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // 4: Token program
  ];

  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      logMessages: [
        "Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]",
        "Program log: Instruction: InitializeLbPair",
        "Program log: DLMM pool created successfully",
        "Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo consumed 50000 compute units",
        "Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo success",
      ],
      postBalances: [],
      postTokenBalances: [],
      preBalances: [],
      preTokenBalances: [],
      rewards: [],
      status: { Ok: null },
    },
    slot: 456789012,
    transaction: {
      message: {
        staticAccountKeys: accountKeys,
        recentBlockhash: "44444444444444444444444444444444",
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

describe("MeteoraSource - Basic Properties", () => {
  test("should return correct programId", () => {
    const source = new MeteoraSource(createMockConnection());
    expect(source.programId).toBe(METEORA_DLMM_PROGRAM);
  });

  test("should return correct sourceName", () => {
    const source = new MeteoraSource(createMockConnection());
    expect(source.sourceName).toBe("Meteora DLMM");
  });

  test("should return correct sourceType", () => {
    const source = new MeteoraSource(createMockConnection());
    expect(source.sourceType).toBe("meteora");
  });
});

// ============================================================================
// Test: isPoolInitLog
// ============================================================================

describe("MeteoraSource - isPoolInitLog", () => {
  let source: MeteoraSource;

  beforeEach(() => {
    source = new MeteoraSource(createMockConnection());
  });

  test("should detect 'InitializeLbPair' pattern", () => {
    expect(source.isPoolInitLog("Program log: Instruction: InitializeLbPair")).toBe(true);
  });

  test("should detect 'initialize_lb_pair' pattern", () => {
    expect(source.isPoolInitLog("Program log: initialize_lb_pair")).toBe(true);
  });

  test("should detect 'InitializeCustomizablePermissionlessLbPair' pattern", () => {
    expect(source.isPoolInitLog("Program log: InitializeCustomizablePermissionlessLbPair")).toBe(true);
  });

  test("should detect pattern in middle of log", () => {
    const log = "Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo log: InitializeLbPair executed";
    expect(source.isPoolInitLog(log)).toBe(true);
  });

  test("should reject non-init logs", () => {
    expect(source.isPoolInitLog("Program log: swap")).toBe(false);
  });

  test("should reject swap logs", () => {
    expect(source.isPoolInitLog("Program log: Swap")).toBe(false);
  });

  test("should reject empty log", () => {
    expect(source.isPoolInitLog("")).toBe(false);
  });
});

// ============================================================================
// Test: parsePoolInit - Success Cases
// ============================================================================

describe("MeteoraSource - parsePoolInit Success", () => {
  let source: MeteoraSource;

  beforeEach(() => {
    source = new MeteoraSource(createMockConnection());
  });

  test("should parse valid pool with anti-sniper config", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintX = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
    const tokenMintY = "So11111111111111111111111111111111111111112"; // SOL
    const blockTime = Math.floor(Date.now() / 1000);
    const slot = 456789012;

    const mockTx = createMockMeteoraTransaction(poolAddress, tokenMintX, tokenMintY, blockTime);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      const detection = result.value;
      expect(detection.poolAddress).toBe(poolAddress);
      expect(detection.tokenMintA).toBe(tokenMintX);
      expect(detection.tokenMintB).toBe(tokenMintY);
      expect(detection.source).toBe("meteora");
      expect(detection.signature).toBe(validSignature);
      expect(detection.slot).toBe(slot);
      expect(detection.blockTime).toBe(blockTime);
      expect(detection.meteoraAntiSniper).toBeDefined();
      expect(detection.meteoraAntiSniper?.hasFeeScheduler).toBe(true);
      expect(detection.meteoraAntiSniper?.hasRateLimiter).toBe(true);
    }
  });

  test("should handle null blockTime correctly", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintX = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintY = "So11111111111111111111111111111111111111112";

    const mockTx = createMockMeteoraTransaction(
      poolAddress,
      tokenMintX,
      tokenMintY,
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
    const poolAddress = "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX";
    const tokenMintX = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const tokenMintY = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // USDT

    const mockTx = createMockMeteoraTransaction(
      poolAddress,
      tokenMintX,
      tokenMintY
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(tokenMintX);
      expect(result.value.tokenMintB).toBe(tokenMintY);
    }
  });
});

// ============================================================================
// Test: parsePoolInit - Error Cases
// ============================================================================

describe("MeteoraSource - parsePoolInit Errors", () => {
  let source: MeteoraSource;

  beforeEach(() => {
    source = new MeteoraSource(createMockConnection());
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
      slot: 456789012,
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
    const mockTx = createMockMeteoraTransaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );

    // Truncate to only 2 accounts (need >= 4)
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
      expect(result.error).toContain("need >= 4");
    }
  });

  test("should fail with exactly 3 accounts (need 4)", async () => {
    const mockTx = createMockMeteoraTransaction(
      "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "So11111111111111111111111111111111111111112"
    );

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
      expect(result.error).toContain("Failed to parse Meteora DLMM pool init");
      expect(result.error).toContain("Network timeout");
    }
  });
});

// ============================================================================
// Test: Account Index Correctness
// ============================================================================

describe("MeteoraSource - Account Index Validation", () => {
  let source: MeteoraSource;

  beforeEach(() => {
    source = new MeteoraSource(createMockConnection());
  });

  test("should extract pool address from index 0", async () => {
    const poolAddress = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT"; // Valid pool
    const tokenMintX = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintY = "So11111111111111111111111111111111111111112";

    const mockTx = createMockMeteoraTransaction(
      poolAddress,
      tokenMintX,
      tokenMintY
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.poolAddress).toBe(poolAddress);
      expect(mockTx.transaction.message.staticAccountKeys[0].toString()).toBe(
        poolAddress
      );
    }
  });

  test("should extract tokenMintX from index 2", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintX = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"; // mSOL
    const tokenMintY = "So11111111111111111111111111111111111111112";

    const mockTx = createMockMeteoraTransaction(
      poolAddress,
      tokenMintX,
      tokenMintY
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintA).toBe(tokenMintX);
      expect(mockTx.transaction.message.staticAccountKeys[2].toString()).toBe(
        tokenMintX
      );
    }
  });

  test("should extract tokenMintY from index 3", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintX = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

    const mockTx = createMockMeteoraTransaction(
      poolAddress,
      tokenMintX,
      tokenMintY
    );

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tokenMintB).toBe(tokenMintY);
      expect(mockTx.transaction.message.staticAccountKeys[3].toString()).toBe(
        tokenMintY
      );
    }
  });
});

// ============================================================================
// Test: Anti-Sniper Configuration
// ============================================================================

describe("MeteoraSource - Anti-Sniper Detection", () => {
  let source: MeteoraSource;

  beforeEach(() => {
    source = new MeteoraSource(createMockConnection());
  });

  test("should include anti-sniper config in parsed result", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintX = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintY = "So11111111111111111111111111111111111111112";

    const mockTx = createMockMeteoraTransaction(poolAddress, tokenMintX, tokenMintY);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.meteoraAntiSniper).toBeDefined();
    }
  });

  test("should detect fee scheduler in anti-sniper config", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintX = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintY = "So11111111111111111111111111111111111111112";

    const mockTx = createMockMeteoraTransaction(poolAddress, tokenMintX, tokenMintY);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.meteoraAntiSniper?.hasFeeScheduler).toBe(true);
      expect(result.value.meteoraAntiSniper?.feeScheduler).toBeDefined();
      expect(result.value.meteoraAntiSniper?.feeScheduler?.cliffFee).toBe(9900); // 99%
    }
  });

  test("should detect rate limiter in anti-sniper config", async () => {
    const poolAddress = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
    const tokenMintX = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const tokenMintY = "So11111111111111111111111111111111111111112";

    const mockTx = createMockMeteoraTransaction(poolAddress, tokenMintX, tokenMintY);

    const originalGetTransaction = source["connection"].getTransaction;
    // @ts-expect-error - Mock type mismatch
    source["connection"].getTransaction = vi.fn(async () => mockTx);

    const result = await source.parsePoolInit(validSignature);

    source["connection"].getTransaction = originalGetTransaction;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.meteoraAntiSniper?.hasRateLimiter).toBe(true);
      expect(result.value.meteoraAntiSniper?.rateLimiter).toBeDefined();
      expect(result.value.meteoraAntiSniper?.rateLimiter?.baseFeePerSol).toBe(100); // 1%
    }
  });
});
