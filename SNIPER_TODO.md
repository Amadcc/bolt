# Token Sniper - Implementation Checklist

## Phase 1: Detection Service (Yellowstone gRPC)

### 1.1 Core Setup
- [ ] Install `@triton-one/yellowstone-grpc` package
- [ ] Create `src/services/sniper/detection/` directory structure
- [ ] Implement GeyserClient with connection management
- [ ] Add reconnection logic with exponential backoff
- [ ] Configure Helius/Triton gRPC endpoint in env

### 1.2 Pool Detection
- [ ] Implement Raydium AMM V4 detection (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`)
- [ ] Implement Raydium CLMM detection (`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`)
- [ ] Implement Pump.fun detection (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`)
- [ ] Implement Meteora DLMM detection (`LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`)
- [ ] Extract token mints from pool creation transactions
- [ ] Extract initial liquidity amount
- [ ] Extract creator address

### 1.3 Event System
- [ ] Create PoolCreatedEvent type with all fields
- [ ] Implement Redis pub/sub for event distribution
- [ ] Add event deduplication (prevent double-processing)
- [ ] Implement event logging with latency metrics

---

## Phase 2: Security Pipeline

### 2.1 Types & Configuration
- [ ] Define SniperFilters interface
- [ ] Define OnChainCheckResult interface
- [ ] Define SimulationResult interface
- [ ] Add branded types for sniper-specific values

### 2.2 Filter Engine (Tier 1 - <100ms)
- [ ] Create FilterEngine class
- [ ] Implement DEX whitelist check
- [ ] Implement min/max liquidity check
- [ ] Implement quote token validation (SOL/USDC/USDT only)

### 2.3 On-Chain Checker (Tier 2 - <500ms)
- [ ] Create OnChainChecker class
- [ ] Check mint authority status (revoked/active)
- [ ] Check freeze authority status (revoked/active)
- [ ] Fetch top token holders distribution
- [ ] Calculate dev/creator holding percentage
- [ ] Calculate pool supply percentage
- [ ] Fetch token metadata (name, symbol, decimals)

### 2.4 Simulation Engine (Tier 3 - <1000ms)
- [ ] Create SimulationEngine class
- [ ] Simulate buy transaction via Jupiter
- [ ] Simulate sell transaction via Jupiter
- [ ] Calculate buy tax percentage
- [ ] Calculate sell tax percentage
- [ ] Detect honeypot (can buy but can't sell)
- [ ] Calculate price impact

### 2.5 Risk Scorer
- [ ] Create RiskScorer class
- [ ] Define scoring weights for each factor
- [ ] Integrate with existing HoneypotDetector service
- [ ] Calculate composite risk score (0-100)
- [ ] Add Redis caching for risk scores (1h TTL)

---

## Phase 3: Execution Engine

### 3.1 Jito Integration
- [ ] Install `jito-ts` package
- [ ] Create JitoClient class
- [ ] Implement bundle creation
- [ ] Implement tip transaction
- [ ] Implement bundle submission to Block Engine
- [ ] Add bundle confirmation waiting
- [ ] Handle bundle dropped errors
- [ ] Implement fallback to regular RPC

### 3.2 Transaction Builder
- [ ] Create TransactionBuilder class
- [ ] Build swap transaction via Jupiter
- [ ] Add compute budget instruction
- [ ] Add priority fee instruction
- [ ] Add Jito anti-sandwich account if using Jito
- [ ] Sign transaction with user wallet

### 3.3 Priority Fee Calculator
- [ ] Create PriorityFeeCalculator class
- [ ] Define fee presets (normal/fast/turbo)
- [ ] Implement dynamic fee calculation based on network
- [ ] Add fee capping to prevent overpaying

### 3.4 Main Executor
- [ ] Create SniperExecutor class
- [ ] Implement execute() method
- [ ] Add retry logic with backoff
- [ ] Implement confirmation with timeout
- [ ] Track execution metrics (time, success rate)
- [ ] Handle all error cases gracefully

---

## Phase 4: Orchestrator

### 4.1 Core Orchestrator
- [ ] Create SniperOrchestrator class
- [ ] Implement start() method per user
- [ ] Implement stop() method per user
- [ ] Wire up detection → security → execution flow
- [ ] Add parallel security checks (Promise.all)
- [ ] Implement decision logic based on filters & risk score

### 4.2 Wallet Integration
- [ ] Get user wallet from session
- [ ] Decrypt private key for signing
- [ ] Clear key from memory after use
- [ ] Handle wallet not available errors

### 4.3 Notifications
- [ ] Send Telegram notification on successful snipe
- [ ] Send notification on rejected pool (if verbose mode)
- [ ] Include signature, amount, risk score in notification
- [ ] Add inline buttons for position management

---

## Phase 5: Telegram Bot Commands

### 5.1 Main Commands
- [ ] Implement `/sniper` - main sniper menu
- [ ] Implement `/autosnipe on|off` - toggle auto-sniper
- [ ] Implement `/filters` - view/edit filters
- [ ] Implement `/positions` - view active positions
- [ ] Implement `/snipehistory` - view snipe history

### 5.2 Inline Keyboards
- [ ] Create sniper menu keyboard
- [ ] Create filters editing keyboard
- [ ] Create position management keyboard
- [ ] Create DEX selection keyboard
- [ ] Create amount selection keyboard

### 5.3 Callback Handlers
- [ ] Handle filter value changes
- [ ] Handle sniper enable/disable
- [ ] Handle execution mode toggle (Jito/Standard)
- [ ] Handle fee mode selection
- [ ] Handle position close

---

## Phase 6: Database

### 6.1 Schema Updates
- [ ] Add SniperConfig model
- [ ] Add SnipeHistory model
- [ ] Add Position model
- [ ] Create migration
- [ ] Run migration on dev/prod

### 6.2 Repository Layer
- [ ] Create getSniperConfig() function
- [ ] Create updateSniperConfig() function
- [ ] Create createSnipeHistory() function
- [ ] Create getPositions() function
- [ ] Create updatePosition() function

---

## Phase 7: Auto-Sell (Position Management)

### 7.1 Position Monitor
- [ ] Create PositionMonitor class
- [ ] Subscribe to token price updates
- [ ] Track entry price vs current price
- [ ] Calculate unrealized PnL

### 7.2 Exit Strategies
- [ ] Implement take-profit trigger
- [ ] Implement stop-loss trigger
- [ ] Implement trailing stop logic
- [ ] Execute sell via Jupiter
- [ ] Update position status in DB

### 7.3 Notifications
- [ ] Notify on take-profit hit
- [ ] Notify on stop-loss hit
- [ ] Include PnL in notification

---

## Phase 8: Monitoring & Telemetry

### 8.1 Metrics
- [ ] Add pools_detected counter (by DEX)
- [ ] Add detection_latency histogram
- [ ] Add security_check_time histogram
- [ ] Add pools_rejected counter (by reason)
- [ ] Add snipes_attempted counter
- [ ] Add snipes_succeeded counter
- [ ] Add execution_time histogram
- [ ] Add pnl gauge (by user)

### 8.2 Logging
- [ ] Log all pool detections
- [ ] Log security check results
- [ ] Log execution attempts and results
- [ ] Log filter rejections with reasons
- [ ] Ensure no PII/keys in logs

### 8.3 Alerting
- [ ] Alert on Geyser stream disconnect
- [ ] Alert on high security check latency (>2s)
- [ ] Alert on Jito failure rate >50%
- [ ] Alert on executor errors

---

## Phase 9: Testing

### 9.1 Unit Tests
- [ ] Test FilterEngine logic
- [ ] Test RiskScorer calculations
- [ ] Test PriorityFeeCalculator
- [ ] Test TransactionBuilder
- [ ] Test event parsing

### 9.2 Integration Tests
- [ ] Test Geyser connection and subscription
- [ ] Test Jito bundle submission (devnet)
- [ ] Test full snipe flow (devnet)
- [ ] Test auto-sell triggers

### 9.3 Load Tests
- [ ] Test multiple concurrent users
- [ ] Test high-frequency pool detection
- [ ] Test security pipeline throughput

---

## Phase 10: Documentation & Deployment

### 10.1 Documentation
- [ ] Update CLAUDE.md with sniper section
- [ ] Document all new commands
- [ ] Document filter options
- [ ] Document risk score factors

### 10.2 Configuration
- [ ] Add Geyser endpoint to .env
- [ ] Add Jito endpoint to .env
- [ ] Add default filter values to constants
- [ ] Configure rate limits

### 10.3 Deployment
- [ ] Test on devnet thoroughly
- [ ] Deploy to staging
- [ ] Monitor metrics and logs
- [ ] Deploy to production
- [ ] Enable for beta users first

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Detection latency | <500ms |
| Security check time | <1000ms |
| Total execution time | <2000ms |
| Jito success rate | >80% |
| Security accuracy | >95% |
| System uptime | >99.5% |

---

## Dependencies

### Packages to Install
- [ ] `@triton-one/yellowstone-grpc`
- [ ] `jito-ts`
- [ ] `@coral-xyz/anchor` (if needed for IDL parsing)

### Infrastructure Required
- [ ] Yellowstone gRPC endpoint (Helius/Triton)
- [ ] Jito Block Engine access
- [ ] Redis (already have)
