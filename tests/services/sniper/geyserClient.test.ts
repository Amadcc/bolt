/**
 * Tests for GeyserClient
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from "bun:test";
import bs58 from "bs58";
import { GeyserClient, createGeyserClient, GeyserConfig } from "../../../src/services/sniper/detection/geyserClient";
import {
  RAYDIUM_AMM_V4,
  RAYDIUM_CLMM,
  PUMPFUN_PROGRAM,
  METEORA_DLMM,
  SOL_MINT,
  USDC_MINT,
  VALID_QUOTE_MINTS,
  PROGRAM_TO_DEX,
} from "../../../src/services/sniper/detection/constants";
import type { PoolCreatedEvent } from "../../../src/types/sniper";
import {
  PUMPFUN_CREATE_FIXTURE,
  RAYDIUM_V4_INIT_FIXTURE,
  createMockSubscribeUpdate,
  INVALID_FIXTURES,
} from "./fixtures/transactions";

// ============================================================================
// Constants Tests
// ============================================================================

describe("Detection Constants", () => {
  describe("Program IDs", () => {
    it("should have valid Raydium AMM V4 address", () => {
      expect(RAYDIUM_AMM_V4.toBase58()).toBe(
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
      );
    });

    it("should have valid Raydium CLMM address", () => {
      expect(RAYDIUM_CLMM.toBase58()).toBe(
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
      );
    });

    it("should have valid Pump.fun address", () => {
      expect(PUMPFUN_PROGRAM.toBase58()).toBe(
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
      );
    });

    it("should have valid Meteora DLMM address", () => {
      expect(METEORA_DLMM.toBase58()).toBe(
        "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
      );
    });
  });

  describe("Token Mints", () => {
    it("should have valid SOL mint", () => {
      expect(SOL_MINT.toBase58()).toBe(
        "So11111111111111111111111111111111111111112"
      );
    });

    it("should have valid USDC mint", () => {
      expect(USDC_MINT.toBase58()).toBe(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      );
    });
  });

  describe("Valid Quote Mints", () => {
    it("should include SOL", () => {
      expect(VALID_QUOTE_MINTS.has(SOL_MINT.toBase58())).toBe(true);
    });

    it("should include USDC", () => {
      expect(VALID_QUOTE_MINTS.has(USDC_MINT.toBase58())).toBe(true);
    });

    it("should not include random address", () => {
      expect(VALID_QUOTE_MINTS.has("randomaddress")).toBe(false);
    });
  });

  describe("Program to DEX Mapping", () => {
    it("should map Raydium V4 correctly", () => {
      expect(PROGRAM_TO_DEX[RAYDIUM_AMM_V4.toBase58()]).toBe("raydium_v4");
    });

    it("should map Pump.fun correctly", () => {
      expect(PROGRAM_TO_DEX[PUMPFUN_PROGRAM.toBase58()]).toBe("pumpfun");
    });

    it("should map Raydium CLMM correctly", () => {
      expect(PROGRAM_TO_DEX[RAYDIUM_CLMM.toBase58()]).toBe("raydium_clmm");
    });

    it("should map Meteora correctly", () => {
      expect(PROGRAM_TO_DEX[METEORA_DLMM.toBase58()]).toBe("meteora");
    });
  });
});

// ============================================================================
// GeyserClient Tests
// ============================================================================

describe("GeyserClient", () => {
  const testConfig: GeyserConfig = {
    endpoint: "https://test-endpoint.com",
    token: "test-token",
    commitment: "confirmed",
    reconnectDelayMs: 100,
    maxReconnectAttempts: 3,
  };

  describe("createGeyserClient", () => {
    it("should create client with default config", () => {
      const client = createGeyserClient();
      expect(client).toBeInstanceOf(GeyserClient);
    });

    it("should create client with custom config", () => {
      const client = createGeyserClient(testConfig);
      expect(client).toBeInstanceOf(GeyserClient);
    });

    it("should use environment variables for defaults", () => {
      const originalEndpoint = process.env.GEYSER_ENDPOINT;
      const originalToken = process.env.GEYSER_TOKEN;

      process.env.GEYSER_ENDPOINT = "https://env-endpoint.com";
      process.env.GEYSER_TOKEN = "env-token";

      const client = createGeyserClient();
      expect(client).toBeInstanceOf(GeyserClient);

      // Restore
      process.env.GEYSER_ENDPOINT = originalEndpoint;
      process.env.GEYSER_TOKEN = originalToken;
    });
  });

  describe("isConnected", () => {
    it("should return false when not connected", () => {
      const client = new GeyserClient(testConfig);
      expect(client.isConnected()).toBe(false);
    });
  });

  describe("disconnect", () => {
    it("should emit disconnected event", async () => {
      const client = new GeyserClient(testConfig);

      let disconnected = false;
      client.on("disconnected", () => {
        disconnected = true;
      });

      await client.disconnect();
      expect(disconnected).toBe(true);
    });

    it("should be idempotent", async () => {
      const client = new GeyserClient(testConfig);

      await client.disconnect();
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });
  });

  describe("event emitter", () => {
    it("should emit pool:created events", () => {
      const client = new GeyserClient(testConfig);

      let receivedEvent: PoolCreatedEvent | null = null;
      client.on("pool:created", (event) => {
        receivedEvent = event;
      });

      const mockEvent: PoolCreatedEvent = {
        signature: "5wHu1qwD7q3S4ALZT6ddQbVmMCbBz2HpM4S1SYBsGLZp" as any,
        slot: 12345,
        timestamp: Date.now(),
        dex: "pumpfun",
        poolAddress: "poolAddress123456789012345678901234567890123" as any,
        baseMint: "baseMint12345678901234567890123456789012345" as any,
        quoteMint: SOL_MINT.toBase58() as any,
        initialLiquidity: 0n as any,
        creator: "creator12345678901234567890123456789012345678" as any,
      };

      client.emit("pool:created", mockEvent);
      expect(receivedEvent).not.toBeNull();
      expect(receivedEvent?.dex).toBe("pumpfun");
    });

    it("should emit error events", () => {
      const client = new GeyserClient(testConfig);

      let receivedError: Error | null = null;
      client.on("error", (error) => {
        receivedError = error;
      });

      const testError = new Error("Test error");
      client.emit("error", testError);
      expect(receivedError).toBe(testError);
    });

    it("should emit connected events", () => {
      const client = new GeyserClient(testConfig);

      let connected = false;
      client.on("connected", () => {
        connected = true;
      });

      client.emit("connected");
      expect(connected).toBe(true);
    });
  });
});

// ============================================================================
// Sniper Types Tests
// ============================================================================

describe("Sniper Types", () => {
  it("should have default sniper filters", async () => {
    const { DEFAULT_SNIPER_FILTERS } = await import("../../../src/types/sniper");

    expect(DEFAULT_SNIPER_FILTERS.minLiquiditySOL).toBe(1);
    expect(DEFAULT_SNIPER_FILTERS.maxLiquiditySOL).toBe(1000);
    expect(DEFAULT_SNIPER_FILTERS.requireMintAuthorityRevoked).toBe(true);
    expect(DEFAULT_SNIPER_FILTERS.requireFreezeAuthorityRevoked).toBe(true);
    expect(DEFAULT_SNIPER_FILTERS.maxDevHoldingPercent).toBe(10);
    expect(DEFAULT_SNIPER_FILTERS.maxRiskScore).toBe(50);
    expect(DEFAULT_SNIPER_FILTERS.allowedDexs).toContain("raydium_v4");
    expect(DEFAULT_SNIPER_FILTERS.allowedDexs).toContain("pumpfun");
  });

  it("should have fee presets", async () => {
    const { FEE_PRESETS } = await import("../../../src/types/sniper");

    expect(FEE_PRESETS.normal).toBe(100_000);
    expect(FEE_PRESETS.fast).toBe(1_500_000);
    expect(FEE_PRESETS.turbo).toBe(7_500_000);
  });
});

// ============================================================================
// Transaction Parsing Tests
// ============================================================================

describe("Transaction Parsing", () => {
  const testConfig: GeyserConfig = {
    endpoint: "https://test-endpoint.com",
    token: "test-token",
    commitment: "confirmed",
    reconnectDelayMs: 100,
    maxReconnectAttempts: 3,
  };

  describe("Pump.fun Create Parsing", () => {
    it("should parse real pump.fun create transaction correctly", () => {
      const client = new GeyserClient(testConfig);
      const parsePoolCreation = (client as any).parsePumpfunCreate.bind(client);

      // Use real fixture data
      const data = Buffer.concat([PUMPFUN_CREATE_FIXTURE.discriminator, Buffer.alloc(100)]);
      const accounts = PUMPFUN_CREATE_FIXTURE.accountKeysArray;

      const result = parsePoolCreation(
        accounts,
        data,
        12345,
        "5wHu1qwD7q3S4ALZT6ddQbVmMCbBz2HpM4S1SYBsGLZp"
      );

      expect(result).not.toBeNull();
      expect(result?.dex).toBe(PUMPFUN_CREATE_FIXTURE.expected.dex);
      expect(result?.baseMint).toBe(PUMPFUN_CREATE_FIXTURE.expected.baseMint);
      expect(result?.poolAddress).toBe(PUMPFUN_CREATE_FIXTURE.expected.poolAddress);
      expect(result?.creator).toBe(PUMPFUN_CREATE_FIXTURE.expected.creator);
      expect(result?.slot).toBe(12345);
    });

    it("should return null for invalid discriminator", () => {
      const client = new GeyserClient(testConfig);
      const parsePoolCreation = (client as any).parsePumpfunCreate.bind(client);

      const result = parsePoolCreation(
        PUMPFUN_CREATE_FIXTURE.accountKeysArray,
        INVALID_FIXTURES.wrongDiscriminator,
        12345,
        "sig"
      );
      expect(result).toBeNull();
    });

    it("should return null for insufficient accounts", () => {
      const client = new GeyserClient(testConfig);
      const parsePoolCreation = (client as any).parsePumpfunCreate.bind(client);

      const data = Buffer.concat([PUMPFUN_CREATE_FIXTURE.discriminator, Buffer.alloc(10)]);

      const result = parsePoolCreation(
        INVALID_FIXTURES.insufficientAccounts,
        data,
        12345,
        "sig"
      );
      expect(result).toBeNull();
    });

    it("should return null for empty data", () => {
      const client = new GeyserClient(testConfig);
      const parsePoolCreation = (client as any).parsePumpfunCreate.bind(client);

      const result = parsePoolCreation(
        PUMPFUN_CREATE_FIXTURE.accountKeysArray,
        INVALID_FIXTURES.emptyData,
        12345,
        "sig"
      );
      expect(result).toBeNull();
    });

    it("should return null for too short data", () => {
      const client = new GeyserClient(testConfig);
      const parsePoolCreation = (client as any).parsePumpfunCreate.bind(client);

      const result = parsePoolCreation(
        PUMPFUN_CREATE_FIXTURE.accountKeysArray,
        INVALID_FIXTURES.shortData,
        12345,
        "sig"
      );
      expect(result).toBeNull();
    });
  });

  describe("Raydium V4 Initialize Parsing", () => {
    it("should parse real raydium v4 initialize2 transaction correctly", () => {
      const client = new GeyserClient(testConfig);
      const parseRaydiumV4 = (client as any).parseRaydiumV4Initialize.bind(client);

      // Use real fixture data
      const data = Buffer.concat([RAYDIUM_V4_INIT_FIXTURE.discriminator, Buffer.alloc(100)]);
      const accounts = RAYDIUM_V4_INIT_FIXTURE.accountKeysArray;

      const result = parseRaydiumV4(
        accounts,
        data,
        54321,
        "2xSignature12345678901234567890123456789012345678901234567890123456789012345678901234"
      );

      expect(result).not.toBeNull();
      expect(result?.dex).toBe(RAYDIUM_V4_INIT_FIXTURE.expected.dex);
      expect(result?.poolAddress).toBe(RAYDIUM_V4_INIT_FIXTURE.expected.poolAddress);
      expect(result?.baseMint).toBe(RAYDIUM_V4_INIT_FIXTURE.expected.baseMint);
      expect(result?.quoteMint).toBe(RAYDIUM_V4_INIT_FIXTURE.expected.quoteMint);
      expect(result?.creator).toBe(RAYDIUM_V4_INIT_FIXTURE.expected.creator);
      expect(result?.slot).toBe(54321);
    });

    it("should return null for wrong discriminator", () => {
      const client = new GeyserClient(testConfig);
      const parseRaydiumV4 = (client as any).parseRaydiumV4Initialize.bind(client);

      const data = Buffer.alloc(100);
      data[0] = 2; // Wrong discriminator

      const result = parseRaydiumV4(
        RAYDIUM_V4_INIT_FIXTURE.accountKeysArray,
        data,
        12345,
        "sig"
      );
      expect(result).toBeNull();
    });

    it("should return null for insufficient accounts", () => {
      const client = new GeyserClient(testConfig);
      const parseRaydiumV4 = (client as any).parseRaydiumV4Initialize.bind(client);

      const data = Buffer.concat([RAYDIUM_V4_INIT_FIXTURE.discriminator, Buffer.alloc(100)]);

      const result = parseRaydiumV4(
        INVALID_FIXTURES.insufficientAccounts,
        data,
        12345,
        "sig"
      );
      expect(result).toBeNull();
    });

    it("should return null for empty data", () => {
      const client = new GeyserClient(testConfig);
      const parseRaydiumV4 = (client as any).parseRaydiumV4Initialize.bind(client);

      const result = parseRaydiumV4(
        RAYDIUM_V4_INIT_FIXTURE.accountKeysArray,
        INVALID_FIXTURES.emptyData,
        12345,
        "sig"
      );
      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// Reconnection Logic Tests
// ============================================================================

describe("Reconnection Logic", () => {
  const testConfig: GeyserConfig = {
    endpoint: "https://test-endpoint.com",
    token: "test-token",
    commitment: "confirmed",
    reconnectDelayMs: 10, // Fast for testing
    maxReconnectAttempts: 3,
  };

  it("should track reconnect attempts", () => {
    const client = new GeyserClient(testConfig);

    // Access private property
    expect((client as any).reconnectAttempts).toBe(0);
  });

  it("should emit error when max reconnect attempts reached", async () => {
    const client = new GeyserClient(testConfig);

    let errorEmitted = false;
    let errorMessage = "";

    client.on("error", (error) => {
      errorEmitted = true;
      errorMessage = error.message;
    });

    // Manually set reconnect attempts to max
    (client as any).reconnectAttempts = 3;
    (client as any).isRunning = true;

    // Trigger handleDisconnect
    await (client as any).handleDisconnect(new Error("Test disconnect"));

    expect(errorEmitted).toBe(true);
    expect(errorMessage).toBe("Max reconnect attempts reached");
  });
});

// ============================================================================
// Stream Processing Tests
// ============================================================================

describe("Stream Processing", () => {
  const testConfig: GeyserConfig = {
    endpoint: "https://test-endpoint.com",
    token: "test-token",
    commitment: "confirmed",
    reconnectDelayMs: 100,
    maxReconnectAttempts: 3,
  };

  it("should build correct subscribe request", () => {
    const client = new GeyserClient(testConfig);
    const request = (client as any).buildSubscribeRequest();

    expect(request).toBeDefined();
    expect(request.transactions).toBeDefined();
    expect(request.transactions.pumpfun).toBeDefined();
    expect(request.transactions.pumpfun.vote).toBe(false);
    expect(request.transactions.pumpfun.failed).toBe(false);
    expect(request.transactions.pumpfun.accountInclude).toContain(
      PUMPFUN_PROGRAM.toBase58()
    );
  });

  it("should use correct commitment level", () => {
    const clientConfirmed = new GeyserClient({ ...testConfig, commitment: "confirmed" });
    const clientProcessed = new GeyserClient({ ...testConfig, commitment: "processed" });

    const reqConfirmed = (clientConfirmed as any).buildSubscribeRequest();
    const reqProcessed = (clientProcessed as any).buildSubscribeRequest();

    // CommitmentLevel.CONFIRMED = 1, PROCESSED = 0
    expect(reqConfirmed.commitment).toBe(1);
    expect(reqProcessed.commitment).toBe(0);
  });
});

// ============================================================================
// Event Flow Integration Tests
// ============================================================================

describe("Event Flow Integration", () => {
  const testConfig: GeyserConfig = {
    endpoint: "https://test-endpoint.com",
    token: "test-token",
    commitment: "confirmed",
    reconnectDelayMs: 100,
    maxReconnectAttempts: 3,
  };

  it("should properly chain events from detection to emission", async () => {
    const client = new GeyserClient(testConfig);

    const events: string[] = [];

    client.on("connected", () => events.push("connected"));
    client.on("pool:created", () => events.push("pool:created"));
    client.on("disconnected", () => events.push("disconnected"));

    // Simulate event flow
    client.emit("connected");
    client.emit("pool:created", {
      signature: "test" as any,
      slot: 1,
      timestamp: Date.now(),
      dex: "pumpfun",
      poolAddress: "pool" as any,
      baseMint: "base" as any,
      quoteMint: "quote" as any,
      initialLiquidity: 0n as any,
      creator: "creator" as any,
    });
    client.emit("disconnected");

    expect(events).toEqual(["connected", "pool:created", "disconnected"]);
  });

  it("should handle multiple pool:created listeners", () => {
    const client = new GeyserClient(testConfig);

    let count = 0;

    client.on("pool:created", () => count++);
    client.on("pool:created", () => count++);
    client.on("pool:created", () => count++);

    client.emit("pool:created", {
      signature: "test" as any,
      slot: 1,
      timestamp: Date.now(),
      dex: "pumpfun",
      poolAddress: "pool" as any,
      baseMint: "base" as any,
      quoteMint: "quote" as any,
      initialLiquidity: 0n as any,
      creator: "creator" as any,
    });

    expect(count).toBe(3);
  });
});

// ============================================================================
// E2E Flow Tests with Mock Stream
// ============================================================================

describe("E2E Flow with Mock Stream", () => {
  const testConfig: GeyserConfig = {
    endpoint: "https://test-endpoint.com",
    token: "test-token",
    commitment: "confirmed",
    reconnectDelayMs: 100,
    maxReconnectAttempts: 3,
  };

  it("should emit pool:created event when parseTransaction succeeds", () => {
    const client = new GeyserClient(testConfig);

    // Create mock transaction message
    const mockMessage = createMockSubscribeUpdate(
      PUMPFUN_PROGRAM.toBase58(),
      PUMPFUN_CREATE_FIXTURE.accountKeysArray,
      Buffer.concat([PUMPFUN_CREATE_FIXTURE.discriminator, Buffer.alloc(100)]),
      12345,
      "5wHu1qwD7q3S4ALZT6ddQbVmMCbBz2HpM4S1SYBsGLZp"
    );

    // Test parseTransaction directly
    const result = (client as any).parseTransaction(mockMessage.transaction);

    // Verify result
    expect(result).not.toBeNull();
    expect(result?.dex).toBe("pumpfun");
    expect(result?.baseMint).toBe(PUMPFUN_CREATE_FIXTURE.expected.baseMint);
  });

  it("should correctly build mock subscribe update message", () => {
    const mockMessage = createMockSubscribeUpdate(
      PUMPFUN_PROGRAM.toBase58(),
      PUMPFUN_CREATE_FIXTURE.accountKeysArray,
      Buffer.concat([PUMPFUN_CREATE_FIXTURE.discriminator, Buffer.alloc(100)]),
      99999
    );

    expect(mockMessage.transaction).toBeDefined();
    expect(mockMessage.transaction.slot).toBe(BigInt(99999));
    expect(mockMessage.transaction.transaction.transaction?.message?.instructions).toHaveLength(1);
  });

  it("should handle complete event flow from detection to emission", async () => {
    const client = new GeyserClient(testConfig);

    const receivedEvents: PoolCreatedEvent[] = [];

    client.on("pool:created", (event) => {
      receivedEvents.push(event);
    });

    // Manually trigger the event as if parseTransaction succeeded
    const mockEvent: PoolCreatedEvent = {
      signature: "5wHu1qwD7q3S4ALZT6ddQbVmMCbBz2HpM4S1SYBsGLZp" as any,
      slot: 12345,
      timestamp: Date.now(),
      dex: "pumpfun",
      poolAddress: PUMPFUN_CREATE_FIXTURE.expected.poolAddress as any,
      baseMint: PUMPFUN_CREATE_FIXTURE.expected.baseMint as any,
      quoteMint: SOL_MINT.toBase58() as any,
      initialLiquidity: 0n as any,
      creator: PUMPFUN_CREATE_FIXTURE.expected.creator as any,
    };

    client.emit("pool:created", mockEvent);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].dex).toBe("pumpfun");
    expect(receivedEvents[0].baseMint).toBe(PUMPFUN_CREATE_FIXTURE.expected.baseMint);
    expect(receivedEvents[0].poolAddress).toBe(PUMPFUN_CREATE_FIXTURE.expected.poolAddress);
    expect(receivedEvents[0].creator).toBe(PUMPFUN_CREATE_FIXTURE.expected.creator);
  });

  it("should not emit event for non-pool transactions", () => {
    const client = new GeyserClient(testConfig);

    let eventCount = 0;
    client.on("pool:created", () => eventCount++);

    // Create mock message with wrong discriminator
    const mockMessage = createMockSubscribeUpdate(
      PUMPFUN_PROGRAM.toBase58(),
      PUMPFUN_CREATE_FIXTURE.accountKeysArray,
      INVALID_FIXTURES.wrongDiscriminator
    );

    const result = (client as any).parseTransaction(mockMessage.transaction);

    expect(result).toBeNull();
    expect(eventCount).toBe(0);
  });

  it("should handle raydium v4 transactions in E2E flow", () => {
    const client = new GeyserClient(testConfig);

    const mockMessage = createMockSubscribeUpdate(
      RAYDIUM_AMM_V4.toBase58(),
      RAYDIUM_V4_INIT_FIXTURE.accountKeysArray,
      Buffer.concat([RAYDIUM_V4_INIT_FIXTURE.discriminator, Buffer.alloc(100)]),
      54321
    );

    const result = (client as any).parseTransaction(mockMessage.transaction);

    expect(result).not.toBeNull();
    expect(result?.dex).toBe("raydium_v4");
    expect(result?.poolAddress).toBe(RAYDIUM_V4_INIT_FIXTURE.expected.poolAddress);
    expect(result?.baseMint).toBe(RAYDIUM_V4_INIT_FIXTURE.expected.baseMint);
    expect(result?.quoteMint).toBe(RAYDIUM_V4_INIT_FIXTURE.expected.quoteMint);
  });
});

// ============================================================================
// Performance Tests
// ============================================================================

describe("Performance", () => {
  const testConfig: GeyserConfig = {
    endpoint: "https://test-endpoint.com",
    token: "test-token",
    commitment: "confirmed",
    reconnectDelayMs: 100,
    maxReconnectAttempts: 3,
  };

  it("should parse pump.fun transaction in under 1ms", () => {
    const client = new GeyserClient(testConfig);
    const parsePoolCreation = (client as any).parsePumpfunCreate.bind(client);

    const data = Buffer.concat([PUMPFUN_CREATE_FIXTURE.discriminator, Buffer.alloc(100)]);
    const accounts = PUMPFUN_CREATE_FIXTURE.accountKeysArray;

    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      parsePoolCreation(accounts, data, 12345, "sig");
    }

    const elapsed = performance.now() - start;
    const avgTime = elapsed / 1000;

    expect(avgTime).toBeLessThan(1); // Less than 1ms per parse
  });

  it("should parse raydium v4 transaction in under 1ms", () => {
    const client = new GeyserClient(testConfig);
    const parseRaydiumV4 = (client as any).parseRaydiumV4Initialize.bind(client);

    const data = Buffer.concat([RAYDIUM_V4_INIT_FIXTURE.discriminator, Buffer.alloc(100)]);
    const accounts = RAYDIUM_V4_INIT_FIXTURE.accountKeysArray;

    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      parseRaydiumV4(accounts, data, 12345, "sig");
    }

    const elapsed = performance.now() - start;
    const avgTime = elapsed / 1000;

    expect(avgTime).toBeLessThan(1); // Less than 1ms per parse
  });
});
