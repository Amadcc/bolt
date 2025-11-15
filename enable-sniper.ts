import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function enableSniper() {
  console.log('🎯 Enabling sniper for @oilmarket_uz...\n');

  const userId = 'd1b51da4-516a-4a45-8913-45a16dd35ff8';

  const updated = await prisma.snipeConfig.update({
    where: { userId },
    data: {
      enabled: true,
    },
  });

  console.log('✅ Sniper ENABLED!');
  console.log(`   User ID: ${updated.userId}`);
  console.log(`   Enabled: ${updated.enabled}`);
  console.log(`   Auto-Trading: ${updated.autoTrading}`);
  console.log(`   Sources: ${updated.enabledSources.join(', ')}`);
  console.log(`   Buy Amount: ${Number(updated.buyAmountLamports) / 1e9} SOL`);
  console.log(`   Max Honeypot Risk: ${updated.maxHoneypotRisk}`);
  console.log(`   Max Buys/Hour: ${updated.maxBuysPerHour}`);
  console.log(`   Max Buys/Day: ${updated.maxBuysPerDay}`);

  await prisma.$disconnect();
}

enableSniper().catch(console.error);
