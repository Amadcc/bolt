/**
 * Fallback Chain Orchestrator
 *
 * Manages multiple API providers with priority-based fallback:
 * 1. GoPlus API (fastest, priority 1)
 * 2. RugCheck API (Solana-specific, priority 2)
 * 3. TokenSniffer API (comprehensive, priority 3)
 *
 * Features:
 * - Automatic fallback on provider failure
 * - Circuit breaker per provider
 * - Metrics tracking
 * - Configurable priority order
 */

import { logger } from "../../utils/logger.js";
import { recordHoneypotFallbackChain } from "../../utils/metrics.js";
import { GoPlusProvider } from "./providers/GoPlusProvider.js";
import { RugCheckProvider } from "./providers/RugCheckProvider.js";
import { TokenSnifferProvider } from "./providers/TokenSnifferProvider.js";
import type {
  APIProvider,
  APILayerResult,
  HoneypotDetectorConfig,
} from "../../types/honeypot.js";

// ============================================================================
// Fallback Chain Configuration
// ============================================================================

const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60000,
  monitoringPeriod: 120000,
};

// ============================================================================
// Fallback Chain Orchestrator
// ============================================================================

export class FallbackChain {
  private providers: APIProvider[] = [];

  constructor(private readonly config: HoneypotDetectorConfig) {
    this.initializeProviders();
  }

  /**
   * Execute fallback chain
   * Try providers in priority order until one succeeds
   */
  async execute(tokenMint: string): Promise<APILayerResult | null> {
    const startTime = Date.now();
    const availableProviders = this.getAvailableProviders();
    const aggregatedResults: Array<{
      provider: APIProvider;
      result: APILayerResult;
    }> = [];

    if (availableProviders.length === 0) {
      logger.warn("No API providers available", {
        tokenMint: tokenMint.slice(0, 8),
      });
      recordHoneypotFallbackChain("none", 0);
      return null;
    }

    logger.debug("Starting fallback chain", {
      tokenMint: tokenMint.slice(0, 8),
      availableProviders: availableProviders.map((p) => p.name),
      maxProviders: this.config.fallbackChain.maxProviders,
    });

    let attempts = 0;
    const maxProviders = Math.min(
      this.config.fallbackChain.maxProviders,
      availableProviders.length
    );

    // Try each provider in priority order
    for (const provider of availableProviders) {
      if (attempts >= maxProviders) {
        logger.debug("Reached max provider attempts", {
          tokenMint: tokenMint.slice(0, 8),
          attempts,
          maxProviders,
        });
        break;
      }

      attempts++;

      logger.debug("Trying provider", {
        tokenMint: tokenMint.slice(0, 8),
        provider: provider.name,
        attempt: attempts,
        priority: provider.priority,
      });

      try {
        const result = await provider.check(tokenMint);

        if (result !== null) {
          const duration = Date.now() - startTime;

          logger.info("Fallback chain succeeded", {
            tokenMint: tokenMint.slice(0, 8),
            provider: provider.name,
            attempts,
            score: result.score,
            flags: result.flags,
            totalDurationMs: duration,
          });

          if (this.config.fallbackChain.stopOnFirstSuccess) {
            recordHoneypotFallbackChain(provider.name, attempts);
            return result;
          }

          aggregatedResults.push({ provider, result });
          continue;
        }

        // Provider returned null (circuit breaker open or other issue)
        logger.debug("Provider returned null, trying next", {
          tokenMint: tokenMint.slice(0, 8),
          provider: provider.name,
        });
      } catch (error) {
        logger.warn("Provider check failed, trying next", {
          tokenMint: tokenMint.slice(0, 8),
          provider: provider.name,
          error,
        });

        // If stopOnFirstSuccess is false, continue to next provider
        // If true, we already returned above on success
      }

      // If stopOnFirstSuccess is false and we have a result, we could aggregate
      // For now, we stop on first success as per config default
    }

    if (aggregatedResults.length > 0) {
      const duration = Date.now() - startTime;
      const winning = aggregatedResults.reduce((best, current) =>
        current.result.score > best.result.score ? current : best
      );

      logger.info("Fallback chain aggregated result", {
        tokenMint: tokenMint.slice(0, 8),
        attempts,
        durationMs: duration,
        providersTried: aggregatedResults.map((entry) => entry.provider.name),
        selectedProvider: winning.provider.name,
        selectedScore: winning.result.score,
      });

      recordHoneypotFallbackChain("aggregate", attempts);
      return winning.result;
    }

    // All providers failed
    const duration = Date.now() - startTime;
    logger.warn("Fallback chain exhausted, all providers failed", {
      tokenMint: tokenMint.slice(0, 8),
      attempts,
      durationMs: duration,
    });

    recordHoneypotFallbackChain("none", attempts);
    return null;
  }

  /**
   * Get all enabled and available providers, sorted by priority
   */
  getAvailableProviders(): APIProvider[] {
    return this.providers
      .filter((provider) => provider.isAvailable())
      .sort((a, b) => a.priority - b.priority); // Lower priority number = higher priority
  }

  /**
   * Get all providers (for status checking)
   */
  getAllProviders(): APIProvider[] {
    return [...this.providers];
  }

  /**
   * Get provider by name
   */
  getProvider(name: string): APIProvider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  /**
   * Reset all providers (for testing/admin)
   */
  resetAll(): void {
    logger.info("Resetting all providers");
    for (const provider of this.providers) {
      provider.reset();
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Initialize all configured providers
   */
  private initializeProviders(): void {
    logger.info("Initializing API providers", {
      fallbackEnabled: this.config.fallbackChain.enabled,
      maxProviders: this.config.fallbackChain.maxProviders,
    });

    // GoPlus Provider
    if (this.config.providers.goplus.enabled) {
      const goplus = new GoPlusProvider({
        ...this.config.providers.goplus,
        circuitBreaker:
          this.config.providers.goplus.circuitBreaker ||
          DEFAULT_CIRCUIT_BREAKER_CONFIG,
      });
      this.providers.push(goplus);
      logger.info("GoPlus provider initialized", {
        priority: goplus.priority,
      });
    }

    // RugCheck Provider
    if (this.config.providers.rugcheck.enabled) {
      const rugcheck = new RugCheckProvider({
        ...this.config.providers.rugcheck,
        circuitBreaker:
          this.config.providers.rugcheck.circuitBreaker ||
          DEFAULT_CIRCUIT_BREAKER_CONFIG,
      });
      this.providers.push(rugcheck);
      logger.info("RugCheck provider initialized", {
        priority: rugcheck.priority,
      });
    }

    // TokenSniffer Provider
    if (this.config.providers.tokensniffer.enabled) {
      const tokensniffer = new TokenSnifferProvider({
        ...this.config.providers.tokensniffer,
        circuitBreaker:
          this.config.providers.tokensniffer.circuitBreaker ||
          DEFAULT_CIRCUIT_BREAKER_CONFIG,
      });
      this.providers.push(tokensniffer);
      logger.info("TokenSniffer provider initialized", {
        priority: tokensniffer.priority,
      });
    }

    // Sort by priority
    this.providers.sort((a, b) => a.priority - b.priority);

    logger.info("Fallback chain initialized", {
      providersCount: this.providers.length,
      providers: this.providers.map((p) => ({
        name: p.name,
        priority: p.priority,
      })),
    });
  }
}
