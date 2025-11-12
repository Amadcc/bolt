import { Keypair } from "@solana/web3.js";
import { unlockWallet, clearKeypair } from "../wallet/keyManager.js";
import { logger } from "../../utils/logger.js";
import { Err, Ok, type Result } from "../../types/common.js";
import {
  storeAutomationLease,
  loadAutomationLease,
  clearAutomationLease,
  hasAutomationLease,
  batchHasAutomationLease
} from "./automationVault.js";

export async function establishAutomationLease(
  userId: string,
  password: string
): Promise<Result<Date, string>> {
  const unlockResult = await unlockWallet({ userId, password });

  if (!unlockResult.success) {
    logger.warn("Failed to unlock wallet for automation lease", {
      userId,
      error: unlockResult.error,
    });
    const errorMessage =
      "message" in unlockResult.error
        ? unlockResult.error.message
        : unlockResult.error.type;
    return Err(
      `Unable to unlock wallet: ${errorMessage || "Unknown error"}`
    );
  }

  const { walletId, keypair } = unlockResult.value;

  try {
    const expiresAtResult = await storeAutomationLease(
      userId,
      walletId,
      new Uint8Array(keypair.secretKey)
    );

    if (!expiresAtResult.success) {
      return Err(expiresAtResult.error);
    }

    logger.info("Automation lease established", {
      userId,
      walletId,
      expiresAt: expiresAtResult.value.toISOString(),
    });

    return Ok(expiresAtResult.value);
  } finally {
    clearKeypair(keypair);
  }
}

export async function getAutomationKeypair(
  userId: string
): Promise<Result<{ keypair: Keypair; walletId: string; expiresAt: Date }, string>> {
  const leaseResult = await loadAutomationLease(userId);

  if (!leaseResult.success) {
    return Err(leaseResult.error);
  }

  const { walletId, privateKey, expiresAt } = leaseResult.value;

  try {
    const keypair = Keypair.fromSecretKey(privateKey);
    privateKey.fill(0);

    return Ok({ keypair, walletId, expiresAt });
  } catch (error) {
    logger.error("Failed to construct keypair from automation lease", {
      userId,
      error,
    });
    return Err("Automation lease corrupted. Please re-enable auto-snipe.");
  }
}

export async function revokeAutomationLease(userId: string): Promise<void> {
  await clearAutomationLease(userId);
}

export async function automationLeaseActive(userId: string): Promise<boolean> {
  return hasAutomationLease(userId);
}

export async function batchAutomationLeaseActive(
  userIds: string[]
): Promise<Map<string, boolean>> {
  return batchHasAutomationLease(userIds);
}
