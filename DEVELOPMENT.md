# Development Guide - Testing, Monitoring & Workflow

Production development practices for the Token Sniper Bot.

## TESTING STRATEGY

### Unit Tests (Services Layer)

```typescript
// tests/services/keyManager.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { KeyManager } from "../src/services/wallet/keyManager";
import { prisma } from "../src/utils/db";
import { redis } from "../src/utils/redis";

describe("KeyManager", () => {
  let keyManager: KeyManager;
  const testUserId = "test-user-" + Date.now();

  beforeEach(() => {
    keyManager = new KeyManager();
  });

  afterEach(async () => {
    // Cleanup
    await prisma.wallet.deleteMany({ where: { userId: testUserId } });
    await redis.del(`session:*`);
  });

  it("should create wallet with encrypted private key", async () => {
    const result = await keyManager.createWallet(testUserId, "StrongPass123!");

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.value.publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(result.value.walletId).toBeDefined();

      // Verify wallet in database
      const wallet = await prisma.wallet.findUnique({
        where: { id: result.value.walletId },
      });

      expect(wallet).toBeDefined();
      expect(wallet?.publicKey).toBe(result.value.publicKey);
      expect(wallet?.encryptedPrivateKey).toBeDefined();
    }
  });

  it("should reject weak passwords", async () => {
    const result = await keyManager.createWallet(testUserId, "123");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("password");
    }
  });

  it("should create and validate trading session", async () => {
    // Create wallet
    const walletResult = await keyManager.createWallet(
      testUserId,
      "StrongPass123!"
    );

    expect(walletResult.success).toBe(true);
    if (!walletResult.success) return;

    // Create session
    const sessionResult = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "StrongPass123!"
    );

    expect(sessionResult.success).toBe(true);
    if (!sessionResult.success) return;

    // Verify session token
    expect(sessionResult.value).toHaveLength(64); // 32 bytes hex

    // Get keypair from session
    const keypairResult = await keyManager.getKeypairFromSession(
      sessionResult.value
    );

    expect(keypairResult.success).toBe(true);
    if (keypairResult.success) {
      expect(keypairResult.value.publicKey.toString()).toBe(
        walletResult.value.publicKey
      );
    }
  });

  it("should reject invalid password", async () => {
    const walletResult = await keyManager.createWallet(
      testUserId,
      "CorrectPass123!"
    );

    expect(walletResult.success).toBe(true);
    if (!walletResult.success) return;

    const sessionResult = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "WrongPass123!"
    );

    expect(sessionResult.success).toBe(false);
    if (!sessionResult.success) {
      expect(sessionResult.error).toContain("Invalid password");
    }
  });

  it("should expire session after TTL", async () => {
    const walletResult = await keyManager.createWallet(
      testUserId,
      "StrongPass123!"
    );

    if (!walletResult.success) return;

    const sessionResult = await keyManager.createTradingSession(
      testUserId,
      walletResult.value.walletId,
      "StrongPass123!"
    );

    if (!sessionResult.success) return;

    // Manually expire session in Redis
    await redis.del(`session:${sessionResult.value}`);

    const keypairResult = await keyManager.getKeypairFromSession(
      sessionResult.value
    );

    expect(keypairResult.success).toBe(false);
    if (!keypairResult.success) {
      expect(keypairResult.error).toContain("expired");
    }
  });
});
```

### Integration Tests (Jupiter)

```typescript
// tests/integration/jupiter.test.ts

import { describe, it, expect, beforeAll } from "bun:test";
import { JupiterService } from "../src/services/trading/jupiter";
import { RpcConnectionPool } from "../src/services/blockchain/rpcPool";
import { asTokenMint, asLamports } from "../src/types/common";

describe("Jupiter Integration", () => {
  let jupiter: JupiterService;
  let rpcPool: RpcConnectionPool;

  beforeAll(() => {
    rpcPool = new RpcConnectionPool([
      { url: process.env.SOLANA_RPC_URL!, weight: 1 },
    ]);

    jupiter = new JupiterService(rpcPool);
  });

  it("should get quote for SOL -> USDC swap", async () => {
    const SOL = asTokenMint("So11111111111111111111111111111111111111112");
    const USDC = asTokenMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    const result = await jupiter.getQuote({
      inputMint: SOL,
      outputMint: USDC,
      amount: asLamports(BigInt(1e9)), // 1 SOL
      slippageBps: 50,
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.value.outAmount).toBeDefined();
      expect(Number(result.value.outAmount)).toBeGreaterThan(0);
      expect(result.value.routePlan).toBeDefined();
    }
  }, 30000); // 30s timeout

  it("should return NO_ROUTE for invalid pair", async () => {
    const SOL = asTokenMint("So11111111111111111111111111111111111111112");
    const INVALID = asTokenMint("1111111111111111111111111111111111111111111");

    const result = await jupiter.getQuote({
      inputMint: SOL,
      outputMint: INVALID,
      amount: asLamports(BigInt(1e9)),
      slippageBps: 50,
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.type).toBe("NO_ROUTE");
    }
  }, 30000);

  it("should cache quotes", async () => {
    const SOL = asTokenMint("So11111111111111111111111111111111111111112");
    const USDC = asTokenMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    // First call
    const start1 = Date.now();
    const result1 = await jupiter.getQuote({
      inputMint: SOL,
      outputMint: USDC,
      amount: asLamports(BigInt(1e9)),
      slippageBps: 50,
    });
    const time1 = Date.now() - start1;

    // Second call (should be cached)
    const start2 = Date.now();
    const result2 = await jupiter.getQuote({
      inputMint: SOL,
      outputMint: USDC,
      amount: asLamports(BigInt(1e9)),
      slippageBps: 50,
    });
    const time2 = Date.now() - start2;

    expect(result1.success && result2.success).toBe(true);
    expect(time2).toBeLessThan(time1 / 2); // Cache should be much faster
  }, 30000);
});
```

### E2E Tests (Devnet)

1. `cp .env.e2e.example .env.e2e` and populate **isolated** Postgres/Redis URLs plus `SOLANA_RPC_URL=https://api.devnet.solana.com`.
2. Start dependencies (`bun run docker:up`) so Redis/Postgres are reachable.
3. Fund your devnet wallets (or rely on the built-in airdrop helper) and ensure `SOLANA_NETWORK=devnet`.
4. Run the suite:  
   ```bash
   bun run test:e2e
   ```

Current coverage:

- `tests/e2e/devnet-connection.test.ts` – RPC smoke tests + devnet faucet (ensures airdrop helper works before trades run).
- `tests/e2e/wallet-session.e2e.test.ts` – Full wallet creation + session lifecycle using the real Postgres/Redis stack.
- `tests/e2e/trading.e2e.test.ts` – Gated by `RUN_E2E_TRADING_TESTS`; executes a SOL→USDC swap via Jupiter/Jito stack, confirms the signature on devnet, and asserts token balances moved.

Set `RUN_E2E_TRADING_TESTS=true` in `.env.e2e` once the devnet trading wallets and token fixtures are ready; trading/error-flow specs will automatically un-skip at that point.

## MONITORING SETUP

### Prometheus Metrics Endpoint

```typescript
// src/index.ts (add to main server)

import { register } from "prom-client";

app.get("/metrics", async (request, reply) => {
  reply.type("text/plain").send(await register.metrics());
});
```

### Grafana Dashboard (JSON)

```json
{
  "dashboard": {
    "title": "Token Sniper Bot",
    "panels": [
      {
        "title": "Orders Per Second",
        "targets": [
          {
            "expr": "rate(orders_total[1m])"
          }
        ]
      },
      {
        "title": "Order Latency (p95)",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(order_latency_seconds_bucket[5m]))"
          }
        ]
      },
      {
        "title": "Honeypot Checks",
        "targets": [
          {
            "expr": "sum(rate(honeypot_checks_total[5m])) by (result)"
          }
        ]
      },
      {
        "title": "Active Users",
        "targets": [
          {
            "expr": "active_users"
          }
        ]
      }
    ]
  }
}
```

### Sentry Integration

```typescript
// src/index.ts (at the very beginning)

import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  integrations: [
    new Sentry.Integrations.Http({ tracing: true }),
    new Sentry.Integrations.Prisma({ client: prisma }),
  ],
});

// Error handler middleware
app.setErrorHandler((error, request, reply) => {
  Sentry.captureException(error, {
    extra: {
      url: request.url,
      method: request.method,
      body: request.body,
    },
  });

  logger.error("Request error", { error, url: request.url });

  reply.status(500).send({ error: "Internal server error" });
});
```

### Structured Logging (Pino)

```typescript
// src/utils/logger.ts

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: {
    error: pino.stdSerializers.err,
  },
});

// Service-specific loggers
export const jupiterLogger = logger.child({ service: "jupiter" });
export const honeypotLogger = logger.child({ service: "honeypot" });
export const walletLogger = logger.child({ service: "wallet" });
```

## DAILY WORKFLOW

### Morning Setup

```bash
# Pull latest changes
git pull origin main

# Install dependencies (if package.json changed)
bun install

# Start Docker services
bun run docker:up

# Check services are running
docker ps

# Run database migrations
bun run prisma:migrate

# Generate Prisma Client
bun run prisma:generate

# Start development server
bun dev
```

### During Development

```bash
# Hot reload is automatic with bun --watch

# Run tests in watch mode
bun test --watch

# View database
bun run prisma:studio

# Check Docker logs
bun run docker:logs

# View specific service logs
docker logs token-sniper-bot-postgres-1 -f
docker logs token-sniper-bot-redis-1 -f
```

### Before Committing

```bash
# Type check
bun run build

# Run all tests
bun test

# Check for linting issues (if using)
bun run lint

# Stage changes
git add .

# Commit with conventional commits
git commit -m "feat(wallet): add session-based key management"
# Types: feat, fix, docs, style, refactor, test, chore
```

### Conventional Commit Examples

```bash
# New feature
git commit -m "feat(jupiter): add quote caching with 2s TTL"

# Bug fix
git commit -m "fix(honeypot): handle API timeout correctly"

# Documentation
git commit -m "docs(architecture): add RPC pool documentation"

# Code refactoring
git commit -m "refactor(types): extract branded types to separate file"

# Tests
git commit -m "test(keymanager): add session expiration tests"

# Chores (build, deps, etc)
git commit -m "chore(deps): update @solana/web3.js to 1.95.3"
```

## ENVIRONMENT SETUP

### Development (.env.development)

```bash
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sniper_bot?schema=public

# Redis
REDIS_URL=redis://localhost:6379

# Telegram
BOT_TOKEN=your_dev_bot_token

# Solana (use devnet for testing)
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_NETWORK=devnet

# Monitoring (optional in dev)
SENTRY_DSN=
```

### Production (.env.production)

```bash
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Database (use production DB)
DATABASE_URL=postgresql://user:password@prod-db:5432/sniper_bot

# Redis (use production Redis)
REDIS_URL=redis://prod-redis:6379

# Telegram
BOT_TOKEN=your_production_bot_token

# Solana (mainnet with premium RPC)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=xxx
SOLANA_NETWORK=mainnet-beta
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=xxx

# Monitoring
SENTRY_DSN=https://xxx@sentry.io/xxx
```

## DEBUGGING TIPS

### Debug RPC Issues

```typescript
// Add detailed logging to RPC pool
const conn = await rpcPool.getConnection();
logger.debug("Using RPC endpoint", { endpoint: conn.rpcEndpoint });

try {
  const result = await conn.getBalance(address);
  logger.debug("RPC request successful", {
    endpoint: conn.rpcEndpoint,
    result,
  });
} catch (error) {
  logger.error("RPC request failed", {
    endpoint: conn.rpcEndpoint,
    error,
    stack: error.stack,
  });
}
```

### Debug Jupiter Quotes

```typescript
const quoteResult = await jupiter.getQuote(params);

if (!quoteResult.success) {
  logger.error("Quote failed", {
    error: quoteResult.error,
    params: {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
    },
  });
}
```

### Debug Session Issues

```typescript
// Check if session exists
const sessionData = await redis.get(`session:${token}`);
logger.debug("Session data", {
  exists: !!sessionData,
  token: token.slice(0, 8) + "...",
});

// Check TTL
const ttl = await redis.ttl(`session:${token}`);
logger.debug("Session TTL", { ttl, token: token.slice(0, 8) + "..." });
```

## PERFORMANCE PROFILING

### Measure Function Execution Time

```typescript
async function profiledFunction() {
  const start = performance.now();

  try {
    const result = await expensiveOperation();
    const duration = performance.now() - start;

    logger.info("Operation completed", { duration, result });

    return result;
  } catch (error) {
    const duration = performance.now() - start;
    logger.error("Operation failed", { duration, error });
    throw error;
  }
}
```

### Memory Usage Monitoring

```typescript
// Add to health check endpoint
app.get("/health", async () => {
  const memUsage = process.memoryUsage();

  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + " MB",
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + " MB",
      rss: Math.round(memUsage.rss / 1024 / 1024) + " MB",
    },
    uptime: process.uptime(),
  };
});
```

## DEPLOYMENT CHECKLIST

### Pre-Deploy

- [ ] All tests passing (`bun test`)
- [ ] Type check passing (`bun run build`)
- [ ] No console.log statements (use logger)
- [ ] Environment variables documented
- [ ] Database migrations ready
- [ ] Secrets stored securely (not in .env files)

### Deploy Steps

```bash
# 1. Build production bundle
bun run build

# 2. Run database migrations on production
DATABASE_URL=prod_url bun run prisma:migrate deploy

# 3. Deploy to server (Railway/DigitalOcean/etc)
git push production main

# 4. Verify deployment
curl https://your-api.com/health

# 5. Monitor logs
# Check Sentry for errors
# Check Grafana for metrics
```

### Post-Deploy

- [ ] Health check returns 200
- [ ] Telegram bot responds to /start
- [ ] Database connections working
- [ ] Redis connections working
- [ ] Sentry receiving events
- [ ] Prometheus metrics available

## TROUBLESHOOTING

### Common Issues

**Issue: Bot not responding**

```bash
# Check if bot is running
curl http://localhost:3000/health

# Check bot token
echo $BOT_TOKEN

# Test bot token
curl https://api.telegram.org/bot$BOT_TOKEN/getMe
```

**Issue: Database connection failed**

```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check migrations
bun run prisma:migrate status
```

**Issue: Redis connection failed**

```bash
# Check Redis is running
docker ps | grep redis

# Test connection
redis-cli -u $REDIS_URL ping
```

**Issue: RPC rate limited**

```bash
# Switch to different RPC
# Add to .env:
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_key

# Use rate limiting in code
await sleep(100); // 100ms between requests
```

---

**See Also:**

- `CLAUDE.md` - Core principles and code style
- `ARCHITECTURE.md` - Implementation patterns
- `HONEYPOT.md` - Detection system

**Remember:** Write tests first, commit often, deploy carefully! 🚀
