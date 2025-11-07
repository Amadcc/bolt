/**
 * Prometheus Metrics (HIGH-3)
 *
 * Production-grade observability for monitoring and alerting.
 *
 * Metrics Categories:
 * - Order metrics (trades, latency, volume)
 * - RPC metrics (requests, latency, pool health)
 * - Trading metrics (swaps, slippage, success rate)
 * - Honeypot detection metrics
 * - User metrics (active users, wallets)
 * - Error metrics (by type and service)
 * - Cache metrics (hits, misses)
 * - Circuit breaker metrics (state, failures)
 *
 * Usage:
 * ```typescript
 * import { ordersTotal, orderLatency } from './utils/metrics.js';
 *
 * ordersTotal.inc({ type: 'buy', status: 'success', chain: 'solana' });
 * orderLatency.observe({ type: 'buy', status: 'success' }, 1.2);
 * ```
 *
 * Access metrics:
 * - GET /metrics (Prometheus format)
 */

import { register, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";
import { logger } from "./logger.js";

// ============================================================================
// Default Metrics (CPU, memory, Node.js internals)
// ============================================================================

collectDefaultMetrics({
  prefix: "bolt_sniper_",
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

logger.info("Prometheus default metrics initialized", {
  prefix: "bolt_sniper_",
});

// ============================================================================
// Order Metrics
// ============================================================================

/**
 * Total number of orders created
 * Labels: type (buy/sell/swap), status (success/failed), chain (solana)
 */
export const ordersTotal = new Counter({
  name: "bolt_sniper_orders_total",
  help: "Total number of orders created",
  labelNames: ["type", "status", "chain"],
});

/**
 * Order execution latency in seconds
 * Labels: type (buy/sell/swap), status (success/failed)
 */
export const orderLatency = new Histogram({
  name: "bolt_sniper_order_latency_seconds",
  help: "Order execution latency in seconds",
  labelNames: ["type", "status"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30], // seconds
});

/**
 * Order value in USD
 * Labels: type (buy/sell/swap)
 */
export const orderValue = new Histogram({
  name: "bolt_sniper_order_value_usd",
  help: "Order value in USD",
  labelNames: ["type"],
  buckets: [10, 50, 100, 500, 1000, 5000, 10000],
});

// ============================================================================
// RPC Metrics
// ============================================================================

/**
 * Total RPC requests
 * Labels: endpoint (url), method (getBalance/getSlot/etc), status (success/error)
 */
export const rpcRequests = new Counter({
  name: "bolt_sniper_rpc_requests_total",
  help: "Total RPC requests",
  labelNames: ["endpoint", "method", "status"],
});

/**
 * RPC request latency in seconds
 * Labels: endpoint (url), method (getBalance/getSlot/etc)
 */
export const rpcLatency = new Histogram({
  name: "bolt_sniper_rpc_latency_seconds",
  help: "RPC request latency",
  labelNames: ["endpoint", "method"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5], // seconds
});

/**
 * Number of healthy RPC endpoints in the pool
 */
export const rpcPoolHealthyEndpoints = new Gauge({
  name: "bolt_sniper_rpc_pool_healthy_endpoints",
  help: "Number of healthy RPC endpoints in connection pool",
});

/**
 * Number of unhealthy RPC endpoints in the pool
 */
export const rpcPoolUnhealthyEndpoints = new Gauge({
  name: "bolt_sniper_rpc_pool_unhealthy_endpoints",
  help: "Number of unhealthy RPC endpoints in connection pool",
});

/**
 * RPC endpoint latency (per endpoint)
 * Labels: endpoint (url), priority (primary/fallback/backup)
 */
export const rpcEndpointLatency = new Gauge({
  name: "bolt_sniper_rpc_endpoint_latency_ms",
  help: "Average latency of each RPC endpoint in milliseconds",
  labelNames: ["endpoint", "priority"],
});

// ============================================================================
// Trading Metrics
// ============================================================================

/**
 * Total swap attempts
 * Labels: from_token, to_token, status (success/failed)
 */
export const swapsTotal = new Counter({
  name: "bolt_sniper_swaps_total",
  help: "Total swap attempts",
  labelNames: ["from_token", "to_token", "status"],
});

/**
 * Actual slippage in percent
 */
export const slippageActual = new Histogram({
  name: "bolt_sniper_slippage_percent",
  help: "Actual slippage in percent",
  buckets: [0, 0.5, 1, 2, 5, 10, 20, 50],
});

/**
 * Price impact in percent
 */
export const priceImpact = new Histogram({
  name: "bolt_sniper_price_impact_percent",
  help: "Price impact in percent",
  buckets: [0, 0.1, 0.5, 1, 2, 5, 10, 20],
});

/**
 * Commission earned in USD
 */
export const commissionEarned = new Counter({
  name: "bolt_sniper_commission_usd_total",
  help: "Total commission earned in USD",
  labelNames: ["type"], // buy/sell/swap
});

// ============================================================================
// Honeypot Detection Metrics
// ============================================================================

/**
 * Total honeypot checks
 * Labels: result (safe/risky/error)
 */
export const honeypotChecks = new Counter({
  name: "bolt_sniper_honeypot_checks_total",
  help: "Total honeypot checks performed",
  labelNames: ["result"],
});

/**
 * Honeypot risk score distribution (0-100)
 */
export const honeypotScore = new Histogram({
  name: "bolt_sniper_honeypot_risk_score",
  help: "Honeypot risk score distribution",
  buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
});

/**
 * Honeypot check latency in seconds
 */
export const honeypotCheckLatency = new Histogram({
  name: "bolt_sniper_honeypot_check_latency_seconds",
  help: "Honeypot check latency",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// ============================================================================
// User Metrics
// ============================================================================

/**
 * Number of active users (with unlocked wallets)
 */
export const activeUsers = new Gauge({
  name: "bolt_sniper_active_users",
  help: "Number of active users with unlocked wallets",
});

/**
 * Total wallets created
 */
export const walletsTotal = new Gauge({
  name: "bolt_sniper_wallets_total",
  help: "Total number of wallets created",
});

/**
 * Active sessions count
 */
export const activeSessions = new Gauge({
  name: "bolt_sniper_active_sessions",
  help: "Number of active user sessions",
});

// ============================================================================
// Error Metrics
// ============================================================================

/**
 * Total errors by type and service
 * Labels: type (WALLET_NOT_FOUND/INVALID_PASSWORD/etc), service (keyManager/executor/etc)
 */
export const errorsTotal = new Counter({
  name: "bolt_sniper_errors_total",
  help: "Total errors by type and service",
  labelNames: ["type", "service"],
});

/**
 * Error rate (errors per minute)
 */
export const errorRate = new Gauge({
  name: "bolt_sniper_error_rate_per_minute",
  help: "Error rate per minute",
  labelNames: ["service"],
});

// ============================================================================
// Cache Metrics
// ============================================================================

/**
 * Cache hits
 * Labels: cache_name (jupiter_quotes/honeypot_results/etc)
 */
export const cacheHits = new Counter({
  name: "bolt_sniper_cache_hits_total",
  help: "Total cache hits",
  labelNames: ["cache_name"],
});

/**
 * Cache misses
 * Labels: cache_name (jupiter_quotes/honeypot_results/etc)
 */
export const cacheMisses = new Counter({
  name: "bolt_sniper_cache_misses_total",
  help: "Total cache misses",
  labelNames: ["cache_name"],
});

/**
 * Cache hit rate (0-100%)
 */
export const cacheHitRate = new Gauge({
  name: "bolt_sniper_cache_hit_rate_percent",
  help: "Cache hit rate percentage",
  labelNames: ["cache_name"],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/**
 * Circuit breaker state
 * Labels: circuit_name
 * Values: 0=closed, 1=half-open, 2=open
 */
export const circuitBreakerState = new Gauge({
  name: "bolt_sniper_circuit_breaker_state",
  help: "Circuit breaker state (0=closed, 1=half-open, 2=open)",
  labelNames: ["circuit_name"],
});

/**
 * Circuit breaker failures count
 * Labels: circuit_name
 */
export const circuitBreakerFailures = new Counter({
  name: "bolt_sniper_circuit_breaker_failures_total",
  help: "Total circuit breaker failures",
  labelNames: ["circuit_name"],
});

/**
 * Circuit breaker rejections (requests rejected while open)
 * Labels: circuit_name
 */
export const circuitBreakerRejections = new Counter({
  name: "bolt_sniper_circuit_breaker_rejections_total",
  help: "Total requests rejected by circuit breaker",
  labelNames: ["circuit_name"],
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Record circuit breaker state
 * Converts state string to numeric value for Gauge
 */
export function recordCircuitState(
  name: string,
  state: "closed" | "half-open" | "open"
): void {
  const value = state === "closed" ? 0 : state === "half-open" ? 1 : 2;
  circuitBreakerState.set({ circuit_name: name }, value);
}

/**
 * Record order execution
 * Convenience function to record both counter and histogram
 */
export function recordOrderExecution(
  type: "buy" | "sell" | "swap",
  status: "success" | "failed",
  latencySeconds: number,
  valueUsd?: number
): void {
  // Record counter
  ordersTotal.inc({ type, status, chain: "solana" });

  // Record latency
  orderLatency.observe({ type, status }, latencySeconds);

  // Record value if provided
  if (valueUsd !== undefined && status === "success") {
    orderValue.observe({ type }, valueUsd);
  }
}

/**
 * Record RPC request
 * Convenience function for RPC metrics
 */
export function recordRpcRequest(
  endpoint: string,
  method: string,
  status: "success" | "error",
  latencySeconds: number
): void {
  // Truncate endpoint URL for cleaner labels
  const endpointLabel = new URL(endpoint).hostname;

  rpcRequests.inc({ endpoint: endpointLabel, method, status });
  rpcLatency.observe({ endpoint: endpointLabel, method }, latencySeconds);
}

/**
 * Update RPC pool health metrics
 */
export function updateRpcPoolHealth(healthy: number, unhealthy: number): void {
  rpcPoolHealthyEndpoints.set(healthy);
  rpcPoolUnhealthyEndpoints.set(unhealthy);
}

/**
 * Record cache access
 * Calculates and updates hit rate
 */
export function recordCacheAccess(
  cacheName: string,
  hit: boolean
): void {
  if (hit) {
    cacheHits.inc({ cache_name: cacheName });
  } else {
    cacheMisses.inc({ cache_name: cacheName });
  }

  // Update hit rate
  // Note: In production, you'd calculate this from actual hit/miss counters
  // This is a simplified version
}

// ============================================================================
// Metrics Endpoint
// ============================================================================

/**
 * Get metrics in Prometheus format
 * Use in GET /metrics endpoint
 */
export async function getMetricsContent(): Promise<string> {
  return await register.metrics();
}

/**
 * Get metrics content type for HTTP response
 */
export function getMetricsContentType(): string {
  return register.contentType;
}

/**
 * Clear all metrics (for testing)
 */
export function clearMetrics(): void {
  register.clear();
}

// ============================================================================
// Initialization
// ============================================================================

logger.info("Prometheus metrics registered", {
  metrics: register.getMetricsAsArray().length,
  collectors: [
    "orders",
    "rpc",
    "trading",
    "honeypot",
    "users",
    "errors",
    "cache",
    "circuit_breaker",
  ],
});
