# Meteora DEX Integration

## Overview

Meteora is integrated as the 4th discovery source for the auto-sniper system, alongside PumpFun, Raydium, and Orca.

### What is Meteora?

Meteora is a high-performance DEX on Solana featuring:
- **DLMM (Dynamic Liquidity Market Maker)** - Concentrated liquidity pools similar to Uniswap v3
- **Traditional AMM pools** - Standard constant product pools
- **High trading volume** - One of the most active DEXs on Solana

## Architecture

### Program Monitoring

The Meteora monitor subscribes to on-chain program logs from:
- `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` - DLMM (Dynamic Liquidity Market Maker)
- `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` - Meteora Pools

### Performance Characteristics

⚠️ **High Event Volume**: Meteora generates 5-10x more events than Raydium or Orca due to:
- High trading activity across all pools
- Frequent liquidity adjustments in DLMM pools
- Multiple swap types (DLMM, AMM, routing)

**Optimizations Applied**:
- Reduced concurrent RPC fetches (2 vs 4 for other sources)
- 200ms delay between transaction fetches to prevent rate limiting
- Larger queue buffer (5000 vs 1000) to handle burst traffic
- Debug-level logging for validation errors to reduce noise

## Configuration

### Environment Variables

```bash
# Enable/disable Meteora monitoring (default: enabled)
SNIPE_SOURCE_METEORA_ENABLED=true

# Comma-separated program IDs to monitor (optional, uses defaults if not set)
SNIPE_METEORA_PROGRAM_IDS=LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo,Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB

# Performance tuning (optional, defaults shown)
SNIPE_METEORA_CONCURRENCY=2        # Max concurrent transaction fetches
SNIPE_METEORA_DELAY_MS=200         # Delay between fetches (milliseconds)
SNIPE_METEORA_QUEUE_SIZE=5000      # Max queued transactions before dropping
```

### User Configuration

Users can enable/disable Meteora through:
1. **Telegram UI** - Token Sniper page shows 4 source toggle buttons:
   - 🚀 PumpFun
   - 🔵 Raydium
   - 🐋 Orca
   - ☄️ Meteora

2. **Database** - `SnipeConfig.enabledSources` array field

## Implementation Details

### Files Modified/Created

```
src/services/snipe/discovery/
├── meteora.ts                 # NEW - Meteora monitor
├── programLogs.ts             # MODIFIED - Added configurable queue/delay
└── orchestrator.ts            # MODIFIED - Added Meteora + source filtering

src/types/snipe.ts             # MODIFIED - Added "meteora" to DiscoverySource
src/bot/views/index.ts         # MODIFIED - Added source selection UI
src/bot/handlers/snipe.ts      # MODIFIED - Added toggle_source handler
prisma/schema.prisma           # MODIFIED - Added enabledSources field
```

### Source Filtering

The orchestrator filters events based on user's `enabledSources`:

```typescript
// Check if user has enabled this source
const enabledSources = config.enabledSources || ["pumpfun", "raydium", "orca"];
if (!enabledSources.includes(event.source)) {
  logger.debug("Token skipped - source not enabled by user");
  return;
}
```

## Monitoring

### Metrics

Meteora-specific metrics are tracked via Prometheus:
- `snipe_program_log_subscriptions_active{source="meteora"}` - Active subscriptions
- `snipe_program_log_queue_size{source="meteora"}` - Current queue size
- `snipe_program_log_in_flight{source="meteora"}` - In-flight fetches
- `snipe_program_log_queue_dropped_total{source="meteora"}` - Dropped events

### Health Checks

- **Connection health** - Monitors last event timestamp
- **Stale detection** - Reconnects if no events for 5 minutes
- **Circuit breaker** - Backs off on repeated RPC failures

## Troubleshooting

### Queue Overflows

**Symptoms**: Logs show `Processing queue full, dropping transaction`

**Solutions**:
1. Increase queue size: `SNIPE_METEORA_QUEUE_SIZE=10000`
2. Reduce concurrency: `SNIPE_METEORA_CONCURRENCY=1`
3. Increase delay: `SNIPE_METEORA_DELAY_MS=500`

### Rate Limiting (429 errors)

**Symptoms**: `429 Too Many Requests` errors in logs

**Solutions**:
1. Increase fetch delay: `SNIPE_METEORA_DELAY_MS=500`
2. Reduce concurrency: `SNIPE_METEORA_CONCURRENCY=1`
3. Upgrade RPC provider to higher tier

### High Log Volume

**Symptoms**: Many validation error warnings

**Expected behavior**: Token mint validation errors are common and logged as DEBUG level.
Not all addresses in Meteora logs are valid SPL token mints.

## Testing

### Manual Testing

1. Enable Meteora in Telegram UI
2. Watch logs for `source: "meteora"` events
3. Verify no queue overflow or rate limit errors
4. Check that tokens from Meteora reach orchestrator

### Environment Testing

```bash
# Test with aggressive settings (may hit rate limits)
SNIPE_METEORA_CONCURRENCY=10 SNIPE_METEORA_DELAY_MS=0 bun run dev

# Test with conservative settings (recommended for production)
SNIPE_METEORA_CONCURRENCY=1 SNIPE_METEORA_DELAY_MS=500 bun run dev
```

## Production Recommendations

### RPC Requirements

Meteora monitoring requires a robust RPC provider:
- **Minimum**: Helius Growth plan (50 RPS)
- **Recommended**: Helius Professional plan (100+ RPS)
- **Alternative**: Multiple RPC endpoints with load balancing

### Scaling

For high-volume production:
1. Use dedicated RPC endpoint for Meteora
2. Implement connection pooling (multiple WebSocket connections)
3. Consider sampling: only process every Nth transaction
4. Use Redis caching to deduplicate similar tokens

## Future Enhancements

- [ ] Add token pair filtering (e.g., only SOL pairs)
- [ ] Implement sampling for extreme volume scenarios
- [ ] Add user-configurable performance presets (aggressive/balanced/conservative)
- [ ] Batch token metadata fetches to reduce RPC calls
- [ ] WebSocket connection pooling for better throughput

## References

- [Meteora Docs](https://docs.meteora.ag/)
- [Meteora Programs on Solscan](https://solscan.io/account/LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo)
- [DLMM Whitepaper](https://docs.meteora.ag/dlmm)
