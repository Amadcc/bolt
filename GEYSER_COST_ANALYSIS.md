# Geyser Plugin Cost Analysis

**Last Updated:** 2025-01-16

## Executive Summary

Geyser Plugin (Yellowstone gRPC) provides **4-10x faster** pool detection compared to WebSocket RPC, reducing latency from ~200-500ms to <50ms. With Chainstack's new $49/month pricing (launched September 2025), Geyser is now **accessible for production snipers**.

**Recommendation:** Enable Geyser for competitive sniping. The speed advantage justifies the cost for serious traders.

---

## 🚀 Performance Comparison

### WebSocket RPC (Base)
- **Latency:** 200-500ms
- **Method:** Poll via `Connection.onLogs()`
- **Cost:** Free (public RPC) or $0-50/month (premium RPC)
- **Pros:** Simple, reliable, works everywhere
- **Cons:** Slower, higher latency, limited throughput

### Geyser gRPC (Premium)
- **Latency:** <50ms (sub-50ms SLA)
- **Method:** Direct validator stream via gRPC
- **Cost:** $49-499/month (provider-dependent)
- **Pros:** 4-10x faster, lower CPU usage, better scalability
- **Cons:** Additional cost, requires provider setup

### Speed Comparison

```
┌──────────────────┬──────────┬────────────┬────────────────┐
│ Method           │ Latency  │ Throughput │ First to Detect│
├──────────────────┼──────────┼────────────┼────────────────┤
│ Public RPC       │ ~500ms   │ Low        │ ❌ Never       │
│ Premium RPC      │ ~200ms   │ Medium     │ ⚠️  Sometimes  │
│ Geyser gRPC      │ <50ms    │ High       │ ✅ Usually     │
└──────────────────┴──────────┴────────────┴────────────────┘
```

**Real-World Impact:**
- **Pool created at t=0**
- WebSocket detects at **t=200-500ms**
- Geyser detects at **t=50ms**
- **Advantage: 150-450ms head start** (critical for sniping!)

---

## 💰 Provider Pricing (2025)

### 1. Chainstack ⭐ **RECOMMENDED**

**Pricing:** $49/month (1 stream)

**Limits:**
- Up to 50 Solana accounts per stream
- 5 concurrent filters per connection
- Sub-50ms latency SLA
- Jito ShredStream enabled by default

**Pros:**
- ✅ Most affordable ($49 vs $499+)
- ✅ Good limits for token sniping (50 accounts = 50 DEX programs)
- ✅ Sub-50ms latency guarantee
- ✅ Built-in Jito support

**Cons:**
- ⚠️ Limited to 50 accounts (okay for 5 DEX programs)
- ⚠️ Requires Growth plan or higher

**Setup:**
```bash
# 1. Sign up at Chainstack
https://chainstack.com/marketplace/yellowstone-grpc-geyser-plugin/

# 2. Get endpoint and token from dashboard
GEYSER_ENDPOINT="grpc.chainstack.com:443"
GEYSER_TOKEN="your_token_here"

# 3. Enable in .env
GEYSER_ENABLED=true
```

**Monthly Cost:** **$49** + Chainstack base plan ($25-50)

**Total: ~$75-100/month**

---

### 2. QuickNode

**Pricing:** $499/month (Fleet/Shared access)

**Limits:**
- Unmetered access
- Globally distributed nodes
- No account limits
- Historical replay support

**Pros:**
- ✅ Unmetered access
- ✅ Global distribution
- ✅ No account limits
- ✅ Enterprise-grade SLA

**Cons:**
- ❌ 10x more expensive than Chainstack
- ❌ Overkill for single sniper bot

**Setup:**
```bash
# 1. Sign up at QuickNode
https://www.quicknode.com/solana-yellowstone-grpc

# 2. Get endpoint from dashboard
GEYSER_ENDPOINT="your-endpoint.solana-mainnet.quiknode.pro:10001"
GEYSER_TOKEN="your_token_here"

# 3. Enable in .env
GEYSER_ENABLED=true
```

**Monthly Cost:** **$499**

---

### 3. Helius

**Pricing:** Enterprise (contact sales)

**Limits:** Custom

**Pros:**
- ✅ Enterprise support
- ✅ Custom SLAs
- ✅ LaserStream (7 global endpoints)
- ✅ Automatic failover

**Cons:**
- ❌ No public pricing
- ❌ Likely $500-1000+/month
- ❌ Requires enterprise commitment

**Setup:**
```bash
# 1. Contact Helius sales
https://www.helius.dev/docs/grpc

# 2. Get enterprise contract
# 3. Receive endpoint and token
```

**Monthly Cost:** **$500-1000+ (estimated)**

---

## 📊 Total Infrastructure Cost Comparison

### Base Setup (WebSocket RPC Only)

```
┌──────────────────────┬──────────────┐
│ Service              │ Monthly Cost │
├──────────────────────┼──────────────┤
│ Premium RPC (Helius) │ $50          │
│ Redis Cloud          │ $50          │
│ PostgreSQL           │ $25          │
│ Server (4vCPU/8GB)   │ $40          │
│ Monitoring (Sentry)  │ $50          │
├──────────────────────┼──────────────┤
│ TOTAL                │ $215/month   │
└──────────────────────┴──────────────┘
```

### Premium Setup (Geyser + WebSocket Fallback)

```
┌──────────────────────┬──────────────┐
│ Service              │ Monthly Cost │
├──────────────────────┼──────────────┤
│ Geyser (Chainstack)  │ $49          │
│ Chainstack Base Plan │ $25          │
│ Premium RPC (Helius) │ $50 (backup) │
│ Redis Cloud          │ $50          │
│ PostgreSQL           │ $25          │
│ Server (4vCPU/8GB)   │ $40          │
│ Monitoring (Sentry)  │ $50          │
├──────────────────────┼──────────────┤
│ TOTAL                │ $289/month   │
└──────────────────────┴──────────────┘
```

**Cost Increase:** **+$74/month** (+34%)

**Performance Gain:** **4-10x faster detection** (<50ms vs 200-500ms)

---

## 🎯 ROI Analysis

### Assumptions:
- Average snipe value: **$100 SOL**
- Win rate improvement: **+20%** (due to faster detection)
- Trades per day: **10**
- Average profit per winning trade: **2x** (exit at 100% gain)

### Monthly Returns:

**Base Setup (WebSocket):**
- Win rate: **50%** (5 wins, 5 losses)
- Monthly profit: 5 wins × $100 profit × 30 days = **$15,000**

**Premium Setup (Geyser):**
- Win rate: **70%** (7 wins, 3 losses)
- Monthly profit: 7 wins × $100 profit × 30 days = **$21,000**

**Net Gain:** **+$6,000/month**

**ROI:** **+$6,000 profit - $74 cost = +$5,926/month**

**Payback Period:** **<1 day**

---

## 🔧 Implementation Strategy

### Phase 1: Base (WebSocket Only)
- ✅ Cost: $215/month
- ✅ Setup time: 1-2 days
- ✅ Good for MVP and testing
- ⚠️ Slower detection (200-500ms)

### Phase 2: Hybrid (Geyser Primary, WebSocket Fallback)
- 💰 Cost: $289/month (+$74)
- ⏱️ Setup time: +1 day
- ✅ Best performance (<50ms)
- ✅ Automatic fallback to WebSocket if Geyser fails
- ✅ Production-ready

### Phase 3: Enterprise (Multi-Region Geyser)
- 💰 Cost: $500-1000+/month
- ⏱️ Setup time: +2-3 days
- ✅ Global distribution
- ✅ Custom SLAs
- ⚠️ Overkill for single bot (use for multi-user platform)

---

## 🚦 Recommendation

### For Individual Traders:
**Use Chainstack Geyser ($49/month)**

**Rationale:**
- ✅ Best price/performance ratio
- ✅ 4-10x faster than WebSocket
- ✅ Sub-50ms latency SLA
- ✅ ROI payback in <1 day
- ✅ Easy to disable if needed

### For Platforms (Multi-User):
**Use QuickNode or Helius Enterprise**

**Rationale:**
- ✅ Unmetered access for multiple users
- ✅ Global distribution
- ✅ Enterprise support
- ✅ Scales with user growth

---

## 📋 Decision Matrix

```
┌──────────────┬────────────┬──────────┬────────────┬──────────┐
│ Provider     │ Cost/Month │ Latency  │ Limits     │ Best For │
├──────────────┼────────────┼──────────┼────────────┼──────────┤
│ Chainstack   │ $49        │ <50ms    │ 50 accts   │ Traders  │
│ QuickNode    │ $499       │ <50ms    │ Unmetered  │ Platform │
│ Helius       │ $500-1000+ │ <50ms    │ Custom     │ Enterprise│
└──────────────┴────────────┴──────────┴────────────┴──────────┘
```

**Winner: Chainstack** (for individual sniper bot)

---

## 🔗 Resources

- **Chainstack Marketplace:** https://chainstack.com/marketplace/yellowstone-grpc-geyser-plugin/
- **QuickNode Yellowstone:** https://www.quicknode.com/solana-yellowstone-grpc
- **Helius gRPC Docs:** https://www.helius.dev/docs/grpc
- **Yellowstone GitHub:** https://github.com/rpcpool/yellowstone-grpc

---

## 📈 Future Considerations

### As Your Bot Scales:
1. **1-10 users:** Chainstack ($49/month) ✅
2. **10-100 users:** QuickNode ($499/month)
3. **100+ users:** Helius Enterprise ($1000+/month)

### Cost Optimization:
- Start with Chainstack
- Monitor performance metrics
- Upgrade to QuickNode/Helius only if:
  - Hitting 50 account limit
  - Need global distribution
  - Require custom SLAs

---

**Bottom Line:** For a production sniper bot, **Geyser is worth it**. The $74/month premium pays for itself in faster, more consistent wins. Start with Chainstack, scale to QuickNode/Helius as needed.
