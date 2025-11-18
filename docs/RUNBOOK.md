# Production Runbook

## Table of Contents

- [Overview](#overview)
- [Emergency Contacts](#emergency-contacts)
- [Common Failure Scenarios](#common-failure-scenarios)
  - [RPC Connection Failures](#rpc-connection-failures)
  - [Database Connection Loss](#database-connection-loss)
  - [Redis Failures](#redis-failures)
  - [Circuit Breaker Open State](#circuit-breaker-open-state)
  - [High Memory Usage](#high-memory-usage)
  - [Transaction Failures](#transaction-failures)
- [Troubleshooting Guide](#troubleshooting-guide)
- [Circuit Breaker Recovery](#circuit-breaker-recovery)
- [Performance Tuning Guide](#performance-tuning-guide)
- [Alerting and Escalation](#alerting-and-escalation)
- [Incident Response Procedures](#incident-response-procedures)
- [Maintenance Procedures](#maintenance-procedures)

---

## Overview

This runbook provides operational procedures for the Solana Token Sniper Bot in production environments. It covers common failure scenarios, troubleshooting steps, and recovery procedures.

**System Architecture:**
- **Application:** Bun runtime, TypeScript, grammy (Telegram)
- **Database:** PostgreSQL 15+ with Prisma ORM
- **Cache:** Redis 7+ for sessions and circuit breaker state
- **Blockchain:** Solana mainnet via RPC pool (Helius, QuickNode, public)
- **Trading:** Jupiter v6 aggregator

**Key Features:**
- Circuit breaker pattern for RPC failure handling
- Automatic RPC endpoint failover
- Graceful degradation with fallback data
- Session-based wallet encryption
- Honeypot detection with multi-layer validation

---

## Emergency Contacts

### On-Call Rotation

| Role | Name | Phone | Email | Escalation |
|------|------|-------|-------|------------|
| Primary On-Call | [Your Name] | [Phone] | [Email] | 30 minutes |
| Secondary On-Call | [Name] | [Phone] | [Email] | 1 hour |
| Engineering Lead | [Name] | [Phone] | [Email] | 2 hours |

### External Service Contacts

| Service | Support URL | Status Page |
|---------|-------------|-------------|
| Helius RPC | https://support.helius.dev | https://status.helius.dev |
| QuickNode | https://support.quicknode.com | https://status.quicknode.com |
| Telegram Bot API | https://core.telegram.org/bots/faq | https://telegram.org/status |
| Chainstack (Geyser) | https://support.chainstack.com | https://status.chainstack.com |

---

## Common Failure Scenarios

### RPC Connection Failures

#### Symptoms
- Circuit breaker state = OPEN for RPC endpoints
- Errors: "Connection timeout", "429 Too Many Requests", "503 Service Unavailable"
- Users unable to execute swaps or check balances
- Metrics: `circuit_breaker_state{name="rpc_pool"}` = 1 (OPEN)

#### Root Causes
1. RPC provider rate limiting (429 errors)
2. RPC provider outage (503/504 errors)
3. Network connectivity issues
4. Invalid/expired RPC API keys

#### Diagnosis Commands

```bash
# Check circuit breaker state
curl http://localhost:3000/metrics | grep circuit_breaker_state

# Check application logs for RPC errors
journalctl -u sniper-bot -n 100 | grep -i "rpc\|connection"

# Docker
docker logs sniper-bot --tail 100 | grep -i "rpc\|connection"

# Kubernetes
kubectl logs -n sniper-bot -l app=sniper-bot --tail=100 | grep -i "rpc\|connection"

# Test RPC endpoints manually
curl -X POST https://api.mainnet-beta.solana.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

curl -X POST $HELIUS_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

#### Recovery Steps

**Level 1 - Automatic (No Action Required):**
Circuit breaker will automatically transition from OPEN → HALF_OPEN → CLOSED after timeout (default: 30s).

**Level 2 - Manual Intervention:**

```bash
# 1. Verify RPC endpoint status
curl -X POST $HELIUS_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'

# 2. If rate limited (429), wait for rate limit reset
# Check Helius dashboard: https://dashboard.helius.dev
# Check QuickNode dashboard: https://dashboard.quicknode.com

# 3. If outage (503/504), check status pages:
# Helius: https://status.helius.dev
# QuickNode: https://status.quicknode.com

# 4. Restart application to reset circuit breaker state
sudo systemctl restart sniper-bot

# Docker
docker-compose restart app

# Kubernetes
kubectl rollout restart deployment/sniper-bot -n sniper-bot

# 5. Monitor circuit breaker recovery
watch -n 5 'curl -s http://localhost:3000/metrics | grep circuit_breaker_state'
```

**Level 3 - Escalation:**

If all RPC endpoints are down:

```bash
# 1. Add emergency RPC endpoint
# Edit .env or ConfigMap
BACKUP_RPC_URL="https://api.mainnet-beta.solana.com"

# 2. Redeploy application
kubectl set env deployment/sniper-bot -n sniper-bot BACKUP_RPC_URL=$BACKUP_RPC_URL

# 3. Contact RPC provider support
# Helius: https://support.helius.dev
# QuickNode: https://support.quicknode.com
```

#### Prevention
- [ ] Configure multiple RPC endpoints (Helius + QuickNode + public)
- [ ] Monitor RPC rate limits via provider dashboards
- [ ] Set up alerts for circuit breaker OPEN state
- [ ] Upgrade to higher RPC tier if frequently rate limited

---

### Database Connection Loss

#### Symptoms
- Errors: "Connection terminated", "ECONNREFUSED", "ETIMEDOUT"
- Unable to create wallets or save orders
- Application crashes or restarts frequently
- Metrics: Database query duration spikes or errors

#### Root Causes
1. PostgreSQL service down
2. Network connectivity issues
3. Connection pool exhaustion
4. Database server resource exhaustion (CPU, memory, disk)
5. Firewall blocking connections

#### Diagnosis Commands

```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Docker
docker-compose ps postgres

# Kubernetes
kubectl get pods -n sniper-bot -l app=postgres

# Test database connectivity
psql -U postgres -h db-host -d sniper_bot -c "SELECT 1;"

# Check active connections
psql -U postgres -h db-host -d sniper_bot -c "SELECT count(*) FROM pg_stat_activity;"

# Check connection pool settings
psql -U postgres -h db-host -d sniper_bot -c "SHOW max_connections;"

# Check database resource usage
psql -U postgres -h db-host -d sniper_bot -c "
SELECT
  datname,
  numbackends as active_connections,
  xact_commit,
  xact_rollback,
  blks_read,
  blks_hit
FROM pg_stat_database
WHERE datname = 'sniper_bot';
"
```

#### Recovery Steps

**Level 1 - Service Restart:**

```bash
# Restart PostgreSQL
sudo systemctl restart postgresql

# Docker
docker-compose restart postgres

# Kubernetes
kubectl rollout restart deployment/postgres -n sniper-bot

# Wait for database to be ready
until pg_isready -h db-host -U postgres; do sleep 1; done

# Restart application
sudo systemctl restart sniper-bot
```

**Level 2 - Connection Pool Tuning:**

```bash
# Check Prisma connection pool settings
# Default: connection_limit = num_physical_cpus * 2 + 1

# Increase connection pool (edit DATABASE_URL)
DATABASE_URL="postgresql://postgres:password@db-host:5432/sniper_bot?schema=public&connection_limit=20"

# Restart application
sudo systemctl restart sniper-bot
```

**Level 3 - Database Recovery:**

```bash
# Check database logs for corruption
sudo tail -f /var/log/postgresql/postgresql-15-main.log

# If corrupted, restore from backup (see DEPLOYMENT.md)
pg_restore -U postgres -h db-host -d sniper_bot -c backup_latest.backup

# Run integrity checks
psql -U postgres -h db-host -d sniper_bot -c "VACUUM ANALYZE;"
psql -U postgres -h db-host -d sniper_bot -c "REINDEX DATABASE sniper_bot;"
```

#### Prevention
- [ ] Set up database replication (primary-replica)
- [ ] Monitor database connection pool usage
- [ ] Configure automated backups (hourly incremental, daily full)
- [ ] Set up database resource alerts (CPU, memory, disk)
- [ ] Use connection pooling with pgBouncer for high load

---

### Redis Failures

#### Symptoms
- Errors: "Connection timeout", "Redis is loading", "READONLY"
- Session authentication failures
- Circuit breaker state reset (lost Redis data)
- Increased database query load (cache miss)

#### Root Causes
1. Redis service down
2. Redis out of memory (OOM)
3. Redis persistence (RDB/AOF) issues
4. Network connectivity issues

#### Diagnosis Commands

```bash
# Check Redis status
sudo systemctl status redis-server

# Docker
docker-compose ps redis

# Kubernetes
kubectl get pods -n sniper-bot -l app=redis

# Test Redis connectivity
redis-cli ping

# Check Redis memory usage
redis-cli INFO memory

# Check Redis persistence status
redis-cli INFO persistence

# Check Redis client connections
redis-cli INFO clients

# Monitor Redis commands
redis-cli MONITOR
```

#### Recovery Steps

**Level 1 - Service Restart:**

```bash
# Restart Redis
sudo systemctl restart redis-server

# Docker
docker-compose restart redis

# Kubernetes
kubectl rollout restart deployment/redis -n sniper-bot

# Verify Redis is running
redis-cli ping
# Expected: PONG

# Restart application (to reconnect)
sudo systemctl restart sniper-bot
```

**Level 2 - Memory Tuning:**

```bash
# Check current memory usage
redis-cli INFO memory | grep used_memory_human

# Increase maxmemory (edit redis.conf)
sudo nano /etc/redis/redis.conf
# Set: maxmemory 2gb
# Set: maxmemory-policy allkeys-lru

# Restart Redis
sudo systemctl restart redis-server

# Clear expired keys manually (if needed)
redis-cli --scan --pattern 'session:*' | xargs redis-cli DEL
```

**Level 3 - Persistence Recovery:**

```bash
# Check AOF corruption
redis-check-aof /var/lib/redis/appendonly.aof

# Fix AOF corruption
redis-check-aof --fix /var/lib/redis/appendonly.aof

# Restart Redis
sudo systemctl start redis-server

# Verify data integrity
redis-cli DBSIZE
```

#### Graceful Degradation

The application is designed to function WITHOUT Redis:

```bash
# Disable Redis temporarily
export REDIS_URL=""

# Restart application
sudo systemctl restart sniper-bot

# Application will:
# - Fall back to database for session storage (slower)
# - Lose circuit breaker state (will rebuild from operations)
# - Continue functioning with degraded performance
```

#### Prevention
- [ ] Monitor Redis memory usage (alert at 80%)
- [ ] Enable Redis persistence (AOF + RDB)
- [ ] Configure maxmemory and eviction policy
- [ ] Set up Redis replication (primary-replica)
- [ ] Use Redis Sentinel for automatic failover

---

### Circuit Breaker Open State

#### Symptoms
- Metrics: `circuit_breaker_state{name="rpc_pool"}` = 1 (OPEN)
- Requests failing immediately without attempting RPC call
- Logs: "Circuit breaker is OPEN"
- Graceful degradation active (cached data returned)

#### Root Causes
1. Repeated RPC failures (threshold reached)
2. Network instability
3. RPC provider issues
4. Rate limiting

#### Diagnosis Commands

```bash
# Check circuit breaker metrics
curl http://localhost:3000/metrics | grep -A 5 circuit_breaker

# Expected output:
# circuit_breaker_state{name="rpc_pool"} 0  # CLOSED = 0, HALF_OPEN = 0.5, OPEN = 1
# circuit_breaker_failures_total{name="rpc_pool"} 5
# circuit_breaker_successes_total{name="rpc_pool"} 100

# Check Redis for circuit breaker state
redis-cli GET "circuit_breaker:rpc_pool:state"
redis-cli GET "circuit_breaker:rpc_pool:failureCount"
redis-cli GET "circuit_breaker:rpc_pool:lastFailureTime"

# Check application logs
journalctl -u sniper-bot -n 100 | grep -i "circuit\|breaker"
```

#### Recovery Steps

**Automatic Recovery (Default):**

Circuit breaker automatically transitions:
1. **OPEN** → Wait for timeout (default: 30s)
2. **HALF_OPEN** → Attempt single test request
3. If success → **CLOSED** (normal operation)
4. If failure → **OPEN** (retry later)

**Manual Recovery:**

```bash
# 1. Reset circuit breaker state in Redis
redis-cli DEL "circuit_breaker:rpc_pool:state"
redis-cli DEL "circuit_breaker:rpc_pool:failureCount"
redis-cli DEL "circuit_breaker:rpc_pool:lastFailureTime"

# 2. Restart application (circuit breaker resets to CLOSED)
sudo systemctl restart sniper-bot

# 3. Monitor recovery
watch -n 2 'curl -s http://localhost:3000/metrics | grep circuit_breaker_state'
```

**Force Circuit Breaker Closed (Emergency Only):**

```bash
# WARNING: Only use if you've verified RPC endpoints are healthy
# This bypasses failure threshold and forces CLOSED state

redis-cli SET "circuit_breaker:rpc_pool:state" "CLOSED"
redis-cli SET "circuit_breaker:rpc_pool:failureCount" "0"

# Restart application
sudo systemctl restart sniper-bot
```

#### Prevention
- [ ] Configure multiple RPC endpoints for failover
- [ ] Monitor RPC endpoint health proactively
- [ ] Set appropriate failure threshold (default: 5)
- [ ] Set appropriate timeout for state transitions (default: 30s)
- [ ] Alert on circuit breaker state changes

---

### High Memory Usage

#### Symptoms
- Memory usage &gt;80% of available RAM
- Application slowness or freezing
- OOM (Out of Memory) errors
- Linux OOM killer terminating process

#### Root Causes
1. Memory leak in application code
2. Large in-memory caches (LRU cache)
3. Too many concurrent connections
4. Large transaction payloads

#### Diagnosis Commands

```bash
# Check system memory
free -h
htop

# Check application memory usage
ps aux | grep "bun\|node" | awk '{print $4, $11}'

# Docker
docker stats sniper-bot

# Kubernetes
kubectl top pods -n sniper-bot

# Check heap snapshot (if memory leak suspected)
# Add to application: import v8 from 'v8'; v8.writeHeapSnapshot();
# Analyze with Chrome DevTools
```

#### Recovery Steps

**Level 1 - Restart Application:**

```bash
# Restart to clear memory
sudo systemctl restart sniper-bot

# Docker
docker-compose restart app

# Kubernetes
kubectl rollout restart deployment/sniper-bot -n sniper-bot
```

**Level 2 - Resource Limit Tuning:**

```bash
# Increase memory limit (systemd)
sudo nano /etc/systemd/system/sniper-bot.service
# Add: MemoryMax=16G

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart sniper-bot

# Docker (docker-compose.yml)
services:
  app:
    deploy:
      resources:
        limits:
          memory: 8G

# Kubernetes
kubectl set resources deployment sniper-bot -n sniper-bot \
  --limits=memory=8Gi \
  --requests=memory=4Gi
```

**Level 3 - Application Tuning:**

```bash
# Reduce LRU cache size (edit src/config/constants.ts)
# Default: 10000 items
MAX_CACHE_ITEMS=5000

# Reduce connection pool size
DATABASE_CONNECTION_LIMIT=10

# Restart application
sudo systemctl restart sniper-bot
```

#### Prevention
- [ ] Monitor memory usage with alerts (&gt;80%)
- [ ] Regular memory profiling with heap snapshots
- [ ] Set appropriate resource limits
- [ ] Use streaming for large data processing
- [ ] Implement cache eviction policies

---

### Transaction Failures

#### Symptoms
- Errors: "Transaction simulation failed", "Blockhash not found", "Insufficient funds"
- Failed orders with status = "failed"
- Users reporting unsuccessful swaps
- Metrics: `swap_failures_total` increasing

#### Root Causes
1. Insufficient SOL balance for transaction + fees
2. Slippage too low (price moved beyond tolerance)
3. Blockhash expired (transaction took &gt;60s)
4. Priority fee too low (transaction not processed)
5. Pool liquidity insufficient
6. Smart contract rejection (honeypot, anti-sniper)

#### Diagnosis Commands

```bash
# Check recent failed orders
psql -U postgres -d sniper_bot -c "
SELECT
  id,
  status,
  error->>'type' as error_type,
  error->>'message' as error_message,
  created_at
FROM \"SniperOrder\"
WHERE status = 'FAILED'
ORDER BY created_at DESC
LIMIT 10;
"

# Check user wallet balance
bunx ts-node scripts/check-wallet-balance.ts <wallet_public_key>

# Verify transaction on Solana Explorer
# https://explorer.solana.com/tx/<signature>?cluster=mainnet

# Check Jupiter API health
curl https://lite-api.jup.ag/health
```

#### Recovery Steps

**Insufficient Balance:**

```bash
# Check wallet balance
solana balance <wallet_public_key>

# User needs to deposit SOL
# Provide deposit address via Telegram bot
```

**Slippage Too Low:**

```bash
# Increase slippage tolerance (Telegram bot settings)
# Default: 100 bps (1%)
# Recommended for volatile tokens: 300-500 bps (3-5%)

# User can adjust via bot:
/settings -> Slippage -> 5% (500 bps)
```

**Blockhash Expired:**

```bash
# Increase transaction timeout
# Edit src/config/constants.ts
TRANSACTION_TIMEOUT_MS=45000  # Increase from 30s to 45s

# Restart application
sudo systemctl restart sniper-bot
```

**Priority Fee Too Low:**

```bash
# Increase priority fee level
# User can adjust via bot:
/settings -> Priority Fee -> HIGH or TURBO

# Fee levels:
# NONE: 0 lamports
# LOW: 1,000 lamports (~$0.0001)
# MEDIUM: 10,000 lamports (~$0.001)
# HIGH: 100,000 lamports (~$0.01)
# TURBO: 1,000,000 lamports (~$0.10)
# ULTRA: 10,000,000 lamports (~$1.00)
```

**Honeypot Detection:**

```bash
# Check token risk score
psql -U postgres -d sniper_bot -c "
SELECT token_mint, risk_score, is_honeypot, details
FROM \"HoneypotCheck\"
WHERE token_mint = '<token_mint_address>';
"

# If honeypot detected (risk_score >= 70):
# - Transaction blocked automatically
# - User warned via Telegram
# - No recovery needed (working as intended)
```

#### Prevention
- [ ] Implement pre-flight transaction simulation
- [ ] Set reasonable default slippage (1-3%)
- [ ] Monitor wallet balances and alert users
- [ ] Use dynamic priority fees based on network congestion
- [ ] Implement transaction retry with exponential backoff

---

## Troubleshooting Guide

### Application Won't Start

**Symptoms:**
- Service fails to start
- Process exits immediately
- Logs: "Cannot find module", "Connection refused"

**Diagnosis:**

```bash
# Check service status
sudo systemctl status sniper-bot

# Check logs for errors
journalctl -u sniper-bot -n 50

# Verify dependencies installed
bun install

# Verify Prisma Client generated
bunx prisma generate

# Verify environment variables
bunx ts-node -e "import './src/config/env.js'; console.log('Config valid');"

# Test database connection
psql -U postgres -h db-host -d sniper_bot -c "SELECT 1;"

# Test Redis connection
redis-cli ping
```

**Solution:**

```bash
# 1. Reinstall dependencies
rm -rf node_modules
bun install

# 2. Regenerate Prisma Client
bunx prisma generate

# 3. Verify environment variables
cp .env.example .env
nano .env  # Edit with correct values

# 4. Run database migrations
bunx prisma migrate deploy

# 5. Restart service
sudo systemctl restart sniper-bot
```

---

### Bot Not Responding to Commands

**Symptoms:**
- Telegram messages not received
- No response from bot
- Logs: "Unauthorized", "Wrong token"

**Diagnosis:**

```bash
# Verify bot token
curl https://api.telegram.org/bot${BOT_TOKEN}/getMe

# Check Telegram API status
curl https://telegram.org/status

# Check application logs
journalctl -u sniper-bot -n 100 | grep -i telegram

# Check network connectivity
ping api.telegram.org
```

**Solution:**

```bash
# 1. Verify BOT_TOKEN is correct
echo $BOT_TOKEN

# 2. Test bot token manually
curl https://api.telegram.org/bot${BOT_TOKEN}/getMe

# 3. Restart application
sudo systemctl restart sniper-bot

# 4. Send test message to bot
# Open Telegram and send /start
```

---

### Swap Execution Too Slow

**Symptoms:**
- Swap execution &gt;2 seconds
- Users complaining about slow trades
- Metrics: `swap_execution_duration_seconds` &gt;2.0

**Diagnosis:**

```bash
# Check RPC latency
bunx ts-node scripts/test-rpc-latency.ts

# Check Jupiter API latency
time curl -X POST https://lite-api.jup.ag/quote \
  -H "Content-Type: application/json" \
  -d '{"inputMint":"So11111111111111111111111111111111111111112","outputMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","amount":1000000000,"slippageBps":50}'

# Check database query performance
psql -U postgres -d sniper_bot -c "
SELECT
  query,
  mean_exec_time,
  calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
"

# Check application metrics
curl http://localhost:3000/metrics | grep swap_execution_duration
```

**Solution:**

```bash
# 1. Optimize RPC endpoints
# Use premium RPC (Helius, QuickNode)
# Configure multiple endpoints for failover

# 2. Enable Geyser plugin (if available)
GEYSER_ENABLED=true
GEYSER_ENDPOINT="grpc.chainstack.com:443"

# 3. Optimize database queries
# Add missing indexes
bunx prisma migrate deploy

# 4. Increase connection pool
DATABASE_URL="...?connection_limit=20"

# 5. Use Jupiter lite API (faster)
JUPITER_API_URL="https://lite-api.jup.ag"

# 6. Restart application
sudo systemctl restart sniper-bot
```

---

## Circuit Breaker Recovery

### Understanding Circuit Breaker States

The circuit breaker has 3 states:

1. **CLOSED** (Normal Operation)
   - All requests pass through
   - Failures counted
   - Transitions to OPEN after `failureThreshold` failures

2. **OPEN** (Failure Mode)
   - All requests fail immediately (no RPC call)
   - Graceful degradation active (cached data returned)
   - Transitions to HALF_OPEN after `timeout` (default: 30s)

3. **HALF_OPEN** (Testing Recovery)
   - Single test request allowed
   - If success → CLOSED (recovery complete)
   - If failure → OPEN (retry later)

### Circuit Breaker Configuration

Default configuration (src/services/shared/circuitBreaker.ts):

```typescript
{
  failureThreshold: 5,        // Open after 5 failures
  successThreshold: 2,        // Close after 2 successes (in HALF_OPEN)
  timeout: 30000,             // 30s before HALF_OPEN attempt
  monitoringPeriod: 60000,    // 60s window for counting failures
  enableRedis: true,          // Persist state in Redis
}
```

### Manual Circuit Breaker Reset

```bash
# View circuit breaker state
redis-cli HGETALL "circuit_breaker:rpc_pool"

# Reset to CLOSED state
redis-cli HSET "circuit_breaker:rpc_pool" state CLOSED
redis-cli HSET "circuit_breaker:rpc_pool" failureCount 0
redis-cli HDEL "circuit_breaker:rpc_pool" lastFailureTime

# Restart application
sudo systemctl restart sniper-bot
```

### Circuit Breaker Monitoring

```bash
# Real-time monitoring
watch -n 5 'curl -s http://localhost:3000/metrics | grep circuit_breaker'

# Alert when circuit breaker opens
# Prometheus alert rule:
# alert: CircuitBreakerOpen
# expr: circuit_breaker_state{name="rpc_pool"} == 1
# for: 1m
# labels:
#   severity: warning
# annotations:
#   summary: "Circuit breaker is OPEN for {{ $labels.name }}"
```

---

## Performance Tuning Guide

### RPC Connection Pool Tuning

```bash
# Optimal RPC endpoint configuration
# Prioritize premium endpoints (Helius, QuickNode)

# .env configuration
HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"  # Priority 1
QUICKNODE_RPC_URL="https://YOUR_ENDPOINT.solana-mainnet.quiknode.pro/YOUR_TOKEN/"  # Priority 2
SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"  # Fallback

# Tune circuit breaker settings
# Increase failure threshold if network is unstable
CIRCUIT_BREAKER_FAILURE_THRESHOLD=10  # Default: 5

# Decrease timeout if network is stable
CIRCUIT_BREAKER_TIMEOUT=15000  # Default: 30000 (30s)
```

### Database Performance Tuning

```bash
# Optimize PostgreSQL configuration
sudo nano /etc/postgresql/15/main/postgresql.conf

# Recommended settings for 8GB RAM server:
shared_buffers = 2GB                    # 25% of RAM
effective_cache_size = 6GB              # 75% of RAM
maintenance_work_mem = 512MB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1                  # For SSD
effective_io_concurrency = 200          # For SSD
work_mem = 32MB
min_wal_size = 1GB
max_wal_size = 4GB
max_worker_processes = 4
max_parallel_workers_per_gather = 2
max_parallel_workers = 4

# Restart PostgreSQL
sudo systemctl restart postgresql

# Optimize queries with EXPLAIN ANALYZE
psql -U postgres -d sniper_bot -c "
EXPLAIN ANALYZE
SELECT * FROM \"SniperOrder\"
WHERE \"userId\" = 'user-id' AND status = 'PENDING'
ORDER BY \"createdAt\" DESC;
"

# Add missing indexes
psql -U postgres -d sniper_bot -c "
CREATE INDEX IF NOT EXISTS idx_sniper_order_user_status_created
ON \"SniperOrder\" (\"userId\", status, \"createdAt\" DESC);
"
```

### Redis Performance Tuning

```bash
# Optimize Redis configuration
sudo nano /etc/redis/redis.conf

# Recommended settings:
maxmemory 2gb
maxmemory-policy allkeys-lru
save 900 1                              # Save every 15 min if 1 key changed
save 300 10                             # Save every 5 min if 10 keys changed
save 60 10000                           # Save every 1 min if 10000 keys changed
stop-writes-on-bgsave-error yes
rdbcompression yes
appendonly yes
appendfsync everysec

# Restart Redis
sudo systemctl restart redis-server

# Monitor Redis performance
redis-cli INFO stats
redis-cli SLOWLOG GET 10
```

### Application Performance Tuning

```bash
# Optimize LRU cache size (src/config/constants.ts)
MAX_CACHE_ITEMS=10000                   # Adjust based on memory

# Optimize connection pools
DATABASE_CONNECTION_LIMIT=20            # Adjust based on load
REDIS_MAX_RETRIES=3

# Enable compression for large payloads
COMPRESSION_ENABLED=true

# Restart application
sudo systemctl restart sniper-bot
```

---

## Alerting and Escalation

### Alert Levels

**P1 - Critical (Immediate Response):**
- Application completely down
- Database unavailable
- All RPC endpoints failing
- Security breach detected

**P2 - High (Response within 30 minutes):**
- Circuit breaker OPEN &gt;5 minutes
- High error rate (&gt;5%)
- Memory usage &gt;90%
- Disk space &lt;10%

**P3 - Medium (Response within 2 hours):**
- Single RPC endpoint failing
- Redis connection issues
- High response latency (&gt;2s)

**P4 - Low (Response within 1 day):**
- High cache miss rate
- Minor performance degradation

### Prometheus Alert Rules

```yaml
# prometheus-alerts.yml

groups:
- name: sniper_bot_alerts
  interval: 30s
  rules:

  # P1 - Critical Alerts
  - alert: ApplicationDown
    expr: up{job="sniper-bot"} == 0
    for: 1m
    labels:
      severity: critical
      priority: P1
    annotations:
      summary: "Sniper Bot application is down"
      description: "Application has been down for more than 1 minute"

  - alert: DatabaseUnavailable
    expr: pg_up == 0
    for: 1m
    labels:
      severity: critical
      priority: P1
    annotations:
      summary: "PostgreSQL database is unavailable"

  # P2 - High Priority Alerts
  - alert: CircuitBreakerOpen
    expr: circuit_breaker_state{name="rpc_pool"} == 1
    for: 5m
    labels:
      severity: warning
      priority: P2
    annotations:
      summary: "Circuit breaker is OPEN for {{ $labels.name }}"
      description: "Circuit breaker has been open for more than 5 minutes"

  - alert: HighErrorRate
    expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05
    for: 5m
    labels:
      severity: warning
      priority: P2
    annotations:
      summary: "High error rate detected (>5%)"

  - alert: HighMemoryUsage
    expr: container_memory_usage_bytes / container_spec_memory_limit_bytes > 0.9
    for: 5m
    labels:
      severity: warning
      priority: P2
    annotations:
      summary: "High memory usage detected (>90%)"

  # P3 - Medium Priority Alerts
  - alert: HighResponseLatency
    expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
    for: 10m
    labels:
      severity: info
      priority: P3
    annotations:
      summary: "High response latency detected (p95 >2s)"

  - alert: RedisConnectionIssues
    expr: redis_connected_clients < 1
    for: 5m
    labels:
      severity: info
      priority: P3
    annotations:
      summary: "Redis connection issues detected"
```

### Escalation Procedure

1. **P1 Alert Triggered:**
   - Immediate PagerDuty notification
   - SMS + Phone call to primary on-call
   - Auto-escalate to secondary after 15 minutes

2. **P2 Alert Triggered:**
   - PagerDuty notification
   - Email to on-call team
   - Escalate to engineering lead after 30 minutes

3. **P3 Alert Triggered:**
   - Email notification
   - Slack alert in #alerts channel
   - Review during business hours

4. **P4 Alert Triggered:**
   - Slack notification
   - Create Jira ticket
   - Address during next sprint

---

## Incident Response Procedures

### Incident Response Template

```markdown
## Incident Report

**Incident ID:** INC-2025-001
**Date/Time:** 2025-01-18 14:30 UTC
**Severity:** P1 / P2 / P3 / P4
**Status:** Investigating / Identified / Monitoring / Resolved

### Impact
- Number of affected users:
- Affected functionality:
- Revenue impact:

### Timeline
- **14:30** - Alert triggered
- **14:32** - On-call engineer acknowledged
- **14:35** - Root cause identified
- **14:40** - Fix deployed
- **14:45** - Service restored
- **15:00** - Post-incident review scheduled

### Root Cause
[Detailed explanation of what caused the incident]

### Resolution
[Steps taken to resolve the incident]

### Prevention
- [ ] Action item 1
- [ ] Action item 2
- [ ] Action item 3

### Lessons Learned
[What we learned and how to prevent similar incidents]
```

### Post-Incident Review Process

1. **Schedule PIR within 24 hours** of incident resolution
2. **Invite stakeholders:** Engineering, DevOps, Product
3. **Document timeline** of events
4. **Identify root cause** (use 5 Whys technique)
5. **Create action items** with owners and deadlines
6. **Update runbook** with new procedures
7. **Share learnings** with broader team

---

## Maintenance Procedures

### Routine Maintenance Checklist

**Daily:**
- [ ] Check application logs for errors
- [ ] Monitor resource usage (CPU, memory, disk)
- [ ] Verify backups completed successfully
- [ ] Review Prometheus alerts

**Weekly:**
- [ ] Review database performance metrics
- [ ] Check for dependency updates (`bun outdated`)
- [ ] Analyze slow query log
- [ ] Review user feedback/bug reports

**Monthly:**
- [ ] Database maintenance (VACUUM, REINDEX)
- [ ] Rotate logs (compress and archive)
- [ ] Review and update documentation
- [ ] Security audit (`npm audit`)
- [ ] Review and optimize resource allocation

**Quarterly:**
- [ ] Disaster recovery drill
- [ ] Penetration testing
- [ ] Rotate SESSION_MASTER_SECRET
- [ ] Review and update RPC endpoints
- [ ] Capacity planning review

### Scheduled Maintenance Window

**Recommended maintenance window:** Sunday 02:00-04:00 UTC (lowest traffic)

**Pre-maintenance checklist:**
- [ ] Notify users 48 hours in advance
- [ ] Backup database
- [ ] Prepare rollback plan
- [ ] Test changes in staging environment
- [ ] Coordinate with on-call team

**Maintenance procedure:**

```bash
# 1. Set maintenance mode (optional)
# Create maintenance message in Telegram bot

# 2. Backup database
pg_dump -U postgres -h db-host -d sniper_bot -F c -b -v -f backup_pre_maintenance_$(date +%Y%m%d_%H%M%S).backup

# 3. Stop application
sudo systemctl stop sniper-bot

# 4. Perform maintenance tasks
# - Update dependencies
# - Run database migrations
# - Update configuration
# - Deploy new version

# 5. Start application
sudo systemctl start sniper-bot

# 6. Verify functionality
curl http://localhost:3000/health
# Test critical user flows

# 7. Monitor for issues
journalctl -u sniper-bot -f

# 8. Notify users maintenance is complete
```

---

## Emergency Contacts Reference

### Quick Access

**Primary On-Call:** [Phone] | [Email]
**Secondary On-Call:** [Phone] | [Email]
**Engineering Lead:** [Phone] | [Email]

**External Services:**
- Helius Status: https://status.helius.dev
- QuickNode Status: https://status.quicknode.com
- Telegram Status: https://telegram.org/status

**Documentation:**
- Deployment Guide: [DEPLOYMENT.md](./DEPLOYMENT.md)
- Architecture: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Testing Guide: [TESTING.md](./TESTING.md)

---

**Last Updated:** 2025-01-18
**Maintained By:** DevOps Team
**Review Schedule:** Monthly
