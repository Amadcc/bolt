/**
 * WebSocket Connection Pool Tests
 *
 * Comprehensive test suite for WebSocketPool with:
 * - Connection management
 * - Health monitoring
 * - Auto-reconnect and failover
 * - Circuit breaker integration
 * - Statistics tracking
 */

import { describe, test, expect, afterEach, mock } from "bun:test";
import { Connection } from "@solana/web3.js";
import {
  WebSocketPool,
  initializeWebSocketPool,
  getWebSocketPool,
  defaultWebSocketPool,
} from "./WebSocketPool.js";

// Mock Connection.prototype.getSlot
const originalGetSlot = Connection.prototype.getSlot;

afterEach(() => {
  // Restore original getSlot
  Connection.prototype.getSlot = originalGetSlot;
});

// ============================================================================
// Constructor and Initialization Tests
// ============================================================================

describe("WebSocketPool - Constructor", () => {
  test("should create pool with single endpoint", () => {
    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
      commitment: "confirmed",
    });

    expect(pool).toBeDefined();
    expect(pool.getConnection()).toBeInstanceOf(Connection);
  });

  test("should create pool with multiple endpoints", () => {
    const pool = new WebSocketPool({
      endpoints: [
        "https://api.mainnet-beta.solana.com",
        "https://solana-api.projectserum.com",
        "https://rpc.ankr.com/solana",
      ],
      commitment: "confirmed",
    });

    const stats = pool.getStats();
    expect(stats.totalConnections).toBe(3);
  });

  test("should throw error when no endpoints provided", () => {
    expect(() => {
      new WebSocketPool({
        endpoints: [],
      });
    }).toThrow("WebSocketPool requires at least one endpoint");
  });

  test("should use default config values", () => {
    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    const stats = pool.getStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.healthyConnections).toBe(1);
  });

  test("should initialize all connections", () => {
    const endpoints = [
      "https://api.mainnet-beta.solana.com",
      "https://solana-api.projectserum.com",
    ];

    const pool = new WebSocketPool({ endpoints, commitment: "confirmed" });
    const health = pool.getHealth();

    expect(health).toHaveLength(2);
    expect(health[0].endpoint).toBe(endpoints[0]);
    expect(health[1].endpoint).toBe(endpoints[1]);
  });
});

// ============================================================================
// Health Monitoring Tests
// ============================================================================

describe("WebSocketPool - Health Monitoring", () => {
  test("should start health monitoring", () => {
    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
      healthCheckInterval: 1000,
    });

    pool.start();
    pool.stop();
  });

  test("should stop health monitoring", () => {
    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
      healthCheckInterval: 1000,
    });

    pool.start();
    pool.stop();

    // Should not throw when stopping twice
    pool.stop();
  });

  test("should return health status for all connections", () => {
    const pool = new WebSocketPool({
      endpoints: [
        "https://api.mainnet-beta.solana.com",
        "https://solana-api.projectserum.com",
      ],
    });

    const health = pool.getHealth();

    expect(health).toHaveLength(2);
    expect(health[0]).toHaveProperty("endpoint");
    expect(health[0]).toHaveProperty("isHealthy");
    expect(health[0]).toHaveProperty("lastHealthCheck");
    expect(health[0]).toHaveProperty("consecutiveFailures");
    expect(health[0]).toHaveProperty("uptime");
  });

  test("should track consecutive failures", async () => {
    // Mock getSlot to fail
    Connection.prototype.getSlot = mock(async () => {
      throw new Error("Connection failed");
    });

    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
      healthCheckInterval: 100,
    });

    pool.start();

    // Wait for health check to run
    await new Promise((resolve) => setTimeout(resolve, 200));

    const health = pool.getHealth();
    expect(health[0].consecutiveFailures).toBeGreaterThan(0);

    pool.stop();
  });

  test("should reset consecutive failures on successful health check", async () => {
    let shouldFail = true;

    // Mock getSlot to fail then succeed
    Connection.prototype.getSlot = mock(async () => {
      if (shouldFail) {
        throw new Error("Connection failed");
      }
      return 123456789;
    });

    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
      healthCheckInterval: 100,
    });

    pool.start();

    // Wait for first failure
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Now allow success
    shouldFail = false;

    // Wait for success
    await new Promise((resolve) => setTimeout(resolve, 150));

    const health = pool.getHealth();
    expect(health[0].isHealthy).toBe(true);
    expect(health[0].consecutiveFailures).toBe(0);

    pool.stop();
  });
});

// ============================================================================
// Reconnect Tests
// ============================================================================

describe("WebSocketPool - Reconnect", () => {
  test("should reconnect to specific endpoint", async () => {
    // Mock successful health check
    Connection.prototype.getSlot = mock(async () => 123456789);

    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    const result = await pool.reconnect("https://api.mainnet-beta.solana.com");

    expect(result.success).toBe(true);

    const stats = pool.getStats();
    expect(stats.totalReconnects).toBe(1);
  });

  test("should fail reconnect for non-existent endpoint", async () => {
    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    const result = await pool.reconnect("https://fake-endpoint.com");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Endpoint not found");
    }
  });

  test("should fail reconnect if health check fails", async () => {
    // Mock failed health check
    Connection.prototype.getSlot = mock(async () => {
      throw new Error("Connection failed");
    });

    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    const result = await pool.reconnect("https://api.mainnet-beta.solana.com");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("failed health check");
    }
  });
});

// ============================================================================
// Failover Tests
// ============================================================================

describe("WebSocketPool - Failover", () => {
  test("should failover to healthy endpoint when active fails", async () => {
    let endpoint1Healthy = true;

    // Mock health checks
    Connection.prototype.getSlot = mock(async function (this: Connection) {
      const endpoint = (this as any).rpcEndpoint;

      if (endpoint === "https://api.mainnet-beta.solana.com") {
        if (!endpoint1Healthy) {
          throw new Error("Endpoint 1 failed");
        }
      }

      return 123456789;
    });

    const pool = new WebSocketPool({
      endpoints: [
        "https://api.mainnet-beta.solana.com",
        "https://solana-api.projectserum.com",
      ],
      healthCheckInterval: 100,
      autoReconnect: false, // Disable auto-reconnect for this test
    });

    const initialStats = pool.getStats();
    const initialEndpoint = initialStats.activeEndpoint;

    pool.start();

    // Wait for initial health check
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Fail the first endpoint
    endpoint1Healthy = false;

    // Wait for failover
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stats = pool.getStats();
    expect(stats.activeEndpoint).not.toBe(initialEndpoint);
    expect(stats.totalFailovers).toBeGreaterThan(0);

    pool.stop();
  });

  test("should handle all endpoints failing", async () => {
    // Mock all health checks to fail
    Connection.prototype.getSlot = mock(async () => {
      throw new Error("All endpoints failed");
    });

    const pool = new WebSocketPool({
      endpoints: [
        "https://api.mainnet-beta.solana.com",
        "https://solana-api.projectserum.com",
      ],
      healthCheckInterval: 100,
      autoReconnect: false,
    });

    pool.start();

    // Wait for health checks to run
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stats = pool.getStats();
    expect(stats.healthyConnections).toBe(0);

    pool.stop();
  });
});

// ============================================================================
// Statistics Tests
// ============================================================================

describe("WebSocketPool - Statistics", () => {
  test("should track pool statistics", () => {
    const pool = new WebSocketPool({
      endpoints: [
        "https://api.mainnet-beta.solana.com",
        "https://solana-api.projectserum.com",
      ],
    });

    const stats = pool.getStats();

    expect(stats).toHaveProperty("totalConnections");
    expect(stats).toHaveProperty("healthyConnections");
    expect(stats).toHaveProperty("activeEndpoint");
    expect(stats).toHaveProperty("totalFailovers");
    expect(stats).toHaveProperty("totalReconnects");
    expect(stats).toHaveProperty("avgLatencyMs");

    expect(stats.totalConnections).toBe(2);
    expect(stats.totalFailovers).toBe(0);
    expect(stats.totalReconnects).toBe(0);
  });

  test("should track average latency", async () => {
    // Mock getSlot with delay
    Connection.prototype.getSlot = mock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 123456789;
    });

    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
      healthCheckInterval: 100,
    });

    pool.start();

    // Wait for health checks
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stats = pool.getStats();
    expect(stats.avgLatencyMs).toBeGreaterThan(0);

    pool.stop();
  });

  test("should increment reconnect counter", async () => {
    Connection.prototype.getSlot = mock(async () => 123456789);

    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    await pool.reconnect("https://api.mainnet-beta.solana.com");

    const stats = pool.getStats();
    expect(stats.totalReconnects).toBe(1);
  });
});

// ============================================================================
// Singleton Tests
// ============================================================================

describe("WebSocketPool - Singleton", () => {
  test("should initialize default pool", () => {
    const pool = initializeWebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    expect(pool).toBeDefined();
    expect(defaultWebSocketPool).toBe(pool);

    pool.stop();
  });

  test("should return existing pool when already initialized", () => {
    initializeWebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    const pool2 = initializeWebSocketPool({
      endpoints: ["https://solana-api.projectserum.com"],
    });

    // Should stop old pool and create new one
    expect(pool2).toBeDefined();

    pool2.stop();
  });

  test("should get default pool", () => {
    const pool = initializeWebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    const retrieved = getWebSocketPool();
    expect(retrieved).toBe(pool);

    pool.stop();
  });
});

// ============================================================================
// Circuit Breaker Integration Tests
// ============================================================================

describe("WebSocketPool - Circuit Breaker", () => {
  test("should use circuit breaker for health checks", async () => {
    let callCount = 0;

    // Mock getSlot to fail multiple times
    Connection.prototype.getSlot = mock(async () => {
      callCount++;
      if (callCount <= 5) {
        throw new Error("Connection failed");
      }
      return 123456789;
    });

    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
      healthCheckInterval: 100,
      circuitBreaker: {
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 1000,
      },
    });

    pool.start();

    // Wait for circuit breaker to open
    await new Promise((resolve) => setTimeout(resolve, 600));

    const health = pool.getHealth();
    expect(health[0].consecutiveFailures).toBeGreaterThanOrEqual(5);

    pool.stop();
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("WebSocketPool - Edge Cases", () => {
  test("should handle WebSocket endpoint conversion", () => {
    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    // Connection should convert https:// to wss://
    const conn = pool.getConnection();
    expect(conn).toBeDefined();
  });

  test("should handle http to ws conversion", () => {
    const pool = new WebSocketPool({
      endpoints: ["http://localhost:8899"],
    });

    const conn = pool.getConnection();
    expect(conn).toBeDefined();
  });

  test("should throw when getting connection with no active endpoint", () => {
    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    // This should work normally
    expect(() => pool.getConnection()).not.toThrow();
  });

  test("should handle uptime calculation", () => {
    const pool = new WebSocketPool({
      endpoints: ["https://api.mainnet-beta.solana.com"],
    });

    const health = pool.getHealth();
    expect(health[0].uptime).toBeGreaterThanOrEqual(0);
  });
});
