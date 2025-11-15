import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});

async function debugQuery() {
  console.log('🔍 Debugging SnipeConfig query...\n');

  // Same query as in configService
  console.log('Query: SELECT * FROM SnipeConfig WHERE enabled = true\n');

  const configs = await prisma.snipeConfig.findMany({
    where: { enabled: true },
  });

  console.log(`\n📊 Result: Found ${configs.length} configs\n`);

  if (configs.length > 0) {
    console.log('✅ Configs found:');
    for (const config of configs) {
      console.log(`  - User ID: ${config.userId}`);
      console.log(`    Enabled: ${config.enabled}`);
      console.log(`    Auto-Trading: ${config.autoTrading}`);
      console.log(`    Sources: ${config.enabledSources.join(', ')}`);
      console.log('');
    }
  } else {
    console.log('❌ No configs found with enabled=true');

    // Check all configs
    console.log('\nChecking ALL configs in database...');
    const allConfigs = await prisma.snipeConfig.findMany();
    console.log(`Total configs: ${allConfigs.length}\n`);

    for (const config of allConfigs) {
      console.log(`  - User ID: ${config.userId}`);
      console.log(`    Enabled: ${config.enabled} (type: ${typeof config.enabled})`);
      console.log(`    Auto-Trading: ${config.autoTrading}`);
      console.log('');
    }
  }

  await prisma.$disconnect();
}

debugQuery().catch(console.error);
