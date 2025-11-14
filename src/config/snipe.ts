/**
 * Snipe Configuration Constants
 *
 * Centralized configuration for all sniper-related timeouts and limits.
 * Optimized for production speed and reliability.
 */

// ============================================================================
// HONEYPOT DETECTION
// ============================================================================

/**
 * Honeypot check timeout (milliseconds)
 *
 * Increased from 2s to 5s for better success rate:
 * - GoPlus API typically responds in 1-3s
 * - RugCheck API typically responds in 3-5s
 * - Total with fallback: 5-10s (acceptable for safety)
 *
 * @recommended 5000ms (5 seconds)
 */
export const HONEYPOT_TIMEOUT_MS = parseInt(
  process.env.HONEYPOT_TIMEOUT_MS || "5000",
  10
);

/**
 * Honeypot cache TTL (seconds)
 *
 * How long to cache honeypot results in Redis.
 * Longer = faster subsequent checks, but may miss updates.
 *
 * @recommended 3600 (1 hour)
 */
export const HONEYPOT_CACHE_TTL_SECONDS = 3600;

/**
 * Risk score thresholds (0-100 scale)
 */
export const RISK_THRESHOLDS = {
  /** Tokens with score >= 70 are considered high risk (auto-reject) */
  HIGH_RISK: 70,

  /** Tokens with score >= 30 are considered medium risk (warn user) */
  MEDIUM_RISK: 30,

  /** Tokens with score < 30 are considered safe */
  LOW_RISK: 30,
} as const;

// ============================================================================
// QUOTE & SWAP
// ============================================================================

/**
 * Jupiter quote cache TTL (milliseconds)
 *
 * How long to cache swap quotes. Must be short due to:
 * - Rapidly changing prices
 * - Slippage accumulation over time
 *
 * @recommended 2000ms (2 seconds)
 */
export const QUOTE_CACHE_TTL_MS = 2000;

/**
 * Swap execution timeout (milliseconds)
 *
 * Maximum time to wait for swap transaction confirmation.
 * Longer = more reliable, but slower user experience.
 *
 * @recommended 30000ms (30 seconds)
 */
export const SWAP_CONFIRMATION_TIMEOUT_MS = 30000;

/**
 * Maximum swap retries on failure
 *
 * Number of times to retry failed swaps before giving up.
 *
 * @recommended 3
 */
export const MAX_SWAP_RETRIES = 3;

// ============================================================================
// RATE LIMITING
// ============================================================================

/**
 * Rate limit windows (seconds)
 */
export const RATE_LIMIT_WINDOWS = {
  /** Hourly rate limit window */
  HOUR: 3600,

  /** Daily rate limit window */
  DAY: 86400,
} as const;

/**
 * Default rate limits (per user)
 */
export const DEFAULT_RATE_LIMITS = {
  /** Maximum buys per hour (0 = unlimited) */
  BUYS_PER_HOUR: 15,

  /** Maximum buys per day (0 = unlimited) */
  BUYS_PER_DAY: 50,
} as const;

// ============================================================================
// AUTOMATION
// ============================================================================

/**
 * Automation lease TTL (seconds)
 *
 * How long a user's private key stays decrypted in Redis
 * for auto-trading. Shorter = more secure, but requires
 * more frequent password re-entry.
 *
 * @recommended 900 (15 minutes)
 */
export const AUTOMATION_LEASE_TTL_SECONDS = parseInt(
  process.env.PASSWORD_REUSE_TTL_SECONDS || "900",
  10
);

/**
 * Maximum concurrent executions per user
 *
 * Prevents race conditions where same user tries to
 * snipe multiple tokens simultaneously.
 *
 * @recommended 1 (sequential only)
 */
export const MAX_CONCURRENT_EXECUTIONS_PER_USER = 1;

// ============================================================================
// DISCOVERY
// ============================================================================

/**
 * WebSocket reconnect configuration
 */
export const WEBSOCKET_CONFIG = {
  /** Maximum reconnection attempts before giving up */
  MAX_RECONNECTS: 10,

  /** Base delay between reconnects (milliseconds) */
  RECONNECT_DELAY_MS: 5000,

  /** Whether to use exponential backoff */
  EXPONENTIAL_BACKOFF: true,
} as const;

/**
 * Token event deduplication window (milliseconds)
 *
 * Prevents processing the same token multiple times
 * if it appears on multiple discovery sources.
 *
 * @recommended 60000ms (1 minute)
 */
export const EVENT_DEDUPLICATION_WINDOW_MS = 60000;

// ============================================================================
// PERFORMANCE TUNING
// ============================================================================

/**
 * Batch operations configuration
 */
export const BATCH_CONFIG = {
  /** Maximum active configs to fetch per orchestrator cycle */
  MAX_ACTIVE_CONFIGS_BATCH: 100,

  /** Redis pipeline batch size */
  REDIS_PIPELINE_SIZE: 100,
} as const;

/**
 * Parallel execution limits
 */
export const PARALLELISM = {
  /** Maximum parallel honeypot checks (per token) */
  HONEYPOT_PROVIDERS: 3,

  /** Maximum parallel token processing (orchestrator) */
  TOKEN_PROCESSING: 10,
} as const;

// ============================================================================
// HEALTH & MONITORING
// ============================================================================

/**
 * Health check intervals (milliseconds)
 */
export const HEALTH_CHECK_INTERVALS = {
  /** RPC endpoint health checks */
  RPC_POOL: 30000,

  /** Database connection health */
  DATABASE: 60000,

  /** Redis connection health */
  REDIS: 30000,
} as const;

/**
 * Metric retention (seconds)
 */
export const METRIC_RETENTION = {
  /** How long to keep latency samples */
  LATENCY_SAMPLES: 300, // 5 minutes

  /** How long to keep circuit breaker history */
  CIRCUIT_BREAKER_HISTORY: 120, // 2 minutes
} as const;

// ============================================================================
// VALIDATION
// ============================================================================

// Validate critical configs at startup
if (HONEYPOT_TIMEOUT_MS < 1000) {
  throw new Error(
    `HONEYPOT_TIMEOUT_MS too low: ${HONEYPOT_TIMEOUT_MS}ms (minimum 1000ms)`
  );
}

if (HONEYPOT_TIMEOUT_MS > 30000) {
  throw new Error(
    `HONEYPOT_TIMEOUT_MS too high: ${HONEYPOT_TIMEOUT_MS}ms (maximum 30000ms)`
  );
}

if (AUTOMATION_LEASE_TTL_SECONDS < 60) {
  throw new Error(
    `AUTOMATION_LEASE_TTL_SECONDS too low: ${AUTOMATION_LEASE_TTL_SECONDS}s (minimum 60s)`
  );
}

console.log("✅ Snipe configuration validated successfully");
console.log(`   - Honeypot timeout: ${HONEYPOT_TIMEOUT_MS}ms`);
console.log(`   - Quote cache TTL: ${QUOTE_CACHE_TTL_MS}ms`);
console.log(`   - Automation lease: ${AUTOMATION_LEASE_TTL_SECONDS}s`);
