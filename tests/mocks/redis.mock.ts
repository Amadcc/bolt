/**
 * Mock Redis Client for Unit Tests
 *
 * Provides in-memory Redis functionality without external dependencies.
 * Supports all operations used by the application with full type safety.
 *
 * Features:
 * - In-memory key-value store
 * - TTL support with automatic expiration
 * - Pattern matching (SCAN, KEYS)
 * - Full compatibility with ioredis interface
 */

import type { Redis } from "ioredis";

interface StoreEntry {
  value: string;
  expiry?: number;
}

export class MockRedis implements Partial<Redis> {
  private store = new Map<string, StoreEntry>();
  private subscribers = new Map<string, Set<(message: string) => void>>();

  // ========================================================================
  // Basic Operations
  // ========================================================================

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Check expiry
    if (entry.expiry && Date.now() > entry.expiry) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<"OK" | null> {
    let expiry: number | undefined;

    // Parse arguments: set(key, value, 'EX', seconds)
    if (args.length >= 2 && args[0] === "EX" && typeof args[1] === "number") {
      expiry = Date.now() + args[1] * 1000;
    }

    this.store.set(key, { value, expiry });
    return "OK";
  }

  async setex(key: string, seconds: number, value: string): Promise<"OK"> {
    const expiry = Date.now() + seconds * 1000;
    this.store.set(key, { value, expiry });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        deleted++;
      }
    }
    return deleted;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((key) => this.store.has(key)).length;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2; // Key doesn't exist

    if (!entry.expiry) return -1; // Key has no expiry

    const ttlMs = entry.expiry - Date.now();
    return Math.ceil(ttlMs / 1000);
  }

  async expire(key: string, seconds: number): Promise<0 | 1> {
    const entry = this.store.get(key);
    if (!entry) return 0;

    entry.expiry = Date.now() + seconds * 1000;
    return 1;
  }

  // ========================================================================
  // Pattern Matching
  // ========================================================================

  async keys(pattern: string): Promise<string[]> {
    // Convert glob pattern to regex
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")
          .replace(/\[/g, "\\[")
          .replace(/\]/g, "\\]") +
        "$"
    );

    // Filter out expired keys
    const validKeys = Array.from(this.store.keys()).filter((key) => {
      const entry = this.store.get(key);
      if (!entry) return false;

      // Check if expired
      if (entry.expiry && Date.now() > entry.expiry) {
        this.store.delete(key);
        return false;
      }

      return regex.test(key);
    });

    return validKeys;
  }

  async scan(
    cursor: string | number,
    ...args: unknown[]
  ): Promise<[string, string[]]> {
    let pattern = "*";
    let count = 10;

    // Parse arguments: scan(cursor, 'MATCH', pattern, 'COUNT', count)
    for (let i = 0; i < args.length; i += 2) {
      const cmd = args[i];
      const value = args[i + 1];

      if (cmd === "MATCH" && typeof value === "string") {
        pattern = value;
      } else if (cmd === "COUNT" && typeof value === "number") {
        count = value;
      }
    }

    const allKeys = await this.keys(pattern);
    const cursorNum = typeof cursor === "string" ? parseInt(cursor, 10) : cursor;
    const batch = allKeys.slice(cursorNum, cursorNum + count);
    const nextCursor =
      cursorNum + batch.length >= allKeys.length ? 0 : cursorNum + batch.length;

    return [String(nextCursor), batch];
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async info(section?: string): Promise<string> {
    // Return mock server info in Redis INFO format
    const serverInfo = [
      "# Server",
      "redis_version:7.0.0",
      "redis_mode:standalone",
      "uptime_in_seconds:3600",
      "# Clients",
      "connected_clients:1",
    ];

    return serverInfo.join("\r\n") + "\r\n";
  }

  // ========================================================================
  // Pub/Sub
  // ========================================================================

  async publish(channel: string, message: string): Promise<number> {
    const subscribers = this.subscribers.get(channel);
    if (!subscribers || subscribers.size === 0) return 0;

    for (const callback of subscribers) {
      callback(message);
    }

    return subscribers.size;
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    this.subscribers.get(channel)!.add(callback);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscribers.delete(channel);
  }

  // ========================================================================
  // Database Management
  // ========================================================================

  async flushall(): Promise<"OK"> {
    this.store.clear();
    this.subscribers.clear();
    return "OK";
  }

  async flushdb(): Promise<"OK"> {
    this.store.clear();
    return "OK";
  }

  async dbsize(): Promise<number> {
    return this.store.size;
  }

  // ========================================================================
  // Advanced Operations
  // ========================================================================

  async incr(key: string): Promise<number> {
    const current = await this.get(key);
    const value = current ? parseInt(current, 10) + 1 : 1;
    await this.set(key, String(value));
    return value;
  }

  async decr(key: string): Promise<number> {
    const current = await this.get(key);
    const value = current ? parseInt(current, 10) - 1 : -1;
    await this.set(key, String(value));
    return value;
  }

  async incrby(key: string, increment: number): Promise<number> {
    const current = await this.get(key);
    const value = current ? parseInt(current, 10) + increment : increment;
    await this.set(key, String(value));
    return value;
  }

  async hset(key: string, field: string, value: string): Promise<0 | 1> {
    const hash = await this.get(key);
    const hashObj = hash ? JSON.parse(hash) : {};
    const isNew = !(field in hashObj);
    hashObj[field] = value;
    await this.set(key, JSON.stringify(hashObj));
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const hash = await this.get(key);
    if (!hash) return null;
    const hashObj = JSON.parse(hash);
    return hashObj[field] ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = await this.get(key);
    return hash ? JSON.parse(hash) : {};
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = await this.get(key);
    if (!hash) return 0;

    const hashObj = JSON.parse(hash);
    let deleted = 0;

    for (const field of fields) {
      if (field in hashObj) {
        delete hashObj[field];
        deleted++;
      }
    }

    if (Object.keys(hashObj).length === 0) {
      await this.del(key);
    } else {
      await this.set(key, JSON.stringify(hashObj));
    }

    return deleted;
  }

  // ========================================================================
  // Connection Management (No-ops for mock)
  // ========================================================================

  async connect(): Promise<void> {
    // No-op for mock
  }

  async disconnect(): Promise<void> {
    // No-op for mock
  }

  async quit(): Promise<void> {
    this.store.clear();
    this.subscribers.clear();
  }

  // ========================================================================
  // Type Compatibility
  // ========================================================================

  // Add any missing methods needed by the app
  // These are stubs to satisfy the Redis interface
  on(event: string, listener: (...args: unknown[]) => void): this {
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return this;
  }
}

/**
 * Create mock Redis instance for testing
 */
export function createMockRedis(): Redis {
  return new MockRedis() as unknown as Redis;
}

/**
 * Helper: Wait for TTL expiration in tests
 */
export async function waitForExpiry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms + 10)); // +10ms buffer
}

/**
 * Helper: Seed mock Redis with test data
 */
export async function seedMockRedis(
  redis: Redis,
  data: Record<string, { value: string; ttl?: number }>
): Promise<void> {
  for (const [key, { value, ttl }] of Object.entries(data)) {
    if (ttl) {
      await redis.setex(key, ttl, value);
    } else {
      await redis.set(key, value);
    }
  }
}
