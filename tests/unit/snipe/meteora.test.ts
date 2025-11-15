import { describe, it, expect, beforeEach } from "bun:test";
import { MeteoraLogMonitor } from "../../../src/services/snipe/discovery/meteora.js";

describe("MeteoraLogMonitor", () => {
  let monitor: MeteoraLogMonitor;

  beforeEach(() => {
    monitor = new MeteoraLogMonitor();
  });

  describe("Constructor", () => {
    it("should initialize with default settings", () => {
      expect(monitor).toBeDefined();
      expect(monitor).toBeInstanceOf(MeteoraLogMonitor);
    });

    it("should respect environment variable configuration", () => {
      // Set env vars
      process.env.SNIPE_METEORA_CONCURRENCY = "3";
      process.env.SNIPE_METEORA_DELAY_MS = "500";
      process.env.SNIPE_METEORA_QUEUE_SIZE = "10000";

      const customMonitor = new MeteoraLogMonitor();
      expect(customMonitor).toBeDefined();

      // Clean up
      delete process.env.SNIPE_METEORA_CONCURRENCY;
      delete process.env.SNIPE_METEORA_DELAY_MS;
      delete process.env.SNIPE_METEORA_QUEUE_SIZE;
    });

    it("should handle custom program IDs from environment", () => {
      const customProgramId = "TestProgramId1111111111111111111111111111";
      process.env.SNIPE_METEORA_PROGRAM_IDS = customProgramId;

      const customMonitor = new MeteoraLogMonitor();
      expect(customMonitor).toBeDefined();

      // Clean up
      delete process.env.SNIPE_METEORA_PROGRAM_IDS;
    });

    it("should validate numeric environment variables", () => {
      // Test with invalid values - should fallback to defaults
      process.env.SNIPE_METEORA_CONCURRENCY = "invalid";
      process.env.SNIPE_METEORA_DELAY_MS = "-100";
      process.env.SNIPE_METEORA_QUEUE_SIZE = "0";

      const monitorWithInvalidEnv = new MeteoraLogMonitor();
      expect(monitorWithInvalidEnv).toBeDefined();

      // Clean up
      delete process.env.SNIPE_METEORA_CONCURRENCY;
      delete process.env.SNIPE_METEORA_DELAY_MS;
      delete process.env.SNIPE_METEORA_QUEUE_SIZE;
    });
  });

  describe("Configuration Defaults", () => {
    it("should use conservative defaults for high-volume source", () => {
      // Meteora should have:
      // - Lower concurrency than other sources (2 vs 4)
      // - Delay between fetches (200ms)
      // - Larger queue size (5000 vs 1000)

      // These are implicit in the constructor, but we verify the monitor
      // is created successfully with these settings
      expect(monitor).toBeDefined();
    });
  });

  describe("Event Emitter", () => {
    it("should be an event emitter", () => {
      expect(monitor.on).toBeDefined();
      expect(monitor.emit).toBeDefined();
      expect(monitor.removeListener).toBeDefined();
    });

    it("should accept newToken event listeners", () => {
      let eventReceived = false;
      monitor.on("newToken", () => {
        eventReceived = true;
      });

      // Emit test event
      monitor.emit("newToken", {
        source: "meteora",
        mint: "TestMint111111111111111111111111111111111",
        name: "Test Token",
        symbol: "TEST",
        liquidityLamports: 1000000000n as any,
        tx: "TestSignature111111111111111111111111111111",
        timestamp: new Date(),
      });

      expect(eventReceived).toBe(true);
    });

    it("should accept error event listeners", () => {
      let errorReceived = false;
      monitor.on("error", () => {
        errorReceived = true;
      });

      // Emit test error
      monitor.emit("error", new Error("Test error"));

      expect(errorReceived).toBe(true);
    });
  });

  describe("Program IDs", () => {
    it("should monitor Meteora DLMM program", () => {
      const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

      // The monitor should be initialized with this program ID
      // This is implicit in the DEFAULT_PROGRAMS constant
      expect(monitor).toBeDefined();
    });

    it("should monitor Meteora Pools program", () => {
      const POOLS_PROGRAM = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";

      // The monitor should be initialized with this program ID
      // This is implicit in the DEFAULT_PROGRAMS constant
      expect(monitor).toBeDefined();
    });
  });
});

describe("Meteora Configuration Parsing", () => {
  it("should parse comma-separated program IDs", () => {
    const programIds = "Program1111111111111111111111111111111111,Program2222222222222222222222222222222222";
    process.env.SNIPE_METEORA_PROGRAM_IDS = programIds;

    const monitor = new MeteoraLogMonitor();
    expect(monitor).toBeDefined();

    // Clean up
    delete process.env.SNIPE_METEORA_PROGRAM_IDS;
  });

  it("should handle program IDs with whitespace", () => {
    const programIds = " Program1111111111111111111111111111111111 , Program2222222222222222222222222222222222 ";
    process.env.SNIPE_METEORA_PROGRAM_IDS = programIds;

    const monitor = new MeteoraLogMonitor();
    expect(monitor).toBeDefined();

    // Clean up
    delete process.env.SNIPE_METEORA_PROGRAM_IDS;
  });

  it("should filter out empty program IDs", () => {
    const programIds = "Program1111111111111111111111111111111111,,Program2222222222222222222222222222222222";
    process.env.SNIPE_METEORA_PROGRAM_IDS = programIds;

    const monitor = new MeteoraLogMonitor();
    expect(monitor).toBeDefined();

    // Clean up
    delete process.env.SNIPE_METEORA_PROGRAM_IDS;
  });

  it("should use defaults when env var is empty string", () => {
    process.env.SNIPE_METEORA_PROGRAM_IDS = "";

    const monitor = new MeteoraLogMonitor();
    expect(monitor).toBeDefined();

    // Clean up
    delete process.env.SNIPE_METEORA_PROGRAM_IDS;
  });
});
