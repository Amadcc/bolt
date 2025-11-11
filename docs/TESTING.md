# Testing Guide

## Overview

This document describes the testing strategy, setup, and best practices for the Bolt Sniper Bot project.

## Test Structure

```
tests/
├── unit/              # Unit tests (fast, isolated)
│   ├── wallet/        # Wallet encryption, session management
│   └── trading/       # Trading executor, Jupiter integration
├── e2e/               # End-to-end tests (devnet, slower)
│   ├── wallet-session.e2e.test.ts    # Wallet & session flows
│   ├── trading.e2e.test.ts           # Full trading flows
│   ├── error-handling.e2e.test.ts    # Error scenarios
│   └── helpers/       # Test utilities
└── redis-scan-fix.test.ts  # Integration test for Redis
```

## Running Tests

### Quick Start

```bash
# Run all tests
bun test

# Run specific test suites
bun run test:unit              # Unit tests only
bun run test:e2e               # E2E tests (requires devnet)
bun run test:coverage          # With coverage report

# Watch mode (during development)
bun run test:watch
```

### Test Coverage

```bash
# Generate coverage report
bun run test:coverage

# View HTML report
open coverage/index.html
```

**Coverage Thresholds:**
- Lines: 80%
- Functions: 80%
- Branches: 75%
- Statements: 80%

## E2E Tests Setup

### Prerequisites

1. **Devnet Access**
   - E2E tests run against Solana devnet
   - Devnet SOL is automatically airdropped during tests
   - No real funds required

2. **Environment Configuration**

Create `.env.e2e` file (copy from `.env.e2e.example`):

```bash
cp .env.e2e.example .env.e2e
```

Required variables:
```env
NODE_ENV=test
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_NETWORK=devnet
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379
SESSION_MASTER_SECRET=test_secret_key_here
BOT_TOKEN=test_bot_token_here
```

> **Tip:** Trading + error-handling suites stay skipped until you set `RUN_E2E_TRADING_TESTS=true` in `.env.e2e`. Keep it `false` while provisioning devnet liquidity, then flip it on to exercise the full SOL→USDC swap flow.

3. **Services**

Start PostgreSQL and Redis:
```bash
bun run docker:up
```

### Running E2E Tests

```bash
# Run all E2E tests
bun run test:e2e

# Run specific E2E test file
bun test tests/e2e/error-handling.e2e.test.ts

# Skip E2E tests (fast local testing)
TEST_SKIP_E2E=true bun test
```

`bun run test:e2e` automatically sets `TEST_ENV_FILE=.env.e2e` so Vitest loads devnet credentials. If you prefer to run individual specs, export `TEST_ENV_FILE=.env.e2e RUN_E2E_TRADING_TESTS=true` before invoking `bun test tests/e2e/<file>.ts`.

**Note:** E2E tests may be slow (30-180s per test) due to:
- Devnet transaction confirmation times
- RPC rate limiting
- Network latency

## Test Categories

### 1. Unit Tests

**Purpose:** Test individual functions/modules in isolation

**Characteristics:**
- Fast (<100ms per test)
- No external dependencies (mocked)
- High coverage of edge cases

**Example:**
```typescript
describe("Password Encryption", () => {
  it("should encrypt and decrypt password correctly", async () => {
    const password = "test123";
    const encrypted = await encryptPassword(password);
    const decrypted = await decryptPassword(encrypted);
    expect(decrypted).toBe(password);
  });
});
```

### 2. Integration Tests

**Purpose:** Test interactions between components

**Characteristics:**
- Medium speed (100-1000ms per test)
- Real database/Redis (local)
- Tests service integration

**Example:**
```typescript
describe("Redis Session", () => {
  it("should create and retrieve session", async () => {
    const session = await createSession({ userId, password });
    const retrieved = await getSession(session.token);
    expect(retrieved.userId).toBe(userId);
  });
});
```

### 3. E2E Tests

**Purpose:** Test complete user flows on real network

**Characteristics:**
- Slow (30-180s per test)
- Real devnet blockchain
- Complete application stack

**Example:**
```typescript
describe("Trading E2E", () => {
  it("swaps SOL to USDC on devnet", async () => {
    const result = await executeTrade({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: "100000000", // 0.1 SOL
    });
    expect(result.success).toBe(true);
  });
});
```

## Error Handling Tests

Our error handling E2E test suite (`error-handling.e2e.test.ts`) verifies:

### ✅ Test Coverage

1. **Invalid Password Error**
   - Verifies clear error message
   - No technical details exposed
   - User-friendly guidance

2. **Insufficient Balance Error**
   - Attempts trade with excessive amount
   - Checks for "insufficient balance" message
   - No raw lamports/BigInt in errors

3. **Invalid Token Address Error**
   - Tests multiple invalid formats
   - Ethereum-style addresses rejected
   - Invalid base58 characters caught

4. **Network Timeout with Retry**
   - Simulates unreachable RPC
   - Verifies retry attempts
   - Graceful failure message

5. **Session Expiry Error**
   - Tests expired Redis session
   - Clear "unlock wallet" guidance
   - No Redis/TTL technical details

6. **Rate Limit Error**
   - Multiple failed unlock attempts
   - Rate limiting triggers correctly
   - User-friendly cooldown message

7. **Honeypot Detection Error**
   - High-risk tokens blocked
   - Clear warning to user
   - Risk score displayed

8. **User-Friendly Messages**
   - No technical jargon in errors
   - No stack traces exposed
   - Actionable error messages

### Error Message Standards

**❌ Bad Error Messages:**
```typescript
"Argon2 hash verification failed with code -1"
"PublicKey validation failed: not on ed25519 curve"
"Redis TTL expired for key session:abc123"
```

**✅ Good Error Messages:**
```typescript
"Incorrect password. Please try again."
"Invalid token address. Please check and try again."
"Your session has expired. Please unlock your wallet."
```

## CI/CD Integration

### GitHub Actions

Our test suite runs automatically on:

1. **Push to main/to-prod branches**
   - Unit tests
   - Integration tests
   - Build validation
   - Security scan

2. **Pull Requests**
   - All tests must pass before merge
   - Coverage report generated
   - Build artifacts validated

3. **Nightly Schedule (2 AM UTC)**
   - Full E2E test suite on devnet
   - Long-running integration tests
   - Performance benchmarks

4. **Manual Trigger**
   - On-demand E2E testing
   - Pre-deployment validation

### Workflow Files

`.github/workflows/test.yml` includes:

- **unit-tests** job: Fast unit & integration tests
- **e2e-tests** job: Full E2E suite (devnet)
- **coverage** job: Coverage report & upload
- **build** job: Build validation
- **security** job: Secret scanning, audit
- **all-tests-passed** job: Final status check

### Required Secrets

Configure in GitHub repository settings:

```
SESSION_MASTER_SECRET_TEST  # Test encryption key
BOT_TOKEN_TEST              # Test Telegram bot token
CODECOV_TOKEN               # Coverage upload (optional)
```

## Best Practices

### Writing Tests

1. **Arrange-Act-Assert Pattern**
```typescript
it("should create wallet", async () => {
  // Arrange
  const userId = "test-user";
  const password = "secure-password";

  // Act
  const result = await createWallet({ userId, password });

  // Assert
  expect(result.success).toBe(true);
  expect(result.value.publicKey).toBeDefined();
});
```

2. **Use Descriptive Test Names**
```typescript
// ❌ Bad
it("test 1", () => { ... });

// ✅ Good
it("should reject invalid password after 5 failed attempts", () => { ... });
```

3. **Clean Up Resources**
```typescript
afterAll(async () => {
  // Clean up test data
  await prisma.wallet.deleteMany({ where: { userId } });
  await destroyAllUserSessions(userId);
});
```

4. **Mock External Dependencies**
```typescript
// Mock Jupiter API for unit tests
vi.mock("../../src/services/trading/jupiter.js", () => ({
  getJupiter: vi.fn().mockReturnValue({
    getQuote: vi.fn().mockResolvedValue(mockQuote),
  }),
}));
```

5. **Use Timeouts for Async Tests**
```typescript
it(
  "confirms transaction on-chain",
  { timeout: 60_000 }, // 60 second timeout
  async () => {
    // Test logic
  }
);
```

### Test Data Management

1. **Generate Unique Test Data**
```typescript
const testUser = {
  telegramId: BigInt(Date.now()),
  username: `test_${Date.now()}`,
};
```

2. **Use Factory Functions**
```typescript
async function createTestWallet(): Promise<TestWallet> {
  const user = await createTestUser();
  const wallet = await createWallet({
    userId: user.id,
    password: "test-password",
  });
  return { user, wallet };
}
```

3. **Isolate Tests**
   - Each test should be independent
   - Don't rely on test execution order
   - Clean up after each test

## Debugging Tests

### Failed Tests

1. **Check Logs**
```bash
# Run with verbose logging
DEBUG=* bun test

# Check specific test
bun test tests/e2e/error-handling.e2e.test.ts --reporter=verbose
```

2. **Inspect Coverage Gaps**
```bash
bun run test:coverage
open coverage/index.html
```

3. **Run Single Test**
```bash
# Use .only to focus on one test
it.only("should test specific case", () => { ... });
```

### Common Issues

**Issue: E2E tests timeout**
- Solution: Increase timeout or check devnet status
- Check: https://status.solana.com

**Issue: Redis connection failed**
- Solution: Ensure Redis is running (`bun run docker:up`)
- Check: `redis-cli ping`

**Issue: Database migration errors**
- Solution: Reset test database
- Command: `bunx prisma migrate reset --force`

**Issue: Coverage below threshold**
- Solution: Add tests for uncovered code
- Check: `coverage/index.html` for gaps

## Performance Benchmarks

Target test execution times:

| Test Type | Target | Acceptable | Slow |
|-----------|--------|------------|------|
| Unit | <100ms | 100-500ms | >500ms |
| Integration | <1s | 1-5s | >5s |
| E2E (single) | <60s | 60-180s | >180s |
| Full Suite | <5min | 5-15min | >15min |

## Continuous Improvement

### Coverage Goals

- **Current:** ~70-80% (baseline)
- **Target:** 85%+ for critical paths
- **Stretch:** 90%+ overall

### Priority Areas

1. ✅ Wallet encryption & decryption
2. ✅ Session management
3. ✅ Trading execution
4. ✅ Error handling
5. 🚧 Honeypot detection
6. 🚧 RPC pool failover
7. 🚧 Circuit breaker logic

### Future Enhancements

- [ ] Load testing (100+ concurrent users)
- [ ] Performance regression tests
- [ ] Visual regression tests (Telegram UI)
- [ ] Mutation testing (Stryker)
- [ ] Fuzz testing (critical functions)

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Solana Test Validator](https://docs.solana.com/developing/test-validator)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Codecov Documentation](https://docs.codecov.com/)

## Support

For test-related issues:
1. Check this documentation
2. Review existing test examples
3. Open GitHub issue with `[test]` prefix
4. Ask in team Slack channel

---

**Last Updated:** 2025-11-11
**Maintained By:** Development Team
