# 🚀 Quick Start: Проверка снайпера

## ✅ Простая проверка "работает или нет"

### Способ 1: Быстрая команда (30 секунд)
```bash
./scripts/check-sniper.sh
```

### Способ 2: Проверка логов (1 минута)
```bash
# Смотрим логи снайпера
bun dev 2>&1 | grep -i "snipe\|pumpfun\|raydium\|orca"
```

**Что должно быть:**
```
✅ Snipe orchestrator started { monitorCount: 3 }
✅ Snipe discovery monitor started { monitor: "pumpfun" }
✅ Snipe discovery monitor started { monitor: "raydium" }
✅ Snipe discovery monitor started { monitor: "orca" }
✅ Connected to Pump.fun stream
```

### Способ 3: Проверка метрик (10 секунд)
```bash
curl -s http://localhost:3000/metrics | grep snipe
```

**Должны увидеть:**
```
snipe_opportunities_total
snipe_executions_total
snipe_discovery_events_total
snipe_execution_latency_ms
snipe_automation_lease_failures_total
snipe_rate_limit_hits_total
```

---

## 🎯 Включение Auto-Snipe в боте

1. **Открываем бота в Telegram**
2. Нажимаем `/wallet` или "💼 Wallet"
3. Выбираем **⚙️ Auto-Snipe**
4. Нажимаем **🔴 Enable Auto-Snipe** (станет 🟢)
5. Нажимаем **✅ Grant Automation**
6. Отправляем пароль кошелька
7. Готово! Статус должен показать:
   ```
   Status: 🟢 Active
   Automation: ✅ Active (expires at XX:XX)
   ```

---

## 📊 Проверка работы в реальном времени

### Вариант 1: Watch метрики
```bash
watch -n 1 'curl -s http://localhost:3000/metrics | grep snipe_discovery_events_total'
```

### Вариант 2: Watch логи
```bash
# В одном терминале
bun dev

# В другом терминале
tail -f logs/app.log | grep -i "token\|snipe"
```

### Вариант 3: Redis мониторинг
```bash
# Проверка активных automation leases
redis-cli -p 6380 KEYS "snipe:lease:*"

# Проверка rate limit counters
redis-cli -p 6380 KEYS "snipe:*"
```

---

## 🐛 Частые вопросы

### Q: Как понять что снайпер обнаружил токены?
**A:** Смотрите метрику:
```bash
curl -s http://localhost:3000/metrics | grep 'snipe_discovery_events_total.*emitted'
```
Если счетчик > 0 - токены обнаруживаются.

### Q: Почему нет выполнений?
**A:** Проверьте:
1. Включен ли Auto-Snipe в боте? (должен быть 🟢)
2. Активна ли Automation? (✅ Active)
3. Есть ли токены, проходящие фильтры?

```bash
curl -s http://localhost:3000/metrics | grep 'snipe_opportunities_total'
# accepted - токены прошли фильтры
# rejected - токены отклонены (нормально, если много)
```

### Q: Как проверить почему токены отклоняются?
**A:** Смотрите DEBUG логи:
```bash
bun dev 2>&1 | grep "Token rejected by filter"
```

Увидите причину, например:
- `Liquidity below minimum threshold`
- `Market cap above maximum`
- `Token is blacklisted`

### Q: Automation lease expired - что делать?
**A:** Это нормально! Lease действует 15 минут по безопасности.

Просто заново:
1. Открыть `/wallet` → ⚙️ Auto-Snipe
2. Нажать **✅ Grant Automation**
3. Отправить пароль

Или увеличить TTL в `.env`:
```bash
SNIPE_AUTOMATION_TTL=3600  # 1 час
```

---

## 📈 Ожидаемое поведение

### Первые 5 минут после запуска:
- ✅ Все мониторы подключены
- ⏳ Discovery events = 0-5 (зависит от активности)
- ⏳ Executions = 0 (нормально, если нет подходящих токенов)

### После 1 часа работы:
- ✅ Discovery events = 10-100+ (зависит от Pump.fun активности)
- ✅ Opportunities accepted/rejected > 0
- ✅ Executions = зависит от фильтров и настроек

### Если через 1 час discovery events = 0:
❌ **Проблема!** Проверьте:
1. WebSocket к Pump.fun:
   ```bash
   curl -s http://localhost:3000/metrics | grep pumpfun
   ```
2. RPC подключение:
   ```bash
   curl -s http://localhost:3000/metrics | grep solana_rpc
   ```
3. Логи ошибок:
   ```bash
   bun dev 2>&1 | grep -i error
   ```

---

## 🎬 Полный тест за 2 минуты

```bash
# 1. Проверка сервиса
curl http://localhost:3000/health
# Должен ответить: 200 OK

# 2. Проверка метрик
curl -s http://localhost:3000/metrics | grep snipe | wc -l
# Должно быть > 10 (много метрик)

# 3. Проверка automation lease
redis-cli -p 6380 KEYS "snipe:lease:*" | wc -l
# > 0 если кто-то включил automation

# 4. Проверка discovery
# Ждем 30 секунд...
sleep 30

# Проверяем снова
curl -s http://localhost:3000/metrics | grep 'snipe_discovery_events_total'

# Если counter > 0 = ✅ РАБОТАЕТ!
# Если counter = 0 = ⏳ Ждем больше или проверяем Pump.fun активность
```

---

## 🔗 Полезные ссылки

- **Полное тестирование:** `cat SNIPER_TESTING.md`
- **Архитектура:** `cat ARCHITECTURE.md`
- **Honeypot система:** `cat HONEYPOT.md`

---

## 🚨 Когда бить тревогу

### ❌ ПРОБЛЕМА если:
1. Логи показывают `Snipe orchestrator started` НО метрики пустые
2. Discovery events = 0 после 10 минут
3. Логи показывают ошибки подключения WebSocket
4. Redis не отвечает: `redis-cli -p 6380 ping`

### ✅ ВСЕ ОК если:
1. Логи показывают все 3 monitor started (pumpfun, raydium, orca)
2. Метрики доступны через `/metrics`
3. Automation lease создается (если включен в боте)
4. Discovery events растет со временем (даже медленно)

---

**🎉 Готово!** Если увидел логи `Snipe orchestrator started` - снайпер работает!

Теперь просто включи Auto-Snipe в боте и жди токены 🚀
