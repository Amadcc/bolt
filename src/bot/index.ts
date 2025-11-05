import { Bot, Context, session, SessionFlavor } from "grammy";
import { prisma } from "../utils/db.js";
import {
  handleCreateWallet,
  handlePasswordInput,
} from "./commands/createWallet.js";
import { handleSwap } from "./commands/swap.js";
import { handleBuy } from "./commands/buy.js";
import { handleSell } from "./commands/sell.js";
import { handleUnlock, handleLock, handleStatus, handleUnlockPasswordInput } from "./commands/session.js";
import { logger } from "../utils/logger.js";

interface SessionData {
  walletId?: string;
  encryptedKey?: string;
  settings?: {
    slippage: number;
    autoApprove: boolean;
  };
  // Conversation state
  awaitingPasswordForWallet?: boolean;
  awaitingPasswordForUnlock?: boolean;
  swapConversationStep?: "inputMint" | "outputMint" | "amount" | "password";
  swapConversationData?: {
    inputMint?: string;
    outputMint?: string;
    amount?: string;
  };
}

type MyContext = Context & SessionFlavor<SessionData>;

export const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);

// Session middleware
bot.use(
  session({
    initial: (): SessionData => ({
      settings: { slippage: 1, autoApprove: false },
    }),
  })
);

// Middleware для проверки/создания пользователя
bot.use(async (ctx, next) => {
  if (ctx.from) {
    let user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          telegramId: BigInt(ctx.from.id),
          username: ctx.from.username || null,
        },
      });
      logger.info("New user created", {
        userId: user.id,
        telegramId: ctx.from.id,
      });
    }
  }

  await next();
});

// Commands
bot.command("start", async (ctx) => {
  await ctx.reply(
    `🚀 *Token Sniper Bot*\n\n` +
      `Welcome! I help you snipe new tokens safely.\n\n` +
      `Quick Actions:\n` +
      `/buy BONK 0.1 - Buy tokens with SOL\n` +
      `/sell BONK 1000000 - Sell tokens for SOL\n\n` +
      `Other Commands:\n` +
      `/createwallet - Create a new wallet\n` +
      `/wallet - View your wallet\n` +
      `/swap - Advanced token swaps\n` +
      `/balance - Check balance\n` +
      `/help - Get help`,
    { parse_mode: "Markdown" }
  );
});

bot.command("wallet", async (ctx) => {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    include: { wallets: true },
  });

  if (!user?.wallets.length) {
    await ctx.reply(
      "💼 You don't have a wallet yet.\n\n" + "Use /createwallet to create one."
    );
  } else {
    const wallet = user.wallets[0];
    await ctx.reply(
      `💼 *Your Wallet*\n\n` +
        `Address: \`${wallet.publicKey}\`\n` +
        `Chain: ${wallet.chain}\n` +
        `Status: ${wallet.isActive ? "🟢 Active" : "🔴 Inactive"}`,
      { parse_mode: "Markdown" }
    );
  }
});

bot.command("createwallet", async (ctx) => {
  // Set conversation state
  ctx.session.awaitingPasswordForWallet = true;
  await handleCreateWallet(ctx);
});

bot.command("buy", handleBuy);
bot.command("sell", handleSell);
bot.command("swap", handleSwap);

bot.command("unlock", handleUnlock);
bot.command("lock", handleLock);
bot.command("status", handleStatus);

bot.command("help", async (ctx) => {
  await ctx.reply(
    "📚 *Help & Support*\n\n" +
      "This is a token sniper bot for Solana.\n\n" +
      "*Trading Commands:*\n" +
      "/buy - Buy tokens with SOL\n" +
      "  Example: `/buy BONK 0.1`\n\n" +
      "/sell - Sell tokens for SOL\n" +
      "  Example: `/sell BONK 1000000`\n\n" +
      "/swap - Advanced token swaps\n" +
      "  Example: `/swap USDC BONK 10`\n\n" +
      "*Wallet Commands:*\n" +
      "/createwallet - Create a new wallet\n" +
      "/wallet - View your wallet\n" +
      "/balance - Check balance\n\n" +
      "More features coming soon!",
    { parse_mode: "Markdown" }
  );
});

// Handle text messages (for password input)
bot.on("message:text", async (ctx, next) => {
  // Check if we're waiting for password input for wallet creation
  if (ctx.session.awaitingPasswordForWallet) {
    const password = ctx.message.text;

    // Reset conversation state
    ctx.session.awaitingPasswordForWallet = false;

    // Handle password input
    await handlePasswordInput(ctx, password);
    return; // Don't call next() - we handled this message
  }

  // Check if we're waiting for password input for unlock
  if (ctx.session.awaitingPasswordForUnlock) {
    const password = ctx.message.text;

    // Reset conversation state
    ctx.session.awaitingPasswordForUnlock = false;

    // Handle unlock password input
    await handleUnlockPasswordInput(ctx, password);
    return; // Don't call next() - we handled this message
  }

  // Not in a conversation flow, continue to next handler
  await next();
});

// Error handler
bot.catch((err) => {
  logger.error("Bot error", { error: err });
});

logger.info("Bot initialized");
