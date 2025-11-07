/**
 * Trading Executor Service
 * Orchestrates trade execution with commission calculation and database recording
 */

import { logger } from "../../utils/logger.js";
import { prisma } from "../../utils/db.js";
import { unlockWallet, clearKeypair } from "../wallet/keyManager.js";
// ✅ Redis Session Integration
import { getKeypairForSigning } from "../wallet/session.js";
import { getJupiter } from "./jupiter.js";
import type {
  Result,
  SessionToken,
  SolanaAddress,
  TokenMint,
} from "../../types/common.js";
import { Ok, Err, asSolanaAddress, asTokenMint } from "../../types/common.js";
import type {
  TradeParams,
  TradeResult,
  TradingError,
} from "../../types/trading.js";
import type { JupiterError } from "../../types/jupiter.js";
import type { WalletError } from "../../types/solana.js";
import { asTransactionSignature } from "../../types/common.js";

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
  commissionBps: 85, // 0.85% (for calculation/logging only)
  minCommissionUsd: 0.01, // $0.01 minimum
  platformFeeBps: parseInt(process.env.PLATFORM_FEE_BPS || "50"), // 0.5% default
  feeAccount: process.env.PLATFORM_FEE_ACCOUNT, // Fee collection wallet
};

// ============================================================================
// Trading Executor Class
// ============================================================================

export class TradingExecutor {
  private config: TradingExecutorConfig;

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
  }

  /**
   * Execute a trade with commission calculation and database recording
   *
   * ✅ SECURITY (CRITICAL-2 Fix - Variant C+): Two modes
   * 1. With sessionToken: Uses getKeypairForSigning (NO PASSWORD REQUIRED!)
   * 2. Without sessionToken: Falls back to unlockWallet (requires password parameter)
   */
  async executeTrade(
    params: TradeParams,
    password?: string, // ✅ Optional when sessionToken is provided
    sessionToken?: SessionToken // ✅ Optional Redis session token
  ): Promise<Result<TradeResult, TradingError>> {
    const { userId, inputMint, outputMint, amount, slippageBps } = params;

    logger.info("Executing trade", {
      userId,
      inputMint,
      outputMint,
      amount,
      slippageBps,
      hasPassword: !!password,
      hasSession: !!sessionToken,
    });

    try {
      // LOW-1: Declare proper types instead of implicit 'any'
      let keypair: import("@solana/web3.js").Keypair;
      let publicKey: SolanaAddress;

      // ✅ Step 1: Get keypair - prefer Redis session, fallback to unlockWallet
      // ✅ SECURITY (CRITICAL-2 Fix - Variant C+): No password required with session!
      if (sessionToken) {
        // Use Redis session + getKeypairForSigning (NO PASSWORD NEEDED!)
        logger.info("Using Redis session for trade (no password required)", {
          userId,
          sessionToken: sessionToken.substring(0, 10) + "...",
        });

        const keypairResult = await getKeypairForSigning(sessionToken);

        if (!keypairResult.success) {
          return Err({
            type: "INVALID_PASSWORD",
            message: "Session expired or invalid. Please /unlock again.",
          });
        }

        keypair = keypairResult.value;
        // LOW-1: Use asSolanaAddress() instead of 'as any'
        publicKey = asSolanaAddress(keypair.publicKey.toBase58());

        logger.info("Keypair retrieved from Redis session", {
          userId,
          publicKey,
        });
      } else {
        // Fallback: unlock wallet directly (requires password)
        if (!password) {
          return Err({
            type: "INVALID_PASSWORD",
            message:
              "Password is required for trading without active session. Use /unlock first.",
          });
        }

        logger.info("No session - unlocking wallet directly with password", {
          userId,
        });

        const unlockResult = await unlockWallet({ userId, password });

        if (!unlockResult.success) {
          const error = unlockResult.error as WalletError;

          if (error.type === "WALLET_NOT_FOUND") {
            return Err({
              type: "WALLET_NOT_FOUND",
              message: `Wallet not found for user ${error.userId}`,
            });
          }

          if (error.type === "INVALID_PASSWORD") {
            return Err({ type: "INVALID_PASSWORD", message: error.message });
          }

          return Err({ type: "UNKNOWN", message: "Failed to unlock wallet" });
        }

        keypair = unlockResult.value.keypair;
        publicKey = unlockResult.value.publicKey;

        logger.info("Unlocked wallet for one-time trade", {
          userId,
          publicKey,
        });
      }

      // Step 2: Create pending order in database
      const order = await prisma.order.create({
        data: {
          userId,
          tokenMint: outputMint, // The token being acquired
          side: this.determineSide(inputMint, outputMint),
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
        platformFeeEnabled: !!(
          this.config.platformFeeBps && this.config.feeAccount
        ),
      });

      // ✅ SECURITY: ALWAYS clear keypair from memory after use
      clearKeypair(keypair);

      if (!swapResult.success) {
        const error = swapResult.error as JupiterError;

        // MEDIUM-1: Async DB write (fire-and-forget, don't block error return)
        prisma.order
          .update({
            where: { id: order.id },
            data: { status: "failed" },
          })
          .catch((dbError) => {
            logger.error("Failed to update order status to failed", {
              orderId: order.id,
              error: dbError,
            });
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

      const commissionUsd = commissionResult.success
        ? commissionResult.value
        : this.config.minCommissionUsd;

      // MEDIUM-1: Async DB write (fire-and-forget, don't block return)
      // This saves ~20-50ms on the critical path
      prisma.order
        .update({
          where: { id: order.id },
          data: {
            status: "filled",
            transactionSignature: swapData.signature,
            commissionUsd,
          },
        })
        .catch((dbError) => {
          logger.error("Failed to update order status to filled", {
            orderId: order.id,
            signature: swapData.signature,
            error: dbError,
          });
        });

      logger.info("Trade executed successfully", {
        orderId: order.id,
        signature: swapData.signature,
        inputAmount: swapData.inputAmount.toString(),
        outputAmount: swapData.outputAmount.toString(),
        priceImpactPct: swapData.priceImpactPct,
        commissionUsd,
      });

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
   * Calculate commission in USD (0.85% of output amount)
   */
  private async calculateCommission(
    tokenMint: string,
    outputAmount: bigint
  ): Promise<Result<number, TradingError>> {
    try {
      const jupiter = getJupiter();

      // Get token price in USD
      // LOW-1: Use asTokenMint() instead of 'as any'
      const priceResult = await jupiter.getTokenPrice(asTokenMint(tokenMint));

      if (!priceResult.success) {
        return Err({
          type: "COMMISSION_CALCULATION_FAILED",
          message: "Failed to fetch token price",
        });
      }

      const tokenPriceUsd = priceResult.value;

      // Calculate output value in USD (assuming 9 decimals, adjust if needed)
      const outputValueUsd = (Number(outputAmount) / 1e9) * tokenPriceUsd;

      // Calculate commission (0.85%)
      const commission = (outputValueUsd * this.config.commissionBps) / 10000;

      // Apply minimum commission
      const finalCommission = Math.max(
        commission,
        this.config.minCommissionUsd
      );

      logger.info("Commission calculated", {
        tokenMint,
        outputAmount: outputAmount.toString(),
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
    logger.warn(
      "Trading executor already initialized, returning existing instance"
    );
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
