/**
 * Transaction Simulation Layer for Honeypot Detection
 *
 * Responsibilities:
 * 1. Simulate buy transactions (SOL → Token)
 * 2. Simulate sell transactions (Token → SOL)
 * 3. Calculate taxes from Jupiter quotes
 * 4. Detect honeypots (buy succeeds, sell fails)
 * 5. Analyze top holders and concentration
 * 6. (Optional) Verify liquidity locks
 *
 * Performance Target: <3s total simulation time
 *
 * Integration:
 * - Uses JupiterService for quote generation
 * - Uses Solana simulateTransaction() for tx simulation
 * - Uses getProgramAccounts() for holder analysis
 * - Integrates with HoneypotDetector for multi-layer checks
 */

import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { JupiterService } from "../trading/jupiter.js";
import type {
  Result,
  TokenMint,
} from "../../types/common.js";
import { Ok, Err, asTokenMint } from "../../types/common.js";
import type {
  SimulationConfig,
  SimulationResult,
  SimulationLayerResult,
  HoneypotFlag,
} from "../../types/honeypot.js";
import type { JupiterQuoteResponse, JupiterError } from "../../types/jupiter.js";
import { logger } from "../../utils/logger.js";
import { createCircuitBreaker } from "../shared/circuitBreaker.js";
import type { CircuitBreaker } from "../shared/circuitBreaker.js";

// ============================================================================
// Constants
// ============================================================================

const SOL_MINT = "So11111111111111111111111111111111111111112";

const DEFAULT_CONFIG: SimulationConfig = {
  buyAmount: BigInt(100000000), // 0.1 SOL (100,000,000 lamports)
  timeout: 3000, // 3 seconds
  slippageBps: 50, // 0.5%
  skipHolderAnalysis: false,
};

// ============================================================================
// Simulation Service
// ============================================================================

/**
 * SimulationService provides transaction simulation for honeypot detection
 *
 * Uses Jupiter Ultra API for quotes and Solana RPC for simulation
 */
export class SimulationService {
  private rpcCircuitBreaker: CircuitBreaker;

  constructor(
    private connection: Connection,
    private jupiter: JupiterService
  ) {
    // Initialize circuit breaker for RPC calls
    this.rpcCircuitBreaker = createCircuitBreaker("simulation_rpc", {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 60000,
      monitoringPeriod: 120000,
    });

    logger.info("SimulationService initialized");
  }

  /**
   * Run full simulation for token
   *
   * @param tokenMint - Token to simulate
   * @param config - Simulation config (optional)
   * @returns Simulation result or error
   */
  async simulate(
    tokenMint: TokenMint,
    config: Partial<SimulationConfig> = {}
  ): Promise<Result<SimulationResult, string>> {
    const startTime = Date.now();
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    try {
      logger.debug("Starting token simulation", { tokenMint });

      // Validate timeout
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Simulation timeout")),
          finalConfig.timeout
        )
      );

      // Run simulation with timeout
      const result = await Promise.race([
        this.runSimulation(tokenMint, finalConfig),
        timeoutPromise,
      ]);

      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.error("Simulation failed", {
        tokenMint,
        elapsed,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Simulation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Convert simulation result to layer result for HoneypotDetector
   */
  toLayerResult(result: SimulationResult): SimulationLayerResult {
    const flags: HoneypotFlag[] = [];
    let score = 0;

    // Check if sell fails while buy succeeds
    if (result.canBuy && !result.canSell) {
      flags.push("SELL_SIMULATION_FAILED");
      score += 70; // Very high risk
    }

    // Check high sell tax
    if (result.sellTax > 50) {
      flags.push("HIGH_SELL_TAX");
      score += 40;
    }

    // Check centralized holders
    if (result.top10HoldersPct > 80) {
      flags.push("CENTRALIZED");
      score += 20;
    }

    // Check single holder majority
    if (result.developerHoldingsPct > 50) {
      flags.push("SINGLE_HOLDER_MAJORITY");
      score += 30;
    }

    // Check unlocked liquidity (if available)
    if (result.hasLiquidityLock === false) {
      flags.push("UNLOCKED_LIQUIDITY");
      score += 30;
    }

    return {
      canBuy: result.canBuy,
      canSell: result.canSell,
      buyTax: result.buyTax,
      sellTax: result.sellTax,
      buyPriceImpact: result.buyPriceImpact,
      sellPriceImpact: result.sellPriceImpact,
      top10HoldersPct: result.top10HoldersPct,
      developerHoldingsPct: result.developerHoldingsPct,
      totalHolders: result.totalHolders,
      score: Math.min(score, 100),
      flags,
      timeMs: result.simulationTimeMs,
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Run simulation workflow
   */
  private async runSimulation(
    tokenMint: TokenMint,
    config: SimulationConfig
  ): Promise<Result<SimulationResult, string>> {
    const startTime = Date.now();

    try {
      // Step 1: Get buy quote (SOL → Token)
      const buyQuoteResult = await this.getBuyQuote(
        tokenMint,
        config.buyAmount,
        config.slippageBps
      );

      if (!buyQuoteResult.success) {
        const error = buyQuoteResult as { success: false; error: string };
        return Err(`Buy quote failed: ${error.error}`);
      }

      const buyQuote = buyQuoteResult.value;

      // Calculate sell amount from buy quote output
      const sellAmount = config.sellAmount ?? BigInt(buyQuote.outAmount || "0");

      // Step 2: Get sell quote (Token → SOL)
      const sellQuoteResult = await this.getSellQuote(
        tokenMint,
        sellAmount,
        config.slippageBps
      );

      if (!sellQuoteResult.success) {
        const error = sellQuoteResult as { success: false; error: string };
        return Err(`Sell quote failed: ${error.error}`);
      }

      const sellQuote = sellQuoteResult.value;

      // Step 3, 4 & 6: Run simulations and holder analysis in parallel for maximum speed
      const [canBuy, canSell, holderResult] = await Promise.all([
        this.simulateBuy(buyQuote),
        this.simulateSell(sellQuote),
        !config.skipHolderAnalysis
          ? this.analyzeHolders(tokenMint)
          : Promise.resolve(
              Ok({
                top10HoldersPct: 0,
                developerHoldingsPct: 0,
                totalHolders: 0,
              })
            ),
      ]);

      // Step 5: Calculate taxes
      const buyTax = this.calculateTax(buyQuote);
      const sellTax = this.calculateTax(sellQuote);

      // Extract holder analysis results
      let holderAnalysis = {
        top10HoldersPct: 0,
        developerHoldingsPct: 0,
        totalHolders: 0,
      };

      if (holderResult.success) {
        holderAnalysis = holderResult.value;
      } else if (!config.skipHolderAnalysis) {
        logger.warn("Holder analysis failed, using defaults", {
          tokenMint,
        });
      }

      // Step 7: Detect honeypot
      let isHoneypot = false;
      let honeypotReason: string | undefined;

      if (canBuy && !canSell) {
        isHoneypot = true;
        honeypotReason = "Sell transaction fails while buy succeeds";
      } else if (sellTax > buyTax * 3) {
        isHoneypot = true;
        honeypotReason = `High sell tax: ${sellTax.toFixed(2)}% (buy: ${buyTax.toFixed(2)}%)`;
      } else if (holderAnalysis.top10HoldersPct > 90) {
        isHoneypot = true;
        honeypotReason = `Extreme holder concentration: ${holderAnalysis.top10HoldersPct.toFixed(1)}%`;
      }

      const elapsed = Date.now() - startTime;

      logger.info("Simulation completed", {
        tokenMint,
        canBuy,
        canSell,
        buyTax: buyTax.toFixed(2),
        sellTax: sellTax.toFixed(2),
        isHoneypot,
        top10HoldersPct: holderAnalysis.top10HoldersPct.toFixed(1),
        elapsed,
      });

      return Ok({
        canBuy,
        canSell,
        buyTax,
        sellTax,
        buyPriceImpact: buyQuote.priceImpact * 100, // Convert to percentage
        sellPriceImpact: sellQuote.priceImpact * 100,
        isHoneypot,
        honeypotReason,
        top10HoldersPct: holderAnalysis.top10HoldersPct,
        developerHoldingsPct: holderAnalysis.developerHoldingsPct,
        totalHolders: holderAnalysis.totalHolders,
        simulationTimeMs: elapsed,
      });
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.error("Simulation workflow error", {
        tokenMint,
        elapsed,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Simulation workflow failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get buy quote (SOL → Token)
   */
  private async getBuyQuote(
    tokenMint: TokenMint,
    amount: bigint,
    slippageBps: number
  ): Promise<Result<JupiterQuoteResponse, string>> {
    try {
      logger.debug("Getting buy quote", { tokenMint, amount: amount.toString() });

      // Use dummy user address for simulation (we don't need real signatures)
      const dummyUser = PublicKey.default.toString();

      const quoteResult = await this.jupiter.getQuote({
        inputMint: asTokenMint(SOL_MINT),
        outputMint: tokenMint,
        amount: amount.toString(),
        userPublicKey: dummyUser,
        slippageBps,
      });

      if (!quoteResult.success) {
        // Type assertion: we know quoteResult is the error case
        const errorResult = quoteResult as { success: false; error: JupiterError };
        const jupiterError = errorResult.error;
        let errorMsg: string;

        if (jupiterError.type === "NO_ROUTE") {
          errorMsg = "No route found for buy";
        } else if (jupiterError.type === "TRANSACTION_FAILED") {
          errorMsg = jupiterError.reason;
        } else {
          errorMsg = jupiterError.message;
        }

        return Err(errorMsg);
      }

      // Check if transaction field is available
      if (!quoteResult.value.transaction) {
        return Err("Jupiter quote missing transaction field");
      }

      logger.debug("Buy quote obtained", {
        inAmount: quoteResult.value.inAmount,
        outAmount: quoteResult.value.outAmount,
        priceImpact: quoteResult.value.priceImpact,
      });

      return Ok(quoteResult.value);
    } catch (error) {
      logger.error("Buy quote error", {
        tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
      return Err(
        `Buy quote failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get sell quote (Token → SOL)
   */
  private async getSellQuote(
    tokenMint: TokenMint,
    amount: bigint,
    slippageBps: number
  ): Promise<Result<JupiterQuoteResponse, string>> {
    try {
      logger.debug("Getting sell quote", { tokenMint, amount: amount.toString() });

      // Use dummy user address for simulation (we don't need real signatures)
      const dummyUser = PublicKey.default.toString();

      const quoteResult = await this.jupiter.getQuote({
        inputMint: tokenMint,
        outputMint: asTokenMint(SOL_MINT),
        amount: amount.toString(),
        userPublicKey: dummyUser,
        slippageBps,
      });

      if (!quoteResult.success) {
        // Type assertion: we know quoteResult is the error case
        const errorResult = quoteResult as { success: false; error: JupiterError };
        const jupiterError = errorResult.error;
        let errorMsg: string;

        if (jupiterError.type === "NO_ROUTE") {
          errorMsg = "No route found for sell";
        } else if (jupiterError.type === "TRANSACTION_FAILED") {
          errorMsg = jupiterError.reason;
        } else {
          errorMsg = jupiterError.message;
        }

        return Err(errorMsg);
      }

      // Check if transaction field is available
      if (!quoteResult.value.transaction) {
        return Err("Jupiter quote missing transaction field");
      }

      logger.debug("Sell quote obtained", {
        inAmount: quoteResult.value.inAmount,
        outAmount: quoteResult.value.outAmount,
        priceImpact: quoteResult.value.priceImpact,
      });

      return Ok(quoteResult.value);
    } catch (error) {
      logger.error("Sell quote error", {
        tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });
      return Err(
        `Sell quote failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Simulate buy transaction
   */
  private async simulateBuy(quote: JupiterQuoteResponse): Promise<boolean> {
    try {
      if (!quote.transaction) {
        logger.warn("Buy quote has no transaction to simulate");
        return false;
      }

      logger.debug("Simulating buy transaction");

      // Decode base64 transaction
      const txBuffer = Buffer.from(quote.transaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuffer);

      // Simulate transaction
      const simulation = await this.connection.simulateTransaction(tx, {
        sigVerify: false, // Don't verify signatures (we don't have real keys)
        replaceRecentBlockhash: true, // Use latest blockhash
        commitment: "confirmed",
      });

      const canBuy = simulation.value.err === null;

      logger.debug("Buy simulation result", {
        canBuy,
        err: simulation.value.err,
        logs: simulation.value.logs?.slice(0, 3), // First 3 logs
      });

      return canBuy;
    } catch (error) {
      logger.error("Buy simulation error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Simulate sell transaction
   */
  private async simulateSell(quote: JupiterQuoteResponse): Promise<boolean> {
    try {
      if (!quote.transaction) {
        logger.warn("Sell quote has no transaction to simulate");
        return false;
      }

      logger.debug("Simulating sell transaction");

      // Decode base64 transaction
      const txBuffer = Buffer.from(quote.transaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuffer);

      // Simulate transaction
      const simulation = await this.connection.simulateTransaction(tx, {
        sigVerify: false, // Don't verify signatures (we don't have real keys)
        replaceRecentBlockhash: true, // Use latest blockhash
        commitment: "confirmed",
      });

      const canSell = simulation.value.err === null;

      logger.debug("Sell simulation result", {
        canSell,
        err: simulation.value.err,
        logs: simulation.value.logs?.slice(0, 3), // First 3 logs
      });

      return canSell;
    } catch (error) {
      logger.error("Sell simulation error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Calculate tax from Jupiter quote
   *
   * Tax = (total fees / input amount) * 100
   *
   * @param quote - Jupiter quote response
   * @returns Tax percentage (0-100)
   */
  private calculateTax(quote: JupiterQuoteResponse): number {
    try {
      const inputAmount = BigInt(quote.inAmount);

      // Prevent division by zero
      if (inputAmount === BigInt(0)) {
        logger.warn("Input amount is zero, cannot calculate tax");
        return 0;
      }

      // Calculate total fees from routePlan
      let totalFees = BigInt(0);
      for (const step of quote.routePlan) {
        const feeAmount = BigInt(step.swapInfo.feeAmount);
        totalFees += feeAmount;
      }

      // Calculate tax percentage
      // taxBps = (totalFees / inputAmount) * 10000
      const taxBps = Number((totalFees * BigInt(10000)) / inputAmount);
      const taxPct = taxBps / 100; // Convert basis points to percentage

      logger.debug("Tax calculated", {
        inputAmount: inputAmount.toString(),
        totalFees: totalFees.toString(),
        taxBps,
        taxPct: taxPct.toFixed(2),
      });

      return taxPct;
    } catch (error) {
      logger.error("Tax calculation error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Analyze token holders
   *
   * Uses getTokenLargestAccounts() to get top holders (fast)
   * and getMint() to get total supply
   *
   * Calculates:
   * - Top 10 holders percentage
   * - Developer holdings percentage (top holder)
   * - Total number of holders (approximate from largest accounts)
   *
   * @param tokenMint - Token mint address
   * @returns Holder analysis or error
   */
  private async analyzeHolders(
    tokenMint: TokenMint
  ): Promise<
    Result<
      {
        top10HoldersPct: number;
        developerHoldingsPct: number;
        totalHolders: number;
      },
      string
    >
  > {
    try {
      logger.debug("Analyzing token holders", { tokenMint });

      const mintPublicKey = new PublicKey(tokenMint);

      // Get top 20 largest token accounts (fast!) - wrapped with circuit breaker
      const largestAccounts = await this.rpcCircuitBreaker.execute(async () => {
        return this.connection.getTokenLargestAccounts(mintPublicKey);
      });

      if (largestAccounts === null) {
        // Circuit breaker is OPEN - fallback to conservative assumptions
        logger.warn("RPC circuit breaker OPEN for holder analysis, using conservative fallback");
        return Ok({
          top10HoldersPct: 100, // Assume worst case
          developerHoldingsPct: 100, // Assume worst case
          totalHolders: 0,
        });
      }

      if (largestAccounts.value.length === 0) {
        logger.warn("No token accounts found", { tokenMint });
        return Ok({
          top10HoldersPct: 0,
          developerHoldingsPct: 0,
          totalHolders: 0,
        });
      }

      // Get mint info to get total supply - wrapped with circuit breaker
      const mintInfo = await this.rpcCircuitBreaker.execute(async () => {
        return this.connection.getParsedAccountInfo(mintPublicKey);
      });

      if (mintInfo === null) {
        // Circuit breaker is OPEN - fallback to conservative assumptions
        logger.warn("RPC circuit breaker OPEN for mint info, using conservative fallback");
        return Ok({
          top10HoldersPct: 100, // Assume worst case
          developerHoldingsPct: 100, // Assume worst case
          totalHolders: largestAccounts.value.length,
        });
      }

      if (!mintInfo.value || !mintInfo.value.data) {
        logger.warn("Mint account not found", { tokenMint });
        return Err("Mint account not found");
      }

      const data = mintInfo.value.data;
      if (!("parsed" in data) || data.parsed.type !== "mint") {
        logger.warn("Invalid mint account", { tokenMint });
        return Err("Invalid mint account");
      }

      const totalSupply = Number(data.parsed.info.supply);
      const decimals = data.parsed.info.decimals;

      if (totalSupply === 0) {
        logger.warn("Total supply is zero", { tokenMint });
        return Ok({
          top10HoldersPct: 0,
          developerHoldingsPct: 0,
          totalHolders: largestAccounts.value.length,
        });
      }

      // Calculate top 10 holders percentage
      const top10 = largestAccounts.value.slice(0, 10);
      const top10Supply = top10.reduce(
        (sum, acc) => sum + Number(acc.amount),
        0
      );
      const top10HoldersPct = (top10Supply / totalSupply) * 100;

      // Calculate developer holdings (top holder)
      const developerHoldings = Number(largestAccounts.value[0].amount);
      const developerHoldingsPct = (developerHoldings / totalSupply) * 100;

      // Convert to UI amounts for logging
      const top3UiAmounts = top10
        .slice(0, 3)
        .map((acc) => Number(acc.amount) / Math.pow(10, decimals));

      logger.info("Holder analysis completed", {
        tokenMint,
        totalHolders: largestAccounts.value.length,
        top10HoldersPct: top10HoldersPct.toFixed(2),
        developerHoldingsPct: developerHoldingsPct.toFixed(2),
        top3Balances: top3UiAmounts,
      });

      return Ok({
        top10HoldersPct,
        developerHoldingsPct,
        totalHolders: largestAccounts.value.length,
      });
    } catch (error) {
      logger.error("Holder analysis error", {
        tokenMint,
        error: error instanceof Error ? error.message : String(error),
      });

      return Err(
        `Holder analysis failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let simulationServiceInstance: SimulationService | null = null;

export function initializeSimulationService(
  connection: Connection,
  jupiter: JupiterService
): SimulationService {
  if (simulationServiceInstance) {
    logger.warn(
      "SimulationService already initialized, returning existing instance"
    );
    return simulationServiceInstance;
  }

  simulationServiceInstance = new SimulationService(connection, jupiter);
  logger.info("SimulationService singleton initialized");

  return simulationServiceInstance;
}

export function getSimulationService(): SimulationService {
  if (!simulationServiceInstance) {
    throw new Error(
      "SimulationService not initialized. Call initializeSimulationService() first"
    );
  }

  return simulationServiceInstance;
}
