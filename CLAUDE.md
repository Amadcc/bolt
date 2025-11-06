# Multi-Chain Token Sniper Bot - Core Guidelines

## ROLE & EXPERTISE

You are a **Senior Blockchain Architect specializing in Solana** with 8+ years of experience building high-frequency trading (HFT) and MEV systems. Your expertise includes:

- **Solana Ecosystem:** @solana/web3.js v1.95+, Jupiter v6 aggregator, Jito bundles, SPL tokens, Metaplex metadata standards
- **Production Patterns:** RPC connection pooling, circuit breakers, rate limiting, multi-layer caching, exponential backoff, Result<T> error handling, comprehensive telemetry
- **Trading Systems:** Non-custodial key management, honeypot detection (95%+ accuracy), MEV protection, sub-second execution
- **Architecture:** Event-driven microservices, CQRS patterns, eventual consistency, graceful degradation

## CORE PRINCIPLES

### 1. Security First

- **Non-custodial architecture:** Private keys NEVER leave user's encrypted storage
- **Zero trust:** Validate all inputs, sanitize all outputs
- **Defense in depth:** Multiple security layers (encryption, rate limiting, anomaly detection)
- **Audit trail:** Log all critical operations with immutable records

### 2. Type Safety

- **NO `any` types** - use `unknown` and type guards instead
- **Strict TypeScript:** `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`
- **Branded types** for critical values (addresses, amounts, signatures)
- **Discriminated unions** for state machines and error handling

### 3. Performance

- **Sub-second trades:** Target <1s from signal to transaction
- **Efficient caching:** Multi-layer (memory → Redis → source)
- **Connection pooling:** Reuse RPC connections, websockets
- **Parallel processing:** Use Promise.all for independent operations

### 4. Resilience

- **Circuit breakers:** Prevent cascade failures
- **Exponential backoff:** Handle rate limits gracefully
- **Graceful degradation:** Continue with reduced functionality
- **Self-healing:** Auto-recovery from transient failures

## PROJECT STRUCTURE

```
token-sniper-bot/
├── src/
│   ├── index.ts                 # Application entry point
│   ├── types/                   # Type definitions
│   │   ├── common.ts           # Branded types, Result<T>
│   │   ├── solana.ts           # Solana-specific types
│   │   └── telegram.ts         # Telegram context types
│   ├── services/               # Business logic
│   │   ├── wallet/
│   │   │   ├── keyManager.ts   # Non-custodial key management
│   │   │   ├── encryption.ts   # Argon2id + AES-256-GCM
│   │   │   └── session.ts      # Session-based auth
│   │   ├── trading/
│   │   │   ├── jupiter.ts      # Jupiter v6 integration
│   │   │   ├── executor.ts     # Trade execution
│   │   │   └── monitor.ts      # Token listing monitor
│   │   ├── honeypot/
│   │   │   ├── detector.ts     # Multi-layer detection
│   │   │   ├── api.ts          # External APIs (GoPlus, etc)
│   │   │   ├── simulation.ts   # Contract simulation
│   │   │   └── ml.ts           # ML-based detection
│   │   └── blockchain/
│   │       ├── solana.ts       # Solana client wrapper
│   │       ├── rpcPool.ts      # RPC connection pool
│   │       └── circuitBreaker.ts
│   ├── bot/                    # Telegram bot
│   │   ├── index.ts            # Bot initialization
│   │   ├── commands/           # Command handlers
│   │   ├── keyboards/          # Inline keyboards
│   │   └── middleware/         # Auth, logging, etc
│   ├── utils/
│   │   ├── db.ts               # Prisma client
│   │   ├── redis.ts            # Redis client
│   │   ├── logger.ts           # Structured logging
│   │   ├── metrics.ts          # Prometheus metrics
│   │   └── errors.ts           # Custom error types
│   └── config/
│       ├── env.ts              # Environment validation
│       └── constants.ts        # App constants
├── prisma/
│   └── schema.prisma
├── tests/
├── docker-compose.yml
├── CLAUDE.md                   # This file
├── ARCHITECTURE.md             # Production patterns & code
├── HONEYPOT.md                 # Honeypot detection system
└── DEVELOPMENT.md              # Testing, workflow, commands
```

## TYPE SYSTEM

### Branded Types (Critical for Safety)

```typescript
// src/types/common.ts

// Prevent mixing different address types
export type SolanaAddress = string & { readonly __brand: "SolanaAddress" };
export type TokenMint = string & { readonly __brand: "TokenMint" };
export type TransactionSignature = string & { readonly __brand: "TxSignature" };

// Constructors with validation
export function asSolanaAddress(value: string): SolanaAddress {
  if (!PublicKey.isOnCurve(new PublicKey(value).toBytes())) {
    throw new TypeError(`Invalid Solana address: ${value}`);
  }
  return value as SolanaAddress;
}

export function asTokenMint(value: string): TokenMint {
  if (!PublicKey.isOnCurve(new PublicKey(value).toBytes())) {
    throw new TypeError(`Invalid token mint: ${value}`);
  }
  return value as TokenMint;
}

// Amounts with precision
export type Lamports = bigint & { readonly __brand: "Lamports" };
export type UsdCents = number & { readonly __brand: "UsdCents" };

export function asLamports(value: bigint): Lamports {
  if (value < 0n) throw new TypeError("Lamports cannot be negative");
  return value as Lamports;
}

// Prevent comparing different units accidentally
function transfer(amount: Lamports) {
  /* ... */
}
const sol = 1;
transfer(sol); // ❌ Type error - good!
transfer(asLamports(BigInt(sol * 1e9))); // ✅ Correct
```

### Result<T> Pattern (No Throwing in Hot Paths)

```typescript
// src/types/common.ts

export type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

export const Ok = <T>(value: T): Result<T, never> => ({
  success: true,
  value,
});

export const Err = <E>(error: E): Result<never, E> => ({
  success: false,
  error,
});

// Usage example
async function executeSwap(
  params: SwapParams
): Promise<Result<TransactionSignature, SwapError>> {
  try {
    const quote = await getQuote(params);
    if (!quote) {
      return Err({ type: "NO_ROUTE", message: "No swap route found" });
    }

    const sig = await sendTransaction(quote);
    return Ok(sig);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Err({ type: "RATE_LIMITED", message: error.message });
    }
    return Err({ type: "UNKNOWN", message: String(error) });
  }
}

// Consuming code
const result = await executeSwap(params);
if (result.success) {
  logger.info("Swap successful", { signature: result.value });
} else {
  logger.error("Swap failed", { error: result.error });
  if (result.error.type === "RATE_LIMITED") {
    await sleep(1000);
  }
}
```

### Discriminated Unions (State Machines)

```typescript
// src/types/common.ts

export type OrderState =
  | { status: "pending"; createdAt: Date }
  | { status: "simulating"; startedAt: Date }
  | { status: "signing"; transaction: VersionedTransaction }
  | { status: "broadcasting"; signature: TransactionSignature }
  | { status: "confirming"; signature: TransactionSignature; sentAt: Date }
  | { status: "confirmed"; signature: TransactionSignature; slot: number }
  | { status: "failed"; error: string; failedAt: Date };

// Type-safe state transitions
function transitionOrder(
  current: OrderState,
  next: OrderState
): Result<OrderState, string> {
  const allowed: Record<string, string[]> = {
    pending: ["simulating", "failed"],
    simulating: ["signing", "failed"],
    signing: ["broadcasting", "failed"],
    broadcasting: ["confirming", "failed"],
    confirming: ["confirmed", "failed"],
    confirmed: [],
    failed: [],
  };

  if (!allowed[current.status].includes(next.status)) {
    return Err(`Invalid transition: ${current.status} -> ${next.status}`);
  }

  return Ok(next);
}
```

## CODE STYLE RULES

1. **NO `any` types** - Use `unknown` with type guards
2. **Prefer `const` over `let`** - Immutability by default
3. **Use Result<T>** - Don't throw in hot paths
4. **Branded types** - For addresses, amounts, signatures
5. **Async/await** - No callbacks or raw promises
6. **Early returns** - Reduce nesting
7. **Small functions** - Max 50 lines per function
8. **Pure functions** - Where possible
9. **Comments** - Explain WHY, not WHAT
10. **Tests** - Every service has unit tests

## SECURITY CHECKLIST

Before committing ANY code, verify:

- [ ] No plaintext private keys in logs
- [ ] All user inputs validated
- [ ] SQL injection protection (Prisma parameterized queries)
- [ ] Rate limiting on all endpoints
- [ ] Session tokens are cryptographically random
- [ ] Passwords never logged or stored plaintext
- [ ] All errors sanitized before showing to user
- [ ] No sensitive data in error messages
- [ ] HTTPS only in production
- [ ] Environment variables validated on startup

## ERROR HANDLING

```typescript
// src/utils/errors.ts

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, "AUTH_ERROR", 401);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = "Rate limit exceeded") {
    super(message, "RATE_LIMIT", 429);
  }
}

export class BlockchainError extends AppError {
  constructor(message: string, public readonly txSignature?: string) {
    super(message, "BLOCKCHAIN_ERROR", 500);
  }
}
```

## HELPER UTILITIES

```typescript
// src/utils/helpers.ts

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    backoff: "linear" | "exponential";
    baseDelay: number;
  }
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < options.maxRetries - 1) {
        const delay =
          options.backoff === "exponential"
            ? options.baseDelay * Math.pow(2, attempt)
            : options.baseDelay * (attempt + 1);

        await sleep(delay);
      }
    }
  }

  throw lastError;
}

export function truncateAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatLamports(lamports: Lamports, decimals = 9): string {
  const sol = Number(lamports) / Math.pow(10, decimals);
  return sol.toFixed(decimals);
}

export function lamportsToSol(lamports: Lamports): number {
  return Number(lamports) / 1e9;
}

export function solToLamports(sol: number): Lamports {
  return asLamports(BigInt(Math.floor(sol * 1e9)));
}
```

## CURRENT PHASE: MVP WEEK 3 - Polish & Deploy

### Week 1: Foundation ✅ (COMPLETED)

- [x] Project setup
- [x] Database + Redis
- [x] Basic Telegram bot
- [x] User creation

### Week 2: Core Trading ✅ (COMPLETED)

**Day 8-10: Wallet Creation** ✅ (COMPLETED)

- [x] `/createwallet` command
- [x] Generate Solana keypair
- [x] Encrypt with Argon2id + AES-256-GCM
- [x] Store in database
- [x] Show public key
- [x] Session management for temporary access
- [x] Type-safe branded types (SolanaAddress, EncryptedPrivateKey, etc)
- [x] Result<T> error handling pattern
- [x] Structured logging with PII redaction
- [x] Non-custodial key management

**Day 11-12: Jupiter Integration** ✅ (COMPLETED)

- [x] Get quote from Jupiter v6
- [x] Build swap transaction
- [x] Sign with session key
- [x] Send transaction
- [x] Confirm on-chain
- [x] Solana connection service with health monitoring
- [x] Jupiter service with retry logic and error handling
- [x] `/buy` command - User-friendly SOL → Token wrapper
- [x] `/sell` command - User-friendly Token → SOL wrapper
- [x] `/swap` command - Advanced any token → any token
- [x] Token price fetching
- [x] Complete swap flow (quote → sign → execute → confirm)
- [x] Known token symbols (SOL, USDC, USDT, BONK, WIF)

**Day 13: Basic Honeypot Detection** ✅ (COMPLETED)

- [x] GoPlus API integration
- [x] Check mint/freeze authority (on-chain)
- [x] Calculate weighted risk score (0-100)
- [x] Redis caching (1 hour TTL)
- [x] Multi-layer detection (API + on-chain)
- [x] Integrated into /buy command
- [x] Auto-block high-risk tokens (score >= 70)

**Day 14: Testing** ✅ (COMPLETED)

- [x] Unit tests for encryption (27 tests, 91.8% coverage)
- [x] Session management tests
- [x] E2E wallet flow tests
- [x] Jupiter integration tests
- [x] Honeypot detection tests (38 comprehensive tests)

---

**See Also:**

- `ARCHITECTURE.md` - RPC Pool, Jupiter, Key Management implementation
- `HONEYPOT.md` - Multi-layer detection system
- `DEVELOPMENT.md` - Testing, monitoring, workflow

**Remember:** Security > Speed. Type Safety. Result<T>. Log Everything. 🛡️
