# Production Deployment Checklist

**Version:** 1.0.0
**Last Updated:** 2025-01-18
**Status:** Ready for Production Launch

---

## Table of Contents

1. [Overview](#overview)
2. [Pre-Deployment Checklist](#pre-deployment-checklist)
3. [Infrastructure Checklist](#infrastructure-checklist)
4. [Security Checklist](#security-checklist)
5. [Performance Checklist](#performance-checklist)
6. [Monitoring & Observability](#monitoring--observability)
7. [Testing & Validation](#testing--validation)
8. [Documentation](#documentation)
9. [Post-Deployment Checklist](#post-deployment-checklist)
10. [Go/No-Go Decision](#gono-go-decision)

---

## Overview

This checklist ensures the Solana Token Sniper Bot is production-ready before deployment. Complete ALL items before going live.

**Deployment Date:** ___________
**Deployment Lead:** ___________
**Reviewed By:** ___________

---

## Pre-Deployment Checklist

### Code Quality

- [ ] **All tests passing**
  - [ ] Unit tests: `bun test tests/unit/` (90%+ coverage)
  - [ ] Integration tests: `bun test tests/integration/`
  - [ ] E2E tests: `bun test tests/e2e/`
  - [ ] Load tests: `bun test tests/load/`
  - [ ] Performance benchmarks: `bun test tests/performance/`

- [ ] **Code review completed**
  - [ ] Security-sensitive code reviewed by 2+ engineers
  - [ ] All PR comments resolved
  - [ ] No merge conflicts

- [ ] **TypeScript compilation**
  - [ ] Zero TypeScript errors: `bunx tsc --noEmit`
  - [ ] No `any` types in codebase
  - [ ] Strict mode enabled

- [ ] **Dependency audit**
  - [ ] No critical vulnerabilities: `bun audit`
  - [ ] No high-severity vulnerabilities
  - [ ] Dependencies up to date (last 30 days)

### Environment Configuration

- [ ] **Environment variables configured**
  - [ ] Production `.env` file created (not committed!)
  - [ ] All required variables set (see `.env.example`)
  - [ ] Secrets validated (no test/dev values)
  - [ ] SESSION_MASTER_SECRET generated (64 bytes, base64)
  - [ ] Database URL with strong password
  - [ ] Redis URL configured
  - [ ] BOT_TOKEN validated
  - [ ] Premium RPC endpoints configured (Helius/QuickNode)

- [ ] **Service configuration**
  - [ ] NODE_ENV=production
  - [ ] SOLANA_NETWORK=mainnet
  - [ ] PLATFORM_FEE_ACCOUNT configured
  - [ ] ALLOWED_ORIGINS restricted to production domains

### Database

- [ ] **Database setup**
  - [ ] PostgreSQL 15+ installed and running
  - [ ] Database created: `sniper_bot`
  - [ ] User created with strong password
  - [ ] Migrations applied: `bunx prisma migrate deploy`
  - [ ] Prisma Client generated: `bunx prisma generate`

- [ ] **Database security**
  - [ ] Firewall configured (port 5432 blocked externally)
  - [ ] TLS enabled: `sslmode=require`
  - [ ] Strong password (32+ characters)
  - [ ] Backup strategy configured (see DEPLOYMENT.md)

- [ ] **Database performance**
  - [ ] Indexes created (see schema.prisma)
  - [ ] VACUUM ANALYZE run
  - [ ] Connection pool configured (20 connections)

### Cache (Redis)

- [ ] **Redis setup**
  - [ ] Redis 7+ installed and running
  - [ ] Password authentication enabled (`requirepass`)
  - [ ] Firewall configured (port 6379 blocked externally)
  - [ ] TLS enabled (production)

- [ ] **Redis configuration**
  - [ ] `maxmemory 2gb` configured
  - [ ] `maxmemory-policy allkeys-lru` configured
  - [ ] Persistence enabled: `appendonly yes`
  - [ ] RDB + AOF configured (see DEPLOYMENT.md)

### Blockchain Integration

- [ ] **RPC endpoints**
  - [ ] Primary RPC configured (Helius/QuickNode)
  - [ ] API keys validated
  - [ ] Rate limits verified (check provider dashboard)
  - [ ] Backup RPC configured (failover)
  - [ ] Public RPC as last resort

- [ ] **Geyser Plugin (Optional - Recommended)**
  - [ ] Geyser provider selected (Chainstack $49/mo recommended)
  - [ ] GEYSER_ENABLED=true in .env
  - [ ] GEYSER_ENDPOINT configured
  - [ ] GEYSER_TOKEN configured
  - [ ] Connection tested (see GEYSER_SETUP_GUIDE.md)
  - [ ] Latency validated (<50ms)

---

## Infrastructure Checklist

### Server Setup

- [ ] **Server specifications**
  - [ ] CPU: 4+ cores (8+ for high-frequency trading)
  - [ ] RAM: 8GB minimum (16GB recommended)
  - [ ] Storage: 50GB SSD (NVMe preferred)
  - [ ] Network: 100+ Mbps with low latency (<50ms to RPC)
  - [ ] OS: Ubuntu 22.04 LTS (kernel 5.15+)

- [ ] **Server hardening**
  - [ ] Non-root user created (`sniper-bot`)
  - [ ] SSH key authentication only (password auth disabled)
  - [ ] Firewall configured (ufw enabled)
  - [ ] Fail2ban installed and configured
  - [ ] Unattended upgrades enabled
  - [ ] System timezone set to UTC

### Firewall Configuration

- [ ] **UFW rules configured**
  ```bash
  # SSH (restrict to specific IPs)
  ufw allow from YOUR_IP to any port 22 proto tcp

  # HTTPS (if web dashboard)
  ufw allow 443/tcp

  # Prometheus metrics (internal only)
  ufw allow from 10.0.0.0/8 to any port 3000 proto tcp

  # Block database ports
  ufw deny 5432/tcp
  ufw deny 6379/tcp

  # Default policies
  ufw default deny incoming
  ufw default allow outgoing

  # Enable
  ufw enable
  ```

### Deployment Method

Choose ONE deployment method:

- [ ] **Docker Deployment**
  - [ ] Dockerfile created (see DEPLOYMENT.md)
  - [ ] docker-compose.production.yml configured
  - [ ] Multi-stage build configured
  - [ ] Non-root user in container
  - [ ] Health check configured
  - [ ] Resource limits set (CPU, memory)

- [ ] **Kubernetes Deployment**
  - [ ] Namespace created (`sniper-bot`)
  - [ ] Secrets configured (sealed secrets or external secrets manager)
  - [ ] ConfigMap created
  - [ ] Deployments created (app, postgres, redis)
  - [ ] Services created
  - [ ] PersistentVolumeClaims configured
  - [ ] Network policies configured
  - [ ] Security contexts configured (non-root, read-only filesystem)
  - [ ] Resource limits set

- [ ] **Bare Metal Deployment**
  - [ ] Systemd service created (`sniper-bot.service`)
  - [ ] Service enabled on boot
  - [ ] Log rotation configured
  - [ ] Resource limits configured (MemoryMax, CPUQuota)
  - [ ] Working directory permissions set

### Backup Strategy

- [ ] **Database backups**
  - [ ] Daily automated backups configured
  - [ ] Backup script created (see DEPLOYMENT.md)
  - [ ] Backups encrypted (GPG)
  - [ ] Backups stored offsite (S3/cloud storage)
  - [ ] Retention policy configured (7 days, 4 weeks, 12 months)
  - [ ] Backup restoration tested

- [ ] **Redis backups (if persistent data)**
  - [ ] RDB backups enabled
  - [ ] AOF backups enabled
  - [ ] Backup script configured

---

## Security Checklist

### Cryptography

- [ ] **Password hashing**
  - [ ] Argon2id configured (see SECURITY_AUDIT.md)
  - [ ] Memory cost: 64 MiB (verified)
  - [ ] Time cost: 3 iterations (verified)
  - [ ] Parallelism: 4 threads (verified)

- [ ] **Encryption**
  - [ ] AES-256-GCM for private key encryption (verified)
  - [ ] Unique IV per encryption (verified)
  - [ ] Random salt per user (verified)
  - [ ] Authenticated encryption (verified)

- [ ] **Session management**
  - [ ] Cryptographically secure tokens (32 bytes, 256-bit)
  - [ ] Redis-backed sessions (15-minute TTL)
  - [ ] Auto-expiry configured
  - [ ] Session invalidation on logout

### Rate Limiting

- [ ] **Wallet unlock rate limiting**
  - [ ] 5 attempts per 15 minutes (verified)
  - [ ] Redis-backed tracking (verified)
  - [ ] Metrics tracking unlock failures

- [ ] **RPC rate limiting**
  - [ ] Per-endpoint limits configured (verified)
  - [ ] Circuit breakers enabled (verified)
  - [ ] Failover configured

### Input Validation

- [ ] **Type safety**
  - [ ] TypeScript strict mode enabled
  - [ ] Branded types for critical values (verified)
  - [ ] No `any` types in codebase

- [ ] **Database security**
  - [ ] Prisma ORM only (no raw SQL)
  - [ ] Parameterized queries verified
  - [ ] SQL injection impossible

### Secret Management

- [ ] **Critical secrets configured**
  - [ ] SESSION_MASTER_SECRET: 64 bytes base64-encoded
  - [ ] DATABASE_URL: Strong password (32+ chars)
  - [ ] REDIS_URL: Strong password (if auth enabled)
  - [ ] BOT_TOKEN: Valid Telegram bot token
  - [ ] RPC API keys: Valid and active

- [ ] **Secret rotation plan**
  - [ ] SESSION_MASTER_SECRET rotation scheduled (90 days)
  - [ ] Database password rotation scheduled (90 days)
  - [ ] RPC API key rotation scheduled (annual)

### Network Security

- [ ] **TLS/SSL**
  - [ ] PostgreSQL TLS enabled (`sslmode=require`)
  - [ ] Redis TLS enabled (production)
  - [ ] All external API calls via HTTPS

- [ ] **DDoS protection**
  - [ ] Cloudflare or AWS Shield configured (recommended)
  - [ ] Rate limiting at application level (verified)
  - [ ] Circuit breakers configured (verified)

### Access Control

- [ ] **SSH access**
  - [ ] Key-based authentication only
  - [ ] Root login disabled
  - [ ] Specific IPs whitelisted (if possible)

- [ ] **Database access**
  - [ ] Firewall: Port 5432 blocked externally
  - [ ] Strong password configured
  - [ ] No public access

- [ ] **Redis access**
  - [ ] Firewall: Port 6379 blocked externally
  - [ ] Password authentication enabled
  - [ ] Dangerous commands renamed (FLUSHDB, FLUSHALL, CONFIG)

### Security Audit

- [ ] **Audit completed**
  - [ ] Security audit document reviewed (SECURITY_AUDIT.md)
  - [ ] Security rating: 9.5/10 (verified)
  - [ ] Critical issues resolved
  - [ ] High-priority issues resolved or mitigated

- [ ] **Penetration testing**
  - [ ] Password brute-force test: PASS
  - [ ] SQL injection test: PASS
  - [ ] Rate limit bypass test: PASS
  - [ ] Memory exhaustion test: PASS
  - [ ] Session hijacking test: PASS

- [ ] **Compliance**
  - [ ] OWASP Top 10 compliance: 9/10 (verified)
  - [ ] NIST Cybersecurity Framework aligned
  - [ ] PII redaction in logs (verified)

---

## Performance Checklist

### Performance Targets

- [ ] **Latency targets met**
  - [ ] Pool detection: <500ms (p95)
  - [ ] Honeypot check: <2s (p95)
  - [ ] Trade execution: <1.5s (p95)
  - [ ] Full sniper flow: <4s (p95)

- [ ] **Benchmarks passing**
  - [ ] Comprehensive benchmarks: `bun test tests/performance/comprehensive.test.ts`
  - [ ] Load tests (100+ concurrent): `bun test tests/load/concurrent-snipes.test.ts`
  - [ ] All 13 components within targets

### Resource Limits

- [ ] **Memory usage**
  - [ ] Peak memory <500MB under load
  - [ ] No memory leaks detected
  - [ ] Garbage collection tuned

- [ ] **CPU usage**
  - [ ] Average CPU <80% under load
  - [ ] No CPU thrashing
  - [ ] Worker threads configured correctly

### Database Performance

- [ ] **Query optimization**
  - [ ] All indexes created (verified)
  - [ ] Slow queries identified and optimized
  - [ ] EXPLAIN ANALYZE run on critical queries
  - [ ] Connection pool tuned (20 connections)

- [ ] **PostgreSQL tuning**
  - [ ] shared_buffers configured (25% of RAM)
  - [ ] effective_cache_size configured (75% of RAM)
  - [ ] random_page_cost tuned for SSD (1.1)
  - [ ] VACUUM ANALYZE scheduled

### Cache Performance

- [ ] **Redis optimization**
  - [ ] LRU eviction policy configured
  - [ ] Max memory configured (2GB)
  - [ ] Cache hit rate monitored (target >80%)
  - [ ] TTLs configured appropriately

### RPC Performance

- [ ] **RPC latency**
  - [ ] Average latency <200ms (premium RPC)
  - [ ] Circuit breakers tested
  - [ ] Failover tested
  - [ ] Rate limits respected

### Geyser Performance (if enabled)

- [ ] **Geyser latency**
  - [ ] Average latency <50ms (verified)
  - [ ] 5 concurrent streams verified
  - [ ] Account filters configured (50 accounts max)
  - [ ] Jito ShredStream tested

---

## Monitoring & Observability

### Prometheus Setup

- [ ] **Prometheus installed**
  - [ ] Prometheus server running
  - [ ] Configuration file created (`prometheus.yml`)
  - [ ] Scrape targets configured
  - [ ] Retention period configured (15 days minimum)

- [ ] **Metrics endpoint**
  - [ ] `/metrics` endpoint accessible
  - [ ] Key metrics verified:
    - [ ] `circuit_breaker_state`
    - [ ] `rpc_request_duration_seconds`
    - [ ] `active_sessions`
    - [ ] `wallet_unlock_failures_total`
    - [ ] `honeypot_checks_total`
    - [ ] `benchmark_duration_ms`
    - [ ] `load_test_concurrency`

### Grafana Setup

- [ ] **Grafana installed**
  - [ ] Grafana server running
  - [ ] Admin password changed
  - [ ] Prometheus data source configured

- [ ] **Dashboards imported**
  - [ ] Performance dashboard (`grafana/dashboards/performance.json`)
  - [ ] Detection dashboard (`grafana/dashboards/detection.json`)
  - [ ] Sniper dashboard (`grafana/dashboards/sniper.json`)
  - [ ] Positions dashboard (`grafana/dashboards/positions.json`)
  - [ ] Health dashboard (`grafana/dashboards/health.json`)

- [ ] **Dashboard validation**
  - [ ] All panels display data
  - [ ] Queries return results
  - [ ] Refresh interval configured (30s)
  - [ ] Thresholds configured (yellow/red alerts)

### Alerting

- [ ] **Prometheus alert rules**
  - [ ] Alert rules file created (`prometheus-alerts.yml`)
  - [ ] Critical alerts configured:
    - [ ] CircuitBreakerOpenTooLong (P1)
    - [ ] HighUnlockFailureRate (P2)
    - [ ] HighExecutionLatency (P2)
    - [ ] HighFullFlowLatency (P2)
    - [ ] LowSuccessRate (P2)
    - [ ] HighMemoryUsage (P2)
    - [ ] HighCPUUsage (P2)

- [ ] **Alert routing**
  - [ ] Alertmanager installed (or PagerDuty/Slack)
  - [ ] Alert routing configured
  - [ ] Notification channels tested
  - [ ] Escalation policy defined

### Logging

- [ ] **Structured logging**
  - [ ] Pino logger configured
  - [ ] Log levels configured (INFO in production)
  - [ ] PII redaction verified
  - [ ] No secrets in logs

- [ ] **Log aggregation**
  - [ ] Log rotation configured (daily, 30-day retention)
  - [ ] Centralized logging (ELK/Loki/CloudWatch) configured (optional)
  - [ ] Log shipping tested

### Health Checks

- [ ] **Application health**
  - [ ] `/health` endpoint accessible
  - [ ] Returns 200 OK when healthy
  - [ ] Checks database connectivity
  - [ ] Checks Redis connectivity

- [ ] **Liveness probes** (Kubernetes)
  - [ ] Liveness probe configured
  - [ ] Readiness probe configured
  - [ ] Startup probe configured

---

## Testing & Validation

### Functional Testing

- [ ] **User flows**
  - [ ] /start command works
  - [ ] /createwallet creates wallet successfully
  - [ ] /balance shows correct balance
  - [ ] /buy executes successful swap
  - [ ] /sell executes successful swap
  - [ ] /sniper dashboard loads
  - [ ] /positions shows positions

- [ ] **Security flows**
  - [ ] Wallet unlock requires password
  - [ ] Rate limiting triggers after 5 failed attempts
  - [ ] Session expires after 15 minutes
  - [ ] Honeypot detection blocks high-risk tokens

### Performance Testing

- [ ] **Load testing**
  - [ ] Baseline: 10 concurrent users (verified)
  - [ ] Moderate: 50 concurrent users (verified)
  - [ ] Heavy: 100 concurrent users (verified)
  - [ ] Stress: 200 concurrent users (verified)

- [ ] **Endurance testing**
  - [ ] Application runs for 24+ hours without issues
  - [ ] Memory stable over time
  - [ ] No performance degradation

### Disaster Recovery Testing

- [ ] **Database failure**
  - [ ] Database restore from backup tested
  - [ ] Application recovers automatically
  - [ ] Data integrity verified

- [ ] **Redis failure**
  - [ ] Application gracefully degrades
  - [ ] Sessions recreated on Redis restart
  - [ ] Circuit breaker state recovers

- [ ] **RPC failure**
  - [ ] Circuit breakers trigger correctly
  - [ ] Failover to backup RPC works
  - [ ] Automatic recovery verified

---

## Documentation

### User Documentation

- [ ] **User guides**
  - [ ] Quick start guide created
  - [ ] Filter configuration guide created
  - [ ] Risk management best practices documented
  - [ ] FAQ section created
  - [ ] Troubleshooting guide created

### Developer Documentation

- [ ] **Technical documentation**
  - [ ] README.md updated
  - [ ] ARCHITECTURE.md complete
  - [ ] DEPLOYMENT.md complete
  - [ ] RUNBOOK.md complete
  - [ ] SECURITY_AUDIT.md reviewed
  - [ ] GEYSER_SETUP_GUIDE.md complete
  - [ ] MONITORING_SETUP_GUIDE.md complete

### Operational Documentation

- [ ] **Runbooks**
  - [ ] Emergency contacts documented
  - [ ] Common failure scenarios documented
  - [ ] Recovery procedures documented
  - [ ] Escalation procedures documented

---

## Post-Deployment Checklist

### Immediate Post-Deployment (0-1 hour)

- [ ] **Deployment verification**
  - [ ] Application health check passes
  - [ ] All services running (app, database, redis)
  - [ ] No errors in logs
  - [ ] Metrics endpoint accessible

- [ ] **Smoke testing**
  - [ ] /start command works
  - [ ] Wallet creation works
  - [ ] Balance check works
  - [ ] Test swap executes successfully

- [ ] **Monitoring verification**
  - [ ] Prometheus scraping metrics
  - [ ] Grafana dashboards displaying data
  - [ ] Alerts not firing (green state)

### Short-Term Monitoring (1-24 hours)

- [ ] **Performance monitoring**
  - [ ] Latency within targets (p95 <4s)
  - [ ] Memory usage stable (<500MB)
  - [ ] CPU usage stable (<80%)
  - [ ] No circuit breakers open

- [ ] **Error monitoring**
  - [ ] Error rate <1%
  - [ ] No critical errors
  - [ ] No database connection issues
  - [ ] No RPC failures

- [ ] **User feedback**
  - [ ] Monitor Telegram for user issues
  - [ ] Track swap success rate (>90%)
  - [ ] Track honeypot detection accuracy (>95%)

### Medium-Term Monitoring (1-7 days)

- [ ] **Capacity monitoring**
  - [ ] Concurrent user capacity verified
  - [ ] Database performance stable
  - [ ] Redis cache hit rate >80%

- [ ] **Reliability monitoring**
  - [ ] Uptime >99.9%
  - [ ] No unexpected restarts
  - [ ] Backups completing successfully

- [ ] **Security monitoring**
  - [ ] No brute-force attacks
  - [ ] No SQL injection attempts
  - [ ] No suspicious activity

---

## Go/No-Go Decision

### Pre-Launch Review Meeting

**Date:** ___________
**Attendees:** ___________

### Critical Requirements (Must be 100%)

| Requirement | Status | Notes |
|-------------|--------|-------|
| All tests passing | ☐ PASS | |
| Zero TypeScript errors | ☐ PASS | |
| Security audit 9.5/10 | ☐ PASS | |
| Database migrations applied | ☐ PASS | |
| Secrets configured | ☐ PASS | |
| Firewall configured | ☐ PASS | |
| Monitoring operational | ☐ PASS | |
| Backups configured | ☐ PASS | |

### High-Priority Requirements (Should be 100%)

| Requirement | Status | Notes |
|-------------|--------|-------|
| Performance targets met | ☐ PASS | |
| Geyser configured | ☐ PASS | |
| Grafana dashboards working | ☐ PASS | |
| Alerting configured | ☐ PASS | |
| Documentation complete | ☐ PASS | |
| Disaster recovery tested | ☐ PASS | |

### Decision

- [ ] **GO** - All critical requirements met, proceed with deployment
- [ ] **NO-GO** - Critical issues found, address before deployment

**Decision Maker:** ___________
**Signature:** ___________
**Date:** ___________

---

## Rollback Plan

If issues occur post-deployment:

1. **Immediate Rollback** (within 1 hour)
   ```bash
   # Docker
   docker-compose -f docker-compose.production.yml down
   docker-compose -f docker-compose.production.yml pull app:previous-version
   docker-compose -f docker-compose.production.yml up -d

   # Kubernetes
   kubectl rollout undo deployment/sniper-bot -n sniper-bot

   # Bare Metal
   git checkout previous-version
   sudo systemctl restart sniper-bot
   ```

2. **Database Rollback** (if schema changed)
   ```bash
   pg_restore -U postgres -d sniper_bot -c backup_pre_deployment.backup
   ```

3. **Verify Rollback**
   - Health check passes
   - No errors in logs
   - Users can execute swaps
   - Monitoring shows green state

4. **Post-Rollback**
   - Document issues encountered
   - Schedule post-incident review (PIR)
   - Create action items for fixes
   - Reschedule deployment

---

## Post-Launch Monitoring Schedule

### Week 1 (Beta Testing)

- [ ] **Daily monitoring**
  - [ ] Review logs for errors
  - [ ] Check performance metrics
  - [ ] Monitor user feedback
  - [ ] Track success rates

- [ ] **Limited user rollout**
  - [ ] Deploy to 10-20 users
  - [ ] Gather feedback
  - [ ] Fix critical bugs
  - [ ] Tune performance

### Week 2 (Optimization)

- [ ] **Performance optimization**
  - [ ] Analyze benchmark data
  - [ ] Optimize slow paths
  - [ ] Tune circuit breaker thresholds
  - [ ] Adjust priority fee strategies

### Month 1 (Scaling)

- [ ] **Full rollout**
  - [ ] Open to all users
  - [ ] Monitor infrastructure costs
  - [ ] Scale servers as needed
  - [ ] Implement rate limiting per user

- [ ] **Continuous improvement**
  - [ ] Review weekly metrics
  - [ ] Implement user feedback
  - [ ] Add premium tier features

---

## Checklist Sign-Off

### Approval Chain

| Role | Name | Signature | Date |
|------|------|-----------|------|
| **Engineering Lead** | __________ | __________ | __________ |
| **DevOps Lead** | __________ | __________ | __________ |
| **Security Lead** | __________ | __________ | __________ |
| **Product Manager** | __________ | __________ | __________ |

### Final Deployment Authorization

**I hereby authorize the deployment of the Solana Token Sniper Bot to production.**

**Name:** ___________
**Title:** ___________
**Signature:** ___________
**Date:** ___________

---

## Quick Reference

### Emergency Contacts

- **Primary On-Call:** [Phone] | [Email]
- **Secondary On-Call:** [Phone] | [Email]
- **Engineering Lead:** [Phone] | [Email]

### Critical URLs

- **Application:** https://your-domain.com
- **Grafana:** http://monitoring-server:3000
- **Prometheus:** http://monitoring-server:9090
- **Helius Dashboard:** https://dashboard.helius.dev
- **QuickNode Dashboard:** https://dashboard.quicknode.com
- **Chainstack Dashboard:** https://console.chainstack.com

### Critical Commands

```bash
# Check application status
sudo systemctl status sniper-bot

# View logs
journalctl -u sniper-bot -f

# Check metrics
curl http://localhost:3000/metrics

# Check health
curl http://localhost:3000/health

# Restart application
sudo systemctl restart sniper-bot
```

---

**Document Version:** 1.0.0
**Maintained By:** DevOps Team
**Review Schedule:** Before each deployment
**Next Review:** ___________
