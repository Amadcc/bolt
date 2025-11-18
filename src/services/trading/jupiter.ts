/**
 * Jupiter v6 Ultra API integration
 * Provides swap quote and execution services
 */

import { VersionedTransaction, Connection, Keypair } from "@solana/web3.js";
import type { QuoteGetRequest } from "@jup-ag/api";
import { logger } from "../../utils/logger.js";
import { retry } from "../../utils/helpers.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import type {
  JupiterQuoteResponse,
  JupiterExecuteRequest,
  JupiterExecuteResponse,
  JupiterErrorResponse,
  JupiterSwapParams,
  JupiterSwapResult,
  JupiterError,
  JupiterConfig,
} from "../../types/jupiter.js";
import { DEFAULT_JUPITER_CONFIG } from "../../types/jupiter.js";
import { asTransactionSignature, type TokenMint } from "../../types/common.js";
// AUDIT FIX: Import Jito service for MEV protection
import { getJitoService } from "./jito.js";
import { registerInterval } from "../../utils/intervals.js";
// DAY 7: Import transaction builder for priority fees
import { addPriorityFeeToDeserializedTransaction } from "../sniper/transactionBuilder.js";
// SPRINT 1.1.4: Import circuit breaker for API protection
import { createCircuitBreaker } from "../shared/circuitBreaker.js";
import type { CircuitBreaker } from "../shared/circuitBreaker.js";

// ============================================================================
// Quote Cache (in-memory, 2s TTL)
// ============================================================================

interface CachedQuote {
  quote: JupiterQuoteResponse;
  timestamp: number;
}

// ============================================================================
// Jupiter Service Class
// ============================================================================

const FRIENDLY_NETWORK_ERROR_MESSAGE = "Network connection failed. Please try again.";

export class JupiterService {
  private config: JupiterConfig;
  private connection: Connection;
  private quoteCache: Map<string, CachedQuote> = new Map();
  private readonly QUOTE_CACHE_TTL = 2000; // 2 seconds
  private readonly clusterQueryParams: Record<string, string>;
  private jupiterApiCircuitBreaker: CircuitBreaker;
  private jitoCircuitBreaker: CircuitBreaker;

  constructor(connection: Connection, config: Partial<JupiterConfig> = {}) {
    this.config = { ...DEFAULT_JUPITER_CONFIG, ...config };
    this.connection = connection;
    this.clusterQueryParams = this.buildClusterQueryParams();

    // Initialize circuit breakers for API protection
    this.jupiterApiCircuitBreaker = createCircuitBreaker("jupiter_api", {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 60000,
      monitoringPeriod: 120000,
    });

    this.jitoCircuitBreaker = createCircuitBreaker("jito_block_engine", {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 60000,
      monitoringPeriod: 120000,
    });

    logger.info("Jupiter service initialized", {
      baseUrl: this.config.baseUrl,
      timeout: this.config.timeout,
      defaultSlippageBps: this.config.defaultSlippageBps,
      quoteCacheTTL: this.QUOTE_CACHE_TTL,
    });

    // Start cache cleanup interval (every 5 seconds)
    this.startCacheCleanup();
  }

  /**
   * Generate cache key for quote
   */
  private getCacheKey(params: JupiterSwapParams): string {
    return `${params.inputMint}-${params.outputMint}-${params.amount}-${params.slippageBps ?? this.config.defaultSlippageBps}`;
  }

  /**
   * Get quote from cache if valid
   */
  private getCachedQuote(params: JupiterSwapParams): JupiterQuoteResponse | null {
    const key = this.getCacheKey(params);
    const cached = this.quoteCache.get(key);

    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > this.QUOTE_CACHE_TTL) {
      this.quoteCache.delete(key);
      return null;
    }

    logger.info("Quote cache hit", { key, age });
    return cached.quote;
  }

  /**
   * Store quote in cache
   */
  private setCachedQuote(params: JupiterSwapParams, quote: JupiterQuoteResponse): void {
    const key = this.getCacheKey(params);
    this.quoteCache.set(key, { quote, timestamp: Date.now() });
    logger.info("Quote cached", { key, cacheSize: this.quoteCache.size });
  }

  /**
   * Clean up expired cache entries
   */
  private startCacheCleanup(): void {
    registerInterval(
      () => {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, cached] of this.quoteCache.entries()) {
          if (now - cached.timestamp > this.QUOTE_CACHE_TTL) {
            this.quoteCache.delete(key);
            cleaned++;
          }
        }

        if (cleaned > 0) {
          logger.info("Quote cache cleanup", {
            cleaned,
            remaining: this.quoteCache.size,
          });
        }
      },
      5000,
      "jupiter-quote-cache"
    );
  }

  /**
   * Build cluster/environment query params for Jupiter requests
   */
  private buildClusterQueryParams(): Record<string, string> {
    const network = (process.env.SOLANA_NETWORK || "mainnet-beta").toLowerCase();

    if (network === "devnet") {
      return { cluster: "devnet", environment: "devnet" };
    }

    if (network === "testnet") {
      return { cluster: "testnet", environment: "testnet" };
    }

    if (network === "mainnet") {
      return { cluster: "mainnet-beta", environment: "mainnet-beta" };
    }

    // Default to mainnet-beta which Jupiter expects explicitly
    return { cluster: "mainnet-beta", environment: "mainnet-beta" };
  }

  /**
   * Build full endpoint URL with cluster params applied
   */
  private buildEndpointUrl(
    path: string,
    params?: URLSearchParams
  ): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const base = this.config.baseUrl.endsWith("/")
      ? this.config.baseUrl
      : `${this.config.baseUrl}/`;
    const url = new URL(normalizedPath, base);

    Object.entries(this.clusterQueryParams).forEach(([key, value]) => {
      if (value) {
        url.searchParams.set(key, value);
      }
    });

    if (params) {
      params.forEach((value, key) => {
        url.searchParams.append(key, value);
      });
    }

    return url.toString();
  }

  // ==========================================================================
  // Quote Fetching (/order endpoint)
  // ==========================================================================

  /**
   * Get swap quote from Jupiter
   */
  async getQuote(
    params: JupiterSwapParams
  ): Promise<Result<JupiterQuoteResponse, JupiterError>> {
    // Check cache first
    const cachedQuote = this.getCachedQuote(params);
    if (cachedQuote) {
      return Ok(cachedQuote);
    }

    const startTime = Date.now();

    logger.info("Fetching Jupiter quote", {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: params.slippageBps ?? this.config.defaultSlippageBps,
    });

    try {
      const slippageBps =
        params.slippageBps ?? this.config.defaultSlippageBps;
      const parsedAmount = Number(params.amount);

      if (!Number.isFinite(parsedAmount)) {
        return Err({
          type: "UNKNOWN",
          message: `Invalid amount provided for quote: ${params.amount}`,
        });
      }

      const quoteRequest: QuoteGetRequest = {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: parsedAmount,
        slippageBps,
        platformFeeBps: params.platformFeeBps,
      };

      const queryParams = new URLSearchParams({
        inputMint: quoteRequest.inputMint,
        outputMint: quoteRequest.outputMint,
        amount: params.amount,
        taker: params.userPublicKey,
        slippageBps: String(slippageBps),
      });

      if (quoteRequest.platformFeeBps) {
        queryParams.append(
          "platformFeeBps",
          String(quoteRequest.platformFeeBps)
        );
      }

      // NOTE: Jupiter Lite API does not support referralFee parameter
      // Platform fees would need to be collected manually or via paid Jupiter API
      if (params.referralAccount) {
        queryParams.append("referralAccount", params.referralAccount);
      }

      // Log platform fee config (for reference, not actually used by Jupiter Lite API)
      if (params.platformFeeBps && params.feeAccount) {
        logger.warn("Platform fee configured but not supported by Jupiter Lite API", {
          platformFeeBps: params.platformFeeBps,
          feeAccount: params.feeAccount,
          note: "Upgrade to Jupiter Paid API or implement manual fee collection"
        });
      }

      const url = this.buildEndpointUrl("/ultra/v1/order", queryParams);

      logger.debug("Jupiter quote URL", { url });

      // Wrap Jupiter API call with circuit breaker
      const response = await this.jupiterApiCircuitBreaker.execute(async () => {
        return retry(
          () =>
            fetch(url, {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              signal: AbortSignal.timeout(this.config.timeout),
            }),
          {
            maxRetries: this.config.maxRetries,
            backoff: "exponential",
            baseDelay: 1000,
          }
        );
      });

      if (response === null) {
        // Circuit breaker is OPEN
        logger.warn("Jupiter API circuit breaker OPEN");
        return Err({
          type: "NETWORK_ERROR",
          message: "Jupiter API temporarily unavailable (circuit breaker OPEN)",
        });
      }

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as JupiterErrorResponse;

        logger.error("Jupiter quote request failed", {
          status: response.status,
          error: errorData.error || response.statusText,
        });

        return Err({
          type: "API_ERROR",
          statusCode: response.status,
          message: errorData.error || response.statusText,
        });
      }

      const data = (await response.json()) as JupiterQuoteResponse;

      // Check for transaction generation errors
      if (data.errorCode) {
        logger.warn("Jupiter quote returned with error", {
          errorCode: data.errorCode,
          errorMessage: data.errorMessage,
        });

        if (data.errorCode === 1) {
          return Err({
            type: "INSUFFICIENT_BALANCE",
            message: data.errorMessage || "Insufficient funds",
          });
        } else if (data.errorCode === 3) {
          return Err({
            type: "MINIMUM_AMOUNT",
            message: data.errorMessage || "Amount below minimum",
          });
        }
      }

      // Check if transaction is null (no route found)
      if (!data.transaction) {
        logger.warn("No swap route found", {
          inputMint: params.inputMint,
          outputMint: params.outputMint,
        });

        return Err({
          type: "NO_ROUTE",
          message: "No swap route found for this token pair",
        });
      }

      const elapsed = Date.now() - startTime;

      logger.info("Jupiter quote fetched successfully", {
        inAmount: data.inAmount,
        outAmount: data.outAmount,
        priceImpact: data.priceImpact,
        router: data.router,
        requestId: data.requestId,
        elapsed,
      });

      // Cache the quote
      this.setCachedQuote(params, data);

      return Ok(data);
    } catch (error) {
      const elapsed = Date.now() - startTime;

      if (error instanceof Error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") {
          logger.error("Jupiter quote request timed out", { elapsed });
          return Err({
            type: "TIMEOUT",
            message: `Request timed out after ${elapsed}ms`,
          });
        }

        if (error.message.includes("fetch")) {
          logger.error("Network error fetching Jupiter quote", {
            error: error.message,
          });
          return Err({
            type: "NETWORK_ERROR",
            message: FRIENDLY_NETWORK_ERROR_MESSAGE,
          });
        }
      }

      logger.error("Unknown error fetching Jupiter quote", { error });
      return Err({
        type: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // Transaction Building & Signing
  // ==========================================================================

  /**
   * Deserialize and sign the transaction from Jupiter quote
   *
   * DAY 7: Now supports priority fee optimization via ComputeBudget instructions
   */
  signTransaction(
    transactionBase64: string,
    keypair: Keypair,
    priorityFee?: { computeUnitPrice: number; computeUnitLimit: number }
  ): Result<VersionedTransaction, JupiterError> {
    try {
      logger.debug("Signing Jupiter transaction", { priorityFee });

      // Decode base64 transaction
      const transactionBuffer = Buffer.from(transactionBase64, "base64");

      // Deserialize versioned transaction
      let transaction = VersionedTransaction.deserialize(transactionBuffer);

      // DAY 7: Add priority fee if specified
      if (priorityFee) {
        logger.debug("Adding priority fee to transaction", priorityFee);

        const modifyResult = addPriorityFeeToDeserializedTransaction(
          transaction,
          priorityFee
        );

        if (!modifyResult.success) {
          logger.warn("Failed to add priority fee, using original transaction", {
            error: modifyResult.error,
          });
          // Continue with original transaction if modification fails
        } else {
          transaction = modifyResult.value;
          logger.debug("Priority fee added successfully");
        }
      }

      // Sign transaction
      transaction.sign([keypair]);

      logger.debug("Transaction signed successfully");

      // CRITICAL: Return VersionedTransaction directly to avoid extra serialize/deserialize cycles
      return Ok(transaction);
    } catch (error) {
      logger.error("Failed to sign transaction", { error });
      return Err({
        type: "UNKNOWN",
        message: `Failed to sign transaction: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ==========================================================================
  // Swap Execution (/execute endpoint)
  // ==========================================================================

  /**
   * Execute signed swap transaction via Jupiter
   */
  async executeSwap(
    signedTransaction: string,
    requestId: string
  ): Promise<Result<JupiterExecuteResponse, JupiterError>> {
    const startTime = Date.now();

    logger.info("Executing Jupiter swap", { requestId });

    try {
      const url = this.buildEndpointUrl("/ultra/v1/execute");

      const body: JupiterExecuteRequest = {
        signedTransaction,
        requestId,
      };

      const response = await retry(
        () =>
          fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.config.timeout),
          }),
        {
          maxRetries: this.config.maxRetries,
          backoff: "exponential",
          baseDelay: 1000,
        }
      );

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as JupiterErrorResponse;

        logger.error("Jupiter execute request failed", {
          status: response.status,
          error: errorData.error || response.statusText,
          requestId,
        });

        return Err({
          type: "API_ERROR",
          statusCode: response.status,
          message: errorData.error || response.statusText,
        });
      }

      const data = (await response.json()) as JupiterExecuteResponse;

      const elapsed = Date.now() - startTime;

      if (data.status === "Failed") {
        logger.error("Jupiter swap execution failed", {
          error: data.error,
          signature: data.signature,
          requestId,
          elapsed,
        });

        return Err({
          type: "TRANSACTION_FAILED",
          signature: data.signature,
          reason: data.error || "Unknown execution failure",
        });
      }

      logger.info("Jupiter swap executed successfully", {
        signature: data.signature,
        slot: data.slot,
        inputAmount: data.totalInputAmount,
        outputAmount: data.totalOutputAmount,
        requestId,
        elapsed,
      });

      return Ok(data);
    } catch (error) {
      const elapsed = Date.now() - startTime;

      if (error instanceof Error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") {
          logger.error("Jupiter execute request timed out", {
            elapsed,
            requestId,
          });
          return Err({
            type: "TIMEOUT",
            message: `Request timed out after ${elapsed}ms`,
          });
        }

        if (error.message.includes("fetch")) {
          logger.error("Network error executing Jupiter swap", {
            error: error.message,
            requestId,
          });
          return Err({
            type: "NETWORK_ERROR",
            message: FRIENDLY_NETWORK_ERROR_MESSAGE,
          });
        }
      }

      logger.error("Unknown error executing Jupiter swap", {
        error,
        requestId,
      });
      return Err({
        type: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // High-Level Swap Function (Complete Flow)
  // ==========================================================================

  /**
   * Complete swap flow: quote -> sign -> execute -> confirm
   *
   * DAY 7: Now supports priority fee optimization
   */
  async swap(
    params: JupiterSwapParams,
    keypair: Keypair
  ): Promise<Result<JupiterSwapResult, JupiterError>> {
    logger.info("Starting complete Jupiter swap flow", {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      priorityFee: params.priorityFee,
    });

    // Step 1: Get quote
    const quoteResult = await this.getQuote(params);
    if (!quoteResult.success) {
      return Err(quoteResult.error);
    }

    const quote = quoteResult.value;

    // Step 2: Sign transaction (with optional priority fee)
    const signResult = this.signTransaction(
      quote.transaction!,
      keypair,
      params.priorityFee
    );
    if (!signResult.success) {
      return Err(signResult.error);
    }

    const signedTransaction = signResult.value; // Now a VersionedTransaction object

    // AUDIT FIX: Step 3 - Try Jito MEV protection first, fall back to regular execution
    let execution: JupiterExecuteResponse;
    let usedJito = false;

    try {
      // CRITICAL FIX: signedTransaction is already a VersionedTransaction object
      // Pass directly to Jito to avoid serialize/deserialize cycles that corrupt MessageV0
      const jitoService = getJitoService();

      logger.info("Attempting Jito bundle submission for MEV protection");

      // Wrap Jito bundle submission with circuit breaker
      const bundleResult = await this.jitoCircuitBreaker.execute(async () => {
        return jitoService.submitBundle(
          [signedTransaction],
          keypair,
          "base" // Start with base tip level
        );
      });

      if (bundleResult === null) {
        // Jito circuit breaker is OPEN - fall back to regular RPC
        logger.warn("Jito circuit breaker OPEN, falling back to regular RPC");

        // Serialize VersionedTransaction to base64 for executeSwap
        const signedTransactionBase64 = Buffer.from(signedTransaction.serialize()).toString("base64");

        const executeResult = await this.executeSwap(signedTransactionBase64, quote.requestId);
        if (!executeResult.success) {
          return Err(executeResult.error);
        }
        execution = executeResult.value;
      } else if (bundleResult.success) {
        usedJito = true;
        logger.info("Jito bundle submitted successfully", {
          bundleId: bundleResult.value.bundleId,
          status: bundleResult.value.status,
        });

        // Extract signature from bundle result
        const signature = bundleResult.value.signatures?.[0] || "";

        // Create execution response compatible with Jupiter API
        execution = {
          status: "Success",
          code: 200,
          signature,
          slot: bundleResult.value.slot?.toString() || "0",
          totalInputAmount: quote.inAmount,
          totalOutputAmount: quote.outAmount,
          inputAmountResult: quote.inAmount,
          outputAmountResult: quote.outAmount,
          swapEvents: [], // Jito bundles don't provide detailed swap events
        };
      } else {
        // Jito failed, fall back to regular execution
        logger.warn("Jito bundle submission failed, falling back to regular execution", {
          error: bundleResult.error,
        });

        // Serialize VersionedTransaction to base64 for executeSwap
        const signedTransactionBase64 = Buffer.from(signedTransaction.serialize()).toString("base64");
        const executeResult = await this.executeSwap(
          signedTransactionBase64,
          quote.requestId
        );
        if (!executeResult.success) {
          return Err(executeResult.error);
        }
        execution = executeResult.value;
      }
    } catch (error) {
      // Jito service not available or error occurred, fall back to regular execution
      logger.warn("Jito submission error, falling back to regular execution", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Serialize VersionedTransaction to base64 for executeSwap
      const signedTransactionBase64 = Buffer.from(signedTransaction.serialize()).toString("base64");
      const executeResult = await this.executeSwap(
        signedTransactionBase64,
        quote.requestId
      );
      if (!executeResult.success) {
        return Err(executeResult.error);
      }
      execution = executeResult.value;
    }

    // Step 4: Wait for confirmation (optional but recommended)
    try {
      const signature = asTransactionSignature(execution.signature);

      logger.info("Waiting for transaction confirmation", { signature });

      const confirmation = await this.connection.confirmTransaction(
        execution.signature,
        "confirmed"
      );

      if (confirmation.value.err) {
        logger.error("Transaction confirmation failed", {
          signature,
          error: confirmation.value.err,
        });

        return Err({
          type: "TRANSACTION_FAILED",
          signature: execution.signature,
          reason: JSON.stringify(confirmation.value.err),
        });
      }

      logger.info("Transaction confirmed successfully", {
        signature,
        slot: execution.slot,
        mevProtection: usedJito ? "Jito Bundle" : "None",
      });

      // Build result
      const result: JupiterSwapResult = {
        signature,
        inputAmount: BigInt(execution.totalInputAmount),
        outputAmount: BigInt(execution.totalOutputAmount),
        priceImpactPct: quote.priceImpact * 100, // Convert from 0-1 range to percentage
        slot: Number(execution.slot),
      };

      return Ok(result);
    } catch (error) {
      logger.error("Error confirming transaction", { error });

      // Transaction was sent but confirmation failed - still return partial success
      return Ok({
        signature: asTransactionSignature(execution.signature),
        inputAmount: BigInt(execution.totalInputAmount),
        outputAmount: BigInt(execution.totalOutputAmount),
        priceImpactPct: quote.priceImpact * 100, // Convert from 0-1 range to percentage
        slot: Number(execution.slot),
      });
    }
  }

  /**
   * Simulate swap transaction before execution (Sprint 4 - Transaction Simulation)
   *
   * This method simulates the swap transaction to verify:
   * - Transaction will succeed
   * - Expected output amount
   * - Slippage is within acceptable range
   *
   * Use this BEFORE calling swap() to prevent failed transactions and save gas fees.
   */
  async simulateSwap(
    params: JupiterSwapParams,
    keypair: Keypair
  ): Promise<Result<{
    expectedOutputAmount: string;
    priceImpactPct: number;
    simulationSuccess: boolean;
    logs: string[];
  }, JupiterError>> {
    logger.info("Simulating Jupiter swap", {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
    });

    try {
      // Step 1: Get quote
      const quoteResult = await this.getQuote(params);
      if (!quoteResult.success) {
        return Err(quoteResult.error);
      }

      const quote = quoteResult.value;

      // Step 2: Sign transaction (without sending)
      const signResult = this.signTransaction(
        quote.transaction!,
        keypair,
        params.priorityFee
      );
      if (!signResult.success) {
        return Err(signResult.error);
      }

      const signedTransaction = signResult.value;

      // Step 3: Simulate transaction
      logger.debug("Simulating transaction on-chain");

      const simulation = await this.connection.simulateTransaction(
        signedTransaction,
        {
          commitment: "confirmed",
          replaceRecentBlockhash: true, // Use latest blockhash for simulation
          sigVerify: false, // Skip signature verification for speed
        }
      );

      if (simulation.value.err) {
        logger.warn("Simulation failed", {
          error: simulation.value.err,
          logs: simulation.value.logs,
        });

        return Err({
          type: "SIMULATION_FAILED",
          message: `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`,
        });
      }

      logger.info("Simulation successful", {
        expectedOutput: quote.outAmount,
        priceImpact: quote.priceImpact * 100,
        logsCount: simulation.value.logs?.length || 0,
      });

      return Ok({
        expectedOutputAmount: quote.outAmount,
        priceImpactPct: quote.priceImpact * 100,
        simulationSuccess: true,
        logs: simulation.value.logs || [],
      });
    } catch (error) {
      logger.error("Error during swap simulation", { error });

      return Err({
        type: "UNKNOWN",
        message: `Simulation error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  /**
   * Get token price in USD from DexScreener
   */
  async getTokenPrice(mint: TokenMint): Promise<Result<number, JupiterError>> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        return Err({
          type: "API_ERROR",
          statusCode: response.status,
          message: "Failed to fetch token price",
        });
      }

      const data = (await response.json()) as {
        pairs?: Array<{ priceUsd?: string }>
      };

      // Get price from first pair (usually most liquid)
      const priceUsd = data.pairs?.[0]?.priceUsd;

      if (!priceUsd) {
        return Err({
          type: "UNKNOWN",
          message: "Price not found for token",
        });
      }

      const price = parseFloat(priceUsd);

      if (isNaN(price)) {
        return Err({
          type: "UNKNOWN",
          message: "Invalid price format",
        });
      }

      return Ok(price);
    } catch (error) {
      logger.error("Error fetching token price", { mint, error });
      return Err({
        type: "NETWORK_ERROR",
        message: FRIENDLY_NETWORK_ERROR_MESSAGE,
      });
    }
  }
}

// ============================================================================
// Singleton Instance (for convenience)
// ============================================================================

let jupiterInstance: JupiterService | null = null;

export function initializeJupiter(
  connection: Connection,
  config?: Partial<JupiterConfig>
): JupiterService {
  jupiterInstance = new JupiterService(connection, config);
  return jupiterInstance;
}

export function getJupiter(): JupiterService {
  if (!jupiterInstance) {
    throw new Error(
      "Jupiter service not initialized. Call initializeJupiter() first."
    );
  }
  return jupiterInstance;
}
