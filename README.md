# 🎯 Bolt Sniper Bot

High-performance Solana token trading bot for Telegram with enterprise-grade security.

## 🚀 Features

- **Non-custodial Wallet Management**: Military-grade encryption (Argon2id + AES-256-GCM)
- **Jupiter v6 Integration**: Best swap rates across Solana DEXs
- **Honeypot Detection with Fallback Chain**: Multi-provider API fallback (GoPlus → RugCheck → TokenSniffer) with circuit breakers for 85-90% accuracy
- **Telegram Bot Interface**: User-friendly commands for trading
- **Session-based Authentication**: Secure password management with Redis
- **MEV Protection**: Built-in support for Jito bundles
- **Production-Ready Resilience**: Circuit breaker pattern, exponential backoff, comprehensive metrics

## 📋 Prerequisites

- [Bun](https://bun.sh) v1.1.26+ (fast all-in-one JavaScript runtime)
- PostgreSQL 14+ (for user data and trade history)
- Redis 6+ (for session management and caching)
- Solana RPC access (Alchemy, QuickNode, or public RPC)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

## ⚙️ Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure Environment Variables

**IMPORTANT:** Never commit `.env` to git. It contains production secrets.

```bash
# Copy the example file
cp .env.example .env

# Edit .env with your actual credentials
nano .env  # or use your preferred editor
```

**Required Environment Variables:**

- `BOT_TOKEN`: Get from [@BotFather](https://t.me/BotFather) on Telegram
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string
- `SOLANA_RPC_URL`: Your Solana RPC endpoint
- `SESSION_MASTER_SECRET`: Generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"
  ```

**⚠️ CRITICAL SECURITY NOTES:**

1. **SESSION_MASTER_SECRET**: Used to derive encryption keys for wallet private keys. If compromised, ALL user wallets can be decrypted. Must be 64+ bytes of cryptographically random data.

2. **Never share** your `.env` file or commit it to git (already in `.gitignore`)

3. **Production deployment**: Use environment variables or a secret manager (AWS Secrets Manager, HashiCorp Vault, etc.)

### 3. Setup Database

```bash
# Run Prisma migrations
bun prisma migrate dev

# Generate Prisma client
bun prisma generate
```

### 4. Start Development Services

```bash
# Start PostgreSQL (Docker Compose)
docker-compose up -d postgres

# Start Redis (Docker Compose)
docker-compose up -d redis

# Verify services are running
docker-compose ps
```

### 5. Run the Bot

```bash
# Development mode (with hot reload)
bun run dev

# Production mode
bun run start
```

## 🔧 Development

### Project Structure

```
src/
├── bot/              # Telegram bot (commands, keyboards, middleware)
├── services/         # Business logic (wallet, trading, honeypot, blockchain)
├── types/            # TypeScript types (branded types, Result<T>)
├── utils/            # Utilities (db, redis, logger, metrics)
└── config/           # Configuration (env validation, constants)
```

### Key Design Patterns

- **Branded Types**: `SolanaAddress`, `TokenMint`, `Lamports` prevent type confusion
- **Result<T>**: Railway-oriented programming for error handling
- **Non-custodial**: Private keys NEVER leave encrypted storage
- **Defense in Depth**: Multiple security layers (encryption, rate limiting, validation)

### Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test src/services/wallet/__tests__/encryption.test.ts

# Run with coverage
bun test --coverage

# Devnet E2E smoke tests (requires .env.e2e + funded devnet wallets)
cp .env.e2e.example .env.e2e
bun run test:e2e
# Set RUN_E2E_TRADING_TESTS=true in .env.e2e once SOL→USDC devnet liquidity (and error suite deps) are ready
```

## 📖 Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)**: Production patterns and implementation details
- **[HONEYPOT.md](./HONEYPOT.md)**: Multi-layer honeypot detection system
- **[DEVELOPMENT.md](./DEVELOPMENT.md)**: Testing, monitoring, and workflow
- **[CLAUDE.md](./CLAUDE.md)**: AI assistant guidelines and code style rules
- **[TODO.md](./TODO.md)**: Current development roadmap and tasks

## 🔒 Security

### Reporting Vulnerabilities

Please report security vulnerabilities to [your-email@example.com]. Do NOT open public issues for security bugs.

### Security Features

- ✅ Non-custodial architecture (keys never leave user's encrypted storage)
- ✅ Argon2id password hashing (OWASP recommended, memory-hard)
- ✅ AES-256-GCM encryption for private keys
- ✅ Session-based authentication with Redis (15-minute timeout)
- ✅ Rate limiting on all endpoints
- ✅ Input validation with branded types
- ✅ Honeypot detection before trades
- ✅ No sensitive data in logs (PII redaction)

### Security Checklist Before Deployment

- [ ] `.env` not in git history: `git log --all --full-history -- .env` (should be empty)
- [ ] All secrets rotated (BOT_TOKEN, SESSION_MASTER_SECRET, DATABASE_URL password)
- [ ] HTTPS only in production
- [ ] Rate limiting enabled
- [ ] Monitoring and alerting configured
- [ ] Database backups automated
- [ ] Redis persistence configured
- [ ] Error messages sanitized (no stack traces to users)

## 📈 Metrics & Monitoring

- Prometheus metrics are exposed via `GET /metrics` (Fastify) and include RPC histograms, trade counters, error gauges, Redis/Prisma timings, honeypot detections, and active session counts.
- Default process metrics from `prom-client` are enabled automatically; point your Prometheus server at the endpoint to start scraping.
- A starter Grafana dashboard (`docs/grafana/bolt-metrics-dashboard.json`) visualizes RPC latency, trade volume, error rates, session gauges, and uptime panels for quick import into your stack.

## 📊 Commands

### Telegram Bot Commands

- `/start` - Initialize bot and create user account
- `/createwallet <password>` - Create new non-custodial wallet
- `/unlock <password>` - Unlock wallet for 15 minutes
- `/lock` - Lock wallet immediately
- `/balance` - Check SOL and token balances
- `/buy <token> <sol_amount> [password]` - Buy token with SOL
- `/sell <token> <token_amount> [password]` - Sell token for SOL
- `/swap <from_token> <to_token> <amount> [password]` - Swap any token
- `/settings` - Configure slippage, auto-approve, etc.

## 🤝 Contributing

1. Follow the code style in [CLAUDE.md](./CLAUDE.md)
2. Use **NO `any` types** - use `unknown` with type guards
3. Prefer `Result<T>` over throwing errors in hot paths
4. Use branded types for addresses, amounts, signatures
5. Write tests for all new features
6. Security > Speed. Type Safety. Log Everything.

## 📝 License

[MIT License](./LICENSE) - see LICENSE file for details

---

**Built with:** [Bun](https://bun.sh) • [TypeScript](https://www.typescriptlang.org/) • [Prisma](https://www.prisma.io/) • [Grammy](https://grammy.dev/) • [Solana](https://solana.com/)
