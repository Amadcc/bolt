/**
 * Liquidity Lock Checker Service
 *
 * Detects and verifies liquidity locks on Solana.
 * Supports multiple providers: UNCX, GUACamole, Team Finance, and burn addresses.
 *
 * Detection methods:
 * 1. Check LP token holders - look for known lock program addresses
 * 2. Check burn addresses - LP tokens sent to invalid/burn addresses
 * 3. Query GUACamole API for lock details (optional)
 *
 * @see https://docs.uncx.network/guides/for-projects/solana-lockers
 * @see https://docs.guacamole.gg/products-and-features/launch/liquidity-lockers
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { getRedisClient } from "../../utils/redis.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";
import type { SolanaAddress, TokenMint } from "../../types/common.js";
import type {
  LiquidityLockResult,
  LockDetails,
  LockProvider,
  LockCheckOptions,
  LockServiceConfig,
  GuacamoleVault,
} from "../../types/liquidityLock.js";
import { LOCK_PROGRAM_IDS, BURN_ADDRESSES } from "../../types/liquidityLock.js";
import { createCircuitBreaker } from "../shared/circuitBreaker.js";

// ============================================================================
// Service Class
// ============================================================================

export class LiquidityLockChecker {
  private readonly connection: Connection;
  private readonly config: LockServiceConfig;
  private readonly circuitBreaker;
  private readonly redis;

  constructor(connection: Connection, config?: Partial<LockServiceConfig>) {
    this.connection = connection;
    this.config = {
      enableGuacamoleApi: true,
      guacamoleApiUrl: "https://locker-info.guacamole.gg/vaults",
      cacheTtl: 300, // 5 minutes
      enableCache: true,
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeout: 60000, // 1 minute
      },
      ...config,
    };

    this.circuitBreaker = createCircuitBreaker("liquidity_lock_checker", {
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      successThreshold: 2,
      timeout: this.config.circuitBreaker.resetTimeout,
      monitoringPeriod: 120000, // 2 minutes
    });

    this.redis = getRedisClient();
  }

  /**
   * Check if liquidity is locked for an LP token
   */
  async checkLock(options: LockCheckOptions): Promise<Result<LiquidityLockResult, string>> {
    const startTime = Date.now();

    try {
      // Check cache first
      if (this.config.enableCache) {
        const cached = await this.getFromCache(options.lpMint);
        if (cached) {
          logger.debug("Liquidity lock check - cache hit", {
            lpMint: options.lpMint,
            isLocked: cached.isLocked,
            lockedPercentage: cached.lockedPercentage,
          });
          return Ok(cached);
        }
      }

      // Get LP token supply
      const totalSupplyResult = await this.getTotalSupply(options.lpMint);
      if (!totalSupplyResult.success) {
        return Err(totalSupplyResult.error);
      }
      const totalLpTokens = totalSupplyResult.value;

      // Find all locks
      const locks: LockDetails[] = [];

      // 1. Check known lock programs (UNCX, etc.)
      const programLocksResult = await this.checkLockPrograms(options.lpMint);
      if (programLocksResult.success) {
        locks.push(...programLocksResult.value);
      } else {
        logger.warn("Failed to check lock programs", {
          lpMint: options.lpMint,
          error: programLocksResult.error,
        });
      }

      // 2. Check burn addresses
      const burnedLocksResult = await this.checkBurnAddresses(options.lpMint);
      if (burnedLocksResult.success) {
        locks.push(...burnedLocksResult.value);
      } else {
        logger.warn("Failed to check burn addresses", {
          lpMint: options.lpMint,
          error: burnedLocksResult.error,
        });
      }

      // 3. Check GUACamole API (optional)
      if (options.useGuacamoleApi !== false && this.config.enableGuacamoleApi) {
        const guacLocksResult = await this.checkGuacamoleApi(options.lpMint);
        if (guacLocksResult.success) {
          locks.push(...guacLocksResult.value);
        } else {
          logger.warn("Failed to check GUACamole API", {
            lpMint: options.lpMint,
            error: guacLocksResult.error,
          });
        }
      }

      // Calculate total locked tokens
      const lockedLpTokens = locks.reduce((sum, lock) => sum + lock.amount, 0n);
      const lockedPercentage =
        totalLpTokens > 0n ? Number((lockedLpTokens * 100n) / totalLpTokens) : 0;

      const result: LiquidityLockResult = {
        isLocked: lockedPercentage > 0,
        lockedPercentage,
        totalLpTokens,
        lockedLpTokens,
        locks,
        checkedAt: new Date(),
      };

      // Cache result
      if (this.config.enableCache) {
        await this.saveToCache(options.lpMint, result);
      }

      const duration = Date.now() - startTime;
      logger.info("Liquidity lock check completed", {
        lpMint: options.lpMint,
        isLocked: result.isLocked,
        lockedPercentage: result.lockedPercentage,
        lockCount: locks.length,
        durationMs: duration,
      });

      return Ok(result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Liquidity lock check failed", {
        lpMint: options.lpMint,
        error: errorMsg,
      });
      return Err(errorMsg);
    }
  }

  // ==========================================================================
  // Private Methods - Lock Detection
  // ==========================================================================

  /**
   * Get total supply of LP token
   */
  private async getTotalSupply(lpMint: TokenMint): Promise<Result<bigint, string>> {
    try {
      const result = await this.circuitBreaker.execute(async () => {
        const mintPubkey = new PublicKey(lpMint);
        const supply = await this.connection.getTokenSupply(mintPubkey);
        return supply.value.amount;
      });

      if (result === null) {
        return Err("Failed to get LP token supply: Circuit breaker OPEN");
      }

      return Ok(BigInt(result));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return Err(`Failed to get LP token supply: ${errorMsg}`);
    }
  }

  /**
   * Check known lock programs for LP tokens
   */
  private async checkLockPrograms(lpMint: TokenMint): Promise<Result<LockDetails[], string>> {
    const locks: LockDetails[] = [];

    try {
      await this.circuitBreaker.execute(async () => {
        const mintPubkey = new PublicKey(lpMint);

        // Get all token accounts for this LP mint
        const accounts = await this.connection.getTokenLargestAccounts(mintPubkey);

        for (const account of accounts.value) {
          // Get account info to check owner
          const accountInfo = await this.connection.getParsedAccountInfo(account.address);

          if (
            !accountInfo.value ||
            !("parsed" in accountInfo.value.data) ||
            accountInfo.value.data.program !== "spl-token"
          ) {
            continue;
          }

          const parsedInfo = accountInfo.value.data.parsed.info;
          const owner = parsedInfo.owner as string;
          const amount = BigInt(parsedInfo.tokenAmount.amount);

          // Check if owner is a known lock program
          const provider = this.identifyLockProvider(owner as SolanaAddress);

          if (provider !== "UNKNOWN") {
            locks.push({
              provider,
              amount,
              lockerAddress: account.address.toBase58() as SolanaAddress,
              unlockTime: null, // Would need to fetch from program state
            });

            logger.debug("Found lock program holding LP tokens", {
              lpMint,
              provider,
              amount: amount.toString(),
              locker: account.address.toBase58(),
            });
          }
        }
      });

      return Ok(locks);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return Err(`Failed to check lock programs: ${errorMsg}`);
    }
  }

  /**
   * Check if LP tokens are in burn addresses
   */
  private async checkBurnAddresses(lpMint: TokenMint): Promise<Result<LockDetails[], string>> {
    const locks: LockDetails[] = [];

    try {
      await this.circuitBreaker.execute(async () => {
        const mintPubkey = new PublicKey(lpMint);

        for (const burnAddress of BURN_ADDRESSES) {
          try {
            const burnPubkey = new PublicKey(burnAddress);

            // Get associated token account for burn address
            const { getAssociatedTokenAddress } = await import("@solana/spl-token");
            const ata = await getAssociatedTokenAddress(mintPubkey, burnPubkey);

            const balance = await this.connection.getTokenAccountBalance(ata);

            if (balance.value.uiAmount && balance.value.uiAmount > 0) {
              const amount = BigInt(balance.value.amount);

              locks.push({
                provider: "BURNED",
                amount,
                lockerAddress: ata.toBase58() as SolanaAddress,
                unlockTime: null, // Burned tokens are permanently locked
              });

              logger.debug("Found burned LP tokens", {
                lpMint,
                burnAddress,
                amount: amount.toString(),
              });
            }
          } catch (error) {
            // Account might not exist, which is fine
            logger.debug("Burn address has no LP tokens", {
              lpMint,
              burnAddress,
            });
          }
        }
      });

      return Ok(locks);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return Err(`Failed to check burn addresses: ${errorMsg}`);
    }
  }

  /**
   * Check GUACamole API for lock information
   */
  private async checkGuacamoleApi(lpMint: TokenMint): Promise<Result<LockDetails[], string>> {
    try {
      const response = await fetch(this.config.guacamoleApiUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        return Err(`GUACamole API returned ${response.status}`);
      }

      const vaults = (await response.json()) as GuacamoleVault[];

      // Filter vaults for this LP mint
      const matchingVaults = vaults.filter((v) => v.mint === lpMint);

      const locks: LockDetails[] = matchingVaults.map((vault) => ({
        provider: "GUACAMOLE",
        amount: BigInt(Math.floor(vault.lockedLiquidityLP)),
        lockerAddress: vault.lockerId as SolanaAddress,
        unlockTime: new Date(vault.unlockTime),
        valueUsd: vault.lockedLiquidityUSD,
        poolAddress: vault.poolId as SolanaAddress,
      }));

      if (locks.length > 0) {
        logger.debug("Found GUACamole locks", {
          lpMint,
          lockCount: locks.length,
          totalUsd: locks.reduce((sum, l) => sum + (l.valueUsd || 0), 0),
        });
      }

      return Ok(locks);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return Err(`GUACamole API error: ${errorMsg}`);
    }
  }

  // ==========================================================================
  // Private Methods - Helpers
  // ==========================================================================

  /**
   * Identify lock provider by program address
   */
  private identifyLockProvider(address: SolanaAddress): LockProvider {
    for (const [provider, programId] of Object.entries(LOCK_PROGRAM_IDS)) {
      if (programId === address) {
        return provider as LockProvider;
      }
    }
    return "UNKNOWN";
  }

  /**
   * Get cached lock result
   */
  private async getFromCache(
    lpMint: TokenMint
  ): Promise<LiquidityLockResult | null> {
    try {
      const key = `liquidity-lock:${lpMint}`;
      const cached = await this.redis.get(key);

      if (!cached) {
        return null;
      }

      const parsed = JSON.parse(cached) as LiquidityLockResult;

      // Convert string dates back to Date objects
      parsed.checkedAt = new Date(parsed.checkedAt);
      parsed.locks = parsed.locks.map((lock) => ({
        ...lock,
        amount: BigInt(lock.amount.toString()),
        unlockTime: lock.unlockTime ? new Date(lock.unlockTime) : null,
      }));

      // Convert string bigints back to bigint
      parsed.totalLpTokens = BigInt(parsed.totalLpTokens.toString());
      parsed.lockedLpTokens = BigInt(parsed.lockedLpTokens.toString());

      return parsed;
    } catch (error) {
      logger.warn("Failed to get liquidity lock from cache", {
        lpMint,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Save lock result to cache
   */
  private async saveToCache(
    lpMint: TokenMint,
    result: LiquidityLockResult
  ): Promise<void> {
    try {
      const key = `liquidity-lock:${lpMint}`;

      // Convert bigints to strings for JSON serialization
      const serializable = {
        ...result,
        totalLpTokens: result.totalLpTokens.toString(),
        lockedLpTokens: result.lockedLpTokens.toString(),
        locks: result.locks.map((lock) => ({
          ...lock,
          amount: lock.amount.toString(),
        })),
      };

      await this.redis.setex(
        key,
        this.config.cacheTtl,
        JSON.stringify(serializable)
      );
    } catch (error) {
      logger.warn("Failed to cache liquidity lock result", {
        lpMint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let lockCheckerInstance: LiquidityLockChecker | null = null;

export function getLiquidityLockChecker(
  connection?: Connection,
  config?: Partial<LockServiceConfig>
): LiquidityLockChecker {
  if (!lockCheckerInstance) {
    if (!connection) {
      throw new Error("Connection required for first initialization");
    }
    lockCheckerInstance = new LiquidityLockChecker(connection, config);
  }
  return lockCheckerInstance;
}
