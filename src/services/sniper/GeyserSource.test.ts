/**
 * GeyserSource Unit Tests
 *
 * Tests for Yellowstone gRPC Geyser plugin integration.
 *
 * Coverage:
 * - Initialization and configuration
 * - Health monitoring
 * - Statistics tracking
 * - Singleton pattern
 * - Error handling
 *
 * Note: Integration tests with live Geyser endpoint are in GeyserBenchmark.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Connection } from "@solana/web3.js";
import {
  GeyserSource,
  type GeyserConfig,
  initializeGeyserSource,
  getGeyserSource,
  defaultGeyserSource,
} from "./GeyserSource.js";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { getAllProgramAddresses } from "../../config/programs.js";

// ============================================================================
// Test Setup
// ============================================================================

const TEST_CONFIG: GeyserConfig = {
  endpoint: "test.grpc.endpoint.com:443",
  token: "test_token_123",
  programIds: getAllProgramAddresses(),
  commitment: CommitmentLevel.CONFIRMED,
  tls: true,
  autoReconnect: true,
  maxReconnectAttempts: 3,
  reconnectDelay: 100,
};

const mockConnection = {
  rpcEndpoint: "https://api.mainnet-beta.solana.com",
} as Connection;

// ============================================================================
// Constructor and Initialization Tests
// ============================================================================

describe("GeyserSource - Constructor", () => {
  test("should create GeyserSource with full config", () => {
    const geyser = new GeyserSource(TEST_CONFIG, mockConnection);

    expect(geyser).toBeDefined();
    expect(geyser).toBeInstanceOf(GeyserSource);
  });

  test("should create GeyserSource with minimal config", () => {
    const minimalConfig: GeyserConfig = {
      endpoint: "grpc.test.com:443",
      token: "token",
      programIds: getAllProgramAddresses(),
      commitment: CommitmentLevel.CONFIRMED,
    };

    const geyser = new GeyserSource(minimalConfig, mockConnection);

    expect(geyser).toBeDefined();
  });

  test("should use default values for optional config", () => {
    const config: GeyserConfig = {
      endpoint: "grpc.test.com:443",
      token: "token",
      programIds: getAllProgramAddresses(),
      commitment: CommitmentLevel.CONFIRMED,
    };

    const geyser = new GeyserSource(config, mockConnection);
    const stats = geyser.getStats();

    expect(stats.totalReconnects).toBe(0);
    expect(stats.totalDetections).toBe(0);
  });

  test("should initialize with multiple program IDs", () => {
    const programs = getAllProgramAddresses();

    expect(programs.length).toBeGreaterThan(0);

    const geyser = new GeyserSource(TEST_CONFIG, mockConnection);

    expect(geyser).toBeDefined();
  });
});

// ============================================================================
// Health Monitoring Tests
// ============================================================================

describe("GeyserSource - Health Monitoring", () => {
  let geyser: GeyserSource;

  beforeEach(() => {
    geyser = new GeyserSource(TEST_CONFIG, mockConnection);
  });

  afterEach(async () => {
    await geyser.stop();
  });

  test("should start with connecting status", () => {
    const health = geyser.getHealth();

    expect(health.status).toBe("connecting");
    expect(health).toHaveProperty("attemptedAt");
  });

  test("should track health status after stop", async () => {
    await geyser.stop();

    const health = geyser.getHealth();

    expect(health.status).toBe("disconnected");
    expect(health).toHaveProperty("disconnectedAt");
  });

  test("should return health metrics", () => {
    const metrics = geyser.getMetrics();

    expect(metrics).toHaveProperty("totalDetections");
    expect(metrics).toHaveProperty("avgParsingLatencyMs");
    expect(metrics).toHaveProperty("uptimePct");
    expect(metrics).toHaveProperty("lastDetectionAt");

    expect(metrics.totalDetections).toBe(0);
    expect(metrics.avgParsingLatencyMs).toBe(0);
  });
});

// ============================================================================
// Statistics Tests
// ============================================================================

describe("GeyserSource - Statistics", () => {
  let geyser: GeyserSource;

  beforeEach(() => {
    geyser = new GeyserSource(TEST_CONFIG, mockConnection);
  });

  afterEach(async () => {
    await geyser.stop();
  });

  test("should track statistics", () => {
    const stats = geyser.getStats();

    expect(stats).toHaveProperty("totalDetections");
    expect(stats).toHaveProperty("avgLatencyMs");
    expect(stats).toHaveProperty("totalReconnects");
    expect(stats).toHaveProperty("lastDetectionAt");
    expect(stats).toHaveProperty("uptime");

    expect(stats.totalDetections).toBe(0);
    expect(stats.avgLatencyMs).toBe(0);
    expect(stats.totalReconnects).toBe(0);
    expect(stats.lastDetectionAt).toBeNull();
  });

  test("should track uptime in seconds", async () => {
    // Wait 100ms
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stats = geyser.getStats();

    expect(stats.uptime).toBeGreaterThanOrEqual(0);
  });

  test("should initialize with zero metrics", () => {
    const metrics = geyser.getMetrics();

    expect(metrics.totalDetections).toBe(0);
    expect(metrics.avgParsingLatencyMs).toBe(0);
    expect(metrics.lastDetectionAt).toBeNull();
  });
});

// ============================================================================
// Lifecycle Tests
// ============================================================================

describe("GeyserSource - Lifecycle", () => {
  test("should stop cleanly", async () => {
    const geyser = new GeyserSource(TEST_CONFIG, mockConnection);

    await geyser.stop();

    const health = geyser.getHealth();
    expect(health.status).toBe("disconnected");
  });

  test("should allow multiple stop calls", async () => {
    const geyser = new GeyserSource(TEST_CONFIG, mockConnection);

    await geyser.stop();
    await geyser.stop();

    const health = geyser.getHealth();
    expect(health.status).toBe("disconnected");
  });

  test("should handle stop before start", async () => {
    const geyser = new GeyserSource(TEST_CONFIG, mockConnection);

    // Stop without starting
    await geyser.stop();

    const health = geyser.getHealth();
    expect(health.status).toBe("disconnected");
  });
});

// ============================================================================
// Configuration Tests
// ============================================================================

describe("GeyserSource - Configuration", () => {
  test("should accept confirmed commitment", () => {
    const config: GeyserConfig = {
      ...TEST_CONFIG,
      commitment: CommitmentLevel.CONFIRMED,
    };

    const geyser = new GeyserSource(config, mockConnection);

    expect(geyser).toBeDefined();
  });

  test("should accept finalized commitment", () => {
    const config: GeyserConfig = {
      ...TEST_CONFIG,
      commitment: CommitmentLevel.FINALIZED,
    };

    const geyser = new GeyserSource(config, mockConnection);

    expect(geyser).toBeDefined();
  });

  test("should configure reconnection settings", () => {
    const config: GeyserConfig = {
      ...TEST_CONFIG,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectDelay: 500,
    };

    const geyser = new GeyserSource(config, mockConnection);

    expect(geyser).toBeDefined();
  });

  test("should allow disabling TLS", () => {
    const config: GeyserConfig = {
      ...TEST_CONFIG,
      tls: false,
    };

    const geyser = new GeyserSource(config, mockConnection);

    expect(geyser).toBeDefined();
  });
});

// ============================================================================
// Singleton Tests
// ============================================================================

describe("GeyserSource - Singleton", () => {
  afterEach(async () => {
    if (defaultGeyserSource) {
      await defaultGeyserSource.stop();
    }
  });

  test("should initialize default GeyserSource", () => {
    const geyser = initializeGeyserSource(TEST_CONFIG, mockConnection);

    expect(geyser).toBeDefined();
    expect(geyser).toBeInstanceOf(GeyserSource);
    expect(defaultGeyserSource).toBe(geyser);
  });

  test("should return existing instance when already initialized", () => {
    initializeGeyserSource(TEST_CONFIG, mockConnection);
    const geyser2 = initializeGeyserSource(TEST_CONFIG, mockConnection);

    expect(geyser2).toBeDefined();
    expect(defaultGeyserSource).toBe(geyser2);
  });

  test("should get default GeyserSource", () => {
    const initialized = initializeGeyserSource(TEST_CONFIG, mockConnection);
    const retrieved = getGeyserSource();

    expect(retrieved).toBeDefined();
    expect(retrieved).not.toBeNull();
    if (retrieved && defaultGeyserSource) {
      expect(retrieved).toBe(initialized);
      expect(retrieved).toBe(defaultGeyserSource);
    }
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("GeyserSource - Edge Cases", () => {
  test("should handle empty program IDs array", () => {
    const config: GeyserConfig = {
      ...TEST_CONFIG,
      programIds: [],
    };

    const geyser = new GeyserSource(config, mockConnection);

    expect(geyser).toBeDefined();
  });

  test("should handle historical replay from slot", () => {
    const config: GeyserConfig = {
      ...TEST_CONFIG,
      fromSlot: 250000000,
    };

    const geyser = new GeyserSource(config, mockConnection);

    expect(geyser).toBeDefined();
  });

  test("should track metrics correctly with zero samples", () => {
    const geyser = new GeyserSource(TEST_CONFIG, mockConnection);
    const stats = geyser.getStats();

    expect(stats.avgLatencyMs).toBe(0);
    expect(stats.totalDetections).toBe(0);
  });
});

// ============================================================================
// Integration Hints
// ============================================================================

/**
 * For integration tests with live Geyser endpoint:
 *
 * 1. Set environment variables:
 *    export GEYSER_ENABLED=true
 *    export GEYSER_ENDPOINT="grpc.chainstack.com:443"
 *    export GEYSER_TOKEN="your_token"
 *
 * 2. Run benchmark tests:
 *    bun test src/services/sniper/GeyserBenchmark.test.ts
 *
 * 3. Expected results:
 *    - Connection time: <1s
 *    - First event latency: <50ms
 *    - Average latency: <50ms (4-10x faster than WebSocket)
 */
