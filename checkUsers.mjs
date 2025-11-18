import { prisma } from "./src/utils/db.js";

const users = await prisma.user.findMany({
  take: 20,
  orderBy: { createdAt: 'desc' },
  select: {
    id: true,
    telegramId: true,
    username: true,
    createdAt: true,
  },
});

console.log(`Found ${users.length} users (showing last 20):`);
users.forEach(user => {
  const uname = user.username || '(null)';
  const tid = user.telegramId.toString();
  const date = user.createdAt.toISOString().slice(0, 10);
  console.log(`- ${uname.slice(0, 40)} | TID: ${tid} | ${date}`);
});

const total = await prisma.user.count();
console.log(`\nTotal users in DB: ${total}`);

await prisma.$disconnect();
