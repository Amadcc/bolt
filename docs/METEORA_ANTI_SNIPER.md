# Meteora DLMM Anti-Sniper Suite - Technical Analysis

**Status:** ⚠️ HIGH RISK for sniping
**Recommendation:** Disable Meteora monitoring by default OR add comprehensive fee calculation

---

## Overview

Meteora DLMM implements a **three-layer Anti-Sniper Suite (A.S.S.)** designed specifically to counter token sniping bots. This makes Meteora pools **significantly less profitable** for traditional sniping strategies.

---

## Anti-Sniper Mechanisms

### 1. Fee Scheduler (Time-Based Dynamic Fees)

**Purpose:** Make early sniping unprofitable through excessive fees that decay over time.

**Technical Implementation:**
```typescript
Parameters:
- cliffFeeNumerator: Starting fee (up to 99%)
- numberOfPeriods: Total reduction periods
- periodFrequency: Seconds between reductions
- feeReductionFactor: Basis points to reduce per period

Formula:
currentFee = cliffFeeNumerator - (elapsed_periods * feeReductionFactor)

Example Timeline:
t=0s:    99% fee (cliff)
t=30s:   75% fee
t=60s:   50% fee
t=120s:  25% fee
t=180s:  10% fee
t=300s:  1% fee (base)
```

**Impact on Snipers:**
- Traditional sniper bots execute in first 1-5 seconds
- At this timing, fees are typically 50-99%
- **Makes sniping mathematically impossible to profit**

---

### 2. Rate Limiter (Size-Based Progressive Fees)

**Purpose:** Penalize large purchases (typical bot behavior) while minimizing impact on retail.

**Technical Implementation:**
```typescript
Base Fee: 100 bps (1%) per 1 SOL
Fee Scaling: Linear, +100 bps per additional SOL

Formula:
totalFee = baseFee * amountInSol

Examples:
1 SOL:   1% fee
2 SOL:   2% fee
4 SOL:   4% fee
10 SOL:  10% fee
50 SOL:  50% fee
100 SOL: 100% fee (impossible!)
```

**Impact on Snipers:**
- Large sniper buys (10-100 SOL) incur 10-100% fees
- **Destroys profit margins for high-capital sniping**
- Even 5 SOL buys lose 5% to fees

---

### 3. Alpha Vault (Whitelist Pre-Launch)

**Purpose:** Reserve supply for verified community before public launch.

**Technical Implementation:**
```typescript
Phase 1: Alpha Vault (Whitelist Only)
- Duration: Configurable (typically 1-24 hours)
- Access: Whitelist addresses only
- Fees: 0% or minimal
- Supply: Configurable % of total

Phase 2: Public Launch
- Opens to everyone
- Fee Scheduler activates (99% → 1%)
- Rate Limiter activates (1%+)
```

**Impact on Snipers:**
- **Cannot participate in Alpha Vault** (no whitelist)
- By public launch, best prices are already taken
- Remaining supply is fragmented

---

## Combined Effect - Worst Case Scenario

```typescript
Sniper Bot attempting 10 SOL buy at t=5s:

Fee Scheduler (t=5s):   90% fee
Rate Limiter (10 SOL):  10% fee
Base Slippage:          5% slippage
Total Cost:             105% of input

Result: IMPOSSIBLE TO PROFIT ❌

Even with 100x pump, sniper loses money!
10 SOL input → 0.5 SOL tokens (after 95% fees)
If token 100x → 50 SOL
Net: 50 SOL - 10 SOL = +40 SOL profit

BUT: Most tokens don't 100x immediately
If token 10x → 5 SOL (LOSS of 5 SOL)
If token 5x → 2.5 SOL (LOSS of 7.5 SOL)
```

---

## Detection Strategy

To safely snipe Meteora pools, we need:

### 1. **Pre-Launch Detection**
```typescript
// Detect pool parameters BEFORE launch
interface MeteoraPoolConfig {
  hasFeeScheduler: boolean;
  hasRateLimiter: boolean;
  hasAlphaVault: boolean;

  feeScheduler?: {
    cliffFee: number;        // 0-9900 (0-99%)
    periods: number;
    frequency: number;       // seconds
    reductionFactor: number; // bps per period
  };

  rateLimiter?: {
    baseFee: number;         // bps per SOL
    enabled: boolean;
  };

  alphaVault?: {
    isActive: boolean;
    endsAt: number;          // UNIX timestamp
    reservedSupply: number;  // percentage
  };
}
```

### 2. **Fee Calculation Engine**
```typescript
function calculateEffectiveFee(
  amountSol: number,
  timeSinceLaunch: number,
  config: MeteoraPoolConfig
): number {
  let totalFee = 0;

  // Fee Scheduler
  if (config.hasFeeScheduler) {
    const elapsed = Math.floor(timeSinceLaunch / config.feeScheduler.frequency);
    const currentFee = Math.max(
      config.feeScheduler.cliffFee - (elapsed * config.feeScheduler.reductionFactor),
      100 // minimum 1%
    );
    totalFee += currentFee;
  }

  // Rate Limiter
  if (config.hasRateLimiter) {
    totalFee += amountSol * config.rateLimiter.baseFee;
  }

  return totalFee / 10000; // Convert bps to decimal
}
```

### 3. **Profit Simulation**
```typescript
function canSnipeProfitably(
  amountSol: number,
  expectedPumpMultiplier: number,
  timeSinceLaunch: number,
  config: MeteoraPoolConfig
): boolean {
  const effectiveFee = calculateEffectiveFee(amountSol, timeSinceLaunch, config);

  // After fees, what % of input becomes tokens?
  const tokenReceiveRate = 1 - effectiveFee;

  // After pump, what's the value?
  const postPumpValue = amountSol * tokenReceiveRate * expectedPumpMultiplier;

  // Profitable if post-pump value > input + desired profit margin
  const desiredProfitMargin = 1.5; // 50% minimum profit
  return postPumpValue > (amountSol * desiredProfitMargin);
}

// Example:
canSnipeProfitably(
  10,    // 10 SOL
  10,    // expect 10x pump
  5,     // 5 seconds after launch
  config // 90% fee scheduler + 10% rate limiter
);
// Returns: false (only 1.05 SOL after fees, even with 10x = 10.5 SOL < 15 SOL needed)
```

---

## Recommended Actions

### Option 1: Disable Meteora (SAFEST)
```typescript
// In SourceManager config
const config = {
  enableMeteora: false, // ← Disable by default
  // ... other sources
};
```

**Pros:**
- No risk of losing money to anti-sniper fees
- Focus on DEXs without protections (Raydium V4, Pump.fun)

**Cons:**
- Miss rare profitable Meteora launches

---

### Option 2: Smart Meteora Filtering (ADVANCED)

```typescript
// Only enable Meteora with strict filters:
const meteoraFilters = {
  // Skip if fee scheduler detected
  skipIfFeeScheduler: true,

  // Skip if rate limiter enabled
  skipIfRateLimiter: true,

  // Skip if Alpha Vault is active
  skipIfAlphaVault: true,

  // Only snipe after fees decay to acceptable level
  maxAcceptableFee: 5, // 5% max total fees

  // Minimum time to wait after launch
  minTimeSinceLaunch: 120, // 2 minutes (fees should be <10% by then)
};
```

**Pros:**
- Can capture late-stage pumps
- Safer than blind sniping

**Cons:**
- Miss early action
- Competing with many other bots by then

---

### Option 3: Alpha Vault Whitelist (FUTURE)

```typescript
// For projects we support:
- Get whitelisted for Alpha Vault
- Buy at 0% fees before public
- Exit during public FOMO pump

Requirements:
- Community participation
- Project relationships
- Manual whitelisting per launch
```

**Pros:**
- Legitimate early access
- Zero anti-sniper fees
- Best prices

**Cons:**
- Manual process
- Limited to friendly projects
- Not scalable

---

## Implementation Checklist

- [ ] Add Meteora pool config detection
- [ ] Implement fee calculation engine
- [ ] Add profit simulation before execution
- [ ] Update MeteoraSource with anti-sniper checks
- [ ] Add warning logs for high-fee pools
- [ ] Create filter presets (Conservative/Aggressive)
- [ ] Update SNIPER_TODO.md with Meteora caveats
- [ ] Consider disabling Meteora by default

---

## Competitive Analysis

**Why Meteora has lower priority (70 vs 95 for Raydium):**

| DEX | Anti-Sniper | Typical Fee | Sniper Success Rate |
|-----|-------------|-------------|---------------------|
| Raydium V4 | ❌ None | 0.25% | 80-90% |
| Pump.fun | ❌ None | 1% | 70-80% |
| Orca | ⚠️ Optional | 0.3% | 60-70% |
| **Meteora** | **✅ Strong** | **1-99%** | **10-20%** |

**Conclusion:**
Meteora's Anti-Sniper Suite makes it the **least profitable DEX for sniping**. Focus on Raydium V4, Pump.fun, and Orca instead.

---

## References

- [Meteora Anti-Sniper Suite Docs](https://docs.meteora.ag/anti-sniper-suite/home)
- [Fee Scheduler Details](https://docs.meteora.ag/anti-sniper-suite/fee-scheduler)
- [Rate Limiter Implementation](https://www.ainvest.com/news/meteora-introduces-rate-limiter-combat-sniper-bots-dynamic-fees-2506/)
- [DLMM Overview](https://docs.meteora.ag/product-overview/dlmm-overview)

---

**Last Updated:** 2025-01-16
**Status:** Research Complete ✅
**Action Required:** Decide on Meteora strategy (disable vs smart filtering)
