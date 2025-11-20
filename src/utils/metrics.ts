import client from "prom-client";

const register = new client.Registry();

client.collectDefaultMetrics({
  register,
  prefix: "bolt_",
});

// ---------------------------------------------------------------------------
// Metric Definitions
// ---------------------------------------------------------------------------

const rpcRequestDuration = new client.Histogram({
  name: "rpc_request_duration_ms",
  help: "Latency of Solana RPC requests",
  labelNames: ["endpoint", "method", "status"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000],
  registers: [register],
});

const tradesTotal = new client.Counter({
  name: "trades_total",
  help: "Total trades requested",
  labelNames: ["side"],
  registers: [register],
});

const tradesSuccessTotal = new client.Counter({
  name: "trades_success_total",
  help: "Successful trades",
  labelNames: ["side"],
  registers: [register],
});

const tradesFailedTotal = new client.Counter({
  name: "trades_failed_total",
  help: "Failed trades",
  labelNames: ["side", "reason"],
  registers: [register],
});

const tradeExecutionDuration = new client.Histogram({
  name: "trade_execution_duration_ms",
  help: "Duration of trade execution pipeline",
  labelNames: ["side"],
  buckets: [50, 100, 250, 500, 1000, 2000, 4000, 10000],
  registers: [register],
});

const tradeCommissionUsd = new client.Histogram({
  name: "trade_commission_usd",
  help: "Commission amounts in USD",
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

const errorsTotal = new client.Counter({
  name: "errors_total",
  help: "Total errors grouped by type",
  labelNames: ["type"],
  registers: [register],
});

const walletUnlockFailures = new client.Counter({
  name: "wallet_unlock_failures_total",
  help: "Wallet unlock failures",
  registers: [register],
});

const honeypotDetections = new client.Counter({
  name: "honeypot_detections_total",
  help: "Detected honeypots grouped by risk",
  labelNames: ["risk"],
  registers: [register],
});

const activeSessionsGauge = new client.Gauge({
  name: "active_sessions",
  help: "Number of active wallet sessions",
  registers: [register],
});

const databaseConnectionsGauge = new client.Gauge({
  name: "database_connections",
  help: "Concurrent Prisma operations",
  registers: [register],
});

const redisConnectionsGauge = new client.Gauge({
  name: "redis_connections",
  help: "Redis client connection status",
  registers: [register],
});

const databaseQueryDuration = new client.Histogram({
  name: "database_query_duration_ms",
  help: "Duration of Prisma queries",
  labelNames: ["model", "action"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

const redisCommandDuration = new client.Histogram({
  name: "redis_command_duration_ms",
  help: "Duration of Redis commands",
  labelNames: ["command"],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [register],
});

const honeypotApiRequests = new client.Counter({
  name: "honeypot_api_requests_total",
  help: "Total honeypot API requests by provider",
  labelNames: ["provider", "status"],
  registers: [register],
});

const honeypotApiDuration = new client.Histogram({
  name: "honeypot_api_duration_ms",
  help: "Duration of honeypot API requests",
  labelNames: ["provider"],
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [register],
});

const circuitBreakerState = new client.Gauge({
  name: "circuit_breaker_state",
  help: "Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)",
  labelNames: ["provider"],
  registers: [register],
});

const circuitBreakerTransitions = new client.Counter({
  name: "circuit_breaker_transitions_total",
  help: "Circuit breaker state transitions",
  labelNames: ["provider", "from", "to"],
  registers: [register],
});

const honeypotFallbackChain = new client.Counter({
  name: "honeypot_fallback_chain_total",
  help: "Fallback chain executions",
  labelNames: ["successful_provider", "attempts"],
  registers: [register],
});

const sniperPoolsDetected = new client.Counter({
  name: "sniper_pools_detected_total",
  help: "Total detected pools grouped by DEX",
  labelNames: ["dex"],
  registers: [register],
});

const sniperPoolDetectionDuplicates = new client.Counter({
  name: "sniper_pool_detection_duplicates_total",
  help: "Duplicate detection events prevented",
  labelNames: ["dex"],
  registers: [register],
});

const sniperPoolDetectionLatency = new client.Histogram({
  name: "sniper_pool_detection_latency_ms",
  help: "Latency between block time and detection emission",
  labelNames: ["dex"],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

export function observeRpcRequest(
  endpoint: string,
  method: string,
  durationMs: number,
  status: "ok" | "error"
): void {
  rpcRequestDuration.labels(endpoint, method, status).observe(durationMs);
}

export function recordTradeRequested(side: string): void {
  tradesTotal.labels(side).inc();
}

export function recordTradeSuccess(
  side: string,
  durationMs: number,
  commissionUsd: number
): void {
  tradesSuccessTotal.labels(side).inc();
  tradeExecutionDuration.labels(side).observe(durationMs);
  tradeCommissionUsd.observe(Math.max(commissionUsd, 0));
}

export function recordTradeFailure(
  side: string,
  durationMs: number,
  reason: string
): void {
  tradesFailedTotal.labels(side, reason).inc();
  tradeExecutionDuration.labels(side).observe(durationMs);
}

export function recordError(type: string): void {
  errorsTotal.labels(type).inc();
}

export function incrementWalletUnlockFailures(): void {
  walletUnlockFailures.inc();
  recordError("wallet_unlock");
}

export function recordHoneypotDetection(risk: "low" | "medium" | "high"): void {
  honeypotDetections.labels(risk).inc();
}

export function incrementActiveSessions(): void {
  activeSessionsGauge.inc();
}

export function decrementActiveSessions(): void {
  activeSessionsGauge.dec();
}

export function trackDatabaseQuery(
  model: string,
  action: string,
  durationMs: number
): void {
  databaseQueryDuration.labels(model, action).observe(durationMs);
}

export function incrementDbActivity(): void {
  databaseConnectionsGauge.inc();
}

export function decrementDbActivity(): void {
  databaseConnectionsGauge.dec();
}

export function setRedisConnectionStatus(connected: boolean): void {
  redisConnectionsGauge.set(connected ? 1 : 0);
}

export function trackRedisCommand(command: string, durationMs: number): void {
  redisCommandDuration.labels(command).observe(durationMs);
}

export function recordHoneypotApiRequest(
  provider: string,
  status: "success" | "failure" | "timeout" | "circuit_open",
  durationMs: number
): void {
  honeypotApiRequests.labels(provider, status).inc();
  if (status === "success" || status === "failure") {
    honeypotApiDuration.labels(provider).observe(durationMs);
  }
}

export function setCircuitBreakerState(
  provider: string,
  state: "CLOSED" | "HALF_OPEN" | "OPEN"
): void {
  const stateValue = state === "CLOSED" ? 0 : state === "HALF_OPEN" ? 1 : 2;
  circuitBreakerState.labels(provider).set(stateValue);
}

export function recordCircuitBreakerTransition(
  provider: string,
  from: string,
  to: string
): void {
  circuitBreakerTransitions.labels(provider, from, to).inc();
}

export function recordHoneypotFallbackChain(
  successfulProvider: string | "none",
  attempts: number
): void {
  honeypotFallbackChain.labels(successfulProvider, attempts.toString()).inc();
}

export function recordPoolDetection(dex: string): void {
  sniperPoolsDetected.labels(dex).inc();
}

export function recordPoolDetectionDuplicate(dex: string): void {
  sniperPoolDetectionDuplicates.labels(dex).inc();
}

export function observePoolDetectionLatency(dex: string, latencyMs: number): void {
  sniperPoolDetectionLatency.labels(dex).observe(Math.max(latencyMs, 0));
}

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export const metricsRegistry = register;
