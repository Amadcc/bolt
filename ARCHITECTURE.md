# Architecture Patterns - Production Implementation

This file contains production-ready implementation patterns for the core systems.

## RPC CONNECTION POOL WITH CIRCUIT BREAKER

```typescript
// src/services/blockchain/rpcPool.ts

import { Connection, ConnectionConfig, Commitment } from "@solana/web3.js";

interface RpcEndpoint {
  url: string;
  weight: number; // For weighted round-robin
}

interface CircuitState {
  failures: number;
  lastFailure: Date | null;
  state: "closed" | "open" | "half-open";
}

export class RpcConnectionPool {
  private connections: Map<string, Connection> = new Map();
  private circuits: Map<string, CircuitState> = new Map();
  private currentIndex = 0;

  private readonly FAILURE_THRESHOLD = 5;
  private readonly RESET_TIMEOUT = 30_000; // 30s
  private readonly REQUEST_TIMEOUT = 10_000; // 10s

  constructor(
    private readonly endpoints: RpcEndpoint[],
    private readonly commitment: Commitment = "confirmed"
  ) {
    this.initializeConnections();
  }

  private initializeConnections(): void {
    for (const endpoint of this.endpoints) {
      const config: ConnectionConfig = {
        commitment: this.commitment,
        wsEndpoint: endpoint.url.replace("https", "wss"),
        disableRetryOnRateLimit: true,
        confirmTransactionInitialTimeout: this.REQUEST_TIMEOUT,
      };

      this.connections.set(endpoint.url, new Connection(endpoint.url, config));
      this.circuits.set(endpoint.url, {
        failures: 0,
        lastFailure: null,
        state: "closed",
      });
    }
  }

  async getConnection(): Promise<Connection> {
    const maxAttempts = this.endpoints.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const endpoint = this.selectEndpoint();
      const circuit = this.circuits.get(endpoint.url)!;

      // Circuit breaker logic
      if (circuit.state === "open") {
        const timeSinceFailure =
          Date.now() - (circuit.lastFailure?.getTime() ?? 0);
        if (timeSinceFailure > this.RESET_TIMEOUT) {
          circuit.state = "half-open";
        } else {
          continue; // Try next endpoint
        }
      }

      return this.connections.get(endpoint.url)!;
    }

    throw new Error("All RPC endpoints unavailable");
  }

  private selectEndpoint(): RpcEndpoint {
    // Weighted round-robin
    const totalWeight = this.endpoints.reduce((sum, e) => sum + e.weight, 0);
    let random = Math.random() * totalWeight;

    for (const endpoint of this.endpoints) {
      random -= endpoint.weight;
      if (random <= 0) return endpoint;
    }

    return this.endpoints[0];
  }

  async recordFailure(url: string): Promise<void> {
    const circuit = this.circuits.get(url);
    if (!circuit) return;

    circuit.failures++;
    circuit.lastFailure = new Date();

    if (circuit.failures >= this.FAILURE_THRESHOLD) {
      circuit.state = "open";
      logger.warn("Circuit breaker opened", {
        url,
        failures: circuit.failures,
      });
    }
  }

  async recordSuccess(url: string): Promise<void> {
    const circuit = this.circuits.get(url);
    if (!circuit) return;

    if (circuit.state === "half-open") {
      circuit.state = "closed";
      circuit.failures = 0;
      logger.info("Circuit breaker closed", { url });
    }
  }
}

// Usage
const rpcPool = new RpcConnectionPool([
  { url: "https://api.mainnet-beta.solana.com", weight: 1 },
  { url: "https://solana-api.projectserum.com", weight: 2 },
  { url: process.env.HELIUS_RPC_URL!, weight: 5 },
]);

async function getBalance(
  address: PublicKey
): Promise<Result<Lamports, Error>> {
  const conn = await rpcPool.getConnection();

  try {
    const balance = await conn.getBalance(address);
    await rpcPool.recordSuccess(conn.rpcEndpoint);
    return Ok(asLamports(BigInt(balance)));
  } catch (error) {
    await rpcPool.recordFailure(conn.rpcEndpoint);
    return Err(error as Error);
  }
}
```

## JUPITER V6 INTEGRATION

```typescript
// src/services/trading/jupiter.ts

import { createJupiterApiClient, QuoteResponse } from "@jup-ag/api";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";

interface JupiterQuoteParams {
  inputMint: TokenMint;
  outputMint: TokenMint;
  amount: Lamports;
  slippageBps: number; // 50 = 0.5%
}

interface JupiterSwapParams {
  quote: QuoteResponse;
  userPublicKey: SolanaAddress;
}

type JupiterError =
  | { type: "NO_ROUTE"; message: string }
  | { type: "RATE_LIMITED"; message: string }
  | { type: "API_ERROR"; message: string }
  | { type: "SWAP_BUILD_FAILED"; message: string }
  | { type: "SIGNING_FAILED"; message: string }
  | { type: "TX_FAILED"; message: string }
  | { type: "TX_SEND_FAILED"; message: string };

export class JupiterService {
  private readonly client;
  private readonly cache: Map<
    string,
    { quote: QuoteResponse; timestamp: number }
  > = new Map();
  private readonly CACHE_TTL = 2_000; // 2s cache

  constructor(private readonly rpcPool: RpcConnectionPool) {
    this.client = createJupiterApiClient();
  }

  async getQuote(
    params: JupiterQuoteParams
  ): Promise<Result<QuoteResponse, JupiterError>> {
    // Check cache
    const cacheKey = `${params.inputMint}-${params.outputMint}-${params.amount}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return Ok(cached.quote);
    }

    try {
      const quote = await this.client.quoteGet({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: Number(params.amount),
        slippageBps: params.slippageBps,
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
      });

      if (!quote || !quote.outAmount || quote.outAmount === "0") {
        return Err({ type: "NO_ROUTE", message: "No swap route found" });
      }

      this.cache.set(cacheKey, { quote, timestamp: Date.now() });
      return Ok(quote);
    } catch (error) {
      if (error instanceof Error && error.message.includes("429")) {
        return Err({
          type: "RATE_LIMITED",
          message: "Jupiter API rate limited",
        });
      }
      return Err({ type: "API_ERROR", message: String(error) });
    }
  }

  async buildSwapTransaction(
    params: JupiterSwapParams
  ): Promise<Result<VersionedTransaction, JupiterError>> {
    try {
      const swapResponse = await this.client.swapPost({
        swapRequest: {
          quoteResponse: params.quote,
          userPublicKey: params.userPublicKey,
          dynamicComputeUnitLimit: true,
          priorityLevelWithMaxLamports: {
            priorityLevel: "high",
          },
        },
      });

      const swapTransactionBuf = Buffer.from(
        swapResponse.swapTransaction,
        "base64"
      );
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      return Ok(transaction);
    } catch (error) {
      return Err({ type: "SWAP_BUILD_FAILED", message: String(error) });
    }
  }

  async executeSwap(
    inputMint: TokenMint,
    outputMint: TokenMint,
    amount: Lamports,
    wallet: {
      publicKey: PublicKey;
      signTransaction: (
        tx: VersionedTransaction
      ) => Promise<VersionedTransaction>;
    },
    slippageBps: number = 50
  ): Promise<Result<TransactionSignature, JupiterError>> {
    // Step 1: Get quote
    const quoteResult = await this.getQuote({
      inputMint,
      outputMint,
      amount,
      slippageBps,
    });

    if (!quoteResult.success) return Err(quoteResult.error);

    // Step 2: Build transaction
    const txResult = await this.buildSwapTransaction({
      quote: quoteResult.value,
      userPublicKey: asSolanaAddress(wallet.publicKey.toString()),
    });

    if (!txResult.success) return Err(txResult.error);

    // Step 3: Sign transaction
    let signedTx: VersionedTransaction;
    try {
      signedTx = await wallet.signTransaction(txResult.value);
    } catch (error) {
      return Err({ type: "SIGNING_FAILED", message: String(error) });
    }

    // Step 4: Send with retry
    return await this.sendTransactionWithRetry(signedTx);
  }

  private async sendTransactionWithRetry(
    transaction: VersionedTransaction,
    maxRetries = 3
  ): Promise<Result<TransactionSignature, JupiterError>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const conn = await this.rpcPool.getConnection();

      try {
        const signature = await conn.sendRawTransaction(
          transaction.serialize(),
          {
            skipPreflight: false,
            maxRetries: 0,
          }
        );

        const confirmation = await conn.confirmTransaction(
          signature,
          "confirmed"
        );

        if (confirmation.value.err) {
          return Err({
            type: "TX_FAILED",
            message: JSON.stringify(confirmation.value.err),
          });
        }

        await this.rpcPool.recordSuccess(conn.rpcEndpoint);
        return Ok(signature as TransactionSignature);
      } catch (error) {
        lastError = error as Error;
        await this.rpcPool.recordFailure(conn.rpcEndpoint);

        if (attempt < maxRetries - 1) {
          const backoff = Math.pow(2, attempt) * 1000;
          await sleep(backoff);
        }
      }
    }

    return Err({
      type: "TX_SEND_FAILED",
      message: lastError?.message ?? "Unknown",
    });
  }
}
```

## NON-CUSTODIAL KEY MANAGEMENT

```typescript
// src/services/wallet/encryption.ts

import * as crypto from "crypto";
import * as argon2 from "argon2";
import { Keypair } from "@solana/web3.js";

interface EncryptedKey {
  ciphertext: string; // Base64
  algorithm: "aes-256-gcm";
  version: 1;
}

interface DerivedKey {
  key: Buffer;
  salt: Buffer;
}

export class KeyEncryption {
  private readonly ALGORITHM = "aes-256-gcm";
  private readonly KEY_LENGTH = 32;
  private readonly SALT_LENGTH = 64;
  private readonly NONCE_LENGTH = 12;

  private readonly ARGON2_CONFIG = {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
  };

  async deriveKey(password: string, salt?: Buffer): Promise<DerivedKey> {
    const actualSalt = salt ?? crypto.randomBytes(this.SALT_LENGTH);

    const hash = await argon2.hash(password, {
      ...this.ARGON2_CONFIG,
      salt: actualSalt,
      raw: true,
    });

    return {
      key: Buffer.from(hash),
      salt: actualSalt,
    };
  }

  async encryptPrivateKey(
    privateKey: Uint8Array,
    password: string
  ): Promise<EncryptedKey> {
    const { key, salt } = await this.deriveKey(password);
    const nonce = crypto.randomBytes(this.NONCE_LENGTH);

    const cipher = crypto.createCipheriv(this.ALGORITHM, key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(privateKey)),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Combine: salt (64) + nonce (12) + authTag (16) + ciphertext
    const combined = Buffer.concat([salt, nonce, authTag, encrypted]);

    return {
      ciphertext: combined.toString("base64"),
      algorithm: this.ALGORITHM,
      version: 1,
    };
  }

  async decryptPrivateKey(
    encrypted: EncryptedKey,
    password: string
  ): Promise<Result<Uint8Array, string>> {
    try {
      const combined = Buffer.from(encrypted.ciphertext, "base64");

      const salt = combined.subarray(0, this.SALT_LENGTH);
      const nonce = combined.subarray(
        this.SALT_LENGTH,
        this.SALT_LENGTH + this.NONCE_LENGTH
      );
      const authTag = combined.subarray(
        this.SALT_LENGTH + this.NONCE_LENGTH,
        this.SALT_LENGTH + this.NONCE_LENGTH + 16
      );
      const ciphertext = combined.subarray(
        this.SALT_LENGTH + this.NONCE_LENGTH + 16
      );

      const { key } = await this.deriveKey(password, salt);

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, nonce);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return Ok(new Uint8Array(decrypted));
    } catch (error) {
      return Err("Decryption failed: invalid password or corrupted data");
    }
  }

  async verifyPassword(
    encrypted: EncryptedKey,
    password: string,
    expectedPublicKey: string
  ): Promise<boolean> {
    const result = await this.decryptPrivateKey(encrypted, password);

    if (!result.success) return false;

    try {
      const keypair = Keypair.fromSecretKey(result.value);
      return keypair.publicKey.toString() === expectedPublicKey;
    } catch {
      return false;
    }
  }
}
```

## SESSION-BASED KEY MANAGER

```typescript
// src/services/wallet/keyManager.ts

import { redis } from "../../utils/redis.js";
import { prisma } from "../../utils/db.js";

interface TradingSession {
  userId: string;
  walletId: string;
  privateKey: string; // Base64
  expiresAt: Date;
}

export class KeyManager {
  private readonly encryption = new KeyEncryption();
  private readonly SESSION_TTL = 900; // 15 minutes

  async createWallet(
    userId: string,
    password: string
  ): Promise<Result<{ publicKey: SolanaAddress; walletId: string }, string>> {
    const keypair = Keypair.generate();

    const encrypted = await this.encryption.encryptPrivateKey(
      keypair.secretKey,
      password
    );

    try {
      const wallet = await prisma.wallet.create({
        data: {
          userId,
          publicKey: keypair.publicKey.toString(),
          encryptedPrivateKey: JSON.stringify(encrypted),
          chain: "solana",
          isActive: true,
        },
      });

      return Ok({
        publicKey: asSolanaAddress(wallet.publicKey),
        walletId: wallet.id,
      });
    } catch (error) {
      return Err(`Failed to create wallet: ${error}`);
    }
  }

  async createTradingSession(
    userId: string,
    walletId: string,
    password: string
  ): Promise<Result<string, string>> {
    const wallet = await prisma.wallet.findFirst({
      where: { id: walletId, userId, isActive: true },
    });

    if (!wallet) return Err("Wallet not found");

    const encrypted: EncryptedKey = JSON.parse(wallet.encryptedPrivateKey);

    const isValid = await this.encryption.verifyPassword(
      encrypted,
      password,
      wallet.publicKey
    );

    if (!isValid) return Err("Invalid password");

    const decryptResult = await this.encryption.decryptPrivateKey(
      encrypted,
      password
    );
    if (!decryptResult.success) return Err(decryptResult.error);

    const sessionToken = crypto.randomBytes(32).toString("hex");

    const session: TradingSession = {
      userId,
      walletId,
      privateKey: Buffer.from(decryptResult.value).toString("base64"),
      expiresAt: new Date(Date.now() + this.SESSION_TTL * 1000),
    };

    await redis.setex(
      `session:${sessionToken}`,
      this.SESSION_TTL,
      JSON.stringify(session)
    );

    return Ok(sessionToken);
  }

  async getKeypairFromSession(
    sessionToken: string
  ): Promise<Result<Keypair, string>> {
    const sessionData = await redis.get(`session:${sessionToken}`);

    if (!sessionData) return Err("Session expired");

    try {
      const session: TradingSession = JSON.parse(sessionData);

      if (new Date() > session.expiresAt) {
        await redis.del(`session:${sessionToken}`);
        return Err("Session expired");
      }

      // Extend on activity
      await redis.expire(`session:${sessionToken}`, this.SESSION_TTL);

      const secretKey = Buffer.from(session.privateKey, "base64");
      const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));

      return Ok(keypair);
    } catch (error) {
      return Err("Invalid session data");
    }
  }

  async revokeSession(sessionToken: string): Promise<void> {
    await redis.del(`session:${sessionToken}`);
  }

  async revokeAllSessions(userId: string): Promise<void> {
    const keys = await redis.keys("session:*");

    for (const key of keys) {
      const sessionData = await redis.get(key);
      if (sessionData) {
        const session: TradingSession = JSON.parse(sessionData);
        if (session.userId === userId) {
          await redis.del(key);
        }
      }
    }
  }
}
```

## TRADING FLOW (FULL EXAMPLE)

```typescript
// src/services/trading/executor.ts

export class TradingExecutor {
  constructor(
    private readonly jupiter: JupiterService,
    private readonly keyManager: KeyManager,
    private readonly honeypot: HoneypotDetector
  ) {}

  async executeTrade(
    userId: string,
    sessionToken: string,
    params: {
      tokenMint: TokenMint;
      amountSol: number;
      slippageBps: number;
    }
  ): Promise<Result<TransactionSignature, TradeError>> {
    // 1. Validate session
    const keypairResult = await this.keyManager.getKeypairFromSession(
      sessionToken
    );
    if (!keypairResult.success) {
      return Err({ type: "SESSION_EXPIRED", message: keypairResult.error });
    }

    // 2. Honeypot check
    const analysisResult = await this.honeypot.analyze(params.tokenMint);
    if (!analysisResult.success) {
      return Err({ type: "ANALYSIS_FAILED", message: "Token analysis failed" });
    }

    if (analysisResult.value.isHoneypot) {
      return Err({
        type: "HONEYPOT_DETECTED",
        message: `Risk score: ${analysisResult.value.riskScore}/100`,
      });
    }

    // 3. Execute swap via Jupiter
    const SOL_MINT = asTokenMint("So11111111111111111111111111111111111111112");
    const amount = solToLamports(params.amountSol);

    const swapResult = await this.jupiter.executeSwap(
      SOL_MINT,
      params.tokenMint,
      amount,
      keypairResult.value,
      params.slippageBps
    );

    if (!swapResult.success) {
      return Err({ type: "SWAP_FAILED", message: swapResult.error.message });
    }

    // 4. Record in database
    await prisma.order.create({
      data: {
        userId,
        tokenMint: params.tokenMint,
        side: "buy",
        amount: params.amountSol,
        status: "filled",
        transactionSignature: swapResult.value,
        commissionUsd: params.amountSol * 0.0085, // 0.85% fee
      },
    });

    return Ok(swapResult.value);
  }
}

type TradeError =
  | { type: "SESSION_EXPIRED"; message: string }
  | { type: "ANALYSIS_FAILED"; message: string }
  | { type: "HONEYPOT_DETECTED"; message: string }
  | { type: "SWAP_FAILED"; message: string };
```

## PROMETHEUS METRICS

```typescript
// src/utils/metrics.ts

import { Counter, Histogram, Gauge, register } from "prom-client";

export const ordersTotal = new Counter({
  name: "orders_total",
  help: "Total orders",
  labelNames: ["chain", "side", "status"],
});

export const orderLatency = new Histogram({
  name: "order_latency_seconds",
  help: "Order execution latency",
  labelNames: ["chain", "side"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

export const rpcRequests = new Counter({
  name: "rpc_requests_total",
  help: "Total RPC requests",
  labelNames: ["endpoint", "method", "status"],
});

export const activeUsers = new Gauge({
  name: "active_users",
  help: "Currently active users",
});

// Usage
async function executeOrder(params: OrderParams) {
  const timer = orderLatency.startTimer({ chain: "solana", side: params.side });

  try {
    const result = await jupiterService.executeSwap(/* ... */);
    ordersTotal.inc({ chain: "solana", side: params.side, status: "filled" });
    return result;
  } finally {
    timer();
  }
}
```

---

**See Also:**

- `CLAUDE.md` - Core principles and type system
- `HONEYPOT.md` - Detection system implementation
- `DEVELOPMENT.md` - Testing and workflow
