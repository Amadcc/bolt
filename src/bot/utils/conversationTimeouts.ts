import { registerInterval } from "../../utils/intervals.js";
import { logger } from "../../utils/logger.js";

interface ConversationTimeoutEntry {
  key: string;
  expiresAt: number;
  onExpire: () => Promise<void> | void;
}

const CLEANUP_INTERVAL_MS = 30_000;
export const DEFAULT_CONVERSATION_TTL_MS = 5 * 60 * 1000;
export const CONVERSATION_TOPICS = {
  walletPassword: "wallet_password",
  unlockPassword: "unlock_password",
  awaitingInput: "awaiting_input",
} as const;

const timeouts = new Map<string, ConversationTimeoutEntry>();

registerInterval(() => {
  const now = Date.now();
  for (const [key, entry] of timeouts.entries()) {
    if (entry.expiresAt <= now) {
      timeouts.delete(key);
      Promise.resolve()
        .then(() => entry.onExpire())
        .catch((error) => {
          logger.error("Conversation timeout handler failed", {
            key,
            error,
          });
        });
    }
  }
}, CLEANUP_INTERVAL_MS, "conversation-timeouts");

export function scheduleConversationTimeout(
  key: string,
  ttlMs: number,
  onExpire: () => Promise<void> | void
): void {
  timeouts.set(key, {
    key,
    expiresAt: Date.now() + ttlMs,
    onExpire,
  });
}

export function cancelConversationTimeout(key: string): void {
  timeouts.delete(key);
}

export function buildConversationKey(
  telegramId: number,
  topic: string
): string {
  return `${topic}:${telegramId}`;
}
