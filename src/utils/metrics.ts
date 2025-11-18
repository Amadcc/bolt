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

const sniperOrdersTotal = new client.Counter({
  name: "sniper_orders_total",
  help: "Total sniper orders created",
  registers: [register],
});

const sniperOrdersSuccessTotal = new client.Counter({
  name: "sniper_orders_success_total",
  help: "Successful sniper orders",
  registers: [register],
});

const sniperOrdersFailedTotal = new client.Counter({
  name: "sniper_orders_failed_total",
  help: "Failed sniper orders",
  labelNames: ["reason"],
  registers: [register],
});

const sniperExecutionDuration = new client.Histogram({
  name: "sniper_execution_duration_ms",
  help: "Duration of sniper order execution (end-to-end)",
  buckets: [100, 250, 500, 1000, 1500, 2000, 3000, 5000, 10000],
  registers: [register],
});

const sniperFilterCheckDuration = new client.Histogram({
  name: "sniper_filter_check_duration_ms",
  help: "Duration of filter validation checks",
  buckets: [50, 100, 250, 500, 1000, 2000],
  registers: [register],
});

const sniperFilterRejections = new client.Counter({
  name: "sniper_filter_rejections_total",
  help: "Orders rejected by filters",
  labelNames: ["filter"],
  registers: [register],
});

const sniperPositionsOpenGauge = new client.Gauge({
  name: "sniper_positions_open",
  help: "Number of currently open sniper positions",
  registers: [register],
});

const sniperPositionsClosed = new client.Counter({
  name: "sniper_positions_closed_total",
  help: "Closed sniper positions",
  labelNames: ["status"], // PROFIT, LOSS, MANUAL
  registers: [register],
});

const sniperRetries = new client.Counter({
  name: "sniper_retries_total",
  help: "Sniper order retry attempts",
  labelNames: ["attempt"],
  registers: [register],
});

// DAY 7: Priority Fee Optimization Metrics

const feeOptimizationDuration = new client.Histogram({
  name: "fee_optimization_duration_ms",
  help: "Duration of priority fee optimization",
  buckets: [5, 10, 25, 50, 100, 250, 500],
  registers: [register],
});

const priorityFeeComputeUnitPrice = new client.Histogram({
  name: "priority_fee_compute_unit_price",
  help: "Compute unit price in microlamports",
  labelNames: ["mode"],
  buckets: [0, 10_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000],
  registers: [register],
});

const networkCongestionLevel = new client.Gauge({
  name: "network_congestion_level",
  help: "Current network congestion level (0-1)",
  registers: [register],
});

const feeOptimizationTotal = new client.Counter({
  name: "fee_optimization_total",
  help: "Total fee optimizations",
  labelNames: ["status"],
  registers: [register],
});

const feeCappedTotal = new client.Counter({
  name: "fee_capped_total",
  help: "Total fees capped by user max",
  labelNames: ["mode"],
  registers: [register],
});

const feeBoostedTotal = new client.Counter({
  name: "fee_boosted_total",
  help: "Total fees boosted for hyped launches",
  labelNames: ["mode"],
  registers: [register],
});

const feeMarketPercentiles = new client.Gauge({
  name: "fee_market_percentile",
  help: "Fee market percentiles (p50, p75, p90, p95)",
  labelNames: ["percentile"],
  registers: [register],
});

// DAY 8: Jito MEV Smart Routing Metrics

const jitoBundleSubmissions = new client.Counter({
  name: "jito_bundle_submissions_total",
  help: "Total Jito bundle submissions",
  labelNames: ["mode"], // MEV_TURBO or MEV_SECURE
  registers: [register],
});

const jitoBundleSuccess = new client.Counter({
  name: "jito_bundle_success_total",
  help: "Successful Jito bundle landings",
  labelNames: ["mode"],
  registers: [register],
});

const jitoBundleFailed = new client.Counter({
  name: "jito_bundle_failed_total",
  help: "Failed Jito bundles",
  labelNames: ["mode", "reason"], // reason: timeout, invalid, failed, etc
  registers: [register],
});

const jitoBundleDuration = new client.Histogram({
  name: "jito_bundle_duration_ms",
  help: "Duration from bundle submission to confirmation",
  labelNames: ["mode"],
  buckets: [500, 1000, 2000, 3000, 5000, 10000, 30000],
  registers: [register],
});

const jitoTipAmount = new client.Histogram({
  name: "jito_tip_amount_lamports",
  help: "Jito tip amounts in lamports",
  labelNames: ["tip_level"], // base, competitive, high, dynamic
  buckets: [1_000, 10_000, 50_000, 100_000, 200_000, 500_000, 1_000_000],
  registers: [register],
});

const jitoSmartRoutingMethod = new client.Counter({
  name: "jito_smart_routing_method_total",
  help: "Smart routing winner method",
  labelNames: ["method"], // jito or rpc
  registers: [register],
});

const jitoAntiSandwich = new client.Counter({
  name: "jito_anti_sandwich_enabled_total",
  help: "Bundles with anti-sandwich protection",
  registers: [register],
});

const jitoRpcFallback = new client.Counter({
  name: "jito_rpc_fallback_total",
  help: "Fallbacks to direct RPC after Jito failure",
  registers: [register],
});

// DAY 9: Position Monitoring & Auto TP/SL Metrics

const positionMonitorActive = new client.Gauge({
  name: "position_monitor_active_total",
  help: "Number of actively monitored positions",
  registers: [register],
});

const positionPriceChecks = new client.Counter({
  name: "position_price_checks_total",
  help: "Total price checks performed",
  labelNames: ["status"], // success, cache_hit, api_failure
  registers: [register],
});

const positionExitTriggered = new client.Counter({
  name: "position_exit_triggered_total",
  help: "Position exits triggered",
  labelNames: ["trigger"], // take_profit, stop_loss, trailing_stop, manual
  registers: [register],
});

const positionExitDuration = new client.Histogram({
  name: "position_exit_duration_ms",
  help: "Time to execute position exit",
  buckets: [500, 1000, 2000, 3000, 5000, 10000],
  registers: [register],
});

const positionPnl = new client.Histogram({
  name: "position_pnl_percentage",
  help: "Realized P&L percentage distribution",
  labelNames: ["outcome"], // profit, loss
  buckets: [-90, -50, -25, -10, 0, 10, 25, 50, 100, 200, 500],
  registers: [register],
});

const positionTrailingStopUpdates = new client.Counter({
  name: "position_trailing_stop_updates_total",
  help: "Trailing stop-loss updates",
  registers: [register],
});

const priceFeedLatency = new client.Histogram({
  name: "price_feed_latency_ms",
  help: "Price feed latency by source",
  labelNames: ["source"], // dexscreener, jupiter, raydium
  buckets: [50, 100, 250, 500, 1000, 2000],
  registers: [register],
});

const priceFeedErrors = new client.Counter({
  name: "price_feed_errors_total",
  help: "Price feed errors by source",
  labelNames: ["source", "reason"],
  registers: [register],
});

// DAY 10: Rug Detection & Emergency Exit Metrics

const rugDetectionChecks = new client.Counter({
  name: "rug_detection_checks_total",
  help: "Total rug detection checks performed",
  labelNames: ["status"], // success, error
  registers: [register],
});

const rugDetected = new client.Counter({
  name: "rug_detected_total",
  help: "Rug pulls detected by type",
  labelNames: ["rug_type", "severity"], // rug_type: liquidity_removal, authority_reenabled, etc.
  registers: [register],
});

const emergencyExitTriggered = new client.Counter({
  name: "emergency_exit_triggered_total",
  help: "Emergency exits triggered by rug type",
  labelNames: ["rug_type"], // liquidity_removal, authority_reenabled, etc.
  registers: [register],
});

const emergencyExitDuration = new client.Histogram({
  name: "emergency_exit_duration_ms",
  help: "Time to execute emergency exit",
  buckets: [500, 1000, 2000, 5000, 10000, 30000],
  registers: [register],
});

const positionSavedPercentage = new client.Histogram({
  name: "position_saved_percentage",
  help: "Percentage of position value saved in emergency exit",
  buckets: [0, 10, 25, 50, 75, 90, 100],
  registers: [register],
});

const rugMonitorActive = new client.Gauge({
  name: "rug_monitor_active_positions",
  help: "Number of positions being monitored for rug indicators",
  registers: [register],
});

const rugMonitorCircuitBreaker = new client.Gauge({
  name: "rug_monitor_circuit_breaker_state",
  help: "Rug monitor circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)",
  registers: [register],
});

// DAY 11: Multi-Wallet Support Metrics

const walletRotations = new client.Counter({
  name: "wallet_rotations_total",
  help: "Total wallet rotations by strategy",
  labelNames: ["strategy"], // ROUND_ROBIN, LEAST_USED, RANDOM, SPECIFIC, PRIMARY_ONLY
  registers: [register],
});

const walletUsage = new client.Counter({
  name: "wallet_usage_total",
  help: "Wallet usage count by wallet ID",
  labelNames: ["wallet_id"],
  registers: [register],
});

const activeWalletsGauge = new client.Gauge({
  name: "active_wallets_count",
  help: "Number of active wallets by user",
  labelNames: ["user_id"],
  registers: [register],
});

const walletsPerUser = new client.Histogram({
  name: "wallets_per_user",
  help: "Distribution of wallet count per user",
  buckets: [1, 2, 3, 5, 7, 10],
  registers: [register],
});

const walletCreations = new client.Counter({
  name: "wallet_creations_total",
  help: "Total wallet creations",
  labelNames: ["status"], // success, error
  registers: [register],
});

const walletDeletions = new client.Counter({
  name: "wallet_deletions_total",
  help: "Total wallet deletions",
  labelNames: ["status"], // success, error
  registers: [register],
});

// DAY 12: Copy-Trade Protection (Privacy Layer) Metrics

const privacyLayerDuration = new client.Histogram({
  name: "privacy_layer_duration_ms",
  help: "Duration of privacy layer application",
  buckets: [1, 5, 10, 25, 50, 100, 250],
  registers: [register],
});

const privacyScore = new client.Gauge({
  name: "privacy_score",
  help: "Current privacy score for user (0-100)",
  labelNames: ["userId"],
  registers: [register],
});

const privacyLayerApplied = new client.Counter({
  name: "privacy_layer_applied_total",
  help: "Total privacy layer applications",
  labelNames: ["mode", "userId"], // mode: OFF, BASIC, ADVANCED
  registers: [register],
});

const privacyTiming = new client.Histogram({
  name: "privacy_timing_delay_ms",
  help: "Randomized timing delays applied",
  labelNames: ["mode"],
  buckets: [0, 500, 1000, 2000, 3000, 5000, 8000, 10000],
  registers: [register],
});

const privacyWalletRotations = new client.Counter({
  name: "privacy_wallet_rotations_total",
  help: "Wallet rotations for privacy",
  labelNames: ["strategy"], // ROUND_ROBIN, RANDOM, FRESH_ONLY, FRESH_THRESHOLD
  registers: [register],
});

const privacyObfuscationApplied = new client.Counter({
  name: "privacy_obfuscation_applied_total",
  help: "Obfuscation techniques applied",
  labelNames: ["pattern"], // NONE, MEMO_RANDOM, DUMMY_INSTRUCTIONS, SPLIT_AMOUNT, FULL
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

export function recordSniperOrderCreated(): void {
  sniperOrdersTotal.inc();
}

export function recordSniperOrderSuccess(durationMs: number): void {
  sniperOrdersSuccessTotal.inc();
  sniperExecutionDuration.observe(durationMs);
}

export function recordSniperOrderFailure(reason: string, durationMs: number): void {
  sniperOrdersFailedTotal.labels(reason).inc();
  sniperExecutionDuration.observe(durationMs);
}

export function recordSniperFilterCheck(durationMs: number): void {
  sniperFilterCheckDuration.observe(durationMs);
}

export function recordSniperFilterRejection(filter: string): void {
  sniperFilterRejections.labels(filter).inc();
}

export function incrementOpenPositions(): void {
  sniperPositionsOpenGauge.inc();
}

export function decrementOpenPositions(): void {
  sniperPositionsOpenGauge.dec();
}

export function recordPositionClosed(status: "PROFIT" | "LOSS" | "MANUAL"): void {
  sniperPositionsClosed.labels(status).inc();
  decrementOpenPositions();
}

export function recordSniperRetry(attemptNumber: number): void {
  sniperRetries.labels(attemptNumber.toString()).inc();
}

// DAY 7: Fee Optimization Metrics

export function recordFeeOptimization(
  durationMs: number,
  status: "success" | "failure"
): void {
  feeOptimizationDuration.observe(durationMs);
  feeOptimizationTotal.labels(status).inc();
}

export function recordPriorityFee(
  mode: string,
  computeUnitPrice: number,
  wasCapped: boolean,
  wasBoosted: boolean
): void {
  priorityFeeComputeUnitPrice.labels(mode).observe(computeUnitPrice);

  if (wasCapped) {
    feeCappedTotal.labels(mode).inc();
  }

  if (wasBoosted) {
    feeBoostedTotal.labels(mode).inc();
  }
}

export function updateNetworkCongestion(level: number): void {
  networkCongestionLevel.set(level);
}

export function updateFeeMarketPercentiles(percentiles: {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}): void {
  feeMarketPercentiles.labels("p50").set(percentiles.p50);
  feeMarketPercentiles.labels("p75").set(percentiles.p75);
  feeMarketPercentiles.labels("p90").set(percentiles.p90);
  feeMarketPercentiles.labels("p95").set(percentiles.p95);
}

// DAY 8: Jito Smart Routing Metrics

export function recordJitoBundleSubmission(mode: "MEV_TURBO" | "MEV_SECURE"): void {
  jitoBundleSubmissions.labels(mode).inc();
}

export function recordJitoBundleSuccess(
  mode: "MEV_TURBO" | "MEV_SECURE",
  durationMs: number
): void {
  jitoBundleSuccess.labels(mode).inc();
  jitoBundleDuration.labels(mode).observe(durationMs);
}

export function recordJitoBundleFailure(
  mode: "MEV_TURBO" | "MEV_SECURE",
  reason: string
): void {
  jitoBundleFailed.labels(mode, reason).inc();
}

export function recordJitoTip(tipLamports: bigint, tipLevel: string): void {
  jitoTipAmount.labels(tipLevel).observe(Number(tipLamports));
}

export function recordSmartRoutingWinner(method: "jito" | "rpc"): void {
  jitoSmartRoutingMethod.labels(method).inc();
}

export function recordAntiSandwich(): void {
  jitoAntiSandwich.inc();
}

export function recordJitoRpcFallback(): void {
  jitoRpcFallback.inc();
}

// DAY 9: Position Monitoring Metrics

export function recordPositionMonitorStarted(): void {
  positionMonitorActive.inc();
}

export function recordPositionMonitorStopped(): void {
  positionMonitorActive.dec();
}

export function recordPriceCheck(
  status: "success" | "cache_hit" | "memory_cache_hit" | "redis_cache_hit" | "api_failure"
): void {
  positionPriceChecks.labels(status).inc();
}

export function recordExitTriggered(
  trigger: "take_profit" | "stop_loss" | "trailing_stop" | "manual"
): void {
  positionExitTriggered.labels(trigger).inc();
}

export function recordExitDuration(durationMs: number): void {
  positionExitDuration.observe(durationMs);
}

export function recordPositionPnl(pnlPercentage: number): void {
  const outcome = pnlPercentage >= 0 ? "profit" : "loss";
  positionPnl.labels(outcome).observe(pnlPercentage);
}

export function recordTrailingStopUpdate(): void {
  positionTrailingStopUpdates.inc();
}

export function recordPriceFeedLatency(source: string, latencyMs: number): void {
  priceFeedLatency.labels(source).observe(latencyMs);
}

export function recordPriceFeedError(source: string, reason: string): void {
  priceFeedErrors.labels(source, reason).inc();
}

// DAY 10: Rug Detection & Emergency Exit Metrics

export function recordRugDetectionCheck(status: "success" | "error"): void {
  rugDetectionChecks.labels(status).inc();
}

export function recordRugDetected(
  rugType: "LIQUIDITY_REMOVAL" | "AUTHORITY_REENABLED" | "SUPPLY_MANIPULATION" | "HOLDER_DUMP" | "MULTIPLE_INDICATORS",
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
): void {
  rugDetected.labels(rugType, severity).inc();
}

export function recordEmergencyExitTriggered(
  rugType: "LIQUIDITY_REMOVAL" | "AUTHORITY_REENABLED" | "SUPPLY_MANIPULATION" | "HOLDER_DUMP" | "MULTIPLE_INDICATORS"
): void {
  emergencyExitTriggered.labels(rugType).inc();
}

export function recordEmergencyExitDuration(durationMs: number): void {
  emergencyExitDuration.observe(durationMs);
}

export function recordPositionSavedPercentage(percentage: number): void {
  positionSavedPercentage.observe(percentage);
}

export function recordRugMonitorStarted(): void {
  rugMonitorActive.inc();
}

export function recordRugMonitorStopped(): void {
  rugMonitorActive.dec();
}

export function setRugMonitorCircuitState(
  state: "CLOSED" | "HALF_OPEN" | "OPEN"
): void {
  const stateValue = state === "CLOSED" ? 0 : state === "HALF_OPEN" ? 1 : 2;
  rugMonitorCircuitBreaker.set(stateValue);
}

// DAY 11: Multi-Wallet Support Metrics

export function recordWalletRotation(
  strategy: "ROUND_ROBIN" | "LEAST_USED" | "RANDOM" | "SPECIFIC" | "PRIMARY_ONLY"
): void {
  walletRotations.labels(strategy).inc();
}

export function recordWalletUsage(walletId: string): void {
  walletUsage.labels(walletId).inc();
}

export function setActiveWalletsCount(userId: string, count: number): void {
  activeWalletsGauge.labels(userId).set(count);
}

export function recordWalletsPerUser(count: number): void {
  walletsPerUser.observe(count);
}

export function recordWalletCreation(status: "success" | "error"): void {
  walletCreations.labels(status).inc();
}

export function recordWalletDeletion(status: "success" | "error"): void {
  walletDeletions.labels(status).inc();
}

// DAY 12: Copy-Trade Protection Metrics

export function recordPrivacyLayerDuration(durationMs: number): void {
  privacyLayerDuration.observe(durationMs);
}

export function setPrivacyScore(userId: string, score: number): void {
  privacyScore.labels(userId).set(score);
}

export function recordPrivacyLayerApplied(
  mode: "OFF" | "BASIC" | "ADVANCED",
  userId: string
): void {
  privacyLayerApplied.labels(mode, userId).inc();
}

export function recordPrivacyTiming(mode: string, delayMs: number): void {
  privacyTiming.labels(mode).observe(delayMs);
}

export function recordPrivacyWalletRotation(
  strategy: "ROUND_ROBIN" | "RANDOM" | "FRESH_ONLY" | "FRESH_THRESHOLD"
): void {
  privacyWalletRotations.labels(strategy).inc();
}

export function recordPrivacyObfuscation(
  pattern: "NONE" | "MEMO_RANDOM" | "DUMMY_INSTRUCTIONS" | "SPLIT_AMOUNT" | "FULL"
): void {
  privacyObfuscationApplied.labels(pattern).inc();
}

// Metrics object for direct access (used by privacy layer)
export const metrics = {
  privacyLayerDuration,
  privacyScore,
  privacyLayerApplied,
  privacyTiming,
  privacyWalletRotations,
  privacyObfuscationApplied,
};

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export const metricsRegistry = register;
