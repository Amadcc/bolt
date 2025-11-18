/**
 * Jito MEV Protection Service
 *
 * Provides bundle submission to Jito Block Engine for atomic transaction execution
 * and protection against sandwich attacks.
 *
 * Features:
 * - Bundle creation with tip transaction
 * - Bundle submission to Jito Block Engine
 * - Bundle status tracking
 * - Automatic tip calculation
 * - Fallback to regular submission on failure
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import axios, { type AxiosInstance, type AxiosError } from "axios";
import { webcrypto, createHash } from "crypto";
import { logger } from "../../utils/logger.js";
import type { Result } from "../../types/common.js";
import { Ok, Err, asTransactionSignature } from "../../types/common.js";
import type {
  JitoConfig,
  BundleResult,
  JitoError,
  TipLevel,
  TipConfiguration,
  JitoRpcResponse,
  BundleStatusResponse,
  InflightBundleStatusResponse,
  SmartRoutingOptions,
  SmartRoutingResult,
} from "../../types/jito.js";
// AUDIT FIX: Import SolanaService for RPCPool integration
import type { SolanaService } from "../blockchain/solana.js";
// DAY 8: Import metrics for smart routing
import {
  recordJitoBundleSubmission,
  recordJitoBundleSuccess,
  recordJitoBundleFailure,
  recordJitoTip,
  recordSmartRoutingWinner,
  recordAntiSandwich,
  recordJitoRpcFallback,
} from "../../utils/metrics.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Official Jito tip accounts (8 validators)
 * Source: https://jito-labs.gitbook.io/mev/searcher-resources/bundles
 *
 * CRITICAL: Tip instruction MUST be in the LAST transaction of the bundle
 * to prevent tip theft during blockchain forks.
 */
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

/**
 * DAY 8: Anti-sandwich protection account
 * Source: https://www.jito.network/blog/jito-bundles-101-a-step-by-step-guide-on-how-to-use-jito-bundles/
 *
 * Adding this account as a read-only account prevents the transaction from being
 * included in the public mempool, protecting against sandwich attacks from other MEV bots.
 *
 * NOTE: This account is specifically for mainnet-beta. Do NOT use on devnet/testnet.
 */
const JITO_DONT_FRONT_ADDRESS = new PublicKey(
  "DittoGuaQBso9A4UbUjH2c6D7w6LKkKSkYSdg87fBjPB"
);

// AUDIT FIX: Multiple Block Engine endpoints for failover
const DEFAULT_BLOCK_ENGINE_URLS = [
  "https://mainnet.block-engine.jito.wtf", // Primary
  "https://amsterdam.mainnet.block-engine.jito.wtf", // Amsterdam
  "https://frankfurt.mainnet.block-engine.jito.wtf", // Frankfurt
  "https://ny.mainnet.block-engine.jito.wtf", // New York
  "https://tokyo.mainnet.block-engine.jito.wtf", // Tokyo
];

const DEFAULT_CONFIG: JitoConfig = {
  blockEngineUrls: DEFAULT_BLOCK_ENGINE_URLS,
  timeout: 10000, // 10 seconds
  confirmationTimeout: 30000, // 30 seconds
  tipLamports: BigInt(100_000), // 0.0001 SOL (base tip)
  enabled: true,
};

// Security limits (production-grade constraints)
const MAX_TIP_LAMPORTS = BigInt(100_000_000); // 0.1 SOL - safety limit
const MIN_TIP_LAMPORTS = BigInt(1_000); // 1000 lamports - Jito minimum
const MAX_BUNDLE_SIZE_BYTES = 1232 * 5; // Solana limit: 1232 bytes per tx
const BUNDLE_DEDUPLICATION_TTL = 60_000; // 1 minute cache for replay protection

// ============================================================================
// Jito Service Class
// ============================================================================

export class JitoService {
  private config: JitoConfig;
  private requestId = 0;
  // AUDIT FIX: Use SolanaService instead of Connection for RPCPool integration
  private solanaService: SolanaService;

  // P1 SECURITY: Bundle deduplication cache for replay protection
  private bundleCache: Map<string, number> = new Map(); // hash -> timestamp

  // AUDIT FIX: Dynamic tip amounts based on config.tipLamports
  private tipAmounts: TipConfiguration;

  // AUDIT FIX: Track current endpoint for failover
  private currentEndpointIndex = 0;

  constructor(solanaService: SolanaService, config: Partial<JitoConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.solanaService = solanaService;

    const solanaHealth = this.solanaService.getHealth();
    logger.info("Jito service linked to Solana RPC pool", {
      solanaHealthy: solanaHealth.healthy,
      lastSolanaHealthCheck: solanaHealth.lastCheck,
    });

    // P0 SECURITY: Validate tip amount to prevent fund loss
    if (this.config.tipLamports > MAX_TIP_LAMPORTS) {
      const maxSol = Number(MAX_TIP_LAMPORTS) / 1e9;
      throw new Error(
        `Jito tip amount ${this.config.tipLamports} exceeds safety maximum ${MAX_TIP_LAMPORTS} (${maxSol} SOL). ` +
          `Check JITO_TIP_LAMPORTS in .env`
      );
    }

    // AUDIT FIX: Calculate tip amounts based on config.tipLamports
    // Pattern: base = config, competitive = 10x, high = 100x
    // P0 SECURITY: Clamp each tier to MAX_TIP_LAMPORTS to prevent accidental large tips
    const clampToMax = (amount: bigint, level: TipLevel): bigint => {
      if (amount > MAX_TIP_LAMPORTS) {
        logger.warn("Tip amount exceeds safety maximum, clamping to MAX_TIP_LAMPORTS", {
          configured: amount.toString(),
          level,
          max: MAX_TIP_LAMPORTS.toString(),
        });
        return MAX_TIP_LAMPORTS;
      }
      return amount;
    };

    const baseTip = clampToMax(this.config.tipLamports, "base");
    if (baseTip !== this.config.tipLamports) {
      this.config.tipLamports = baseTip;
    }

    this.tipAmounts = {
      base: baseTip,
      competitive: clampToMax(baseTip * 10n, "competitive"),
      high: clampToMax(baseTip * 100n, "high"),
    };

    if (this.config.tipLamports < MIN_TIP_LAMPORTS) {
      throw new Error(
        `Jito tip amount ${this.config.tipLamports} below minimum ${MIN_TIP_LAMPORTS}. ` +
          `Jito requires at least 1,000 lamports. Check JITO_TIP_LAMPORTS in .env`
      );
    }

    // AUDIT FIX: Validate we have at least one endpoint
    if (!this.config.blockEngineUrls || this.config.blockEngineUrls.length === 0) {
      throw new Error("Jito service requires at least one Block Engine URL");
    }

    logger.info("Jito service initialized", {
      blockEngineUrls: this.config.blockEngineUrls,
      endpointCount: this.config.blockEngineUrls.length,
      tipLamports: this.config.tipLamports.toString(),
      enabled: this.config.enabled,
    });
  }

  /**
   * AUDIT FIX: Create API client for specific endpoint
   * Allows dynamic switching between Block Engine endpoints
   */
  private createApiClient(baseURL: string): AxiosInstance {
    return axios.create({
      baseURL,
      timeout: this.config.timeout,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Submit a bundle of transactions to Jito Block Engine
   *
   * @param transactions - Array of signed transactions (max 5)
   * @param payer - Keypair to sign the tip transaction
   * @param tipLevel - Tip level (base, competitive, high)
   * @returns Bundle result with ID and status
   */
  async submitBundle(
    transactions: VersionedTransaction[],
    payer: Keypair,
    tipLevel: TipLevel = "base"
  ): Promise<Result<BundleResult, JitoError>> {
    const startTime = Date.now();

    try {
      if (!this.config.enabled) {
        return Err({
          type: "BUNDLE_SUBMISSION_FAILED",
          message: "Jito bundles disabled in configuration",
        });
      }

      if (transactions.length === 0) {
        return Err({
          type: "BUNDLE_INVALID",
          message: "Bundle must contain at least one transaction",
        });
      }

      if (transactions.length > 4) {
        // Max 4 user transactions + 1 tip transaction = 5 total
        return Err({
          type: "BUNDLE_INVALID",
          message: "Bundle can contain maximum 4 transactions (5 with tip)",
        });
      }

      // P1 SECURITY: Validate transactions before submission
      const validationResult = this.validateTransactions(transactions);
      if (!validationResult.success) {
        return validationResult;
      }

      // P1 SECURITY: Check for bundle replay
      const bundleHash = this.hashBundle(transactions);
      if (this.isDuplicateBundle(bundleHash)) {
        logger.warn("Duplicate bundle detected", { bundleHash });
        return Err({
          type: "BUNDLE_INVALID",
          message: "Bundle already submitted recently",
        });
      }

      // CRITICAL FIX: Extract blockhash from first user transaction
      // Jito requires all transactions in bundle to share the same blockhash
      const userTx = transactions[0];
      const blockhashFromUserTx = userTx.message.recentBlockhash;

      if (!blockhashFromUserTx) {
        return Err({
          type: "BUNDLE_INVALID",
          message: "User transaction missing blockhash",
        });
      }

      // DEBUG: Verify user transaction is valid
      logger.info("User transaction details", {
        hasSignatures: userTx.signatures && userTx.signatures.length > 0,
        signatureCount: userTx.signatures?.length,
        firstSignature: userTx.signatures[0] ? Buffer.from(userTx.signatures[0]).toString("base64").slice(0, 16) : "none",
        messageType: userTx.message.constructor.name,
        blockhash: blockhashFromUserTx,
      });

      logger.info("Submitting Jito bundle", {
        transactionCount: transactions.length,
        tipLevel,
        tipLamports: this.tipAmounts[tipLevel].toString(),
        sharedBlockhash: blockhashFromUserTx,
      });

      // Create tip transaction with SAME blockhash as user transactions
      const tipTx = await this.createTipTransaction(
        payer,
        tipLevel,
        blockhashFromUserTx,
        this.config.useAntiSandwich || false // DAY 8: Anti-sandwich protection
      );
      if (!tipTx.success) {
        return tipTx;
      }

      // Build bundle: user transactions + tip transaction
      const bundle = [...transactions, tipTx.value];

      // Serialize transactions to base64
      const serializedTxs = bundle.map((tx) =>
        Buffer.from(tx.serialize()).toString("base64")
      );

      const submissionResult = await this.submitSerializedBundle(serializedTxs);
      if (!submissionResult.success) {
        return submissionResult;
      }

      const bundleId = submissionResult.value;

      logger.info("Jito bundle submitted", {
        bundleId,
        timeMs: Date.now() - startTime,
      });

      // P1 SECURITY: Cache bundle hash to prevent replay
      this.cacheBundle(bundleHash);

      // Track bundle status
      const statusResult = await this.trackBundleStatus(bundleId);
      if (!statusResult.success) {
        return statusResult;
      }

      return Ok(statusResult.value);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;

        if (axiosError.response?.status === 429) {
          logger.warn("Jito rate limited");
          return Err({
            type: "RATE_LIMITED",
            message: "Jito Block Engine rate limit exceeded",
          });
        }

        if (axiosError.code === "ECONNABORTED") {
          logger.warn("Jito request timeout");
          return Err({
            type: "NETWORK_ERROR",
            message: "Jito Block Engine request timeout",
          });
        }
      }

      // P0 SECURITY: Log error type but sanitize message
      logger.error("Jito bundle submission failed", {
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
        timeMs: Date.now() - startTime,
        // Don't log error.message - may contain sensitive data
      });

      return Err({
        type: "UNKNOWN",
        message: "Bundle submission failed. Please try again.",
      });
    }
  }

  /**
   * Submit serialized transactions to Jito with endpoint failover
   */
  private async submitSerializedBundle(
    serializedTxs: string[]
  ): Promise<Result<string, JitoError>> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < this.config.blockEngineUrls.length; attempt++) {
      const endpointIndex =
        (this.currentEndpointIndex + attempt) % this.config.blockEngineUrls.length;
      const endpoint = this.config.blockEngineUrls[endpointIndex];
      const apiClient = this.createApiClient(endpoint);

      try {
        logger.debug("Attempting bundle submission", {
          endpoint,
          attempt: attempt + 1,
          totalEndpoints: this.config.blockEngineUrls.length,
        });

        const response = await apiClient.post<JitoRpcResponse<string>>(
          "/api/v1/bundles",
          {
            jsonrpc: "2.0",
            id: ++this.requestId,
            method: "sendBundle",
            params: [serializedTxs],
          }
        );

        // Update preferred endpoint
        this.currentEndpointIndex = endpointIndex;

        if (response.data.error) {
          logger.error("Jito bundle submission error", {
            endpoint,
            errorCode: response.data.error.code,
          });

          return Err({
            type: "BUNDLE_SUBMISSION_FAILED",
            message: "Bundle submission rejected by Jito",
          });
        }

        const bundleId = response.data.result;
        if (!bundleId) {
          return Err({
            type: "BUNDLE_SUBMISSION_FAILED",
            message: "No bundle ID returned from Jito",
          });
        }

        logger.info("Bundle submitted successfully", {
          endpoint,
          endpointIndex,
        });

        return Ok(bundleId);
      } catch (error) {
        lastError = error;

        const errorDetails: Record<string, unknown> = {
          endpoint,
          attempt: attempt + 1,
          errorType:
            error instanceof Error ? error.constructor.name : "Unknown",
        };

        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
          errorDetails.statusCode = axiosError.response?.status;
          errorDetails.statusText = axiosError.response?.statusText;
          errorDetails.errorCode = axiosError.code;
          errorDetails.errorMessage = axiosError.message;

          if (axiosError.response?.data) {
            const responseData = axiosError.response.data as unknown;
            // Safe type narrowing for error response
            if (responseData && typeof responseData === "object") {
              const data = responseData as { error?: { message?: string }; message?: string };
              errorDetails.jitoError = data.error?.message || data.message;
            }
          }
        } else if (error instanceof Error) {
          errorDetails.errorMessage = error.message;
        }

        logger.warn("Bundle submission failed on endpoint", errorDetails);

        if (attempt === this.config.blockEngineUrls.length - 1) {
          logger.error("All Block Engine endpoints failed");
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error("Failed to submit bundle to any endpoint");
  }

  /**
   * Submit a Jito bundle from base64-encoded signed transactions
   *
   * CRITICAL: This method preserves original transaction signatures by NOT deserializing/reserializing.
   * Jupiter returns transactions in base64 format - we pass them directly to Jito to prevent signature loss.
   *
   * @param signedTransactions - Array of base64-encoded, fully signed transactions
   * @param payer - Keypair to pay the tip (will sign tip transaction)
   * @param tipLevel - Tip level (base, competitive, high)
   * @returns Bundle submission result with bundle ID and status
   */
  async submitBundleFromBase64(
    signedTransactions: string[],
    payer: Keypair,
    tipLevel: TipLevel = "base"
  ): Promise<Result<BundleResult, JitoError>> {
    const startTime = Date.now();

    try {
      if (!this.config.enabled) {
        return Err({
          type: "UNKNOWN",
          message: "Jito bundles disabled in configuration",
        });
      }

      if (signedTransactions.length === 0) {
        return Err({
          type: "BUNDLE_INVALID",
          message: "Bundle must contain at least one transaction",
        });
      }

      if (signedTransactions.length > 4) {
        return Err({
          type: "BUNDLE_INVALID",
          message: "Bundle can contain maximum 4 transactions (5 with tip)",
        });
      }

      // Decode transactions for validation without mutating original base64 payloads
      const decodedTransactions: VersionedTransaction[] = [];
      for (let i = 0; i < signedTransactions.length; i++) {
        try {
          const buffer = Buffer.from(signedTransactions[i], "base64");
          decodedTransactions.push(VersionedTransaction.deserialize(buffer));
        } catch (error) {
          logger.error("Failed to decode base64 transaction for Jito bundle", {
            index: i,
            errorType: error instanceof Error ? error.constructor.name : "Unknown",
          });
          return Err({
            type: "BUNDLE_INVALID",
            message: `Failed to decode transaction ${i + 1}`,
          });
        }
      }

      // Reuse validation + security layers (size, signatures, duplicates)
      const validationResult = this.validateTransactions(decodedTransactions);
      if (!validationResult.success) {
        return validationResult;
      }

      const bundleHash = this.hashBundle(decodedTransactions);
      if (this.isDuplicateBundle(bundleHash)) {
        logger.warn("Duplicate bundle detected (base64 path)", { bundleHash });
        return Err({
          type: "BUNDLE_INVALID",
          message: "Bundle already submitted recently",
        });
      }

      // Transactions must share blockhash; derive from first entry
      const blockhash = decodedTransactions[0].message.recentBlockhash;

      if (!blockhash) {
        return Err({
          type: "BUNDLE_INVALID",
          message: "Transaction missing blockhash",
        });
      }

      logger.info("Submitting Jito bundle from base64", {
        transactionCount: signedTransactions.length,
        tipLevel,
        tipLamports: this.tipAmounts[tipLevel].toString(),
        sharedBlockhash: blockhash,
        messageType: decodedTransactions[0].message.constructor.name,
      });

      // DEBUG: Check first transaction signatures
      const firstTx = decodedTransactions[0];
      logger.debug("First transaction inspection", {
        hasSignatures: firstTx.signatures && firstTx.signatures.length > 0,
        signatureCount: firstTx.signatures?.length,
        allSignaturesValid: firstTx.signatures?.every(sig => sig && sig.length === 64),
        base64Length: signedTransactions[0].length,
        messageAccountKeysLength: firstTx.message.staticAccountKeys?.length,
      });

      // Create tip transaction with SAME blockhash as user transactions
      const tipTx = await this.createTipTransaction(
        payer,
        tipLevel,
        blockhash,
        this.config.useAntiSandwich || false // DAY 8: Anti-sandwich protection
      );
      if (!tipTx.success) {
        return tipTx;
      }

      // Build bundle: ORIGINAL base64 user transactions + tip transaction
      // This preserves signatures from Jupiter
      const tipTxBase64 = Buffer.from(tipTx.value.serialize()).toString("base64");
      const serializedTxs = [...signedTransactions, tipTxBase64];

      const submissionResult = await this.submitSerializedBundle(serializedTxs);
      if (!submissionResult.success) {
        return submissionResult;
      }

      const bundleId = submissionResult.value;

      logger.info("Jito bundle submitted from base64", {
        bundleId,
        timeMs: Date.now() - startTime,
      });

      // Prevent replay
      this.cacheBundle(bundleHash);

      // Track bundle status
      const statusResult = await this.trackBundleStatus(bundleId);
      if (!statusResult.success) {
        return statusResult;
      }

      return Ok(statusResult.value);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;

        if (axiosError.response?.status === 429) {
          logger.warn("Jito rate limited");
          return Err({
            type: "RATE_LIMITED",
            message: "Jito Block Engine rate limit exceeded",
          });
        }

        if (axiosError.code === "ECONNABORTED") {
          logger.warn("Jito request timeout");
          return Err({
            type: "NETWORK_ERROR",
            message: "Jito Block Engine request timeout",
          });
        }
      }

      // P0 SECURITY: Log error type but sanitize message
      logger.error("Jito bundle submission from base64 failed", {
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
        timeMs: Date.now() - startTime,
      });

      return Err({
        type: "UNKNOWN",
        message: "Bundle submission failed. Please try again.",
      });
    }
  }

  /**
   * Create a tip transaction to Jito validator
   *
   * CRITICAL FIX: Now accepts blockhash parameter to ensure all transactions
   * in bundle share the same blockhash (Jito requirement)
   *
   * DAY 8: Added support for anti-sandwich protection with jitodontfront account
   *
   * @param payer - Keypair to pay the tip
   * @param tipLevel - Tip level (base, competitive, high)
   * @param blockhash - Recent blockhash (must match user transactions)
   * @param useAntiSandwich - Enable anti-sandwich protection with jitodontfront
   * @returns Signed tip transaction
   */
  private async createTipTransaction(
    payer: Keypair,
    tipLevel: TipLevel,
    blockhash: string,
    useAntiSandwich = false
  ): Promise<Result<VersionedTransaction, JitoError>> {
    try {
      const tipAmount = this.tipAmounts[tipLevel];

      // P1 SECURITY: Use crypto-secure random for tip account selection
      // Prevents prediction-based MEV attacks
      const randomBytes = new Uint32Array(1);
      webcrypto.getRandomValues(randomBytes);
      const randomIndex = randomBytes[0] % JITO_TIP_ACCOUNTS.length;
      const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[randomIndex]);

      logger.debug("Creating Jito tip transaction", {
        tipAccount: tipAccount.toBase58(),
        tipLamports: tipAmount.toString(),
        tipLevel,
        blockhash, // Log shared blockhash for verification
        useAntiSandwich,
      });

      // Create legacy transaction (Jito requires legacy format for tip)
      const transaction = new Transaction();

      // DAY 8: Add anti-sandwich protection if enabled
      // The jitodontfront account signals to Jito validators to NOT include
      // this transaction in the public mempool, preventing sandwich attacks.
      // We add it as a read-only account key in the tip transfer instruction.
      if (useAntiSandwich) {
        logger.debug("Adding jitodontfront account for anti-sandwich protection");

        // DAY 8: Record anti-sandwich metric
        recordAntiSandwich();

        // Create transfer instruction with jitodontfront as additional key
        const transferIx = SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: tipAccount,
          lamports: Number(tipAmount),
        });

        // Add jitodontfront as read-only, non-signer account
        transferIx.keys.push({
          pubkey: JITO_DONT_FRONT_ADDRESS,
          isSigner: false,
          isWritable: false,
        });

        transaction.add(transferIx);
      } else {
        // Standard tip transfer without anti-sandwich protection
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: tipAccount,
            lamports: Number(tipAmount),
          })
        );
      }

      // CRITICAL: Use provided blockhash (same as user transactions)
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payer.publicKey;

      // Compile to message and create versioned transaction
      const message = transaction.compileMessage();
      const versionedTx = new VersionedTransaction(message);

      // Sign with payer
      versionedTx.sign([payer]);

      return Ok(versionedTx);
    } catch (error) {
      // P0 SECURITY: Sanitize error - don't expose blockhash or transaction details
      logger.error("Failed to create tip transaction", {
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
      });

      return Err({
        type: "BUNDLE_INVALID",
        message: "Failed to create tip transaction",
      });
    }
  }

  /**
   * Track bundle status until it lands or times out
   *
   * @param bundleId - Bundle UUID from submission
   * @returns Final bundle status
   */
  private async trackBundleStatus(
    bundleId: string
  ): Promise<Result<BundleResult, JitoError>> {
    const startTime = Date.now();
    const timeout = this.config.confirmationTimeout;
    const pollInterval = 1000; // Poll every 1 second

    // AUDIT FIX: Use current working endpoint
    const endpoint = this.config.blockEngineUrls[this.currentEndpointIndex];
    const apiClient = this.createApiClient(endpoint);

    logger.info("Tracking Jito bundle status", { bundleId, endpoint });

    while (Date.now() - startTime < timeout) {
      try {
        // Check inflight status
        const response = await apiClient.post<
          JitoRpcResponse<InflightBundleStatusResponse[]>
        >("/api/v1/bundles", {
          jsonrpc: "2.0",
          id: ++this.requestId,
          method: "getInflightBundleStatuses",
          params: [[bundleId]],
        });

        if (response.data.error) {
          // P0 SECURITY: Sanitize error messages
          logger.error("Bundle status check error", {
            errorCode: response.data.error.code,
          });

          return Err({
            type: "UNKNOWN",
            message: "Failed to check bundle status",
            bundleId,
          });
        }

        const statuses = response.data.result;
        if (!statuses || statuses.length === 0) {
          // Bundle not found in inflight, might have already landed
          const confirmedResult = await this.getConfirmedBundleStatus(bundleId);
          if (confirmedResult.success) {
            return confirmedResult;
          }

          // Wait and retry
          await this.sleep(pollInterval);
          continue;
        }

        const status = statuses[0];

        switch (status.status) {
          case "Landed":
            logger.info("Jito bundle landed", {
              bundleId,
              slot: status.landed_slot,
              timeMs: Date.now() - startTime,
            });

            return Ok({
              bundleId,
              status: "Landed",
              slot: status.landed_slot,
            });

          case "Invalid":
            logger.error("Jito bundle invalid", { bundleId });

            return Err({
              type: "BUNDLE_INVALID",
              message: "Bundle rejected as invalid",
              bundleId,
            });

          case "Failed":
            logger.error("Jito bundle failed", { bundleId });

            return Err({
              type: "BUNDLE_SUBMISSION_FAILED",
              message: "Bundle execution failed",
              bundleId,
            });

          case "Pending":
            // Continue polling
            logger.debug("Jito bundle pending", { bundleId });
            await this.sleep(pollInterval);
            break;
        }
      } catch (error) {
        // AUDIT FIX: Don't log full error object (may contain Jito API payload)
        logger.warn("Bundle status check failed", {
          errorType: error instanceof Error ? error.constructor.name : "Unknown",
          bundleId,
        });

        // Continue polling on error
        await this.sleep(pollInterval);
      }
    }

    logger.error("Jito bundle timeout", {
      bundleId,
      timeoutMs: timeout,
    });

    return Err({
      type: "BUNDLE_TIMEOUT",
      message: `Bundle did not land within ${timeout}ms`,
      bundleId,
    });
  }

  /**
   * Get confirmed bundle status (for bundles that already landed)
   *
   * @param bundleId - Bundle UUID
   * @returns Bundle status if found
   */
  private async getConfirmedBundleStatus(
    bundleId: string
  ): Promise<Result<BundleResult, JitoError>> {
    // AUDIT FIX: Use current working endpoint
    const endpoint = this.config.blockEngineUrls[this.currentEndpointIndex];
    const apiClient = this.createApiClient(endpoint);

    try {
      const response = await apiClient.post<
        JitoRpcResponse<BundleStatusResponse[]>
      >("/api/v1/bundles", {
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "getBundleStatuses",
        params: [[bundleId]],
      });

      if (response.data.error || !response.data.result) {
        return Err({
          type: "UNKNOWN",
          message: "Bundle not found in confirmed statuses",
          bundleId,
        });
      }

      const statuses = response.data.result;
      if (statuses.length === 0) {
        return Err({
          type: "UNKNOWN",
          message: "Bundle not found",
          bundleId,
        });
      }

      const status = statuses[0];

      if (status.err) {
        // P0 SECURITY: Don't expose raw error from Jito API
        return Err({
          type: "BUNDLE_SUBMISSION_FAILED",
          message: "Bundle execution failed",
          bundleId,
        });
      }

      const signatures = status.transactions.map((sig) =>
        asTransactionSignature(sig)
      );

      return Ok({
        bundleId,
        status: "Landed",
        signatures,
        slot: status.slot,
      });
    } catch (error) {
      // P0 SECURITY: Sanitize error messages
      return Err({
        type: "UNKNOWN",
        message: "Failed to get bundle status",
        bundleId,
      });
    }
  }

  /**
   * Get current Jito configuration
   *
   * @returns Current Jito config
   */
  getConfig(): JitoConfig {
    return { ...this.config };
  }

  /**
   * Get bundle status by bundle ID
   *
   * @param bundleId - Bundle UUID
   * @returns Bundle status result
   */
  async getBundleStatus(bundleId: string): Promise<Result<BundleResult, JitoError>> {
    return await this.getConfirmedBundleStatus(bundleId);
  }

  /**
   * Get tip amount for a given level
   *
   * @param level - Tip level
   * @returns Tip amount in lamports
   */
  getTipAmount(level: TipLevel): bigint {
    return this.tipAmounts[level];
  }

  /**
   * DAY 8: Calculate optimal tip based on trade size
   *
   * Tip scaling strategy:
   * - Small trades (<0.1 SOL): 10k lamports (0.00001 SOL)
   * - Medium trades (0.1-1 SOL): 50k lamports (0.00005 SOL)
   * - Large trades (1-5 SOL): 100k lamports (0.0001 SOL)
   * - Very large trades (>5 SOL): 200k lamports (0.0002 SOL)
   *
   * This ensures:
   * 1. Cost-effective for small snipes
   * 2. Competitive for medium trades
   * 3. High priority for large trades where MEV matters most
   *
   * @param tradeSizeSol - Trade size in SOL
   * @returns Optimal tip in lamports
   */
  calculateOptimalTip(tradeSizeSol: number): bigint {
    let tipLamports: bigint;

    if (tradeSizeSol < 0.1) {
      // Small trades: minimal tip
      tipLamports = BigInt(10_000);
    } else if (tradeSizeSol < 1.0) {
      // Medium trades: moderate tip
      tipLamports = BigInt(50_000);
    } else if (tradeSizeSol < 5.0) {
      // Large trades: competitive tip
      tipLamports = BigInt(100_000);
    } else {
      // Very large trades: high priority tip
      tipLamports = BigInt(200_000);
    }

    // P0 SECURITY: Enforce maximum tip limit
    if (tipLamports > MAX_TIP_LAMPORTS) {
      logger.warn("Calculated tip exceeds maximum, capping to MAX_TIP_LAMPORTS", {
        calculated: tipLamports.toString(),
        max: MAX_TIP_LAMPORTS.toString(),
        tradeSizeSol,
      });
      return MAX_TIP_LAMPORTS;
    }

    // Enforce minimum tip (Jito requirement)
    if (tipLamports < MIN_TIP_LAMPORTS) {
      logger.warn("Calculated tip below minimum, raising to MIN_TIP_LAMPORTS", {
        calculated: tipLamports.toString(),
        min: MIN_TIP_LAMPORTS.toString(),
        tradeSizeSol,
      });
      return MIN_TIP_LAMPORTS;
    }

    logger.debug("Calculated optimal Jito tip", {
      tradeSizeSol,
      tipLamports: tipLamports.toString(),
    });

    return tipLamports;
  }

  /**
   * DAY 8: Smart routing with dual-mode execution
   *
   * Executes transaction with optimal strategy based on mode:
   *
   * MEV_TURBO:
   * - Jito-only submission (fastest, best MEV protection)
   * - Uses dynamic tip based on trade size
   * - Anti-sandwich protection if enabled
   * - 5s bundle timeout for sniper speed
   *
   * MEV_SECURE:
   * - Race condition: Jito + direct RPC simultaneously
   * - Whichever confirms first wins
   * - Redundancy for critical transactions
   * - Fallback if one method fails
   *
   * @param signedTransaction - Base64-encoded signed transaction
   * @param payer - Keypair for tip transaction
   * @param options - Smart routing options
   * @returns Smart routing result with method used and timing
   */
  async executeSmartRouting(
    signedTransaction: string,
    payer: Keypair,
    options: SmartRoutingOptions
  ): Promise<Result<SmartRoutingResult, JitoError>> {
    const startTime = Date.now();

    // DAY 8: Record metrics
    recordJitoBundleSubmission(options.mode);

    logger.info("Executing smart routing", {
      mode: options.mode,
      tradeSizeSol: options.tradeSizeSol,
      antiSandwich: options.antiSandwich || false,
      bundleTimeout: options.bundleTimeout || 5000,
    });

    // Calculate optimal tip based on trade size
    const optimalTip = this.calculateOptimalTip(options.tradeSizeSol);

    // Determine tip level from calculated amount
    const tipLevel = this.getTipLevelFromAmount(optimalTip);

    // DAY 8: Record tip amount
    recordJitoTip(optimalTip, "dynamic");

    if (options.mode === "MEV_TURBO") {
      // TURBO mode: Jito-only with optimized settings
      const bundleTimeout = options.bundleTimeout || 5000; // Default 5s for snipers

      // Temporarily override confirmation timeout for this submission
      const originalTimeout = this.config.confirmationTimeout;
      this.config.confirmationTimeout = bundleTimeout;

      try {
        const bundleResult = await this.submitBundleFromBase64(
          [signedTransaction],
          payer,
          tipLevel
        );

        // Restore original timeout
        this.config.confirmationTimeout = originalTimeout;

        if (!bundleResult.success) {
          // DAY 8: Record failure
          recordJitoBundleFailure(options.mode, bundleResult.error.type);
          return bundleResult;
        }

        const result = bundleResult.value;

        // Extract signature from bundle result
        const signature = result.signatures?.[0] || asTransactionSignature("unknown");

        // DAY 8: Record success
        const confirmationTime = Date.now() - startTime;
        recordJitoBundleSuccess(options.mode, confirmationTime);
        recordSmartRoutingWinner("jito");

        return Ok({
          method: "jito",
          signature,
          slot: result.slot || 0,
          bundleId: result.bundleId,
          confirmationTimeMs: confirmationTime,
        });
      } finally {
        // Ensure timeout is always restored
        this.config.confirmationTimeout = originalTimeout;
      }
    } else {
      // SECURE mode: Race condition between Jito and direct RPC
      return await this.executeRaceCondition(
        signedTransaction,
        payer,
        tipLevel,
        options.bundleTimeout || 5000,
        startTime
      );
    }
  }

  /**
   * DAY 8: Execute race condition between Jito and direct RPC
   *
   * Submits transaction via both methods simultaneously and uses whichever
   * confirms first. Provides redundancy and ensures fastest confirmation.
   *
   * @param signedTransaction - Base64-encoded signed transaction
   * @param payer - Keypair for tip transaction
   * @param tipLevel - Tip level for Jito
   * @param bundleTimeout - Bundle confirmation timeout
   * @param startTime - Start timestamp for timing
   * @returns Smart routing result
   */
  private async executeRaceCondition(
    signedTransaction: string,
    payer: Keypair,
    tipLevel: TipLevel,
    bundleTimeout: number,
    startTime: number
  ): Promise<Result<SmartRoutingResult, JitoError>> {
    logger.info("Starting race condition: Jito vs direct RPC");

    // Temporarily override confirmation timeout for Jito
    const originalTimeout = this.config.confirmationTimeout;
    this.config.confirmationTimeout = bundleTimeout;

    try {
      // Start both submissions simultaneously
      const jitoPromise = this.submitBundleFromBase64(
        [signedTransaction],
        payer,
        tipLevel
      ).then((result): { method: "jito" | "rpc"; result: Result<BundleResult, JitoError> } => ({
        method: "jito",
        result,
      }));

      const rpcPromise = this.sendViaDirectRPC(signedTransaction).then(
        (result): { method: "jito" | "rpc"; result: Result<BundleResult, JitoError> } => ({
          method: "rpc",
          result,
        })
      );

      // Race: whichever confirms first wins
      const winner = await Promise.race([jitoPromise, rpcPromise]);

      // Restore original timeout
      this.config.confirmationTimeout = originalTimeout;

      if (!winner.result.success) {
        logger.warn("Winner method failed, trying fallback", {
          method: winner.method,
          error: winner.result.error,
        });

        // DAY 8: Record fallback
        if (winner.method === "jito") {
          recordJitoRpcFallback();
        }

        // If winner failed, try the other method
        const fallback = winner.method === "jito"
          ? await this.sendViaDirectRPC(signedTransaction).then(r => ({ method: "rpc" as const, result: r }))
          : await this.submitBundleFromBase64([signedTransaction], payer, tipLevel).then(r => ({ method: "jito" as const, result: r }));

        if (!fallback.result.success) {
          return fallback.result;
        }

        const fallbackBundleResult = fallback.result.value;
        const fallbackSignature = fallbackBundleResult.signatures?.[0] || asTransactionSignature("unknown");

        logger.info("Fallback method succeeded", {
          method: fallback.method,
          signature: fallbackSignature,
        });

        return Ok({
          method: fallback.method,
          signature: fallbackSignature,
          slot: fallbackBundleResult.slot || 0,
          bundleId: fallback.method === "jito" ? fallbackBundleResult.bundleId : undefined,
          confirmationTimeMs: Date.now() - startTime,
        });
      }

      const bundleResult = winner.result.value;
      const signature = bundleResult.signatures?.[0] || asTransactionSignature("unknown");

      const confirmationTime = Date.now() - startTime;

      logger.info("Race condition winner", {
        method: winner.method,
        signature,
        timeMs: confirmationTime,
      });

      // DAY 8: Record winner method
      recordSmartRoutingWinner(winner.method);

      return Ok({
        method: winner.method,
        signature,
        slot: bundleResult.slot || 0,
        bundleId: winner.method === "jito" ? bundleResult.bundleId : undefined,
        confirmationTimeMs: confirmationTime,
      });
    } catch (error) {
      // Restore timeout on error
      this.config.confirmationTimeout = originalTimeout;

      logger.error("Race condition failed", {
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
      });

      return Err({
        type: "UNKNOWN",
        message: "Both Jito and RPC methods failed",
      });
    }
  }

  /**
   * DAY 8: Send transaction via direct RPC (fallback method)
   *
   * @param signedTransaction - Base64-encoded signed transaction
   * @returns Bundle result format for consistency
   */
  private async sendViaDirectRPC(
    signedTransaction: string
  ): Promise<Result<BundleResult, JitoError>> {
    try {
      logger.debug("Sending transaction via direct RPC");

      // Await connection from SolanaService
      const connection = await this.solanaService.getConnection();
      const transactionBuffer = Buffer.from(signedTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(transactionBuffer);

      // Send transaction
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });

      logger.info("Transaction sent via RPC", { signature });

      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(
        signature,
        "confirmed"
      );

      if (confirmation.value.err) {
        logger.error("RPC transaction failed", {
          signature,
          error: confirmation.value.err,
        });

        return Err({
          type: "BUNDLE_SUBMISSION_FAILED",
          message: "Transaction failed on-chain",
        });
      }

      logger.info("RPC transaction confirmed", { signature });

      // Get slot from recent blockhash
      const slot = await connection.getSlot();

      return Ok({
        bundleId: "rpc-direct",
        status: "Landed",
        signatures: [asTransactionSignature(signature)],
        slot,
      });
    } catch (error) {
      logger.error("Direct RPC submission failed", {
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
      });

      return Err({
        type: "NETWORK_ERROR",
        message: "Direct RPC submission failed",
      });
    }
  }

  /**
   * DAY 8: Get tip level from calculated tip amount
   *
   * Maps calculated tip amount back to TipLevel for existing API
   *
   * @param tipLamports - Calculated tip in lamports
   * @returns Corresponding tip level
   */
  private getTipLevelFromAmount(tipLamports: bigint): TipLevel {
    if (tipLamports <= BigInt(10_000)) {
      return "base";
    } else if (tipLamports <= BigInt(50_000)) {
      return "base";
    } else if (tipLamports <= BigInt(100_000)) {
      return "competitive";
    } else {
      return "high";
    }
  }

  /**
   * Sleep for a given duration
   *
   * @param ms - Duration in milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * P1 SECURITY: Validate transactions before bundle submission
   *
   * Checks:
   * - Transaction signatures are valid
   * - Bundle size doesn't exceed Solana limits
   * - No duplicate transactions
   *
   * @param transactions - Transactions to validate
   * @returns Validation result
   */
  private validateTransactions(
    transactions: VersionedTransaction[]
  ): Result<void, JitoError> {
    let totalSize = 0;

    const seenSignatures = new Set<string>();

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];

      // Check transaction size
      const serialized = tx.serialize();
      totalSize += serialized.length;

      if (serialized.length > 1232) {
        logger.error("Transaction exceeds size limit", {
          index: i,
          size: serialized.length,
        });

        return Err({
          type: "BUNDLE_INVALID",
          message: "Transaction exceeds maximum size (1232 bytes)",
        });
      }

      // Verify transaction has signatures
      if (!tx.signatures || tx.signatures.length === 0) {
        logger.error("Transaction missing signatures", { index: i });

        return Err({
          type: "BUNDLE_INVALID",
          message: "Transaction must be signed before submission",
        });
      }

      // Check for duplicate transactions (by first signature)
      const sigStr = Buffer.from(tx.signatures[0]).toString("base64");
      if (seenSignatures.has(sigStr)) {
        logger.error("Duplicate transaction in bundle", { index: i });

        return Err({
          type: "BUNDLE_INVALID",
          message: "Bundle contains duplicate transactions",
        });
      }
      seenSignatures.add(sigStr);
    }

    // Check total bundle size (with tip transaction)
    // Reserve space for tip transaction (~250 bytes)
    if (totalSize + 250 > MAX_BUNDLE_SIZE_BYTES) {
      logger.error("Bundle exceeds size limit", {
        totalSize,
        maxSize: MAX_BUNDLE_SIZE_BYTES,
      });

      return Err({
        type: "BUNDLE_INVALID",
        message: "Bundle exceeds maximum size limit",
      });
    }

    return Ok(undefined);
  }

  /**
   * P1 SECURITY: Hash bundle for deduplication
   *
   * Creates deterministic hash from transaction signatures
   *
   * @param transactions - Transactions to hash
   * @returns Bundle hash (hex string)
   */
  private hashBundle(transactions: VersionedTransaction[]): string {
    const signaturesData = transactions
      .map((tx) => Buffer.from(tx.signatures[0]))
      .reduce((acc, sig) => Buffer.concat([acc, sig]), Buffer.alloc(0));

    // Use crypto-secure hashing (SHA-256)
    const hash = createHash("sha256");
    hash.update(signaturesData);
    return hash.digest("hex");
  }

  /**
   * P1 SECURITY: Check if bundle was recently submitted
   *
   * @param bundleHash - Bundle hash to check
   * @returns True if duplicate
   */
  private isDuplicateBundle(bundleHash: string): boolean {
    const now = Date.now();

    // Clean up expired entries
    for (const [hash, timestamp] of this.bundleCache.entries()) {
      if (now - timestamp > BUNDLE_DEDUPLICATION_TTL) {
        this.bundleCache.delete(hash);
      }
    }

    return this.bundleCache.has(bundleHash);
  }

  /**
   * P1 SECURITY: Cache bundle hash
   *
   * @param bundleHash - Bundle hash to cache
   */
  private cacheBundle(bundleHash: string): void {
    this.bundleCache.set(bundleHash, Date.now());
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let jitoServiceInstance: JitoService | null = null;

// AUDIT FIX: Accept SolanaService instead of Connection for RPCPool integration
export function initializeJitoService(
  solanaService: SolanaService,
  config?: Partial<JitoConfig>
): JitoService {
  if (jitoServiceInstance) {
    logger.warn(
      "Jito service already initialized, returning existing instance"
    );
    return jitoServiceInstance;
  }

  jitoServiceInstance = new JitoService(solanaService, config);
  return jitoServiceInstance;
}

export function getJitoService(): JitoService {
  if (!jitoServiceInstance) {
    throw new Error(
      "Jito service not initialized. Call initializeJitoService() first"
    );
  }

  return jitoServiceInstance;
}
