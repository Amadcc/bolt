import type { SnipeConfig, SnipeExecution } from "@prisma/client";
import { prisma } from "../../utils/db.js";
import { logger } from "../../utils/logger.js";
import { Err, Ok, type Result } from "../../types/common.js";
import type { NewTokenEvent } from "../../types/snipe.js";
import { getHoneypotDetector } from "../honeypot/detector.js";
import { enforceRateLimits, decrementRateCounters } from "./rateLimiter.js";
import { getAutomationKeypair } from "./automationService.js";
import { clearKeypair } from "../wallet/keyManager.js";
import { getJupiter } from "../trading/jupiter.js";
import { SOL_MINT } from "../../config/tokens.js";
import { asTokenMint } from "../../types/common.js";
import {
  recordSnipeAnalysisDuration,
  recordSnipeExecutionOutcome,
  recordSnipeExecutionLatency,
  recordAutomationLeaseFailure,
} from "../../utils/metrics.js";
import type { JupiterError } from "../../types/jupiter.js";
import {
  notifyAutoSnipeFailure,
  notifyAutoSnipeSkipped,
  notifyAutoSnipeSuccess,
} from "./notifier.js";
import { HONEYPOT_TIMEOUT_MS } from "../../config/snipe.js";

export class SnipeExecutor {
  async execute(
    userId: string,
    config: SnipeConfig,
    event: NewTokenEvent
  ): Promise<Result<SnipeExecution, string>> {
    const rateLimit = await enforceRateLimits(userId, config);
    if (!rateLimit.success) {
      await this.notifyFailure(config, event, rateLimit.error);
      return Err(rateLimit.error);
    }

    const execution = await prisma.snipeExecution.create({
      data: {
        user: { connect: { id: userId } },
        tokenMint: event.mint,
        tokenName: event.name,
        tokenSymbol: event.symbol,
        status: "PENDING",
        buyAmountLamports: config.buyAmountLamports,
        discoveredAt: event.timestamp,
        liquidityLamports: event.liquidityLamports,
        marketCapUsd: event.marketCapUsd,
      },
    });

    try {
      const honeypotResult = await this.performHoneypotCheck(
        event.mint,
        execution.id
      );

      if (honeypotResult.success) {
        recordSnipeAnalysisDuration(honeypotResult.value.durationMs);
      }

      if (!honeypotResult.success) {
        await this.failExecution(execution.id, honeypotResult.error);
        await decrementRateCounters(userId, config); // Don't count failed honeypot checks
        await this.notifyFailure(config, event, honeypotResult.error);
        return Err(honeypotResult.error);
      }

      if (honeypotResult.value.honeypotScore > config.maxHoneypotRisk) {
        const reason = `Risk score ${honeypotResult.value.honeypotScore}/100 exceeds limit`;
        await this.skipExecution(execution.id, reason, honeypotResult.value);
        await decrementRateCounters(userId, config); // Don't count high-risk tokens
        await this.notifySkip(config, event, reason);
        return Err(reason);
      }

      const keypairResult = await getAutomationKeypair(userId);
      if (!keypairResult.success) {
        const failureMessage = `Automation lease unavailable: ${keypairResult.error}`;
        await this.failExecution(execution.id, failureMessage);
        await decrementRateCounters(userId, config); // Don't count auth failures
        await this.notifyFailure(config, event, keypairResult.error);

        // Record lease failure metrics
        if (keypairResult.error.includes("expired")) {
          recordAutomationLeaseFailure("expired");
        } else if (keypairResult.error.includes("not found")) {
          recordAutomationLeaseFailure("auth_failed");
        } else {
          recordAutomationLeaseFailure("storage_error");
        }

        return Err(keypairResult.error);
      }

      const { keypair, expiresAt } = keypairResult.value;
      logger.info("Executing auto-snipe swap", {
        userId,
        token: event.symbol,
        expiresAt: expiresAt.toISOString(),
      });

      await prisma.snipeExecution.update({
        where: { id: execution.id },
        data: {
          status: "EXECUTING",
          honeypotScore: honeypotResult.value.honeypotScore,
          analyzedAt: new Date(),
          analysisDurationMs: honeypotResult.value.durationMs,
        },
      });

      const jupiter = getJupiter();

      const swapResult = await jupiter.swap(
        {
          inputMint: asTokenMint(SOL_MINT),
          outputMint: event.mint,
          amount: config.buyAmountLamports.toString(),
          slippageBps: config.slippageBps,
          userPublicKey: keypair.publicKey.toBase58(),
        },
        keypair
      );

      clearKeypair(keypair);

      if (!swapResult.success) {
        const errorMessage = describeJupiterError(swapResult.error);
        await this.failExecution(execution.id, errorMessage);
        recordSnipeExecutionOutcome("failed");
        await this.notifyFailure(config, event, errorMessage);
        return Err(errorMessage);
      }

      const result = swapResult.value;

      const successRecord = await prisma.snipeExecution.update({
        where: { id: execution.id },
        data: {
          status: "SUCCESS",
          success: true,
          outputAmountTokens: result.outputAmount,
          slippageBps: config.slippageBps,
          transactionSignature: result.signature,
          executedAt: new Date(),
          confirmedAt: new Date(),
        },
      });

      await prisma.snipeConfig.update({
        where: { userId },
        data: { lastAutomationAt: new Date() },
      }).catch((error) => {
        logger.warn("Failed to update lastAutomationAt", { userId, error });
      });

      recordSnipeExecutionOutcome("success");

      // Record end-to-end execution latency
      const executionLatencyMs = Date.now() - event.timestamp.getTime();
      recordSnipeExecutionLatency(executionLatencyMs, "success");

      await this.notifySuccess(
        config,
        event,
        swapResult.value.signature,
        swapResult.value.outputAmount
      );
      return Ok(successRecord);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failExecution(execution.id, message);
      await decrementRateCounters(userId, config); // Don't count unexpected errors
      recordSnipeExecutionOutcome("failed");

      // Record execution latency even for failures
      const executionLatencyMs = Date.now() - event.timestamp.getTime();
      recordSnipeExecutionLatency(executionLatencyMs, "failed");

      await this.notifyFailure(config, event, message);
      return Err(message);
    }
  }

  private async performHoneypotCheck(
    tokenMint: string,
    executionId: string
  ): Promise<Result<{ honeypotScore: number; durationMs: number }, string>> {
    const detector = getHoneypotDetector();
    try {
      const startedAt = Date.now();
      const result = await Promise.race([
        detector.check(tokenMint),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), HONEYPOT_TIMEOUT_MS)
        ),
      ]);

      if (!result.success) {
        return Err(`Honeypot check failed: ${result.error.type ?? "unknown"}`);
      }

      await prisma.snipeExecution.update({
        where: { id: executionId },
        data: { status: "ANALYZING" },
      });

      return Ok({
        honeypotScore: result.value.riskScore,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Honeypot analysis error: ${message}`);
    }
  }

  private async failExecution(id: string, reason: string): Promise<void> {
    await prisma.snipeExecution.update({
      where: { id: id },
      data: {
        status: "FAILED",
        success: false,
        failureReason: reason,
      },
    });
  }

  private async skipExecution(
    id: string,
    reason: string,
    context: { honeypotScore: number }
  ): Promise<void> {
    await prisma.snipeExecution.update({
      where: { id },
      data: {
        status: "SKIPPED",
        failureReason: reason,
        honeypotScore: context.honeypotScore,
      },
    });
  }

  private async notifySuccess(
    config: SnipeConfig,
    event: NewTokenEvent,
    signature: string,
    outputAmount?: bigint
  ): Promise<void> {
    if (!config.notifyOnSuccess) {
      return;
    }

    await notifyAutoSnipeSuccess({
      userId: config.userId,
      token: event,
      signature,
      buyAmountLamports: config.buyAmountLamports,
      outputAmount,
    });
  }

  private async notifyFailure(
    config: SnipeConfig,
    event: NewTokenEvent,
    reason: string
  ): Promise<void> {
    if (!config.notifyOnFailure) {
      return;
    }

    await notifyAutoSnipeFailure({
      userId: config.userId,
      token: event,
      reason,
    });
  }

  private async notifySkip(
    config: SnipeConfig,
    event: NewTokenEvent,
    reason: string
  ): Promise<void> {
    if (!config.notifyOnFailure) {
      return;
    }

    await notifyAutoSnipeSkipped({
      userId: config.userId,
      token: event,
      reason,
    });
  }
}

export const snipeExecutor = new SnipeExecutor();

function describeJupiterError(error: JupiterError): string {
  if ("message" in error) {
    return error.message;
  }
  if (error.type === "TRANSACTION_FAILED") {
    return error.reason;
  }
  const fallbackType = (error as { type?: string }).type ?? "UNKNOWN";
  return `Jupiter error: ${fallbackType}`;
}
