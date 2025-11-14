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

const snipeOpportunities = new client.Counter({
  name: "snipe_opportunities_total",
  help: "Auto-snipe opportunities by result",
  labelNames: ["result"],
  registers: [register],
});

const snipeExecutions = new client.Counter({
  name: "snipe_executions_total",
  help: "Auto-snipe execution outcomes",
  labelNames: ["status"],
  registers: [register],
});

const snipeAnalysisDuration = new client.Histogram({
  name: "snipe_analysis_duration_ms",
  help: "Duration of honeypot analysis for auto-snipe",
  buckets: [50, 100, 200, 500, 1000, 2000, 4000],
  registers: [register],
});

const snipeDiscoveryEvents = new client.Counter({
  name: "snipe_discovery_events_total",
  help: "Discovery events emitted by auto-snipe sources",
  labelNames: ["source", "status"],
  registers: [register],
});

const snipeExecutionLatency = new client.Histogram({
  name: "snipe_execution_latency_ms",
  help: "Time from token discovery to transaction confirmation (end-to-end)",
  labelNames: ["status"],
  buckets: [100, 500, 1000, 2000, 5000, 10000, 30000],
  registers: [register],
});

const automationLeaseFailures = new client.Counter({
  name: "snipe_automation_lease_failures_total",
  help: "Failed automation lease establishment attempts",
  labelNames: ["reason"],
  registers: [register],
});

const snipeRateLimitHits = new client.Counter({
  name: "snipe_rate_limit_hits_total",
  help: "Number of snipes blocked by rate limiting",
  labelNames: ["limit_type"],
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

export function recordSnipeOpportunity(result: "accepted" | "rejected"): void {
  snipeOpportunities.labels(result).inc();
}

export function recordSnipeExecutionOutcome(
  status: "success" | "failed"
): void {
  snipeExecutions.labels(status).inc();
}

export function recordSnipeAnalysisDuration(durationMs: number): void {
  if (durationMs > 0) {
    snipeAnalysisDuration.observe(durationMs);
  }
}

export function recordSnipeDiscoveryEvent(
  source: string,
  status: "emitted" | "error" | "ignored"
): void {
  snipeDiscoveryEvents.labels(source, status).inc();
}

export function recordSnipeExecutionLatency(
  durationMs: number,
  status: "success" | "failed"
): void {
  snipeExecutionLatency.labels(status).observe(durationMs);
}

export function recordAutomationLeaseFailure(
  reason: "auth_failed" | "storage_error" | "expired"
): void {
  automationLeaseFailures.labels(reason).inc();
}

export function recordSnipeRateLimitHit(
  limitType: "hourly" | "daily"
): void {
  snipeRateLimitHits.labels(limitType).inc();
}

// ---------------------------------------------------------------------------
// PumpFun Monitor Metrics (2025 Optimizations)
// ---------------------------------------------------------------------------

const pumpfunTokensDetected = new client.Counter({
  name: "pumpfun_tokens_detected_total",
  help: "Total number of tokens detected from Pump.fun",
  registers: [register],
});

const pumpfunMessagesSkipped = new client.Counter({
  name: "pumpfun_messages_skipped_total",
  help: "Total messages skipped (subscription messages, invalid mints, rate limited)",
  labelNames: ["reason"],
  registers: [register],
});

const pumpfunParseErrors = new client.Counter({
  name: "pumpfun_parse_errors_total",
  help: "Total JSON parse errors from Pump.fun messages",
  registers: [register],
});

const pumpfunReconnections = new client.Counter({
  name: "pumpfun_reconnections_total",
  help: "Total reconnection attempts to Pump.fun",
  labelNames: ["reason"],
  registers: [register],
});

const pumpfunConnectionState = new client.Gauge({
  name: "pumpfun_connection_state",
  help: "Connection state (0=disconnected, 1=connected, 2=reconnecting)",
  registers: [register],
});

const pumpfunLastMessageTimestamp = new client.Gauge({
  name: "pumpfun_last_message_timestamp_seconds",
  help: "Timestamp of last received message (for staleness detection)",
  registers: [register],
});

const pumpfunMessageProcessingDuration = new client.Histogram({
  name: "pumpfun_message_processing_duration_ms",
  help: "Duration of message processing",
  buckets: [1, 5, 10, 25, 50, 100, 250],
  registers: [register],
});

export function recordPumpFunTokenDetected(): void {
  pumpfunTokensDetected.inc();
}

export function recordPumpFunMessageSkipped(reason: "subscription" | "no_mint" | "invalid_mint" | "rate_limited"): void {
  pumpfunMessagesSkipped.labels(reason).inc();
}

export function recordPumpFunParseError(): void {
  pumpfunParseErrors.inc();
}

export function recordPumpFunReconnection(reason: "close" | "error" | "stale"): void {
  pumpfunReconnections.labels(reason).inc();
}

export function setPumpFunConnectionState(state: "disconnected" | "connected" | "reconnecting"): void {
  const stateValue = state === "disconnected" ? 0 : state === "connected" ? 1 : 2;
  pumpfunConnectionState.set(stateValue);
}

export function updatePumpFunLastMessageTimestamp(): void {
  pumpfunLastMessageTimestamp.set(Date.now() / 1000);
}

export function observePumpFunMessageProcessing(durationMs: number): void {
  pumpfunMessageProcessingDuration.observe(durationMs);
}

// ---------------------------------------------------------------------------
// ProgramLog Monitor Metrics (Raydium/Orca) (2025 Optimizations)
// ---------------------------------------------------------------------------

const programLogSubscriptionsActive = new client.Gauge({
  name: "program_log_subscriptions_active",
  help: "Active program log subscriptions",
  labelNames: ["source"],
  registers: [register],
});

const programLogQueueSize = new client.Gauge({
  name: "program_log_queue_size",
  help: "Size of processing queue",
  labelNames: ["source"],
  registers: [register],
});

const programLogInFlight = new client.Gauge({
  name: "program_log_in_flight",
  help: "Number of transactions currently being processed",
  labelNames: ["source"],
  registers: [register],
});

const programLogFetchDuration = new client.Histogram({
  name: "program_log_fetch_duration_ms",
  help: "Duration of transaction fetching and processing",
  labelNames: ["source"],
  buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [register],
});

const programLogReconnections = new client.Counter({
  name: "program_log_reconnections_total",
  help: "Total reconnection attempts to program logs",
  labelNames: ["source", "program_id", "reason"],
  registers: [register],
});

const programLogFetchErrors = new client.Counter({
  name: "program_log_fetch_errors_total",
  help: "Total transaction fetch errors",
  labelNames: ["source", "error_type"],
  registers: [register],
});

const programLogQueueDropped = new client.Counter({
  name: "program_log_queue_dropped_total",
  help: "Total transactions dropped due to queue overflow",
  labelNames: ["source"],
  registers: [register],
});

const programLogLastEventTimestamp = new client.Gauge({
  name: "program_log_last_event_timestamp_seconds",
  help: "Timestamp of last received event per program",
  labelNames: ["source", "program_id"],
  registers: [register],
});

export function setProgramLogSubscriptionsActive(source: string, count: number): void {
  programLogSubscriptionsActive.labels(source).set(count);
}

export function setProgramLogQueueSize(source: string, size: number): void {
  programLogQueueSize.labels(source).set(size);
}

export function setProgramLogInFlight(source: string, count: number): void {
  programLogInFlight.labels(source).set(count);
}

export function observeProgramLogFetchDuration(source: string, durationMs: number): void {
  programLogFetchDuration.labels(source).observe(durationMs);
}

export function recordProgramLogReconnection(source: string, programId: string, reason: "error" | "stale" | "manual"): void {
  programLogReconnections.labels(source, programId, reason).inc();
}

export function recordProgramLogFetchError(source: string, errorType: "timeout" | "rpc_error" | "parse_error"): void {
  programLogFetchErrors.labels(source, errorType).inc();
}

export function recordProgramLogQueueDropped(source: string): void {
  programLogQueueDropped.labels(source).inc();
}

export function updateProgramLogLastEventTimestamp(source: string, programId: string): void {
  programLogLastEventTimestamp.labels(source, programId).set(Date.now() / 1000);
}

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export const metricsRegistry = register;
