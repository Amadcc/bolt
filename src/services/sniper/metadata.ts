/**
 * Token Metadata Service (OPTIMIZED)
 *
 * Fetches and caches token metadata (name, symbol, URI) from Metaplex.
 *
 * Performance Optimizations:
 * - PublicKey caching (LRU cache, 1000 entries)
 * - Fast-path for cache hits (<5ms)
 * - Batch fetching with parallelization
 * - Connection reuse for Metaplex
 * - Minimal object allocations
 *
 * Performance Target: <5ms cache hit, <200ms cache miss
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Metaplex } from "@metaplex-foundation/js";
import type { TokenMint } from "../../types/common.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import { logger } from "../../utils/logger.js";
import { redis } from "../../utils/redis.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Token metadata
 */
export interface TokenMetadata {
  /** Token mint address */
  mint: TokenMint;

  /** Token name */
  name: string;

  /** Token symbol */
  symbol: string;

  /** Metadata URI (IPFS, Arweave, etc.) */
  uri: string;

  /** Cached at timestamp */
  cachedAt?: Date;
}

/**
 * Metadata fetch options
 */
export interface MetadataFetchOptions {
  /** Use cache if available */
  useCache?: boolean;

  /** Cache TTL in seconds (default: 24 hours) */
  cacheTtl?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default cache TTL (24 hours)
 */
const DEFAULT_CACHE_TTL = 60 * 60 * 24;

/**
 * Redis key prefix for metadata cache
 */
const CACHE_KEY_PREFIX = "sniper:metadata:";

/**
 * PublicKey cache size (LRU)
 */
const PUBKEY_CACHE_SIZE = 1000;

// ============================================================================
// PublicKey Cache (Performance Optimization)
// ============================================================================

/**
 * LRU cache for PublicKey objects to avoid repeated parsing
 */
class PublicKeyCache {
  private cache = new Map<string, PublicKey>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(address: string): PublicKey {
    let pubkey = this.cache.get(address);

    if (!pubkey) {
      // Cache miss - create and store
      pubkey = new PublicKey(address);
      this.set(address, pubkey);
    } else {
      // Cache hit - move to end (LRU)
      this.cache.delete(address);
      this.cache.set(address, pubkey);
    }

    return pubkey;
  }

  private set(address: string, pubkey: PublicKey): void {
    // Evict oldest entry if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(address, pubkey);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// Metadata Service Implementation
// ============================================================================

/**
 * Token metadata service with Metaplex integration (OPTIMIZED)
 */
export class TokenMetadataService {
  private metaplex: Metaplex;
  private pubkeyCache: PublicKeyCache;

  constructor(connection: Connection) {
    this.metaplex = Metaplex.make(connection);
    this.pubkeyCache = new PublicKeyCache(PUBKEY_CACHE_SIZE);
  }

  /**
   * Fetch token metadata with caching (FAST PATH)
   *
   * Performance: <5ms cache hit, <200ms cache miss
   *
   * @param tokenMint - Token mint address
   * @param options - Fetch options
   * @returns Token metadata or error
   */
  async fetchMetadata(
    tokenMint: TokenMint,
    options: MetadataFetchOptions = {}
  ): Promise<Result<TokenMetadata, string>> {
    const { useCache = true, cacheTtl = DEFAULT_CACHE_TTL } = options;

    try {
      // FAST PATH: Try cache first
      if (useCache) {
        const cached = await this.getFromCache(tokenMint);
        if (cached.success) {
          // Cache hit - return immediately (<5ms)
          return cached;
        }
      }

      // SLOW PATH: Fetch from Metaplex
      const metadata = await this.fetchFromMetaplex(tokenMint);

      // Cache result for future requests
      if (useCache && metadata.success) {
        await this.saveToCache(tokenMint, metadata.value, cacheTtl);
      }

      return metadata;
    } catch (error) {
      logger.warn("Metadata fetch error", {
        mint: tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return minimal fallback metadata
      return Ok({
        mint: tokenMint,
        name: "Unknown Token",
        symbol: "???",
        uri: "",
      });
    }
  }

  /**
   * Batch fetch metadata for multiple tokens (PARALLEL)
   *
   * Processes all requests in parallel for maximum throughput.
   *
   * @param tokenMints - Array of token mint addresses
   * @param options - Fetch options
   * @returns Array of metadata results
   */
  async fetchBatch(
    tokenMints: TokenMint[],
    options: MetadataFetchOptions = {}
  ): Promise<Result<TokenMetadata, string>[]> {
    logger.debug("Batch fetching metadata", { count: tokenMints.length });

    // Parallel processing for maximum speed
    const promises = tokenMints.map((mint) => this.fetchMetadata(mint, options));

    return Promise.all(promises);
  }

  /**
   * Prefetch and cache metadata for new token (FIRE-AND-FORGET)
   *
   * Used to warm cache when new pool is detected.
   * Non-blocking, errors are logged but not thrown.
   *
   * @param tokenMint - Token mint address
   */
  prefetchMetadata(tokenMint: TokenMint): void {
    // Fire and forget - don't await result
    this.fetchMetadata(tokenMint, { useCache: true }).catch((error) => {
      logger.debug("Prefetch failed (non-critical)", {
        mint: tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Get PublicKey cache statistics
   */
  getCacheStats(): { pubkeyCacheSize: number; pubkeyCacheMax: number } {
    return {
      pubkeyCacheSize: this.pubkeyCache.size(),
      pubkeyCacheMax: PUBKEY_CACHE_SIZE,
    };
  }

  /**
   * Clear PublicKey cache (for testing/debugging)
   */
  clearCaches(): void {
    this.pubkeyCache.clear();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Fetch metadata from Metaplex (OPTIMIZED)
   *
   * Uses cached PublicKey objects to avoid repeated parsing.
   *
   * @param tokenMint - Token mint address
   * @returns Token metadata or error
   */
  private async fetchFromMetaplex(
    tokenMint: TokenMint
  ): Promise<Result<TokenMetadata, string>> {
    try {
      logger.debug("Fetching metadata from Metaplex", { mint: tokenMint });

      // Use cached PublicKey to avoid repeated parsing
      const mintPubkey = this.pubkeyCache.get(tokenMint);

      // Fetch NFT metadata
      const nft = await this.metaplex.nfts().findByMint({ mintAddress: mintPubkey });

      // Extract metadata
      const metadata: TokenMetadata = {
        mint: tokenMint,
        name: nft.name || "Unknown",
        symbol: nft.symbol || "???",
        uri: nft.uri || "",
        cachedAt: new Date(),
      };

      logger.info("Metadata fetched from Metaplex", {
        mint: tokenMint,
        name: metadata.name,
        symbol: metadata.symbol,
      });

      return Ok(metadata);
    } catch (error) {
      logger.warn("Metaplex fetch failed", {
        mint: tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Metaplex fetch failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get metadata from Redis cache (FAST PATH)
   *
   * Target: <5ms
   *
   * @param tokenMint - Token mint address
   * @returns Cached metadata or error
   */
  private async getFromCache(
    tokenMint: TokenMint
  ): Promise<Result<TokenMetadata, string>> {
    try {
      const key = CACHE_KEY_PREFIX + tokenMint;
      const cached = await redis.get(key);

      if (!cached) {
        return Err("Cache miss");
      }

      const metadata = JSON.parse(cached) as TokenMetadata;

      // Restore Date object
      if (metadata.cachedAt) {
        metadata.cachedAt = new Date(metadata.cachedAt);
      }

      logger.debug("Metadata cache hit", {
        mint: tokenMint,
        name: metadata.name,
        symbol: metadata.symbol,
      });

      return Ok(metadata);
    } catch (error) {
      logger.error("Cache read error", {
        mint: tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
      return Err("Cache error");
    }
  }

  /**
   * Save metadata to Redis cache
   *
   * @param tokenMint - Token mint address
   * @param metadata - Token metadata
   * @param ttl - Cache TTL in seconds
   */
  private async saveToCache(
    tokenMint: TokenMint,
    metadata: TokenMetadata,
    ttl: number
  ): Promise<void> {
    try {
      const key = CACHE_KEY_PREFIX + tokenMint;
      const value = JSON.stringify(metadata);

      await redis.setex(key, ttl, value);

      logger.debug("Metadata cached", {
        mint: tokenMint,
        ttl,
      });
    } catch (error) {
      logger.error("Cache write error", {
        mint: tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Invalidate cached metadata
   *
   * @param tokenMint - Token mint address
   */
  async invalidateCache(tokenMint: TokenMint): Promise<void> {
    try {
      const key = CACHE_KEY_PREFIX + tokenMint;
      await redis.del(key);

      logger.debug("Metadata cache invalidated", { mint: tokenMint });
    } catch (error) {
      logger.error("Cache invalidation error", {
        mint: tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
