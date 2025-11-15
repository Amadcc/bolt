import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkSnipes() {
  console.log('🔫 Recent Snipe Executions:\n');

  const executions = await prisma.snipeExecution.findMany({
    orderBy: { createdAt: 'desc' },
    take: 15,
  });

  console.log(`Total executions: ${executions.length}\n`);

  const stats = {
    success: 0,
    failed: 0,
    honeypot: 0,
    jupiter: 0,
    timeout: 0,
  };

  for (const exec of executions) {
    const time = exec.createdAt.toLocaleTimeString('en-US', { hour12: false });
    console.log(`[${time}] ${exec.tokenSymbol || 'Unknown'} (${exec.tokenMint.slice(0, 8)}...)`);
    console.log(`   Status: ${exec.status}`);
    console.log(`   Honeypot Score: ${exec.honeypotScore}/100`);

    if (exec.success) {
      console.log(`   ✅ SUCCESS - Tx: ${exec.transactionSignature?.slice(0, 12)}...`);
      stats.success++;
    } else if (exec.failureReason) {
      console.log(`   ❌ FAILED: ${exec.failureReason}`);
      stats.failed++;

      if (exec.failureReason.includes('Risk score')) {
        stats.honeypot++;
      } else if (exec.failureReason.includes('quotes')) {
        stats.jupiter++;
      } else if (exec.failureReason.includes('timeout')) {
        stats.timeout++;
      }
    }
    console.log('');
  }

  console.log('📈 Statistics:');
  console.log(`   ✅ Successful: ${stats.success}`);
  console.log(`   ❌ Failed: ${stats.failed}`);
  console.log(`      - Honeypot blocked: ${stats.honeypot}`);
  console.log(`      - Jupiter quotes failed: ${stats.jupiter}`);
      console.log(`      - Timeout: ${stats.timeout}`);

  await prisma.$disconnect();
}

checkSnipes().catch(console.error);
