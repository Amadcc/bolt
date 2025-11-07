/**
 * Redis Client with Production Error Handling (LOW-4)
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Circuit breaker pattern for cascade failure prevention
 * - Connection state tracking and health monitoring
 * - Graceful degradation on errors
 * - Comprehensive event logging
 * - Metrics and statistics
 */

import Redis, { type RedisOptions } from "ioredis";
import { logger } from "./logger.js";
import { createCriticalCircuitBreaker } from "../services/blockchain/circuitBreaker.js";
import type { Result } from "../types/common.js";
import { Ok, Err } from "../types/common.js";

// ============================================================================
// Types
// ============================================================================

export type RedisConnectionState =
  | "connecting"
  | "connected"
  | "ready"
  | "reconnecting"
  | "disconnecting"
  | "disconnected"
  | "error";

export interface RedisStats {
  state: RedisConnectionState;
  isHealthy: boolean;
  totalCommands: number;
  failedCommands: number;
  reconnectAttempts: number;
  lastError?: string;
  lastErrorTime?: number;
  connectedAt?: number;
  disconnectedAt?: number;
  uptime?: number; // Milliseconds
}

// ============================================================================
// Configuration
// ============================================================================

const REDIS_CONFIG: RedisOptions = {
  // Connection
  retryStrategy: (times: number) => {
    // LOW-4: Exponential backoff with max delay
    const delay = Math.min(times * 50, 2000); // Max 2s delay
    logger.debug("Redis retry strategy", { attempt: times, delayMs: delay });
    return delay;
  },

  // Timeouts
  connectTimeout: 10000, // 10s
  commandTimeout: 5000, // 5s

  // Connection pool
  maxRetriesPerRequest: 3,

  // Reconnection
  enableOfflineQueue: true, // Queue commands while disconnected
  autoResubscribe: true,
  autoResendUnfulfilledCommands: true,

  // Keep-alive
  keepAlive: 30000, // 30s

  // Lazy connection (don't connect until first command)
  lazyConnect: false,
};

// ============================================================================
// Connection State
// ============================================================================

let connectionState: RedisConnectionState = "connecting";
let totalCommands = 0;
let failedCommands = 0;
let reconnectAttempts = 0;
let lastError: string | undefined;
let lastErrorTime: number | undefined;
let connectedAt: number | undefined;
let disconnectedAt: number | undefined;

// LOW-4: Circuit breaker for Redis operations
const redisCircuitBreaker = createCriticalCircuitBreaker("redis");

// ============================================================================
// Redis Client
// ============================================================================

export const redis = new Redis(process.env.REDIS_URL!, REDIS_CONFIG);

// ============================================================================
// Event Handlers (LOW-4: Comprehensive error handling)
// ============================================================================

redis.on("connect", () => {
  connectionState = "connected";
  logger.info("Redis connection established", {
    url: process.env.REDIS_URL?.replace(/:[^:@]+@/, ":***@"), // Redact password
  });
});

redis.on("ready", () => {
  connectionState = "ready";
  connectedAt = Date.now();
  disconnectedAt = undefined;

  logger.info("Redis client ready", {
    reconnectAttempts,
    uptimeMs: connectedAt ? Date.now() - connectedAt : 0,
  });

  // Reset circuit breaker on successful connection
  if (redisCircuitBreaker.getState() !== "closed") {
    redisCircuitBreaker.reset();
  }
});

redis.on("error", (err: Error) => {
  connectionState = "error";
  lastError = err.message;
  lastErrorTime = Date.now();
  failedCommands++;

  logger.error("Redis error", {
    error: err.message,
    stack: err.stack,
    state: connectionState,
    totalFailures: failedCommands,
  });
});

redis.on("close", () => {
  connectionState = "disconnected";
  disconnectedAt = Date.now();

  logger.warn("Redis connection closed", {
    wasConnectedFor: connectedAt ? Date.now() - connectedAt : 0,
  });
});

redis.on("reconnecting", (delay: number) => {
  connectionState = "reconnecting";
  reconnectAttempts++;

  logger.warn("Redis reconnecting", {
    attempt: reconnectAttempts,
    delayMs: delay,
  });
});

redis.on("end", () => {
  connectionState = "disconnected";
  disconnectedAt = Date.now();

  logger.warn("Redis connection ended", {
    totalReconnectAttempts: reconnectAttempts,
  });
});

// ============================================================================
// Health Monitoring (LOW-4)
// ============================================================================

/**
 * Check Redis connection health
 *
 * @returns true if Redis is connected and responsive
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const start = Date.now();

    // LOW-4: Use circuit breaker for health check
    await redisCircuitBreaker.execute(async () => {
      const pong = await redis.ping();
      if (pong !== "PONG") {
        throw new Error("Redis PING did not return PONG");
      }
    });

    const elapsed = Date.now() - start;

    logger.debug("Redis health check passed", {
      elapsedMs: elapsed,
      state: connectionState,
    });

    return true;
  } catch (error) {
    logger.error("Redis health check failed", {
      error: error instanceof Error ? error.message : String(error),
      state: connectionState,
    });
    return false;
  }
}

/**
 * Get Redis connection statistics
 */
export function getRedisStats(): RedisStats {
  return {
    state: connectionState,
    isHealthy: connectionState === "ready",
    totalCommands,
    failedCommands,
    reconnectAttempts,
    lastError,
    lastErrorTime,
    connectedAt,
    disconnectedAt,
    uptime: connectedAt ? Date.now() - connectedAt : undefined,
  };
}

/**
 * Get Redis connection state
 */
export function getRedisState(): RedisConnectionState {
  return connectionState;
}

/**
 * Check if Redis is ready for commands
 */
export function isRedisReady(): boolean {
  return connectionState === "ready";
}

// ============================================================================
// Safe Command Execution (LOW-4: Graceful degradation)
// ============================================================================

/**
 * Execute Redis command with error handling and circuit breaker
 *
 * @param operation Name of operation (for logging)
 * @param fn Redis command function
 * @returns Result with value or error
 */
export async function safeRedisCommand<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<Result<T, Error>> {
  try {
    totalCommands++;

    // LOW-4: Use circuit breaker
    const result = await redisCircuitBreaker.execute(fn);

    logger.debug("Redis command successful", { operation });
    return Ok(result);
  } catch (error) {
    failedCommands++;
    const err = error instanceof Error ? error : new Error(String(error));

    logger.error("Redis command failed", {
      operation,
      error: err.message,
      state: connectionState,
      failureRate: ((failedCommands / totalCommands) * 100).toFixed(2) + "%",
    });

    return Err(err);
  }
}

// ============================================================================
// SCAN Helper (MEDIUM-6 + LOW-4)
// ============================================================================

/**
 * MEDIUM-6: Non-blocking SCAN helper (replaces blocking KEYS)
 * LOW-4: Added error handling and circuit breaker
 *
 * Iterates through all keys matching pattern using cursor-based SCAN.
 * This is non-blocking and safe for production use.
 *
 * @param pattern Redis key pattern (e.g., "session:*")
 * @param count Number of keys to scan per iteration (default: 100)
 * @returns Result with array of matching keys or error
 */
export async function redisScan(
  pattern: string,
  count: number = 100
): Promise<Result<string[], Error>> {
  const result = await safeRedisCommand("SCAN", async () => {
    const keys: string[] = [];
    let cursor = "0";

    do {
      // SCAN returns [cursor, keys]
      const [nextCursor, batch] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        count
      );

      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");

    return keys;
  });

  return result;
}

// ============================================================================
// Graceful Shutdown (LOW-4)
// ============================================================================

/**
 * Gracefully disconnect from Redis
 *
 * - Waits for pending commands to complete
 * - Closes connection cleanly
 * - Updates connection state
 */
export async function disconnectRedis(): Promise<void> {
  try {
    connectionState = "disconnecting";

    logger.info("Disconnecting from Redis", {
      totalCommands,
      failedCommands,
      reconnectAttempts,
      uptime: connectedAt ? Date.now() - connectedAt : 0,
    });

    await redis.quit();

    connectionState = "disconnected";
    disconnectedAt = Date.now();

    logger.info("Redis disconnected successfully");
  } catch (error) {
    logger.error("Error during Redis disconnect", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Force disconnect if graceful quit fails
    redis.disconnect();
  }
}

/**
 * Force disconnect from Redis (emergency shutdown)
 */
export function forceDisconnectRedis(): void {
  logger.warn("Force disconnecting from Redis");
  redis.disconnect();
  connectionState = "disconnected";
  disconnectedAt = Date.now();
}
