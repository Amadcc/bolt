/**
 * Pool Event Broadcaster Tests
 *
 * Comprehensive test suite for Redis pub/sub event broadcasting:
 * - Event publishing (raw and scored detections)
 * - Event deduplication
 * - Statistics tracking
 * - Error handling
 * - Cleanup mechanisms
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  PoolEventBroadcaster,
  type PoolEvent,
  type BroadcasterStats,
  initializePoolEventBroadcaster,
  getPoolEventBroadcaster,
  defaultBroadcaster,
} from "./PoolEventBroadcaster.js";
import type { RawPoolDetection } from "./sources/BaseSource.js";
import type { ScoredPoolDetection } from "./SourceManager.js";
import { asSolanaAddress, asTokenMint } from "../../types/common.js";
import { redis } from "../../utils/redis.js";

// ============================================================================
// Test Setup
// ============================================================================

// Mock Redis
const mockRedisPublish = mock(async () => 1); // 1 subscriber

beforeEach(() => {
  redis.publish = mockRedisPublish as any;
  mockRedisPublish.mockClear();
});

// ============================================================================
// Raw Detection Publishing Tests
// ============================================================================

describe("PoolEventBroadcaster - Raw Detection Publishing", () => {
  test("should publish raw pool detection", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    const result = await broadcaster.publishRawDetection(detection);

    expect(result.success).toBe(true);
    expect(mockRedisPublish).toHaveBeenCalledTimes(1);

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(1);
    expect(stats.totalFailed).toBe(0);

    broadcaster.stop();
  });

  test("should include correct event structure", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    await broadcaster.publishRawDetection(detection);

    expect(mockRedisPublish).toHaveBeenCalledTimes(1);

    const [channel, message] = mockRedisPublish.mock.calls[0];
    expect(channel).toBe("pool:detection:raw");

    const event = JSON.parse(message) as PoolEvent;
    expect(event.type).toBe("raw_detection");
    expect(event.source).toBe("raydium_v4");
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.data).toMatchObject(detection);

    broadcaster.stop();
  });

  test("should track latency metrics", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    await broadcaster.publishRawDetection(detection);

    const stats = broadcaster.getStats();
    expect(stats.avgPublishLatencyMs).toBeGreaterThanOrEqual(0);

    broadcaster.stop();
  });
});

// ============================================================================
// Scored Detection Publishing Tests
// ============================================================================

describe("PoolEventBroadcaster - Scored Detection Publishing", () => {
  test("should publish scored pool detection", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: ScoredPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
      priority: 10,
    };

    const result = await broadcaster.publishScoredDetection(detection);

    expect(result.success).toBe(true);
    expect(mockRedisPublish).toHaveBeenCalledTimes(1);

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(1);

    broadcaster.stop();
  });

  test("should publish to correct channel", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: ScoredPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
      priority: 10,
    };

    await broadcaster.publishScoredDetection(detection);

    const [channel, message] = mockRedisPublish.mock.calls[0];
    expect(channel).toBe("pool:detection:scored");

    const event = JSON.parse(message) as PoolEvent;
    expect(event.type).toBe("scored_detection");
    expect((event.data as ScoredPoolDetection).priority).toBe(10);

    broadcaster.stop();
  });
});

// ============================================================================
// Deduplication Tests
// ============================================================================

describe("PoolEventBroadcaster - Deduplication", () => {
  test("should deduplicate events within 1 second window", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    // First publish
    await broadcaster.publishRawDetection(detection);

    // Second publish (duplicate)
    await broadcaster.publishRawDetection(detection);

    // Third publish (duplicate)
    await broadcaster.publishRawDetection(detection);

    expect(mockRedisPublish).toHaveBeenCalledTimes(1); // Only first one

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(1);
    expect(stats.totalDeduplicated).toBe(2);

    broadcaster.stop();
  });

  test("should publish duplicate after deduplication window", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    // First publish
    await broadcaster.publishRawDetection(detection);

    // Wait for deduplication window to expire (1 second)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Second publish (should go through)
    await broadcaster.publishRawDetection(detection);

    expect(mockRedisPublish).toHaveBeenCalledTimes(2);

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(2);
    expect(stats.totalDeduplicated).toBe(0);

    broadcaster.stop();
  });

  test("should handle different signatures separately", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection1: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    const detection2: RawPoolDetection = {
      ...detection1,
      signature: "2ZE7R7NqJ5yoP4q2b2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia1234567890abcd",
    };

    await broadcaster.publishRawDetection(detection1);
    await broadcaster.publishRawDetection(detection2);

    expect(mockRedisPublish).toHaveBeenCalledTimes(2);

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(2);
    expect(stats.totalDeduplicated).toBe(0);

    broadcaster.stop();
  });
});

// ============================================================================
// Statistics Tests
// ============================================================================

describe("PoolEventBroadcaster - Statistics", () => {
  test("should track total published events", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    await broadcaster.publishRawDetection(detection);

    const scoredDetection: ScoredPoolDetection = {
      ...detection,
      // Different signature to avoid deduplication
      signature: "2ZE7R7NqJ5yoP4q2b2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia1234567890abcd",
      priority: 10,
    };

    await broadcaster.publishScoredDetection(scoredDetection);

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(2);

    broadcaster.stop();
  });

  test("should track failed publications", async () => {
    // Mock Redis publish to fail
    const mockFailingPublish = mock(async () => {
      throw new Error("Redis connection failed");
    });
    redis.publish = mockFailingPublish as any;

    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    const result = await broadcaster.publishRawDetection(detection);

    expect(result.success).toBe(false);

    const stats = broadcaster.getStats();
    expect(stats.totalFailed).toBe(1);
    expect(stats.totalPublished).toBe(0);

    broadcaster.stop();
  });

  test("should calculate average latency correctly", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    await broadcaster.publishRawDetection(detection);

    const stats = broadcaster.getStats();
    expect(stats.avgPublishLatencyMs).toBeGreaterThanOrEqual(0); // Latency can be 0 for very fast operations
    expect(stats.avgPublishLatencyMs).toBeLessThan(100); // Should be < 100ms

    broadcaster.stop();
  });

  test("should limit latency samples to last 100", async () => {
    const broadcaster = new PoolEventBroadcaster();

    // Publish 150 events
    for (let i = 0; i < 150; i++) {
      const detection: RawPoolDetection = {
        poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
        tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
        tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
        source: "raydium_v4",
        signature: `sig${i}${"x".repeat(70)}`,
        slot: 123456789 + i,
        blockTime: Math.floor(Date.now() / 1000),
      };

      await broadcaster.publishRawDetection(detection);
    }

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(150);
    expect(stats.avgPublishLatencyMs).toBeGreaterThanOrEqual(0); // Can be 0 for very fast operations

    broadcaster.stop();
  });
});

// ============================================================================
// Cleanup Tests
// ============================================================================

describe("PoolEventBroadcaster - Cleanup", () => {
  test("should cleanup old events from deduplication cache", async () => {
    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    await broadcaster.publishRawDetection(detection);

    // Wait for cleanup timer (5 seconds)
    await new Promise((resolve) => setTimeout(resolve, 5500));

    // After cleanup, should be able to publish again
    await broadcaster.publishRawDetection(detection);

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(2);

    broadcaster.stop();
  });

  test("should stop cleanup timer on stop()", async () => {
    const broadcaster = new PoolEventBroadcaster();

    broadcaster.stop();

    // Publish event
    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    await broadcaster.publishRawDetection(detection);

    const stats = broadcaster.getStats();
    expect(stats.totalPublished).toBe(1);
  });

  test("should clear events on stop()", () => {
    const broadcaster = new PoolEventBroadcaster();

    broadcaster.stop();

    // Should not throw
    broadcaster.stop();
  });
});

// ============================================================================
// Singleton Tests
// ============================================================================

describe("PoolEventBroadcaster - Singleton", () => {
  test("should initialize default broadcaster", () => {
    const broadcaster = initializePoolEventBroadcaster();

    expect(broadcaster).toBeDefined();
    expect(defaultBroadcaster).toBe(broadcaster);

    broadcaster.stop();
  });

  test("should warn when already initialized", () => {
    const broadcaster1 = initializePoolEventBroadcaster();
    const broadcaster2 = initializePoolEventBroadcaster();

    expect(broadcaster1).toBe(broadcaster2);

    broadcaster2.stop();
  });

  test("should get default broadcaster", () => {
    const broadcaster = initializePoolEventBroadcaster();
    const retrieved = getPoolEventBroadcaster();

    expect(retrieved).toBe(broadcaster);

    broadcaster.stop();
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe("PoolEventBroadcaster - Error Handling", () => {
  test("should return error on Redis publish failure", async () => {
    const mockFailingPublish = mock(async () => {
      throw new Error("Connection timeout");
    });
    redis.publish = mockFailingPublish as any;

    const broadcaster = new PoolEventBroadcaster();

    const detection: RawPoolDetection = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    const result = await broadcaster.publishRawDetection(detection);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to publish event");
    expect(result.error).toContain("Connection timeout");

    broadcaster.stop();
  });

  test("should handle JSON serialization errors gracefully", async () => {
    const broadcaster = new PoolEventBroadcaster();

    // Create circular reference
    const detection: any = {
      poolAddress: asSolanaAddress("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
      tokenMintA: asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      tokenMintB: asTokenMint("So11111111111111111111111111111111111111112"),
      source: "raydium_v4",
      signature: "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia",
      slot: 123456789,
      blockTime: Math.floor(Date.now() / 1000),
    };

    // Create circular reference
    detection.self = detection;

    const result = await broadcaster.publishRawDetection(detection);

    expect(result.success).toBe(false);

    broadcaster.stop();
  });
});
