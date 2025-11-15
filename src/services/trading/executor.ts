/**
 * Trading Executor Service
 * Orchestrates trade execution with commission calculation and database recording
 */

import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import { unlockWallet, clearKeypair } from "../wallet/keyManager.js";
// ✅ Redis Session Integration
import { getKeypairForSigning } from "../wallet/session.js";
import { getPasswordTemporary } from "../wallet/passwordVault.js";
import { getJupiter } from "./jupiter.js";
import { getSolanaConnection } from "../blockchain/solana.js";
import { PublicKey } from "@solana/web3.js";
import type { Result, SessionToken } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import type { TradeParams, TradeResult, TradingError } from "../../types/trading.js";
import type { JupiterError } from "../../types/jupiter.js";
import type { WalletError } from "../../types/solana.js";
import { asTransactionSignature } from "../../types/common.js";
import {
  incrementWalletUnlockFailures,
  recordError,
  recordTradeFailure,
  recordTradeRequested,
  recordTradeSuccess,
} from "../../utils/metrics.js";
import {
  registerInterval,
  clearRegisteredInterval,
} from "../../utils/intervals.js";

// ============================================================================
// Trading Executor Configuration
// ============================================================================

interface TradingExecutorConfig {
  commissionBps: number; // Commission in basis points (85 = 0.85%)
  minCommissionUsd: number; // Minimum commission in USD
  platformFeeBps: number; // Platform fee collected via Jupiter (50 = 0.5%)
  feeAccount?: string; // Account to receive platform fees
}

const DEFAULT_CONFIG: TradingExecutorConfig = {
  commissionBps: 0, // No commission
  minCommissionUsd: 0, // No minimum
  platformFeeBps: parseInt(process.env.PLATFORM_FEE_BPS || "50"), // 0.5% default
  feeAccount: process.env.PLATFORM_FEE_ACCOUNT, // Fee collection wallet
};

// ============================================================================
// Token Decimals Cache
// ============================================================================

interface DecimalsCacheEntry {
  decimals: number;
  timestamp: number;
  lastAccessed: number; // For LRU eviction
}

const DECIMALS_CACHE_TTL = 3600000; // 1 hour in milliseconds
const DECIMALS_CACHE_MAX_SIZE = 1000; // Maximum number of tokens to cache
const DECIMALS_CACHE_CLEANUP_INTERVAL = 300000; // Cleanup every 5 minutes

// ============================================================================
// Trading Executor Class
// ============================================================================

export class TradingExecutor {
  private config: TradingExecutorConfig;
  private decimalsCache: Map<string, DecimalsCacheEntry> = new Map();
  private cacheCleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<TradingExecutorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info("Trading executor initialized", {
      commissionBps: this.config.commissionBps,
      commissionPct: (this.config.commissionBps / 100).toFixed(2) + "%",
      minCommissionUsd: this.config.minCommissionUsd,
      platformFeeBps: this.config.platformFeeBps,
      platformFeePct: (this.config.platformFeeBps / 100).toFixed(2) + "%",
      feeAccount: this.config.feeAccount,
      revenueEnabled: !!(this.config.platformFeeBps && this.config.feeAccount),
    });

    // Start periodic cache cleanup
    this.startCacheCleanup();
  }

  /**
   * Start periodic cleanup of expired cache entries
   */
  private startCacheCleanup(): void {
    this.cacheCleanupTimer = registerInterval(
      () => {
        this.cleanupExpiredEntries();
      },
      DECIMALS_CACHE_CLEANUP_INTERVAL,
      "trading-executor-cache"
    );

    // Ensure cleanup runs even if process is idle
    if (this.cacheCleanupTimer.unref) {
      this.cacheCleanupTimer.unref();
    }

    logger.debug("Decimals cache cleanup timer started", {
      intervalMs: DECIMALS_CACHE_CLEANUP_INTERVAL,
    });
  }

  /**
   * Stop cache cleanup timer (for graceful shutdown)
   */
  public stopCacheCleanup(): void {
    if (this.cacheCleanupTimer) {
      clearRegisteredInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      logger.debug("Decimals cache cleanup timer stopped");
    }
  }

  /**
   * Clean up expired cache entries
   * Removes entries older than TTL
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let removedCount = 0;

    for (const [tokenMint, entry] of this.decimalsCache.entries()) {
      if (now - entry.timestamp > DECIMALS_CACHE_TTL) {
        this.decimalsCache.delete(tokenMint);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.debug("Cleaned up expired decimals cache entries", {
        removedCount,
        remainingSize: this.decimalsCache.size,
      });
    }
  }

  /**
   * Evict least recently used entry to make room for new one
   * Uses LRU (Least Recently Used) eviction policy
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [tokenMint, entry] of this.decimalsCache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = tokenMint;
      }
    }

    if (oldestKey) {
      this.decimalsCache.delete(oldestKey);
      logger.debug("Evicted LRU decimals cache entry", {
        tokenMint: oldestKey,
        cacheSize: this.decimalsCache.size,
      });
    }
  }

  /**
   * Get swap quote from Jupiter
   * ✅ No authentication required - just price preview
   */
  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
    userPublicKey: string;
  }): Promise<Result<any, TradingError>> {
    try {
      const jupiter = getJupiter();
      const quoteResult = await jupiter.getQuote({
        inputMint: params.inputMint as any,
        outputMint: params.outputMint as any,
        amount: params.amount,
        slippageBps: params.slippageBps || 50,
        userPublicKey: params.userPublicKey as any,
      });

      if (!quoteResult.success) {
        return Err({
          type: "QUOTE_FAILED",
          message: "Failed to get quote from Jupiter",
        });
      }

      return Ok(quoteResult.value);
    } catch (error) {
      logger.error("Error getting quote", { error, params });
      return Err({
        type: "QUOTE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Execute a trade with commission calculation and database recording
   *
   * ✅ Redis Session Integration: Two modes
   * 1. With sessionToken: Uses getKeypairForSigning (requires password in Grammy session)
   * 2. Without sessionToken: Falls back to unlockWallet (requires password parameter)
   */
  async executeTrade(
    params: TradeParams,
    password?: string,
    sessionToken?: SessionToken, // ✅ Optional Redis session token
    options?: { reusePassword?: boolean }
  ): Promise<Result<TradeResult, TradingError>> {
    const { userId, inputMint, outputMint, amount, slippageBps } = params;
    const tradeSide = this.determineSide(inputMint, outputMint);
    const tradeStart = Date.now();
    const reuseSessionPassword = options?.reusePassword ?? false;
    const recordFailure = (reason: string, errorType?: string) => {
      if (errorType) {
        recordError(errorType);
      }
      recordTradeFailure(tradeSide, Date.now() - tradeStart, reason);
    };

    logger.info("Executing trade", {
      userId,
      inputMint,
      outputMint,
      amount,
      slippageBps,
      passwordProvided: !!password,
      hasSession: !!sessionToken,
      reuseSessionPassword,
    });

    recordTradeRequested(tradeSide);

    try {
      let keypair;
      let publicKey;
      let effectivePassword = password;

      // Prefer Redis session password if session token is provided
      if (sessionToken) {
        const passwordResult = await getPasswordTemporary(sessionToken, {
          consume: !reuseSessionPassword,
        });

        if (!passwordResult.success) {
          logger.error("Failed to load password from Redis", {
            userId,
            sessionToken: "[REDACTED]",
            sessionTokenPresent: true,
          });
          recordFailure("session_password_lookup", "session_password_error");
          return Err({
            type: "INVALID_PASSWORD",
            message: "Unable to access secure password cache. Please /unlock again."
          });
        }

        if (!passwordResult.value) {
          logger.warn("Session password expired before trade", {
            userId,
            sessionToken: "[REDACTED]",
            sessionTokenPresent: true,
          });
          recordFailure("session_expired", "session_password_expired");

          return Err({
            type: "INVALID_PASSWORD",
            message: "Session expired. Please /unlock again before trading."
          });
        }

        effectivePassword = passwordResult.value;
      }

      // ✅ Step 1: Get keypair - prefer Redis session, fallback to unlockWallet
      if (sessionToken && effectivePassword) {
        // Use Redis session + getKeypairForSigning
        logger.info("Using Redis session for trade", {
          userId,
          sessionToken: "[REDACTED]",
          sessionTokenPresent: true,
        });

        const keypairResult = await getKeypairForSigning(sessionToken, effectivePassword);

        if (!keypairResult.success) {
          recordFailure("session_unlock_failed", "session_keypair_failure");
          return Err({
            type: "INVALID_PASSWORD",
            message: "Session expired or invalid password. Please /unlock again."
          });
        }

        keypair = keypairResult.value;
        publicKey = keypair.publicKey.toBase58() as any;

        logger.info("Keypair retrieved from Redis session", { userId, publicKey });
      } else {
        // Fallback: unlock wallet directly
        if (!effectivePassword) {
          recordFailure("missing_password", "trade_missing_password");
          return Err({
            type: "INVALID_PASSWORD",
            message: "Password is required for trading"
          });
        }

        logger.info("No session - unlocking wallet directly", { userId });

        const unlockResult = await unlockWallet({ userId, password: effectivePassword });

        if (!unlockResult.success) {
          const error = unlockResult.error as WalletError;

          if (error.type === "WALLET_NOT_FOUND") {
            recordFailure("wallet_not_found", "wallet_not_found");
            return Err({ type: "WALLET_NOT_FOUND", message: `Wallet not found for user ${error.userId}` });
          }

          if (error.type === "INVALID_PASSWORD") {
            incrementWalletUnlockFailures();
            recordFailure("invalid_password", "wallet_invalid_password");
            return Err({ type: "INVALID_PASSWORD", message: error.message });
          }

          recordFailure("wallet_unlock_unknown", "wallet_unlock_unknown");
          return Err({ type: "UNKNOWN", message: "Failed to unlock wallet" });
        }

        keypair = unlockResult.value.keypair;
        publicKey = unlockResult.value.publicKey;

        logger.info("Unlocked wallet for one-time trade", { userId, publicKey });
      }

      // Step 2: Create pending order in database
      const order = await prisma.order.create({
        data: {
          userId,
          tokenMint: outputMint, // The token being acquired
          side: tradeSide,
          amount: amount,
          status: "pending",
        },
      });

      logger.info("Order created", { orderId: order.id, side: order.side });

      // Step 3: Execute swap via Jupiter with platform fee
      const jupiter = getJupiter();

      const swapResult = await jupiter.swap(
        {
          inputMint,
          outputMint,
          amount,
          userPublicKey: publicKey,
          slippageBps,
          platformFeeBps: this.config.platformFeeBps,
          feeAccount: this.config.feeAccount,
        },
        keypair
      );

      logger.info("Swap executed with platform fee", {
        platformFeeBps: this.config.platformFeeBps,
        feeAccount: this.config.feeAccount,
        platformFeeEnabled: !!(this.config.platformFeeBps && this.config.feeAccount),
      });

      // ✅ SECURITY: ALWAYS clear keypair from memory after use
      clearKeypair(keypair);

      if (!swapResult.success) {
        const error = swapResult.error as JupiterError;
        recordError("swap_failed");
        recordTradeFailure(tradeSide, Date.now() - tradeStart, "swap_failed");

        // Update order status to failed
        await prisma.order.update({
          where: { id: order.id },
          data: { status: "failed" },
        });

        logger.error("Swap failed", { orderId: order.id, error });

        return Err({
          type: "SWAP_FAILED",
          reason: "message" in error ? error.message : "Unknown swap error",
        });
      }

      const swapData = swapResult.value;

      // Step 4: Calculate commission (0.85% of output amount in USD)
      const commissionResult = await this.calculateCommission(
        outputMint,
        swapData.outputAmount
      );

      if (!commissionResult.success) {
        logger.warn("Failed to calculate commission, using minimum", {
          orderId: order.id,
          error: commissionResult.error,
        });
      }

      const commissionUsd =
        commissionResult.success
          ? commissionResult.value
          : this.config.minCommissionUsd;

      // Step 5: Update order with success status
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: "filled",
          transactionSignature: swapData.signature,
          commissionUsd,
        },
      });

      logger.info("Trade executed successfully", {
        orderId: order.id,
        signature: swapData.signature,
        inputAmount: swapData.inputAmount.toString(),
        outputAmount: swapData.outputAmount.toString(),
        priceImpactPct: swapData.priceImpactPct,
        commissionUsd,
      });

      recordTradeSuccess(
        tradeSide,
        Date.now() - tradeStart,
        commissionUsd
      );

      return Ok({
        orderId: order.id,
        signature: asTransactionSignature(swapData.signature),
        inputAmount: swapData.inputAmount,
        outputAmount: swapData.outputAmount,
        inputMint,
        outputMint,
        priceImpactPct: swapData.priceImpactPct,
        commissionUsd,
        slot: swapData.slot,
      });
    } catch (error) {
      logger.error("Unexpected error executing trade", { userId, error });
      return Err({
        type: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get token decimals from on-chain mint account
   * Uses 1-hour cache with LRU eviction to minimize RPC calls
   */
  private async getTokenDecimals(
    tokenMint: string
  ): Promise<Result<number, TradingError>> {
    try {
      const now = Date.now();

      // Check cache first
      const cached = this.decimalsCache.get(tokenMint);

      if (cached && now - cached.timestamp < DECIMALS_CACHE_TTL) {
        // Update lastAccessed for LRU
        cached.lastAccessed = now;

        logger.debug("Token decimals cache hit", {
          tokenMint,
          decimals: cached.decimals,
          age: Math.floor((now - cached.timestamp) / 1000) + "s",
        });
        return Ok(cached.decimals);
      }

      // Cache miss - fetch from on-chain
      logger.debug("Token decimals cache miss, fetching from RPC", { tokenMint });

      const connection = await getSolanaConnection();
      const mintPublicKey = new PublicKey(tokenMint);

      // Get mint account info
      const mintInfo = await connection.getParsedAccountInfo(mintPublicKey);

      if (!mintInfo.value) {
        return Err({
          type: "INVALID_TOKEN",
          message: `Token mint account not found: ${tokenMint}`,
        });
      }

      // Extract decimals from parsed data
      const data = mintInfo.value.data;
      if (!("parsed" in data) || !data.parsed?.info?.decimals) {
        return Err({
          type: "INVALID_TOKEN",
          message: `Invalid mint account data for ${tokenMint}`,
        });
      }

      const decimals = data.parsed.info.decimals as number;

      // Check if cache is full and evict LRU if needed
      if (this.decimalsCache.size >= DECIMALS_CACHE_MAX_SIZE) {
        this.evictLRU();
      }

      // Save to cache with current timestamp
      this.decimalsCache.set(tokenMint, {
        decimals,
        timestamp: now,
        lastAccessed: now,
      });

      logger.info("Token decimals fetched and cached", {
        tokenMint,
        decimals,
        cacheSize: this.decimalsCache.size,
        maxSize: DECIMALS_CACHE_MAX_SIZE,
      });

      return Ok(decimals);
    } catch (error) {
      logger.error("Error fetching token decimals", { tokenMint, error });
      return Err({
        type: "RPC_ERROR",
        message: `Failed to fetch decimals: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Calculate commission in USD (0.85% of output amount)
   */
  private async calculateCommission(
    tokenMint: string,
    outputAmount: bigint
  ): Promise<Result<number, TradingError>> {
    try {
      const jupiter = getJupiter();

      // Get token decimals (cached)
      const decimalsResult = await this.getTokenDecimals(tokenMint);

      if (!decimalsResult.success) {
        logger.warn("Failed to get token decimals, using default 9", {
          tokenMint,
          error: decimalsResult.error,
        });
        // Fallback to 9 decimals (SOL standard) if decimals fetch fails
        // This prevents commission calculation from completely failing
      }

      const decimals = decimalsResult.success ? decimalsResult.value : 9;
      const divisor = Math.pow(10, decimals);

      // Get token price in USD
      const priceResult = await jupiter.getTokenPrice(tokenMint as any);

      if (!priceResult.success) {
        return Err({
          type: "COMMISSION_CALCULATION_FAILED",
          message: "Failed to fetch token price",
        });
      }

      const tokenPriceUsd = priceResult.value;

      // Calculate output value in USD using correct decimals
      const outputValueUsd = (Number(outputAmount) / divisor) * tokenPriceUsd;

      // Calculate commission (0.85%)
      const commission = (outputValueUsd * this.config.commissionBps) / 10000;

      // Apply minimum commission
      const finalCommission = Math.max(commission, this.config.minCommissionUsd);

      logger.info("Commission calculated", {
        tokenMint,
        outputAmount: outputAmount.toString(),
        decimals,
        divisor,
        tokenPriceUsd,
        outputValueUsd: outputValueUsd.toFixed(2),
        commission: commission.toFixed(4),
        finalCommission: finalCommission.toFixed(4),
      });

      return Ok(finalCommission);
    } catch (error) {
      logger.error("Error calculating commission", { error });
      return Err({
        type: "COMMISSION_CALCULATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Determine trade side (buy/sell)
   * If input is SOL → buy
   * If output is SOL → sell
   * Otherwise → swap
   */
  private determineSide(inputMint: string, outputMint: string): string {
    const SOL_MINT = "So11111111111111111111111111111111111111112";

    if (inputMint === SOL_MINT) return "buy";
    if (outputMint === SOL_MINT) return "sell";
    return "swap";
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let tradingExecutorInstance: TradingExecutor | null = null;

export function initializeTradingExecutor(
  config?: Partial<TradingExecutorConfig>
): TradingExecutor {
  if (tradingExecutorInstance) {
    logger.warn("Trading executor already initialized, returning existing instance");
    return tradingExecutorInstance;
  }

  tradingExecutorInstance = new TradingExecutor(config);
  return tradingExecutorInstance;
}

export function getTradingExecutor(): TradingExecutor {
  if (!tradingExecutorInstance) {
    throw new Error(
      "Trading executor not initialized. Call initializeTradingExecutor() first"
    );
  }

  return tradingExecutorInstance;
}
