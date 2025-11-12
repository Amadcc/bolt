import { prisma } from "../../utils/db.js";
import { logger } from "../../utils/logger.js";
import { bot } from "../../bot/index.js";
import type { NewTokenEvent } from "../../types/snipe.js";
import { truncateAddress } from "../../utils/helpers.js";

interface SuccessPayload {
  userId: string;
  token: NewTokenEvent;
  signature: string;
  buyAmountLamports: bigint;
  outputAmount?: bigint;
}

interface FailurePayload {
  userId: string;
  token: NewTokenEvent;
  reason: string;
}

async function getTelegramId(userId: string): Promise<bigint | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true },
  });

  return user?.telegramId ?? null;
}

async function sendMessage(telegramId: bigint, text: string): Promise<void> {
  const chatId = Number(telegramId);

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (error) {
    logger.error("Failed to send auto-snipe notification", {
      telegramId: chatId,
      error,
    });
  }
}

export async function notifyAutoSnipeSuccess(payload: SuccessPayload): Promise<void> {
  const telegramId = await getTelegramId(payload.userId);
  if (!telegramId) {
    return;
  }

  const solSpent = Number(payload.buyAmountLamports) / 1e9;
  const tokensReceived =
    payload.outputAmount !== undefined
      ? Number(payload.outputAmount)
      : undefined;

  const textLines = [
    "✅ *Auto-Snipe Executed!*",
    ``,
    `Token: ${payload.token.symbol || truncateAddress(payload.token.mint)} `,
    `Mint: \`${truncateAddress(payload.token.mint)}\``,
    `Spent: ${solSpent.toFixed(4)} SOL`,
  ];

  if (tokensReceived !== undefined) {
    textLines.push(`Received: ${tokensReceived.toLocaleString()} tokens`);
  }

  textLines.push(
    `Signature: \`${payload.signature}\``,
    `[View on Solscan](https://solscan.io/tx/${payload.signature})`
  );

  await sendMessage(telegramId, textLines.join("\n"));
}

export async function notifyAutoSnipeFailure(payload: FailurePayload): Promise<void> {
  const telegramId = await getTelegramId(payload.userId);
  if (!telegramId) {
    return;
  }

  const text =
    `⚠️ *Auto-Snipe Update*\n\n` +
    `Token: ${payload.token.symbol || truncateAddress(payload.token.mint)}\n` +
    `Reason: ${payload.reason}`;

  await sendMessage(telegramId, text);
}

export async function notifyAutoSnipeSkipped(payload: FailurePayload): Promise<void> {
  await notifyAutoSnipeFailure(payload);
}
