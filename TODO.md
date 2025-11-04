# Token Sniper Bot - Development Roadmap

**Project Start Date:** Day 1  
**Current Phase:** Week 2 - Core Trading  
**Target MVP Completion:** Week 3 (21 days total)

---

## ✅ WEEK 1: FOUNDATION (COMPLETED)

### Day 1-2: Project Setup ✅

- [x] Initialize project with Bun
- [x] Configure TypeScript (`tsconfig.json`)
- [x] Setup `package.json` with scripts
- [x] Install core dependencies
  - [x] Fastify (API server)
  - [x] grammY (Telegram bot)
  - [x] Prisma (ORM)
  - [x] @solana/web3.js
  - [x] ioredis
- [x] Create project structure (`src/`, `tests/`, etc)

### Day 3-4: Infrastructure ✅

- [x] Docker Compose setup
  - [x] PostgreSQL 15
  - [x] Redis 7
- [x] Prisma schema design
  - [x] Users table
  - [x] Wallets table
  - [x] Orders table
  - [x] HoneypotChecks table
- [x] Run initial migration
- [x] Database connection (`src/utils/db.ts`)
- [x] Redis connection (`src/utils/redis.ts`)

### Day 5-7: Basic Telegram Bot ✅

- [x] Bot initialization with grammY
- [x] Session middleware
- [x] User auto-creation middleware
- [x] `/start` command
- [x] `/wallet` command (basic)
- [x] `/help` command
- [x] Health check endpoint (`/health`)
- [x] Graceful shutdown handlers
- [x] Environment validation

### Documentation ✅

- [x] CLAUDE.md - Core guidelines
- [x] ARCHITECTURE.md - Production patterns
- [x] HONEYPOT.md - Detection system
- [x] DEVELOPMENT.md - Testing & workflow
- [x] TODO.md - This file

---

## ⬜ WEEK 2: CORE TRADING (CURRENT)

### Day 8-10: Wallet Creation ✅ (COMPLETED)

- [x] **Encryption Service** (`src/services/wallet/encryption.ts`)

  - [x] Install `argon2` package: `bun add argon2`
  - [x] Implement `KeyEncryption` class
    - [x] `encryptPrivateKey()` - AES-256-GCM encryption
    - [x] `decryptPrivateKey()` - AES-256-GCM decryption
    - [x] `validatePassword()` - Password validation
    - [x] Argon2id KDF (64MB memory, 3 iterations)
  - [x] Unit tests for encryption/decryption

- [x] **Key Manager Service** (`src/services/wallet/keyManager.ts`)

  - [x] Implement `KeyManager` class
    - [x] `createWallet()` - Generate keypair + encrypt + store
    - [x] `unlockWallet()` - Decrypt key with password
    - [x] `getWalletInfo()` - Get public data only
    - [x] `hasWallet()` - Check wallet existence
    - [x] `clearKeypair()` - Memory sanitization
  - [x] Password strength validation (min 8 chars, letters + numbers)
  - [x] Non-custodial architecture with Result<T> pattern
  - [x] Unit tests for key manager

- [x] **Session Management** (`src/services/wallet/session.ts`)

  - [x] `createSession()` - Create Redis session (15min TTL)
  - [x] `getSession()` - Retrieve session data
  - [x] `destroySession()` - Delete session
  - [x] `extendSession()` - Extend TTL on activity
  - [x] Cryptographically secure session tokens

- [x] **Telegram Commands**

  - [x] `/createwallet` command handler
    - [x] Prompt for password
    - [x] Create wallet
    - [x] Show public key
    - [x] Password deletion for security
  - [x] Update `/wallet` command to show wallet info
  - [x] Conversation state management

- [x] **Type System**

  - [x] Branded types (SolanaAddress, EncryptedPrivateKey, SessionToken, Lamports)
  - [x] Result<T> error handling pattern
  - [x] Discriminated unions for state machines
  - [x] NO 'any' types - full type safety

- [x] **Utilities**

  - [x] Structured logging with PII redaction
  - [x] Custom error hierarchy
  - [x] Helper functions (retry, sleep, conversions)

- [x] **Testing**
  - [x] Test wallet creation flow
  - [x] Test encryption/decryption
  - [x] Test session management
  - [x] Test password validation
  - [x] E2E wallet flow tests

**Completion Criteria:**

- Users can create wallets with encrypted private keys
- Trading sessions work (15 min TTL)
- All tests passing
- No plaintext keys in logs

---

### Day 11-12: Jupiter Integration

- [ ] **Jupiter Service** (`src/services/trading/jupiter.ts`)

  - [ ] Install Jupiter SDK: `bun add @jup-ag/api`
  - [ ] Implement `JupiterService` class
    - [ ] `getQuote()` - Get swap quote with caching (2s TTL)
    - [ ] `buildSwapTransaction()` - Build versioned transaction
    - [ ] `executeSwap()` - Full swap flow
    - [ ] `sendTransactionWithRetry()` - Retry logic (3 attempts, exponential backoff)
  - [ ] Quote caching in memory Map
  - [ ] Type-safe error handling (Result<T>)

- [ ] **RPC Connection Pool** (`src/services/blockchain/rpcPool.ts`)

  - [ ] Implement `RpcConnectionPool` class
    - [ ] Weighted round-robin selection
    - [ ] Circuit breaker logic
    - [ ] Failure tracking
    - [ ] Auto-recovery (30s timeout)
  - [ ] Configure multiple RPC endpoints
    - [ ] Public Solana RPC
    - [ ] Helius RPC (premium)
    - [ ] QuickNode (optional)

- [ ] **Trading Executor** (`src/services/trading/executor.ts`)

  - [ ] Implement `TradingExecutor` class
    - [ ] Validate session
    - [ ] Check honeypot (integrated later)
    - [ ] Execute swap
    - [ ] Record in database
    - [ ] Calculate commission (0.85%)

- [ ] **Telegram Commands**

  - [ ] `/buy <token> <amount>` command
  - [ ] `/sell <token> <amount>` command
  - [ ] Inline keyboards for confirmation
  - [ ] Progress messages (analyzing, swapping, confirming)
  - [ ] Success/failure notifications with transaction link

- [ ] **Testing**
  - [ ] Integration test: SOL → USDC swap on devnet
  - [ ] Test quote caching
  - [ ] Test RPC failover
  - [ ] Test transaction retry logic
  - [ ] Test commission calculation

**Completion Criteria:**

- Users can execute swaps via Telegram
- RPC pool with circuit breaker works
- Sub-second execution on devnet
- Transactions confirmed successfully

---

### Day 13: Basic Honeypot Detection

- [ ] **API Detection Layer** (`src/services/honeypot/api.ts`)

  - [ ] Implement `ApiDetectionLayer` class
    - [ ] `checkGoPlus()` - GoPlus API integration
      - [ ] Check `is_mintable`
      - [ ] Check `can_take_back_ownership`
      - [ ] Check `sell_tax`
      - [ ] Check `buy_tax`
    - [ ] `checkHoneypotIs()` - Honeypot.is API (optional)
    - [ ] Timeout handling (5s)
    - [ ] Error handling

- [ ] **Simulation Layer** (`src/services/honeypot/simulation.ts`)

  - [ ] Implement `SimulationLayer` class
    - [ ] `checkAuthorities()` - Check mint/freeze authority
    - [ ] `simulateSwap()` - Jupiter quote test
    - [ ] RPC integration

- [ ] **Heuristic Layer** (`src/services/honeypot/heuristics.ts`)

  - [ ] Implement `HeuristicLayer` class
    - [ ] `checkLiquidity()` - Liquidity check (placeholder)
    - [ ] `checkHolderConcentration()` - Top 10 holders
    - [ ] `checkTokenAge()` - Token creation time

- [ ] **Main Detector** (`src/services/honeypot/detector.ts`)

  - [ ] Implement `HoneypotDetector` class
    - [ ] `analyze()` - Run all layers in parallel
    - [ ] Weighted ensemble (25% API, 45% Sim, 30% Heur)
    - [ ] Result caching (1 hour TTL)
    - [ ] Persist to database
  - [ ] Prometheus metrics

- [ ] **Integration with Trading**

  - [ ] Add honeypot check to `TradingExecutor`
  - [ ] Show risk score in Telegram before trade
  - [ ] Block high-risk tokens (score >= 70)
  - [ ] Allow override with warning

- [ ] **Testing**
  - [ ] Test with known honeypot token (test data)
  - [ ] Test with USDC (should pass)
  - [ ] Test API timeout handling
  - [ ] Test caching

**Completion Criteria:**

- Honeypot detection works (80-85% accuracy with API+Sim)
- Risk scores shown in Telegram
- High-risk tokens blocked
- Caching working

---

### Day 14: Testing & Refinement

- [ ] **Unit Tests**

  - [ ] `KeyManager` tests (all methods)
  - [ ] `KeyEncryption` tests
  - [ ] `JupiterService` tests (with mocks)
  - [ ] `HoneypotDetector` tests

- [ ] **Integration Tests**

  - [ ] Full trading flow (wallet → session → swap)
  - [ ] Honeypot detection flow
  - [ ] RPC failover test

- [ ] **Error Handling**

  - [ ] Review all error paths
  - [ ] Add user-friendly error messages
  - [ ] Test edge cases

- [ ] **Code Review**

  - [ ] Check NO `any` types
  - [ ] Verify all Result<T> usage
  - [ ] Confirm branded types used
  - [ ] Security checklist review

- [ ] **Documentation**
  - [ ] Update README.md
  - [ ] Add inline code comments
  - [ ] Document environment variables

**Completion Criteria:**

- All tests passing
- Test coverage > 70%
- No critical bugs
- Code follows guidelines

---

## ⬜ WEEK 3: POLISH & DEPLOY

### Day 15-17: UX Improvements

- [ ] **Inline Keyboards**

  - [ ] Main menu keyboard
  - [ ] Wallet actions keyboard
  - [ ] Trade confirmation keyboard
  - [ ] Settings keyboard

- [ ] **Balance Checking**

  - [ ] `/balance` command
  - [ ] Show SOL balance
  - [ ] Show token balances (top 5)
  - [ ] Portfolio value in USD

- [ ] **Settings**

  - [ ] `/settings` command
  - [ ] Configure slippage (0.1% - 5%)
  - [ ] Configure auto-approve trades
  - [ ] Configure notifications

- [ ] **Progress Messages**

  - [ ] "Analyzing token..." with animated emoji
  - [ ] "Building transaction..."
  - [ ] "Sending transaction..."
  - [ ] "Confirming on-chain..."

- [ ] **Error Messages**

  - [ ] User-friendly error texts
  - [ ] Suggestions for fixing errors
  - [ ] Support contact info

- [ ] **Help System**
  - [ ] Update `/help` with detailed commands
  - [ ] Add FAQ
  - [ ] Add examples

**Completion Criteria:**

- Excellent UX
- Clear error messages
- Helpful documentation

---

### Day 18-19: Monitoring & Observability

- [ ] **Sentry Setup**

  - [ ] Install: `bun add @sentry/node`
  - [ ] Initialize Sentry in `src/index.ts`
  - [ ] Add error handler middleware
  - [ ] Test error reporting

- [ ] **Prometheus Metrics**

  - [ ] Install: `bun add prom-client`
  - [ ] Implement metrics in `src/utils/metrics.ts`
    - [ ] `orders_total` counter
    - [ ] `order_latency_seconds` histogram
    - [ ] `honeypot_checks_total` counter
    - [ ] `rpc_requests_total` counter
    - [ ] `active_users` gauge
  - [ ] Add `/metrics` endpoint
  - [ ] Instrument code with metrics

- [ ] **Logging**

  - [ ] Install: `bun add pino pino-pretty`
  - [ ] Setup structured logging
  - [ ] Service-specific loggers
  - [ ] Log rotation (production)

- [ ] **Health Checks**
  - [ ] Enhance `/health` endpoint
    - [ ] Database connectivity
    - [ ] Redis connectivity
    - [ ] RPC connectivity
    - [ ] Memory usage
    - [ ] Uptime
  - [ ] Add `/ready` endpoint (for k8s)

**Completion Criteria:**

- Sentry catching errors
- Prometheus metrics exposed
- Logs structured and readable
- Health checks working

---

### Day 20-21: Deployment

- [ ] **Pre-Deploy Checklist**

  - [ ] All tests passing
  - [ ] Type check passing
  - [ ] No console.log (use logger)
  - [ ] Environment variables documented
  - [ ] Secrets in secure storage
  - [ ] Database migrations ready

- [ ] **Production Environment**

  - [ ] Choose hosting (Railway/DigitalOcean/Render)
  - [ ] Setup production database
  - [ ] Setup production Redis
  - [ ] Configure environment variables
  - [ ] Setup domain (optional)

- [ ] **Deploy**

  - [ ] Build: `bun run build`
  - [ ] Run migrations: `bun run prisma:migrate deploy`
  - [ ] Deploy application
  - [ ] Verify health endpoint
  - [ ] Test bot commands

- [ ] **Post-Deploy**

  - [ ] Monitor Sentry for errors
  - [ ] Check Prometheus metrics
  - [ ] Verify database connections
  - [ ] Test all critical flows
  - [ ] Backup database

- [ ] **Beta Testing**
  - [ ] Invite 10-20 beta testers
  - [ ] Collect feedback
  - [ ] Fix critical bugs
  - [ ] Iterate

**Completion Criteria:**

- Bot live in production
- All services healthy
- Beta testers onboarded
- Zero critical bugs

---

## 🚀 POST-MVP (PHASE 2)

### Week 4-8: Production Hardening

- [ ] **Enhanced Security**

  - [ ] MFA support (TOTP)
  - [ ] Emergency lock mechanism
  - [ ] Activity monitoring
  - [ ] Suspicious transaction detection

- [ ] **Advanced Honeypot Detection**

  - [ ] ML Layer implementation
  - [ ] Train XGBoost model (100+ features)
  - [ ] Achieve 95%+ accuracy
  - [ ] Continuous learning

- [ ] **Performance Optimization**

  - [ ] Query optimization
  - [ ] Connection pooling (PgBouncer)
  - [ ] Multi-layer caching
  - [ ] WebSocket for real-time updates

- [ ] **Advanced Features**
  - [ ] Stop-loss / Take-profit
  - [ ] Limit orders
  - [ ] Price alerts
  - [ ] Portfolio tracking
  - [ ] Copy trading

### Week 9-16: Microservices Architecture

- [ ] **Service Extraction**

  - [ ] Market Data Service
  - [ ] Honeypot Detection Service
  - [ ] Trading Service
  - [ ] User Service

- [ ] **Message Queue**

  - [ ] Migrate Redis Streams → Kafka
  - [ ] Event-driven architecture
  - [ ] Stream processing

- [ ] **Multi-Chain Support**

  - [ ] Add Ethereum adapter
  - [ ] Add BSC adapter
  - [ ] Add Base adapter
  - [ ] Unified abstraction layer

- [ ] **Scaling**
  - [ ] Kubernetes deployment
  - [ ] Auto-scaling (HPA)
  - [ ] Multi-region support
  - [ ] Load balancing

---

## 📊 METRICS & GOALS

### Week 1 Goals ✅

- [x] Basic bot responding to commands
- [x] Database and Redis working
- [x] Health check endpoint
- [x] Clean project structure

### Week 2 Goals (Current)

- [x] Users can create wallets ✅
- [ ] Users can execute swaps
- [ ] Honeypot detection working (80%+ accuracy)
- [x] All core tests passing ✅
- [ ] Sub-2s trade execution

### Week 3 Goals

- [ ] 10+ beta testers
- [ ] Deployed to production
- [ ] 99% uptime
- [ ] Zero security incidents
- [ ] Positive user feedback

### MVP Success Metrics

- [ ] 50+ active users (Week 4)
- [ ] $10K+ monthly volume
- [ ] <1s average order execution
- [ ] 85%+ honeypot accuracy
- [ ] 99.5% uptime
- [ ] Zero exploits
- [ ] <5% user churn

---

## 🔧 TECH DEBT & NICE-TO-HAVES

### Technical Improvements (Post-MVP)

- [ ] Add request rate limiting per user
- [ ] Implement API key rotation
- [ ] Add database read replicas
- [ ] Implement database sharding (if >100K users)
- [ ] Add Redis Cluster (if >10K users)
- [ ] Implement distributed tracing (Jaeger)
- [ ] Add APM (DataDog/New Relic)
- [ ] Implement blue-green deployments

### Feature Ideas (Backlog)

- [ ] Web dashboard (view-only)
- [ ] Mobile app (React Native)
- [ ] Referral program
- [ ] Loyalty rewards
- [ ] Advanced analytics
- [ ] Social features (copy traders)
- [ ] Token watchlists
- [ ] Custom alerts
- [ ] Multi-wallet support
- [ ] Hardware wallet support (Ledger)

---

## 📝 NOTES

### Current Blockers

- None (Week 1 completed successfully)

### Decisions Made

- ✅ Use Bun instead of Node.js (faster, native TS)
- ✅ Use Fastify instead of Express (3x faster)
- ✅ Use Prisma instead of TypeORM (better DX)
- ✅ Start with Solana only (74% of market)
- ✅ Non-custodial from day 1 (main differentiator)
- ✅ Session-based auth (balance security/UX)
- ✅ Modular monolith → Microservices (gradual)

### Key Risks & Mitigations

1. **Risk:** Users lose private keys

   - **Mitigation:** Session-based auth (no repeated password entry), MFA (Phase 2)

2. **Risk:** Honeypot detection false positives

   - **Mitigation:** Show risk score, allow override with warning, continuous improvement

3. **Risk:** RPC rate limits

   - **Mitigation:** Connection pool, multiple endpoints, exponential backoff

4. **Risk:** Jupiter API downtime
   - **Mitigation:** Fallback to direct Raydium/Orca swaps (Phase 2)

---

## ✅ DAILY CHECKLIST

Before starting work:

- [ ] `git pull origin main`
- [ ] `bun install`
- [ ] `bun run docker:up`
- [ ] `bun run prisma:migrate`

Before committing:

- [ ] `bun run build` (type check)
- [ ] `bun test` (all tests pass)
- [ ] Review security checklist
- [ ] No `any` types
- [ ] No console.log statements

After committing:

- [ ] Use conventional commits format
- [ ] Update this TODO.md if needed
- [ ] Push to GitHub

---

**Last Updated:** Day 10 (Wallet Creation Complete)
**Next Milestone:** Day 12 (Jupiter Integration Complete)
**MVP Target:** Day 21

🚀 Let's build something bulletproof!
