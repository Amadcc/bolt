/**
 * Production-Ready Redis Client
 *
 * Features:
 * - Exponential backoff retry strategy
 * - TLS support for production (rediss://)
 * - Connection pooling and keepAlive
 * - Comprehensive event handlers with structured logging
 * - Error throttling to prevent log spam
 * - Health check with latency monitoring
 * - Graceful shutdown support
 */

import Redis, { type RedisOptions } from "ioredis";
import { logger } from "./logger.js";
import {
  setRedisConnectionStatus,
  trackRedisCommand,
} from "./metrics.js";

// ============================================================================
// Configuration
// ============================================================================

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

// Timeouts
const CONNECTION_TIMEOUT_MS = 10000; // 10 seconds
const COMMAND_TIMEOUT_MS = 5000; // 5 seconds
const KEEP_ALIVE_MS = 30000; // 30 seconds

// Retry configuration
const MAX_RETRY_ATTEMPTS = 10;
const RETRY_BASE_DELAY_MS = 200; // Start with 200ms
const RETRY_MAX_DELAY_MS = 10000; // Cap at 10 seconds

// Error throttling
let lastErrorLogTime = 0;
const ERROR_THROTTLE_MS = 5000; // Max one error log per 5 seconds

// Reconnection tracking
let reconnectCount = 0;

// ============================================================================
// Redis Options
// ============================================================================

const redisOptions: RedisOptions = {
  // Connection
  connectTimeout: CONNECTION_TIMEOUT_MS,
  commandTimeout: COMMAND_TIMEOUT_MS,
  keepAlive: KEEP_ALIVE_MS,

  // Reconnection strategy with exponential backoff
  retryStrategy(times: number): number | null {
    if (times > MAX_RETRY_ATTEMPTS) {
      logger.error("Redis max retry attempts reached", {
        attempts: times,
        maxAttempts: MAX_RETRY_ATTEMPTS,
      });
      return null; // Stop retrying
    }

    // Exponential backoff: 200ms, 400ms, 800ms, 1600ms, ..., max 10s
    const delay = Math.min(
      RETRY_BASE_DELAY_MS * Math.pow(2, times - 1),
      RETRY_MAX_DELAY_MS
    );

    logger.debug("Redis retry scheduled", {
      attempt: times,
      delayMs: delay,
    });

    return delay;
  },

  // Reconnect on specific errors
  reconnectOnError(err: Error): boolean | 1 | 2 {
    const targetErrors = ["READONLY", "ECONNRESET", "ETIMEDOUT"];
    const shouldReconnect = targetErrors.some((target) =>
      err.message.includes(target)
    );

    if (shouldReconnect) {
      logger.warn("Redis reconnecting due to error", {
        errorMessage: err.message,
      });
      return true; // Reconnect
    }

    return false; // Don't reconnect for other errors
  },

  // TLS configuration for production
  ...(IS_PRODUCTION && REDIS_URL.startsWith("rediss://")
    ? {
        tls: {
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
      }
    : {}),

  // Lazy connect - allows app to start even if Redis is down
  lazyConnect: false,

  // Enable offline queue
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3,
};

// ============================================================================
// Redis Client
// ============================================================================

export const redis = new Redis(REDIS_URL, redisOptions);
setRedisConnectionStatus(false);

const originalSendCommand = redis.sendCommand.bind(redis);
redis.sendCommand = function patchedSendCommand(command: any, ...args: any[]) {
  const commandName =
    (command?.name as string | undefined)?.toLowerCase() ?? "unknown";
  const start = Date.now();
  const result = originalSendCommand(
    command,
    ...args
  ) as Promise<unknown>;

  result
    .then(() => {
      trackRedisCommand(commandName, Date.now() - start);
    })
    .catch(() => {
      trackRedisCommand(commandName, Date.now() - start);
    });

  return result;
};

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Throttled error logging to prevent log spam
 */
function logErrorThrottled(message: string, context: object): void {
  const now = Date.now();
  if (now - lastErrorLogTime >= ERROR_THROTTLE_MS) {
    logger.error(message, context);
    lastErrorLogTime = now;
  }
}

/**
 * Connection established (before ready)
 */
redis.on("connect", () => {
  logger.info("Redis connection established", {
    url: REDIS_URL.replace(/:[^:@]+@/, ":***@"), // Redact password
    env: NODE_ENV,
  });
});

/**
 * Ready to accept commands
 */
redis.on("ready", () => {
  reconnectCount = 0; // Reset counter on successful connection

  logger.info("Redis ready to accept commands", {
    tls: IS_PRODUCTION && REDIS_URL.startsWith("rediss://"),
  });
  setRedisConnectionStatus(true);
});

/**
 * Reconnecting after connection loss
 */
redis.on("reconnecting", (timeUntilReconnect: number) => {
  reconnectCount++;

  logger.warn("Redis reconnecting", {
    reconnectCount,
    timeUntilReconnectMs: timeUntilReconnect,
  });
});

/**
 * Connection closed
 */
redis.on("close", () => {
  logger.warn("Redis connection closed");
  setRedisConnectionStatus(false);
});

/**
 * Connection ended (manual disconnect or max retries)
 */
redis.on("end", () => {
  logger.warn("Redis connection ended", {
    reconnectCount,
  });
  setRedisConnectionStatus(false);
});

/**
 * Error occurred (throttled)
 */
redis.on("error", (err: Error) => {
  logErrorThrottled("Redis error occurred", {
    error: err.message,
    name: err.name,
    reconnectCount,
  });
});

// ============================================================================
// Health Check Types
// ============================================================================

export interface RedisHealthStatus {
  healthy: boolean;
  latencyMs?: number;
  serverInfo?: {
    version: string;
    mode: string;
    uptimeSeconds: number;
    connectedClients: number;
  };
  error?: string;
}

// ============================================================================
// Health Check Function
// ============================================================================

/**
 * Check Redis health with latency monitoring
 *
 * Executes PING command and retrieves server info
 * Returns detailed health status including latency
 */
export async function checkRedisHealth(): Promise<RedisHealthStatus> {
  try {
    // Measure PING latency
    const startTime = Date.now();
    const pingResult = await redis.ping();
    const latencyMs = Date.now() - startTime;

    if (pingResult !== "PONG") {
      return {
        healthy: false,
        error: `Unexpected PING response: ${pingResult}`,
      };
    }

    // Get server info
    const infoStr = await redis.info("server");

    // Parse server info (format: "key:value\r\n")
    const infoLines = infoStr.split("\r\n");
    const infoMap: Record<string, string> = {};

    for (const line of infoLines) {
      if (line && !line.startsWith("#")) {
        const [key, value] = line.split(":");
        if (key && value) {
          infoMap[key] = value;
        }
      }
    }

    const serverInfo = {
      version: infoMap.redis_version || "unknown",
      mode: infoMap.redis_mode || "unknown",
      uptimeSeconds: parseInt(infoMap.uptime_in_seconds || "0", 10),
      connectedClients: parseInt(infoMap.connected_clients || "0", 10),
    };

    logger.debug("Redis health check passed", {
      latencyMs,
      serverInfo,
    });

    return {
      healthy: true,
      latencyMs,
      serverInfo,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    logger.error("Redis health check failed", {
      error: errorMessage,
    });

    return {
      healthy: false,
      error: errorMessage,
    };
  }
}

// ============================================================================
// Non-Blocking Key Scanning (Production-Safe Alternative to KEYS)
// ============================================================================

/**
 * Scan keys matching pattern using non-blocking SCAN command
 *
 * ⚠️ NEVER use redis.keys() in production - it blocks Redis!
 * Use this function instead - it uses cursor-based iteration.
 *
 * Performance:
 * - redis.keys("*"): O(N) - BLOCKS Redis for entire duration
 * - scanKeys("*"): O(N) - Returns in small batches, NO blocking
 *
 * @param pattern - Redis pattern (e.g., "session:*", "user:*:tokens")
 * @param count - Hint for batch size (default 100). Redis may return more/fewer.
 * @returns Array of all matching keys
 *
 * Example:
 * ```typescript
 * // BAD (blocks Redis):
 * const keys = await redis.keys("session:*");
 *
 * // GOOD (non-blocking):
 * const keys = await scanKeys("session:*");
 * ```
 */
export async function scanKeys(
  pattern: string,
  count: number = 100
): Promise<string[]> {
  const allKeys: string[] = [];
  let cursor = "0";

  logger.debug("Starting non-blocking SCAN", { pattern, count });

  do {
    // SCAN returns [nextCursor, keys]
    // cursor "0" means iteration complete
    const result = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      count.toString()
    );

    const [nextCursor, keys] = result;

    cursor = nextCursor;
    allKeys.push(...keys);

    logger.debug("SCAN iteration", {
      cursor,
      keysFound: keys.length,
      totalSoFar: allKeys.length,
    });
  } while (cursor !== "0");

  logger.debug("SCAN complete", {
    pattern,
    totalKeys: allKeys.length,
  });

  return allKeys;
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Close Redis connection gracefully
 *
 * Waits for pending commands with timeout, then closes connection
 * Falls back to disconnect() if quit() times out
 */
export async function closeRedis(): Promise<void> {
  const SHUTDOWN_TIMEOUT_MS = 5000; // 5 seconds max

  logger.info("Closing Redis connection...");

  try {
    // Create timeout promise
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Redis shutdown timeout"));
      }, SHUTDOWN_TIMEOUT_MS);
    });

    // Race between graceful quit and timeout
    await Promise.race([
      redis.quit(), // Graceful close (waits for pending commands)
      timeoutPromise,
    ]);

    logger.info("Redis connection closed gracefully");
  } catch (error) {
    if (error instanceof Error && error.message === "Redis shutdown timeout") {
      logger.warn("Redis graceful shutdown timed out, forcing disconnect");

      // Force disconnect
      redis.disconnect();

      logger.info("Redis connection force disconnected");
    } else {
      logger.error("Error during Redis shutdown", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Force disconnect as fallback
      redis.disconnect();
    }
  }
}
