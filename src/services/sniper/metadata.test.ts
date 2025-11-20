/**
 * Unit tests for Token Metadata Service
 *
 * Tests:
 * - PublicKey LRU cache
 * - Metadata fetching with cache
 * - Metaplex integration
 * - Redis caching
 * - Batch fetching
 * - Error handling & fallbacks
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { TokenMetadataService } from "./metadata.js";
import type { TokenMetadata } from "./metadata.js";
import { Connection } from "@solana/web3.js";
import { asTokenMint } from "../../types/common.js";
import { redis } from "../../utils/redis.js";

const MOCK_RPC_URL = "https://api.mainnet-beta.solana.com";

function createMockConnection(): Connection {
  return new Connection(MOCK_RPC_URL, "confirmed");
}

describe("TokenMetadataService - Initialization", () => {
  test("should initialize with connection", () => {
    const service = new TokenMetadataService(createMockConnection());
    expect(service).toBeDefined();
  });

  test("should start with empty PublicKey cache", () => {
    const service = new TokenMetadataService(createMockConnection());
    const stats = service.getCacheStats();

    expect(stats.pubkeyCacheSize).toBe(0);
    expect(stats.pubkeyCacheMax).toBe(1000);
  });
});

describe("TokenMetadataService - PublicKey Cache", () => {
  let service: TokenMetadataService;

  beforeEach(() => {
    service = new TokenMetadataService(createMockConnection());
  });

  test("should cache PublicKey objects", () => {
    const mint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

    // Access private pubkeyCache directly for testing
    const pubkeyCache = service["pubkeyCache" as keyof typeof service] as any;

    // Manually call get to populate cache
    pubkeyCache.get(mint);

    const stats = service.getCacheStats();
    expect(stats.pubkeyCacheSize).toBe(1);
  });

  test("should clear PublicKey cache", () => {
    service.clearCaches();
    const stats = service.getCacheStats();

    expect(stats.pubkeyCacheSize).toBe(0);
  });
});

describe("TokenMetadataService - Redis Caching", () => {
  let service: TokenMetadataService;
  const mint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

  beforeEach(() => {
    service = new TokenMetadataService(createMockConnection());
  });

  afterEach(() => {
    // Cleanup mocks
  });

  test("should return cached metadata on cache hit", async () => {
    const cachedMetadata: TokenMetadata = {
      mint,
      name: "Cached Token",
      symbol: "CACHED",
      uri: "https://example.com/cached.json",
      cachedAt: new Date(),
    };

    // Mock redis.get to return cached data
    const mockRedisGet = mock(async () => JSON.stringify(cachedMetadata));
    redis.get = mockRedisGet;

    const result = await service.fetchMetadata(mint, { useCache: true });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe("Cached Token");
      expect(result.value.symbol).toBe("CACHED");
    }
  });

  test("should fetch from Metaplex on cache miss", async () => {
    // Mock redis.get to return null (cache miss)
    const mockRedisGet = mock(async () => null);
    redis.get = mockRedisGet;

    // Mock redis.setex for caching result
    const mockRedisSetex = mock(async () => "OK" as const);
    redis.setex = mockRedisSetex as any;

    // Mock Metaplex
    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => ({
      success: true,
      value: {
        mint,
        name: "Fresh Token",
        symbol: "FRESH",
        uri: "https://example.com/fresh.json",
        cachedAt: new Date(),
      },
    })) as any;

    const result = await service.fetchMetadata(mint, { useCache: true });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe("Fresh Token");
      expect(result.value.symbol).toBe("FRESH");
    }

    // Should have cached the result
    expect(mockRedisSetex).toHaveBeenCalled();
  });

  test("should skip cache when useCache=false", async () => {
    const mockRedisGet = mock(async () => "should not be called");
    redis.get = mockRedisGet;

    const mockRedisSetex = mock(async () => "OK" as const);
    redis.setex = mockRedisSetex as any;

    // Mock Metaplex
    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => ({
      success: true,
      value: {
        mint,
        name: "No Cache Token",
        symbol: "NOCACHE",
        uri: "https://example.com/nocache.json",
        cachedAt: new Date(),
      },
    })) as any;

    const result = await service.fetchMetadata(mint, { useCache: false });

    expect(result.success).toBe(true);
    // Should NOT have read from cache
    expect(mockRedisGet).not.toHaveBeenCalled();
    // Should NOT have written to cache
    expect(mockRedisSetex).not.toHaveBeenCalled();
  });

  test("should handle cache read errors gracefully", async () => {
    // Mock redis.get to throw error
    const mockRedisGet = mock(async () => {
      throw new Error("Redis connection failed");
    });
    redis.get = mockRedisGet;

    // Mock Metaplex as fallback
    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => ({
      success: true,
      value: {
        mint,
        name: "Fallback Token",
        symbol: "FALLBACK",
        uri: "https://example.com/fallback.json",
        cachedAt: new Date(),
      },
    })) as any;

    const result = await service.fetchMetadata(mint, { useCache: true });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe("Fallback Token");
    }
  });

  test("should invalidate cache", async () => {
    const mockRedisDel = mock(async () => 1);
    redis.del = mockRedisDel;

    await service.invalidateCache(mint);

    expect(mockRedisDel).toHaveBeenCalledWith("sniper:metadata:" + mint);
  });
});

describe("TokenMetadataService - Metaplex Integration", () => {
  let service: TokenMetadataService;
  const mint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

  beforeEach(() => {
    service = new TokenMetadataService(createMockConnection());

    // Disable cache for these tests
    const mockRedisGet = mock(async () => null);
    redis.get = mockRedisGet;

    const mockRedisSetex = mock(async () => "OK" as const);
    redis.setex = mockRedisSetex as any;
  });

  test("should return fallback metadata on Metaplex error", async () => {
    // Mock Metaplex to throw error (not return error Result)
    (service as any)["fetchFromMetaplex"] = mock(async () => {
      throw new Error("Metaplex API error");
    });

    const result = await service.fetchMetadata(mint, { useCache: false });

    // Should return fallback instead of error
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe("Unknown Token");
      expect(result.value.symbol).toBe("???");
      expect(result.value.uri).toBe("");
    }
  });

  test("should parse valid Metaplex response", async () => {
    // Mock successful Metaplex response
    
    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => ({
      success: true,
      value: {
        mint,
        name: "Bonk",
        symbol: "BONK",
        uri: "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
        cachedAt: new Date(),
      },
    })) as any;

    const result = await service.fetchMetadata(mint, { useCache: false });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe("Bonk");
      expect(result.value.symbol).toBe("BONK");
      expect(result.value.uri).toContain("arweave.net");
    }
  });
});

describe("TokenMetadataService - Batch Fetching", () => {
  let service: TokenMetadataService;

  beforeEach(() => {
    service = new TokenMetadataService(createMockConnection());

    // Mock redis
    const mockRedisGet = mock(async () => null);
    redis.get = mockRedisGet;

    const mockRedisSetex = mock(async () => "OK" as const);
    redis.setex = mockRedisSetex as any;
  });

  test("should fetch metadata for multiple tokens in parallel", async () => {
    const mints = [
      asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      asTokenMint("So11111111111111111111111111111111111111112"),
      asTokenMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    ];

    // Mock Metaplex to return different metadata for each mint
    
    service["fetchFromMetaplex" as keyof typeof service] = mock(async (mint: string) => ({
      success: true,
      value: {
        mint,
        name: `Token ${mint.slice(0, 4)}`,
        symbol: mint.slice(0, 3).toUpperCase(),
        uri: `https://example.com/${mint}.json`,
        cachedAt: new Date(),
      },
    })) as any;

    const results = await service.fetchBatch(mints, { useCache: false });

    expect(results.length).toBe(3);
    expect(results.every((r) => r.success)).toBe(true);
  });

  test("should handle mixed success/failure in batch", async () => {
    const mints = [
      asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
      asTokenMint("So11111111111111111111111111111111111111112"),
    ];

    let callCount = 0;
    (service as any)["fetchFromMetaplex"] = mock(async (mint: string) => {
      callCount++;
      if (callCount === 1) {
        return {
          success: true,
          value: {
            mint,
            name: "Success Token",
            symbol: "SUCCESS",
            uri: "https://example.com/success.json",
            cachedAt: new Date(),
          },
        };
      } else {
        // Throw error to trigger catch block and fallback
        throw new Error("Metaplex error");
      }
    });

    const results = await service.fetchBatch(mints, { useCache: false });

    expect(results.length).toBe(2);
    // First should succeed
    expect(results[0].success).toBe(true);
    // Second should return fallback (Unknown Token)
    expect(results[1].success).toBe(true);
    if (results[1].success) {
      expect(results[1].value.name).toBe("Unknown Token");
    }
  });

  test("should return empty array for empty batch", async () => {
    const results = await service.fetchBatch([], { useCache: false });

    expect(results).toEqual([]);
  });
});

describe("TokenMetadataService - Prefetch", () => {
  let service: TokenMetadataService;

  beforeEach(() => {
    service = new TokenMetadataService(createMockConnection());

    // Mock redis
    const mockRedisGet = mock(async () => null);
    redis.get = mockRedisGet;

    const mockRedisSetex = mock(async () => "OK" as const);
    redis.setex = mockRedisSetex as any;
  });

  test("should prefetch metadata without blocking", () => {
    const mint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

    // Mock Metaplex
    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => ({
      success: true,
      value: {
        mint,
        name: "Prefetch Token",
        symbol: "PREFETCH",
        uri: "https://example.com/prefetch.json",
        cachedAt: new Date(),
      },
    })) as any;

    // Should not throw and should return immediately
    expect(() => service.prefetchMetadata(mint)).not.toThrow();
  });

  test("should handle prefetch errors silently", () => {
    const mint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

    // Mock Metaplex to fail

    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => {
      throw new Error("Prefetch failed");
    }) as any;

    // Should not throw even if fetch fails
    expect(() => service.prefetchMetadata(mint)).not.toThrow();
  });
});

describe("TokenMetadataService - Cache TTL", () => {
  let service: TokenMetadataService;
  const mint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

  beforeEach(() => {
    service = new TokenMetadataService(createMockConnection());

    // Mock redis.get to return null (cache miss)
    const mockRedisGet = mock(async () => null);
    redis.get = mockRedisGet;
  });

  test("should use default TTL (24 hours)", async () => {
    const mockRedisSetex = mock(async () => "OK" as const);
    redis.setex = mockRedisSetex as any;

    // Mock Metaplex
    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => ({
      success: true,
      value: {
        mint,
        name: "Test Token",
        symbol: "TEST",
        uri: "https://example.com/test.json",
        cachedAt: new Date(),
      },
    })) as any;

    await service.fetchMetadata(mint, { useCache: true });

    // Should cache with default TTL (24 hours = 86400 seconds)
    expect(mockRedisSetex).toHaveBeenCalledWith(
      expect.stringContaining(mint),
      86400,
      expect.any(String)
    );
  });

  test("should use custom TTL", async () => {
    const mockRedisSetex = mock(async () => "OK" as const);
    redis.setex = mockRedisSetex as any;

    // Mock Metaplex
    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => ({
      success: true,
      value: {
        mint,
        name: "Test Token",
        symbol: "TEST",
        uri: "https://example.com/test.json",
        cachedAt: new Date(),
      },
    })) as any;

    await service.fetchMetadata(mint, {
      useCache: true,
      cacheTtl: 3600, // 1 hour
    });

    // Should cache with custom TTL (1 hour = 3600 seconds)
    expect(mockRedisSetex).toHaveBeenCalledWith(
      expect.stringContaining(mint),
      3600,
      expect.any(String)
    );
  });
});

describe("TokenMetadataService - Error Recovery", () => {
  let service: TokenMetadataService;
  const mint = asTokenMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

  beforeEach(() => {
    service = new TokenMetadataService(createMockConnection());
  });

  test("should return fallback on complete failure", async () => {
    // Mock redis to fail
    const mockRedisGet = mock(async () => {
      throw new Error("Redis down");
    });
    redis.get = mockRedisGet;

    // Mock Metaplex to fail

    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => {
      throw new Error("Metaplex down");
    }) as any;

    const result = await service.fetchMetadata(mint, { useCache: true });

    // Should return fallback metadata instead of crashing
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe("Unknown Token");
      expect(result.value.symbol).toBe("???");
    }
  });

  test("should handle cache write errors gracefully", async () => {
    const mockRedisGet = mock(async () => null);
    redis.get = mockRedisGet;

    // Mock redis.setex to throw error
    const mockRedisSetex = mock(async () => {
      throw new Error("Redis write failed");
    });
    redis.setex = mockRedisSetex;

    // Mock Metaplex to succeed
    
    service["fetchFromMetaplex" as keyof typeof service] = mock(async () => ({
      success: true,
      value: {
        mint,
        name: "Test Token",
        symbol: "TEST",
        uri: "https://example.com/test.json",
        cachedAt: new Date(),
      },
    })) as any;

    const result = await service.fetchMetadata(mint, { useCache: true });

    // Should succeed even if cache write fails
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe("Test Token");
    }
  });
});
