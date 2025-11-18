/**
 * Transaction Builder Utilities
 *
 * Provides utilities for modifying Solana transactions with priority fees.
 *
 * Features:
 * - Add/replace ComputeBudget instructions
 * - Preserve existing transaction structure
 * - Support for VersionedTransaction (MessageV0)
 *
 * Usage:
 * ```typescript
 * const modified = addPriorityFeeToTransaction(transaction, {
 *   computeUnitPrice: 50_000,
 *   computeUnitLimit: 200_000,
 * });
 * ```
 */

import {
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import type { Result } from "../../types/common.js";
import { Ok, Err } from "../../types/common.js";

// ============================================================================
// Types
// ============================================================================

export interface PriorityFeeConfig {
  /** Compute unit price in microlamports */
  computeUnitPrice: number;

  /** Compute unit limit (max CUs for transaction) */
  computeUnitLimit: number;
}

// ============================================================================
// Transaction Modification
// ============================================================================

/**
 * Add or replace ComputeBudget instructions in a transaction
 *
 * This function:
 * 1. Removes any existing ComputeBudget instructions
 * 2. Adds new SetComputeUnitLimit instruction (if specified)
 * 3. Adds new SetComputeUnitPrice instruction (if > 0)
 * 4. Preserves all other instructions and transaction properties
 *
 * @param transaction - Base64-encoded transaction from Jupiter
 * @param config - Priority fee configuration
 * @returns Modified base64 transaction or error
 */
export function addPriorityFeeToTransaction(
  transactionBase64: string,
  config: PriorityFeeConfig
): Result<string, string> {
  try {
    logger.debug("Adding priority fee to transaction", config);

    // 1. Deserialize transaction
    const transactionBuffer = Buffer.from(transactionBase64, "base64");
    const transaction = VersionedTransaction.deserialize(transactionBuffer);

    // 2. Extract message (MessageV0)
    const message = transaction.message;

    // 3. Get existing instructions
    const existingInstructions = TransactionMessage.decompile(message).instructions;

    // 4. Filter out existing ComputeBudget instructions
    const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
    const filteredInstructions = existingInstructions.filter(
      (ix) => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID
    );

    logger.debug("Removed existing ComputeBudget instructions", {
      originalCount: existingInstructions.length,
      filteredCount: filteredInstructions.length,
      removed: existingInstructions.length - filteredInstructions.length,
    });

    // 5. Create new ComputeBudget instructions
    const newInstructions: TransactionInstruction[] = [];

    // Add SetComputeUnitLimit (always add for predictability)
    if (config.computeUnitLimit > 0) {
      newInstructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: config.computeUnitLimit,
        })
      );
    }

    // Add SetComputeUnitPrice (only if > 0)
    if (config.computeUnitPrice > 0) {
      newInstructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: config.computeUnitPrice,
        })
      );
    }

    // 6. Combine: ComputeBudget instructions first, then others
    const allInstructions = [...newInstructions, ...filteredInstructions];

    logger.debug("Built new instruction list", {
      computeBudgetCount: newInstructions.length,
      otherCount: filteredInstructions.length,
      totalCount: allInstructions.length,
    });

    // 7. Recompile message with new instructions
    const compiledMessage = new TransactionMessage({
      payerKey: message.staticAccountKeys[0]!, // First account is payer
      instructions: allInstructions,
      recentBlockhash: message.recentBlockhash,
    }).compileToV0Message();

    // 8. Create new VersionedTransaction
    const newTransaction = new VersionedTransaction(compiledMessage);

    // 9. Serialize to base64
    const modifiedBase64 = Buffer.from(newTransaction.serialize()).toString("base64");

    logger.debug("Transaction modified successfully", {
      originalSize: transactionBuffer.length,
      modifiedSize: Buffer.from(modifiedBase64, "base64").length,
    });

    return Ok(modifiedBase64);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to add priority fee to transaction", {
      error: errorMsg,
      config,
    });
    return Err(errorMsg);
  }
}

/**
 * Add priority fee to already-deserialized VersionedTransaction
 *
 * @param transaction - Deserialized VersionedTransaction
 * @param config - Priority fee configuration
 * @returns Modified VersionedTransaction or error
 */
export function addPriorityFeeToDeserializedTransaction(
  transaction: VersionedTransaction,
  config: PriorityFeeConfig
): Result<VersionedTransaction, string> {
  try {
    logger.debug("Adding priority fee to deserialized transaction", config);

    // Extract message
    const message = transaction.message;

    // Get existing instructions
    const existingInstructions = TransactionMessage.decompile(message).instructions;

    // Filter out existing ComputeBudget instructions
    const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
    const filteredInstructions = existingInstructions.filter(
      (ix) => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID
    );

    // Create new ComputeBudget instructions
    const newInstructions: TransactionInstruction[] = [];

    if (config.computeUnitLimit > 0) {
      newInstructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: config.computeUnitLimit,
        })
      );
    }

    if (config.computeUnitPrice > 0) {
      newInstructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: config.computeUnitPrice,
        })
      );
    }

    // Combine instructions
    const allInstructions = [...newInstructions, ...filteredInstructions];

    // Recompile message
    const compiledMessage = new TransactionMessage({
      payerKey: message.staticAccountKeys[0]!,
      instructions: allInstructions,
      recentBlockhash: message.recentBlockhash,
    }).compileToV0Message();

    // Create new transaction
    const newTransaction = new VersionedTransaction(compiledMessage);

    logger.debug("Deserialized transaction modified successfully");

    return Ok(newTransaction);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to add priority fee to deserialized transaction", {
      error: errorMsg,
    });
    return Err(errorMsg);
  }
}

/**
 * Calculate total priority fee in lamports
 *
 * Formula: (microlamports_per_CU * compute_units) / 1_000_000
 *
 * @param config - Priority fee configuration
 * @returns Total fee in lamports
 */
export function calculateTotalPriorityFee(config: PriorityFeeConfig): bigint {
  return BigInt(
    Math.floor((config.computeUnitPrice * config.computeUnitLimit) / 1_000_000)
  );
}
