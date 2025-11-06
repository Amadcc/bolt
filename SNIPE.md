# Token Sniper - Architecture & Implementation

## 🎯 Overview

The **Token Sniper** is the core feature that automatically detects and buys newly launched tokens on Solana within milliseconds. This document outlines the complete architecture, implementation plan, and best practices.

---

## 📊 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER LAYER                               │
├─────────────────────────────────────────────────────────────────┤
│  Telegram Bot UI                                                 │
│  • /snipe - Configure settings                                   │
│  • Real-time notifications                                       │
│  • Transaction history                                           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      DISCOVERY LAYER                             │
├─────────────────────────────────────────────────────────────────┤
│  Token Discovery Service                                         │
│  • Pump.fun WebSocket (MVP)                                      │
│  • DEX Program Logs (Raydium/Orca)                              │
│  • Helius/QuickNode Webhooks (Production)                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      FILTERING LAYER                             │
├─────────────────────────────────────────────────────────────────┤
│  Filter Engine                                                   │
│  • Min/Max liquidity                                             │
│  • Min/Max market cap                                            │
│  • Token age (only new tokens)                                   │
│  • Whitelist/Blacklist                                           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      ANALYSIS LAYER                              │
├─────────────────────────────────────────────────────────────────┤
│  Fast Analysis Pipeline                                          │
│  • Honeypot check (2s timeout)                                   │
│  • Liquidity verification                                        │
│  • Holder distribution                                           │
│  • Contract verification                                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      EXECUTION LAYER                             │
├─────────────────────────────────────────────────────────────────┤
│  Snipe Executor                                                  │
│  • Build swap transaction                                        │
│  • Add priority fees                                             │
│  • Sign & send transaction                                       │
│  • Confirm on-chain                                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      NOTIFICATION LAYER                          │
├─────────────────────────────────────────────────────────────────┤
│  • Success notifications                                         │
│  • Failure notifications                                         │
│  • Transaction links                                             │
│  • P&L tracking                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🏗️ Data Models

### SnipeConfig (User Settings)

```typescript
// prisma/schema.prisma

model SnipeConfig {
  id        String   @id @default(cuid())
  userId    String   @unique
  user      User     @relation(fields: [userId], references: [id])

  // Status
  enabled   Boolean  @default(false)

  // Trade Parameters
  buyAmount BigInt   // Amount in lamports (e.g., 0.1 SOL = 100000000)
  slippageBps Int    @default(500) // 5%

  // Filters
  minLiquidity   BigInt?  // Min liquidity in lamports
  maxLiquidity   BigInt?  // Max liquidity in lamports
  minMarketCap   Int?     // Min market cap in USD cents
  maxMarketCap   Int?     // Max market cap in USD cents
  maxHoneypotRisk Int     @default(30) // 0-100

  // Rate Limiting
  maxBuysPerHour Int      @default(10)
  maxBuysPerDay  Int      @default(50)

  // Advanced
  whitelist String[] @default([]) // Only snipe these tokens
  blacklist String[] @default([]) // Never snipe these tokens

  // Metadata
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([enabled])
}
```

### SnipeExecution (History)

```typescript
model SnipeExecution {
  id              String   @id @default(cuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id])

  // Token Info
  tokenMint       String
  tokenSymbol     String?
  tokenName       String?

  // Execution
  status          SnipeStatus // PENDING, ANALYZING, EXECUTING, SUCCESS, FAILED
  buyAmount       BigInt      // Amount in lamports
  outputAmount    BigInt?     // Tokens received

  // Analysis
  honeypotScore   Int?        // 0-100
  liquidity       BigInt?     // Pool liquidity
  marketCap       Int?        // USD cents

  // Transaction
  signature       String?     // Solana transaction signature
  priorityFee     BigInt?     // Priority fee paid

  // Timing
  discoveredAt    DateTime    // When token was discovered
  analyzedAt      DateTime?   // When analysis completed
  executedAt      DateTime?   // When transaction sent
  confirmedAt     DateTime?   // When transaction confirmed

  // Result
  success         Boolean     @default(false)
  failureReason   String?

  // Metadata
  createdAt       DateTime    @default(now())

  @@index([userId, createdAt])
  @@index([tokenMint])
  @@index([status])
}

enum SnipeStatus {
  PENDING
  ANALYZING
  EXECUTING
  SUCCESS
  FAILED
  SKIPPED
}
```

---

## 🔧 Core Services

### 1. Token Discovery Service

**MVP: Pump.fun WebSocket**

```typescript
// src/services/snipe/discovery/pumpfun.ts

import WebSocket from "ws";
import { EventEmitter } from "events";
import { logger } from "../../../utils/logger.js";
import type { TokenMint } from "../../../types/common.js";

interface NewTokenEvent {
  mint: TokenMint;
  name: string;
  symbol: string;
  liquidity: bigint;
  marketCap: number; // USD cents
  timestamp: Date;
}

export class PumpFunMonitor extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectDelay = 5000; // 5 seconds

  constructor(private readonly wsUrl: string = "wss://pumpportal.fun/api/data") {
    super();
  }

  async start(): Promise<void> {
    logger.info("Starting Pump.fun monitor");

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      logger.info("Connected to Pump.fun WebSocket");
      this.reconnectAttempts = 0;

      // Subscribe to new token events
      this.ws?.send(
        JSON.stringify({
          method: "subscribeNewToken",
        })
      );
    });

    this.ws.on("message", (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === "new_token") {
          this.handleNewToken(event.data);
        }
      } catch (error) {
        logger.error("Failed to parse WebSocket message", { error });
      }
    });

    this.ws.on("error", (error) => {
      logger.error("WebSocket error", { error });
    });

    this.ws.on("close", () => {
      logger.warn("WebSocket connection closed");
      this.handleReconnect();
    });
  }

  private handleNewToken(data: any): void {
    const event: NewTokenEvent = {
      mint: data.mint as TokenMint,
      name: data.name,
      symbol: data.symbol,
      liquidity: BigInt(data.liquidity),
      marketCap: data.marketCap,
      timestamp: new Date(),
    };

    logger.info("New token discovered", {
      mint: event.mint,
      symbol: event.symbol,
      liquidity: event.liquidity.toString(),
    });

    this.emit("newToken", event);
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("Max reconnect attempts reached, giving up");
      this.emit("error", new Error("Failed to reconnect to Pump.fun"));
      return;
    }

    this.reconnectAttempts++;
    logger.info(`Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.start();
    }, this.reconnectDelay);
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

---

### 2. Filter Engine

```typescript
// src/services/snipe/filter.ts

import type { SnipeConfig } from "@prisma/client";
import type { NewTokenEvent } from "./discovery/pumpfun.js";
import { logger } from "../../utils/logger.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";

interface FilterResult {
  passed: boolean;
  reason?: string;
}

export class SnipeFilter {
  /**
   * Check if token passes user's snipe filters
   */
  async applyFilters(
    token: NewTokenEvent,
    config: SnipeConfig
  ): Promise<Result<boolean, string>> {
    try {
      // Check whitelist
      if (config.whitelist.length > 0) {
        if (!config.whitelist.includes(token.mint)) {
          return Ok(false); // Not in whitelist
        }
      }

      // Check blacklist
      if (config.blacklist.includes(token.mint)) {
        return Err("Token is blacklisted");
      }

      // Check min liquidity
      if (config.minLiquidity && token.liquidity < config.minLiquidity) {
        return Err(`Liquidity too low: ${token.liquidity} < ${config.minLiquidity}`);
      }

      // Check max liquidity
      if (config.maxLiquidity && token.liquidity > config.maxLiquidity) {
        return Err(`Liquidity too high: ${token.liquidity} > ${config.maxLiquidity}`);
      }

      // Check min market cap
      if (config.minMarketCap && token.marketCap < config.minMarketCap) {
        return Err(`Market cap too low: ${token.marketCap} < ${config.minMarketCap}`);
      }

      // Check max market cap
      if (config.maxMarketCap && token.marketCap > config.maxMarketCap) {
        return Err(`Market cap too high: ${token.marketCap} > ${config.maxMarketCap}`);
      }

      logger.info("Token passed all filters", {
        mint: token.mint,
        symbol: token.symbol,
      });

      return Ok(true);
    } catch (error) {
      logger.error("Filter error", { error, token: token.mint });
      return Err("Filter error");
    }
  }
}
```

---

### 3. Snipe Executor

```typescript
// src/services/snipe/executor.ts

import { prisma } from "../../utils/db.js";
import { honeypotDetector } from "../honeypot/detector.js";
import { jupiterService } from "../trading/jupiter.js";
import { solanaService } from "../blockchain/solana.js";
import { getSessionKeypair } from "../wallet/keyManager.js";
import { logger } from "../../utils/logger.js";
import type { Result, TokenMint, Lamports, TransactionSignature } from "../../types/common.js";
import { Ok, Err, asLamports } from "../../types/common.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

interface SnipeResult {
  success: boolean;
  signature?: TransactionSignature;
  outputAmount?: bigint;
  failureReason?: string;
}

export class SnipeExecutor {
  /**
   * Execute snipe for a token
   */
  async execute(
    userId: string,
    tokenMint: TokenMint,
    config: SnipeConfig
  ): Promise<Result<SnipeResult, string>> {
    const startTime = Date.now();

    // Create execution record
    const execution = await prisma.snipeExecution.create({
      data: {
        userId,
        tokenMint,
        status: "ANALYZING",
        buyAmount: config.buyAmount,
        discoveredAt: new Date(),
      },
    });

    try {
      // STEP 1: Fast honeypot check (2s timeout)
      logger.info("Running honeypot check", { tokenMint, executionId: execution.id });

      const honeypotResult = await Promise.race([
        honeypotDetector.check(tokenMint),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Honeypot check timeout")), 2000)
        ),
      ]);

      if (!honeypotResult.success) {
        await this.failExecution(execution.id, "Honeypot check failed");
        return Err("Honeypot check failed");
      }

      const honeypotScore = honeypotResult.value.riskScore;

      // Update with honeypot score
      await prisma.snipeExecution.update({
        where: { id: execution.id },
        data: {
          honeypotScore,
          analyzedAt: new Date(),
        },
      });

      // Check if risk is acceptable
      if (honeypotScore > config.maxHoneypotRisk) {
        await this.failExecution(execution.id, `High risk: ${honeypotScore}/100`);
        return Err(`High honeypot risk: ${honeypotScore}/100`);
      }

      logger.info("Honeypot check passed", {
        tokenMint,
        riskScore: honeypotScore,
        elapsed: Date.now() - startTime,
      });

      // STEP 2: Execute swap
      await prisma.snipeExecution.update({
        where: { id: execution.id },
        data: { status: "EXECUTING" },
      });

      logger.info("Executing swap", { tokenMint, executionId: execution.id });

      // Get user's keypair from session
      const keypair = getSessionKeypair(userId);
      if (!keypair) {
        await this.failExecution(execution.id, "Wallet not unlocked");
        return Err("Wallet not unlocked");
      }

      // Execute swap with priority fee
      const priorityFee = asLamports(BigInt(0.001 * LAMPORTS_PER_SOL)); // 0.001 SOL

      const swapResult = await jupiterService.executeSwap({
        keypair,
        inputMint: "So11111111111111111111111111111111111111112", // SOL
        outputMint: tokenMint,
        amount: config.buyAmount,
        slippageBps: config.slippageBps,
        priorityFee,
      });

      if (!swapResult.success) {
        await this.failExecution(execution.id, swapResult.error);
        return Err(swapResult.error);
      }

      // STEP 3: Mark as success
      await prisma.snipeExecution.update({
        where: { id: execution.id },
        data: {
          status: "SUCCESS",
          success: true,
          signature: swapResult.value.signature,
          outputAmount: swapResult.value.outputAmount,
          priorityFee,
          executedAt: new Date(),
          confirmedAt: new Date(),
        },
      });

      const elapsed = Date.now() - startTime;
      logger.info("Snipe executed successfully", {
        tokenMint,
        signature: swapResult.value.signature,
        elapsed,
      });

      return Ok({
        success: true,
        signature: swapResult.value.signature,
        outputAmount: swapResult.value.outputAmount,
      });

    } catch (error) {
      logger.error("Snipe execution failed", { error, tokenMint, executionId: execution.id });
      await this.failExecution(execution.id, String(error));
      return Err(String(error));
    }
  }

  private async failExecution(executionId: string, reason: string): Promise<void> {
    await prisma.snipeExecution.update({
      where: { id: executionId },
      data: {
        status: "FAILED",
        success: false,
        failureReason: reason,
      },
    });
  }
}

export const snipeExecutor = new SnipeExecutor();
```

---

### 4. Snipe Orchestrator

```typescript
// src/services/snipe/orchestrator.ts

import { EventEmitter } from "events";
import { prisma } from "../../utils/db.js";
import { PumpFunMonitor } from "./discovery/pumpfun.js";
import { SnipeFilter } from "./filter.js";
import { SnipeExecutor } from "./executor.js";
import { logger } from "../../utils/logger.js";
import { bot } from "../../bot/index.js";

export class SnipeOrchestrator extends EventEmitter {
  private monitor: PumpFunMonitor;
  private filter: SnipeFilter;
  private executor: SnipeExecutor;
  private isRunning = false;

  constructor() {
    super();
    this.monitor = new PumpFunMonitor();
    this.filter = new SnipeFilter();
    this.executor = new SnipeExecutor();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Snipe orchestrator already running");
      return;
    }

    logger.info("Starting snipe orchestrator");
    this.isRunning = true;

    // Start token discovery
    await this.monitor.start();

    // Listen for new tokens
    this.monitor.on("newToken", async (token) => {
      await this.handleNewToken(token);
    });

    this.monitor.on("error", (error) => {
      logger.error("Token monitor error", { error });
      this.emit("error", error);
    });
  }

  private async handleNewToken(token: NewTokenEvent): Promise<void> {
    try {
      // Get all users with snipe enabled
      const configs = await prisma.snipeConfig.findMany({
        where: { enabled: true },
        include: { user: true },
      });

      logger.info(`Processing new token for ${configs.length} users`, {
        mint: token.mint,
        symbol: token.symbol,
      });

      // Process each user's snipe config
      for (const config of configs) {
        // Check rate limits
        const recentExecutions = await this.getRecentExecutions(
          config.userId,
          config.maxBuysPerHour
        );

        if (recentExecutions >= config.maxBuysPerHour) {
          logger.warn("User hit rate limit", {
            userId: config.userId,
            limit: config.maxBuysPerHour,
          });
          continue;
        }

        // Apply filters
        const filterResult = await this.filter.applyFilters(token, config);

        if (!filterResult.success || !filterResult.value) {
          logger.debug("Token filtered out", {
            userId: config.userId,
            mint: token.mint,
            reason: filterResult.error || "Did not pass filters",
          });
          continue;
        }

        // Execute snipe
        const result = await this.executor.execute(config.userId, token.mint, config);

        // Send notification to user
        await this.notifyUser(config.userId, token, result);
      }
    } catch (error) {
      logger.error("Error handling new token", { error, token: token.mint });
    }
  }

  private async getRecentExecutions(userId: string, hours: number): Promise<number> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    return prisma.snipeExecution.count({
      where: {
        userId,
        createdAt: { gte: since },
      },
    });
  }

  private async notifyUser(
    userId: string,
    token: NewTokenEvent,
    result: Result<SnipeResult, string>
  ): Promise<void> {
    try {
      // Get user's Telegram ID
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) return;

      if (result.success && result.value.success) {
        // Success notification
        await bot.api.sendMessage(
          Number(user.telegramId),
          `🎯 *Snipe Success!*\n\n` +
          `Token: ${token.symbol || token.mint.slice(0, 8)}...\n` +
          `Amount: ${result.value.outputAmount?.toString() || "N/A"} tokens\n\n` +
          `[View Transaction](https://solscan.io/tx/${result.value.signature})`,
          { parse_mode: "Markdown" }
        );
      } else {
        // Failure notification
        await bot.api.sendMessage(
          Number(user.telegramId),
          `❌ *Snipe Failed*\n\n` +
          `Token: ${token.symbol || token.mint.slice(0, 8)}...\n` +
          `Reason: ${result.error || result.value?.failureReason || "Unknown"}`,
          { parse_mode: "Markdown" }
        );
      }
    } catch (error) {
      logger.error("Failed to send notification", { error, userId });
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping snipe orchestrator");
    this.isRunning = false;
    await this.monitor.stop();
  }
}

// Singleton instance
export const snipeOrchestrator = new SnipeOrchestrator();
```

---

## 🎨 Telegram UI

### Snipe Settings Page

```typescript
// src/bot/views/snipe.ts

import { InlineKeyboard } from "grammy";
import type { SnipeConfig } from "@prisma/client";

export function renderSnipePage(config?: SnipeConfig): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const status = config?.enabled ? "✅ Enabled" : "❌ Disabled";
  const buyAmount = config ? Number(config.buyAmount) / 1e9 : 0.1;
  const maxRisk = config?.maxHoneypotRisk || 30;

  const text =
    `🎯 *Auto-Snipe Settings*\n\n` +
    `Status: ${status}\n` +
    `Buy Amount: ${buyAmount} SOL per token\n` +
    `Max Risk Score: ${maxRisk}/100\n\n` +
    `*Filters:*\n` +
    `• Min Liquidity: ${config?.minLiquidity ? Number(config.minLiquidity) / 1e9 + " SOL" : "None"}\n` +
    `• Max Market Cap: ${config?.maxMarketCap ? "$" + (config.maxMarketCap / 100).toLocaleString() : "None"}\n` +
    `• Max buys/hour: ${config?.maxBuysPerHour || 10}\n\n` +
    `⚠️ *Warning:* Auto-snipe will execute trades automatically when new tokens match your criteria.`;

  const keyboard = new InlineKeyboard();

  if (!config?.enabled) {
    keyboard.text("✅ Enable Auto-Snipe", "snipe:enable");
  } else {
    keyboard.text("❌ Disable Auto-Snipe", "snipe:disable");
  }

  keyboard
    .row()
    .text("💰 Set Buy Amount", "snipe:set_amount")
    .text("🎲 Set Max Risk", "snipe:set_risk")
    .row()
    .text("🔍 Configure Filters", "snipe:filters")
    .text("📊 View History", "snipe:history")
    .row()
    .text("« Back to Dashboard", "nav:main");

  return { text, keyboard };
}
```

---

## 📅 Implementation Plan

### **Phase 1: Manual Snipe (Days 1-2)**

Quick MVP for testing:

```typescript
// /snipe <token_address>
- [x] Parse token address
- [x] Fast honeypot check (2s)
- [x] Show token info + risk score
- [x] "Buy Now" button
- [x] Execute swap on click
```

### **Phase 2: Config UI (Day 3)**

```typescript
- [ ] Create SnipeConfig table migration
- [ ] /snipe command - show current config
- [ ] Inline keyboard for settings
  - [ ] Enable/Disable toggle
  - [ ] Set buy amount
  - [ ] Set max risk score
  - [ ] Basic filters (liquidity, market cap)
```

### **Phase 3: Auto-Discovery (Days 4-5)**

```typescript
- [ ] Implement PumpFunMonitor
- [ ] WebSocket connection + reconnection logic
- [ ] Parse new token events
- [ ] Store in Redis queue
```

### **Phase 4: Auto-Execution (Days 6-7)**

```typescript
- [ ] Implement SnipeOrchestrator
- [ ] Filter engine
- [ ] Rate limiting (max buys per hour)
- [ ] Execute snipes automatically
- [ ] Telegram notifications
```

### **Phase 5: Testing & Polish (Day 8)**

```typescript
- [ ] End-to-end testing
- [ ] Performance optimization (<500ms)
- [ ] Error handling
- [ ] Add transaction history
- [ ] Analytics dashboard
```

---

## 🚀 Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Discovery → Execution | <500ms | Time from token discovery to tx submission |
| Honeypot Check | <2s | Fast check with aggressive timeout |
| Transaction Confirmation | <30s | Depends on Solana network |
| Success Rate | >80% | Percentage of successful snipes |
| False Positives (Honeypot) | <5% | Safe tokens blocked incorrectly |
| False Negatives (Honeypot) | <2% | Honeypots not detected |

---

## 🔒 Security Considerations

### Rate Limiting

```typescript
// Per-user limits
- Max 10 snipes per hour (configurable)
- Max 50 snipes per day
- Max 1 pending snipe at a time

// System-wide limits
- Max 100 concurrent snipes
- Circuit breaker for failed swaps (5 failures → pause 5 min)
```

### Wallet Security

```typescript
// Session-based execution
- Wallet must be unlocked (session active)
- Session expires after 30 minutes
- Clear keypair from memory after use
```

### Error Handling

```typescript
// Fail gracefully
- Timeout on honeypot check (2s)
- Retry on RPC errors (3 attempts)
- Notify user on failure
- Log all execution attempts
```

---

## 📊 Monitoring & Alerts

### Metrics to Track

```typescript
// Prometheus metrics
- snipe_executions_total (counter)
- snipe_success_rate (gauge)
- snipe_latency_ms (histogram)
- honeypot_check_duration_ms (histogram)
- active_snipe_configs (gauge)
```

### Alerts

```typescript
// Critical alerts
- Success rate < 50% (15 min window)
- Discovery service down > 5 min
- High latency > 5s (15 min window)
- Database connection lost
```

---

## 🧪 Testing Strategy

### Unit Tests

```typescript
// tests/unit/snipe/
- filter.test.ts - Filter logic
- executor.test.ts - Execution flow
- discovery.test.ts - WebSocket parsing
```

### Integration Tests

```typescript
// tests/integration/snipe/
- end-to-end.test.ts - Full snipe flow
- rate-limiting.test.ts - Rate limit enforcement
- notifications.test.ts - Telegram notifications
```

### Load Tests

```typescript
// Simulate high load
- 100 concurrent users
- 1000 tokens per minute
- Verify latency stays <500ms
```

---

## 📚 References

- [Pump.fun API Docs](https://docs.pump.fun)
- [Jupiter v6 API](https://station.jup.ag/docs/apis/swap-api)
- [Solana Program Logs](https://docs.solana.com/developing/on-chain-programs/debugging)
- [Helius Webhooks](https://docs.helius.dev/webhooks-and-websockets/webhooks)

---

## 🎯 Success Criteria

### MVP (Phase 1-2)

- [x] Manual snipe works
- [x] Honeypot check < 2s
- [x] User can configure settings
- [ ] Transactions confirm successfully

### Full Auto-Snipe (Phase 3-5)

- [ ] Auto-discovery working
- [ ] <500ms reaction time
- [ ] >80% success rate
- [ ] Rate limiting enforced
- [ ] Notifications sent reliably
- [ ] Transaction history tracked

---

**Last Updated:** 2025-11-05
**Status:** 📝 Design Complete - Ready for Implementation
