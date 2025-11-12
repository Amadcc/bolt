# 🧪 Sniper Testing Guide

Комплексное руководство по тестированию и верификации Auto-Sniper системы.

---

## 📋 Quick Verification Checklist

### 1. ✅ Сервисы запущены
```bash
# Проверка логов при старте
bun dev

# Должны увидеть:
# ✅ "Snipe orchestrator started" { monitorCount: 3 }
# ✅ "Snipe discovery monitor started" { monitor: "pumpfun" }
# ✅ "Snipe discovery monitor started" { monitor: "raydium" }
# ✅ "Snipe discovery monitor started" { monitor: "orca" }
# ✅ "Connected to Pump.fun stream"
```

### 2. ✅ Метрики доступны
```bash
curl http://localhost:3000/metrics | grep snipe

# Должны увидеть:
# snipe_opportunities_total{status="accepted"}
# snipe_opportunities_total{status="rejected"}
# snipe_execution_outcome_total{status="success"}
# snipe_execution_outcome_total{status="failed"}
# snipe_discovery_events_total{source="pumpfun",status="emitted"}
# snipe_execution_latency_ms
# snipe_automation_lease_failures_total
# snipe_rate_limit_hits_total
```

### 3. ✅ База данных готова
```bash
# Проверка таблиц
bunx prisma studio

# Должны увидеть таблицы:
# - SnipeConfig
# - SnipeExecution
```

---

## 🎯 Уровни тестирования

### Level 1: Unit Tests (Компоненты)

**Filter Service:**
```typescript
// tests/snipe/filter.test.ts
import { snipeFilter } from "../../src/services/snipe/filter";

describe("SnipeFilter", () => {
  it("should reject blacklisted tokens", () => {
    const config = {
      blacklist: ["TokenMintXYZ"],
      // ... other config
    };

    const event = {
      mint: "TokenMintXYZ",
      // ... other event data
    };

    const result = snipeFilter.apply(config, event);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Token is blacklisted");
  });

  it("should pass tokens meeting liquidity requirements", () => {
    const config = {
      minLiquidityLamports: 1_000_000_000n, // 1 SOL
      maxLiquidityLamports: 10_000_000_000n, // 10 SOL
      // ...
    };

    const event = {
      liquidityLamports: 5_000_000_000n, // 5 SOL
      // ...
    };

    const result = snipeFilter.apply(config, event);
    expect(result.success).toBe(true);
  });
});
```

**Rate Limiter:**
```typescript
// tests/snipe/rateLimiter.test.ts
import { enforceRateLimits } from "../../src/services/snipe/rateLimiter";

describe("RateLimiter", () => {
  beforeEach(async () => {
    await redis.flushdb(); // Clean Redis before each test
  });

  it("should allow trades within hourly limit", async () => {
    const config = { maxBuysPerHour: 5, maxBuysPerDay: 20 };

    for (let i = 0; i < 5; i++) {
      const result = await enforceRateLimits("user1", config);
      expect(result.success).toBe(true);
    }
  });

  it("should block trades exceeding hourly limit", async () => {
    const config = { maxBuysPerHour: 3, maxBuysPerDay: 20 };

    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      await enforceRateLimits("user1", config);
    }

    // 4th should fail
    const result = await enforceRateLimits("user1", config);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Hourly auto-trade limit reached");
  });
});
```

---

### Level 2: Integration Tests (E2E Discovery → Execution)

**Mock Discovery Event:**
```typescript
// tests/snipe/integration.test.ts
import { snipeOrchestrator } from "../../src/services/snipe/orchestrator";
import { PumpFunMonitor } from "../../src/services/snipe/discovery/pumpfun";

describe("Sniper Integration", () => {
  it("should process discovery event end-to-end", async () => {
    // Setup: Create user with config
    const user = await prisma.user.create({
      data: { telegramId: 12345n },
    });

    await prisma.snipeConfig.create({
      data: {
        userId: user.id,
        enabled: true,
        autoTrading: true,
        buyAmountLamports: 100_000_000n, // 0.1 SOL
        maxHoneypotRisk: 30,
      },
    });

    // Establish automation lease
    await establishAutomationLease(user.id, "test-password");

    // Emit mock discovery event
    const mockEvent = {
      source: "pumpfun",
      mint: asTokenMint("TestMint11111111111111111111111111111"),
      name: "Test Token",
      symbol: "TEST",
      liquidityLamports: asLamports(5_000_000_000n),
      tx: "signature123",
      timestamp: new Date(),
    };

    // Trigger orchestrator
    await snipeOrchestrator["handleEvent"](mockEvent);

    // Verify execution was created
    const execution = await prisma.snipeExecution.findFirst({
      where: { userId: user.id, tokenMint: mockEvent.mint },
    });

    expect(execution).toBeTruthy();
    expect(execution?.status).toMatch(/PENDING|ANALYZING|EXECUTING/);
  });
});
```

---

### Level 3: Manual Testing (Telegram Bot)

**Test Flow:**

1. **Создание кошелька**
```
/start
/createwallet
[enter password]
```

2. **Включение автоснайпера**
```
/wallet
→ ⚙️ Auto-Snipe
→ 🔴 Enable Auto-Snipe
→ ✅ Grant Automation
[enter password again]
```

3. **Настройка параметров**
```
→ 💰 Buy Amount: 0.1 SOL
→ 🎯 Max Risk: 30
→ ⏱ Rate Limits: 5/hour, 20/day
```

4. **Проверка статуса**
```
→ 🔄 Refresh
# Должно показать:
Status: ✅ Active
Automation: ✅ Active (expires at XX:XX)
```

---

### Level 4: Real-time Monitoring (Production)

**1. Логи в реальном времени**
```bash
# Фильтр логов только для снайпера
bun dev 2>&1 | grep -i "snipe\|pumpfun\|raydium\|orca"

# Что искать:
# ✅ "Token passed filter" - токен прошел фильтры
# ✅ "Auto-snipe execution" - начало выполнения
# ✅ "Executing auto-snipe swap" - свап запущен
# ⚠️ "Token rejected by filter" - токен отклонен (нормально)
# ❌ "Auto-snipe execution failed" - ошибка (нужно проверить)
```

**2. Prometheus Metrics**
```bash
# Смотреть метрики в реальном времени
watch -n 1 'curl -s http://localhost:3000/metrics | grep snipe'
```

**3. Database Monitoring**
```sql
-- Активные снайперы
SELECT
  u.telegramId,
  sc.enabled,
  sc.autoTrading,
  sc.buyAmountLamports / 1e9 as buyAmountSOL,
  sc.maxHoneypotRisk,
  sc.lastAutomationAt
FROM "SnipeConfig" sc
JOIN "User" u ON u.id = sc.userId
WHERE sc.enabled = true;

-- Последние выполнения
SELECT
  status,
  tokenSymbol,
  honeypotScore,
  success,
  (EXTRACT(EPOCH FROM (confirmedAt - discoveredAt)) * 1000)::int as latencyMs,
  failureReason,
  createdAt
FROM "SnipeExecution"
ORDER BY createdAt DESC
LIMIT 20;

-- Статистика успеха
SELECT
  status,
  COUNT(*) as count,
  AVG(honeypotScore) as avgRiskScore,
  AVG(EXTRACT(EPOCH FROM (confirmedAt - discoveredAt)) * 1000) as avgLatencyMs
FROM "SnipeExecution"
WHERE createdAt > NOW() - INTERVAL '1 day'
GROUP BY status;
```

---

### Level 5: Dry-Run Mode (Безопасное тестирование)

Добавим флаг для тестирования БЕЗ реальных транзакций:

```typescript
// .env
SNIPE_DRY_RUN=true  # Не выполнять реальные свапы
```

**Реализация:**
```typescript
// src/services/snipe/executor.ts
const DRY_RUN = process.env.SNIPE_DRY_RUN === "true";

async execute(userId, config, event) {
  // ... honeypot check, rate limit, etc ...

  if (DRY_RUN) {
    logger.warn("DRY RUN MODE: Skipping actual swap", {
      userId,
      token: event.symbol,
      amount: config.buyAmountLamports,
    });

    // Simulate successful execution
    await prisma.snipeExecution.create({
      data: {
        status: "SUCCESS",
        success: true,
        transactionSignature: "DRY_RUN_" + Date.now(),
        // ...
      },
    });

    return Ok(execution);
  }

  // Real execution
  const swapResult = await jupiter.swap(...);
  // ...
}
```

---

## 🔍 Diagnostic Commands

### Check Discovery Health
```bash
# WebSocket status
curl http://localhost:3000/health | jq '.sniper'

# Redis lease count
redis-cli KEYS "snipe:lease:*" | wc -l

# Active configs
curl http://localhost:3000/api/internal/snipe/status
```

### Trigger Test Event (Dev Only)
```typescript
// src/services/snipe/testUtils.ts
export async function triggerTestSnipe(userId: string) {
  const mockEvent: NewTokenEvent = {
    source: "pumpfun",
    mint: asTokenMint("TEST" + Date.now() + "111111111111111"),
    name: "Test Token",
    symbol: "TEST",
    liquidityLamports: asLamports(5_000_000_000n),
    marketCapUsd: 50000,
    tx: "test-" + Date.now(),
    timestamp: new Date(),
  };

  await snipeOrchestrator["handleEvent"](mockEvent);

  return mockEvent;
}
```

**Usage:**
```bash
# Dev console
bun repl
> const { triggerTestSnipe } = await import('./src/services/snipe/testUtils.ts')
> await triggerTestSnipe('user-id-here')
```

---

## 🐛 Common Issues & Debugging

### Issue 1: "No tokens detected"
**Check:**
```bash
# Pump.fun WebSocket connected?
curl -s http://localhost:3000/metrics | grep pumpfun_connected

# Raydium/Orca subscriptions active?
grep "Subscribed to program logs" logs/app.log
```

**Fix:**
- Check RPC endpoint health
- Verify WebSocket URL: `wss://pumpportal.fun/api/data`
- Check firewall/network

### Issue 2: "Automation lease expired"
**Check:**
```bash
# Redis lease TTL
redis-cli TTL "snipe:lease:USER_ID"

# Should be > 0 (seconds remaining)
# -2 means expired/not found
```

**Fix:**
- Re-grant automation access
- Check `SNIPE_AUTOMATION_TTL` env var (default 900s = 15min)

### Issue 3: "Rate limit hit immediately"
**Check:**
```bash
# Rate limit counters
redis-cli KEYS "snipe:hour:*"
redis-cli GET "snipe:hour:USER_ID"
```

**Fix:**
```bash
# Reset rate limits for testing
redis-cli DEL "snipe:hour:USER_ID"
redis-cli DEL "snipe:day:USER_ID"
```

### Issue 4: "Honeypot check timeout"
**Check logs:**
```bash
grep "Honeypot analysis error: timeout" logs/app.log
```

**Fix:**
- Increase `HONEYPOT_TIMEOUT_MS` (currently 2000ms)
- Check GoPlus/RugCheck API availability

---

## 📊 Success Criteria

Снайпер считается **работающим**, если:

✅ **Discovery:**
- [ ] События приходят от всех источников (pumpfun, raydium, orca)
- [ ] Метрика `snipe_discovery_events_total{status="emitted"}` растет

✅ **Filtering:**
- [ ] Токены проходят через фильтры
- [ ] Метрика `snipe_opportunities_total{status="accepted"}` > 0

✅ **Execution:**
- [ ] Honeypot check завершается < 2s
- [ ] Свапы выполняются успешно
- [ ] Метрика `snipe_execution_outcome_total{status="success"}` растет

✅ **Latency:**
- [ ] P95 латентность < 5s (discovery → confirmation)
- [ ] Метрика `snipe_execution_latency_ms` показывает < 5000

✅ **Reliability:**
- [ ] Rate limiting работает корректно
- [ ] Automation leases обновляются
- [ ] Нет memory leaks (проверка через `process.memoryUsage()`)

---

## 🎬 Quick Start Test

Самый быстрый способ проверить снайпер:

```bash
# 1. Запуск с DRY_RUN
SNIPE_DRY_RUN=true bun dev

# 2. В другом терминале - watch метрик
watch -n 1 'curl -s http://localhost:3000/metrics | grep snipe_discovery_events'

# 3. В третьем терминале - watch executions
watch -n 2 'psql $DATABASE_URL -c "SELECT status, COUNT(*) FROM \"SnipeExecution\" WHERE createdAt > NOW() - INTERVAL '\''5 minutes'\'' GROUP BY status;"'

# 4. Включить auto-snipe в Telegram боте
# Если через 5 минут видите новые события и executions = ✅ работает!
```

---

## 📝 Testing Checklist

Перед деплоем в продакшн:

- [ ] Unit тесты проходят: `bun test`
- [ ] TypeScript компилируется: `npx tsc --noEmit`
- [ ] Все discovery sources подключены
- [ ] Metrics endpoint отвечает
- [ ] Database миграции применены
- [ ] Redis подключен
- [ ] Automation lease создается и работает
- [ ] Rate limiting блокирует при превышении
- [ ] Honeypot detection возвращает scores
- [ ] Dry-run выполняется успешно
- [ ] Реальный swap на testnet работает

---

## 🚀 Production Monitoring

После деплоя мониторить:

1. **Grafana Dashboard:**
   - Discovery events per source
   - Execution success rate
   - P50/P95/P99 latency
   - Rate limit hits
   - Automation lease failures

2. **Alerts:**
   - No discovery events for 5 minutes
   - Success rate < 50%
   - P95 latency > 10s
   - Memory usage > 80%

3. **Weekly Review:**
   - Profitable trades ratio
   - Average execution time trend
   - Honeypot detection accuracy
   - User feedback

---

Готово! Теперь у тебя есть полное руководство по тестированию снайпера на всех уровнях.

Хочешь, чтобы я создал:
1. Health check endpoint (`GET /api/snipe/health`)?
2. Test trigger endpoint для dev (`POST /api/snipe/test`)?
3. Unit тесты для основных компонентов?
