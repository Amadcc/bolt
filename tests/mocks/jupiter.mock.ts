/**
 * Mock Jupiter Service for Deterministic Testing
 *
 * Provides predictable Jupiter API responses without external dependencies.
 * Supports configuration for failure scenarios and latency simulation.
 */

import type { Result } from "../../src/types/common";
import { Ok, Err, asLamports, asTokenMint } from "../../src/types/common";
import type { JupiterQuote, JupiterSwapParams } from "../../src/types/jupiter";
import type { TransactionSignature } from "../../src/types/common";

export interface MockJupiterConfig {
  /** Simulate API failures */
  shouldFail: boolean;

  /** Simulate network latency (ms) */
  latency: number;

  /** Mock exchange rate (output/input ratio) */
  exchangeRate: number;

  /** Mock price impact percentage */
  priceImpact: number;
}

const DEFAULT_CONFIG: MockJupiterConfig = {
  shouldFail: false,
  latency: 0,
  exchangeRate: 1000, // 1000x return (generous for testing)
  priceImpact: 0.5, // 0.5% price impact
};

export class MockJupiterService {
  private config: MockJupiterConfig = { ...DEFAULT_CONFIG };
  private priceCache = new Map<string, number>();

  /**
   * Configure mock behavior
   */
  configure(options: Partial<MockJupiterConfig>): void {
    this.config = { ...this.config, ...options };
  }

  /**
   * Reset to default configuration
   */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.priceCache.clear();
  }

  /**
   * Set mock price for specific token
   */
  setPrice(tokenMint: string, priceInSol: number): void {
    this.priceCache.set(tokenMint, priceInSol);
  }

  /**
   * Get quote from Jupiter (mocked)
   */
  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<Result<JupiterQuote, string>> {
    // Simulate latency
    if (this.config.latency > 0) {
      await this.sleep(this.config.latency);
    }

    // Simulate failure
    if (this.config.shouldFail) {
      return Err("Mock Jupiter API failure (configured)");
    }

    // Calculate output amount based on exchange rate
    const outAmount = params.amount * BigInt(Math.floor(this.config.exchangeRate));

    // Calculate slippage threshold
    const slippageMultiplier = 1 - params.slippageBps / 10000;
    const otherAmountThreshold = BigInt(
      Math.floor(Number(outAmount) * slippageMultiplier)
    );

    const mockQuote: JupiterQuote = {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amount.toString(),
      outAmount: outAmount.toString(),
      otherAmountThreshold: otherAmountThreshold.toString(),
      swapMode: "ExactIn",
      slippageBps: params.slippageBps,
      priceImpactPct: this.config.priceImpact,
      routePlan: [
        {
          swapInfo: {
            ammKey: "mockAMM",
            label: "Mock DEX",
            inputMint: params.inputMint,
            outputMint: params.outputMint,
            inAmount: params.amount.toString(),
            outAmount: outAmount.toString(),
            feeAmount: "0",
            feeMint: params.inputMint,
          },
          percent: 100,
        },
      ],
    };

    return Ok(mockQuote);
  }

  /**
   * Get token price (mocked)
   */
  async getTokenPrice(tokenMint: string): Promise<Result<number, string>> {
    // Simulate latency
    if (this.config.latency > 0) {
      await this.sleep(this.config.latency);
    }

    // Simulate failure
    if (this.config.shouldFail) {
      return Err("Mock price API failure (configured)");
    }

    // Check if price is cached
    const cachedPrice = this.priceCache.get(tokenMint);
    if (cachedPrice !== undefined) {
      return Ok(cachedPrice);
    }

    // Return mock price based on token mint (deterministic)
    const mockPrice = this.generateMockPrice(tokenMint);
    return Ok(mockPrice);
  }

  /**
   * Execute swap (mocked)
   */
  async executeSwap(
    params: JupiterSwapParams
  ): Promise<Result<TransactionSignature, string>> {
    // Simulate latency
    if (this.config.latency > 0) {
      await this.sleep(this.config.latency);
    }

    // Simulate failure
    if (this.config.shouldFail) {
      return Err("Mock swap execution failure (configured)");
    }

    // Generate mock transaction signature
    const mockSignature = this.generateMockSignature();
    return Ok(mockSignature as TransactionSignature);
  }

  // ========================================================================
  // Private Helpers
  // ========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Generate deterministic mock price based on token mint
   */
  private generateMockPrice(tokenMint: string): number {
    // Hash token mint to get deterministic price
    let hash = 0;
    for (let i = 0; i < tokenMint.length; i++) {
      hash = (hash << 5) - hash + tokenMint.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Map hash to price range (0.0001 to 1 SOL)
    const normalized = Math.abs(hash % 10000) / 10000;
    const price = 0.0001 + normalized * 0.9999;

    return price;
  }

  /**
   * Generate mock transaction signature
   */
  private generateMockSignature(): string {
    const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let signature = "";

    for (let i = 0; i < 88; i++) {
      signature += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return signature;
  }
}

/**
 * Create mock Jupiter instance for testing
 */
export function createMockJupiter(): MockJupiterService {
  return new MockJupiterService();
}

/**
 * Common test scenarios
 */
export const JupiterTestScenarios = {
  /** Normal operation */
  normal: {
    shouldFail: false,
    latency: 0,
    exchangeRate: 1000,
    priceImpact: 0.5,
  },

  /** Slow API response */
  slow: {
    shouldFail: false,
    latency: 2000, // 2s
    exchangeRate: 1000,
    priceImpact: 0.5,
  },

  /** API failure */
  failure: {
    shouldFail: true,
    latency: 0,
    exchangeRate: 1000,
    priceImpact: 0.5,
  },

  /** High price impact */
  highImpact: {
    shouldFail: false,
    latency: 0,
    exchangeRate: 900, // Less favorable rate
    priceImpact: 5.0, // 5% impact
  },

  /** Low liquidity */
  lowLiquidity: {
    shouldFail: false,
    latency: 0,
    exchangeRate: 500, // Much worse rate
    priceImpact: 10.0, // 10% impact
  },
};
