#!/usr/bin/env bun

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("📊 Checking recent snipe executions...\n");

  const executions = await prisma.snipeExecution.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      status: true,
      success: true,
      tokenMint: true,
      tokenSymbol: true,
      tokenName: true,
      honeypotScore: true,
      buyAmountLamports: true,
      outputAmountTokens: true,
      transactionSignature: true,
      failureReason: true,
      filterReason: true,
      discoveredAt: true,
      analyzedAt: true,
      executedAt: true,
      confirmedAt: true,
      createdAt: true,
    },
  });

  if (executions.length === 0) {
    console.log("❌ No executions found");
    return;
  }

  console.log(`Found ${executions.length} recent executions:\n`);

  for (const exec of executions) {
    const statusEmoji =
      exec.status === "SUCCESS"
        ? "✅"
        : exec.status === "FAILED"
          ? "❌"
          : exec.status === "SKIPPED"
            ? "⏭️"
            : "⏳";

    const latencyMs = exec.confirmedAt
      ? Math.round(
          (exec.confirmedAt.getTime() - exec.discoveredAt.getTime()) / 1
        )
      : null;

    console.log(`${statusEmoji} ${exec.status}`);
    console.log(`   Token: ${exec.tokenSymbol ?? "Unknown"} (${exec.tokenName ?? "Unknown"})`);
    console.log(`   Mint: ${exec.tokenMint.slice(0, 8)}...`);
    console.log(`   Risk Score: ${exec.honeypotScore ?? "N/A"}`);
    console.log(
      `   Buy Amount: ${Number(exec.buyAmountLamports) / 1e9} SOL`
    );

    if (exec.outputAmountTokens) {
      console.log(`   Tokens Received: ${exec.outputAmountTokens}`);
    }

    if (exec.transactionSignature) {
      console.log(`   Tx: ${exec.transactionSignature.slice(0, 20)}...`);
    }

    if (exec.failureReason) {
      console.log(`   Failure: ${exec.failureReason}`);
    }

    if (exec.filterReason) {
      console.log(`   Filter: ${exec.filterReason}`);
    }

    if (latencyMs) {
      console.log(`   Latency: ${latencyMs}ms`);
    }

    console.log(`   Time: ${exec.createdAt.toISOString()}\n`);
  }

  // Summary stats
  const stats = executions.reduce(
    (acc, exec) => {
      acc[exec.status] = (acc[exec.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  console.log("📈 Summary:");
  Object.entries(stats).forEach(([status, count]) => {
    console.log(`   ${status}: ${count}`);
  });

  // Check if any were successful
  const successful = executions.filter((e) => e.success);
  if (successful.length > 0) {
    console.log(`\n🎉 ${successful.length} successful purchases!`);
  }

  // Check common failure reasons
  const failures = executions.filter((e) => e.failureReason);
  if (failures.length > 0) {
    console.log("\n⚠️ Common failure reasons:");
    const reasonCounts = failures.reduce(
      (acc, exec) => {
        const reason = exec.failureReason!;
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    Object.entries(reasonCounts)
      .sort(([, a], [, b]) => b - a)
      .forEach(([reason, count]) => {
        console.log(`   ${reason}: ${count}`);
      });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
