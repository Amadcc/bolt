import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkConfigs() {
  console.log('🔍 Checking Snipe Configurations...\n');

  // Get all users
  const users = await prisma.user.findMany({
    include: {
      snipeConfig: true,
      wallets: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  console.log(`📊 Total Users: ${users.length}\n`);

  for (const user of users) {
    console.log(`👤 User ID: ${user.id}`);
    console.log(`   Telegram: @${user.username || 'N/A'} (${user.telegramId})`);
    console.log(`   Created: ${user.createdAt.toISOString()}`);

    if (user.wallets && user.wallets.length > 0) {
      console.log(`   💰 Wallets: ${user.wallets.length}`);
      for (const wallet of user.wallets) {
        console.log(`      - ${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-8)} (${wallet.type})`);
      }
    } else {
      console.log(`   💰 Wallets: None`);
    }

    if (user.snipeConfig) {
      const sc = user.snipeConfig;
      console.log(`   🎯 Snipe Config:`);
      console.log(`      ✅ Enabled: ${sc.enabled}`);
      console.log(`      🤖 Auto-Trading: ${sc.autoTrading}`);
      console.log(`      💵 Buy Amount: ${Number(sc.buyAmountLamports) / 1e9} SOL`);
      console.log(`      📡 Sources: ${sc.enabledSources.join(', ')}`);
      console.log(`      🚨 Max Honeypot Risk: ${sc.maxHoneypotRisk}`);
      console.log(`      📊 Max Buys/Hour: ${sc.maxBuysPerHour}`);
      console.log(`      📅 Max Buys/Day: ${sc.maxBuysPerDay}`);

      if (sc.lastAutomationAt) {
        console.log(`      ⏰ Last Automation: ${sc.lastAutomationAt.toISOString()}`);
      }
    } else {
      console.log(`   🎯 Snipe Config: Not configured`);
    }
    console.log('');
  }

  // Check enabled configs
  const enabledConfigs = await prisma.snipeConfig.findMany({
    where: {
      enabled: true,
    },
    include: {
      user: true,
    },
  });

  console.log(`\n✅ Enabled Configs: ${enabledConfigs.length}`);

  const autoTradingConfigs = enabledConfigs.filter(c => c.autoTrading);
  console.log(`🤖 Auto-Trading Configs: ${autoTradingConfigs.length}`);

  if (autoTradingConfigs.length > 0) {
    console.log('\n🚀 Active Auto-Traders:');
    for (const config of autoTradingConfigs) {
      console.log(`   - @${config.user.username} (${config.user.telegramId})`);
      console.log(`     Sources: ${config.enabledSources.join(', ')}`);
      console.log(`     Buy: ${Number(config.buyAmountLamports) / 1e9} SOL`);
    }
  }

  await prisma.$disconnect();
}

checkConfigs().catch(console.error);
