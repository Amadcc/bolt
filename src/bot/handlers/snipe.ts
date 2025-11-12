import type { Context } from "../views/index.js";
import { navigateToPage } from "../views/index.js";
import { getUserContext } from "../utils/userContext.js";
import { getSnipeConfig, updateSnipeConfig } from "../../services/snipe/configService.js";
import {
  automationLeaseActive,
  establishAutomationLease,
  revokeAutomationLease,
} from "../../services/snipe/automationService.js";
import {
  buildConversationKey,
  cancelConversationTimeout,
  CONVERSATION_TOPICS,
  DEFAULT_CONVERSATION_TTL_MS,
  scheduleConversationTimeout,
} from "../utils/conversationTimeouts.js";

export async function handleSnipeActionCallback(
  ctx: Context,
  action: string,
  params: string[]
): Promise<void> {
  const userContext = await getUserContext(ctx);
  const config = await getSnipeConfig(userContext.userId);

  switch (action) {
    case "toggle":
      await updateSnipeConfig(userContext.userId, { enabled: !config.enabled });
      await ctx.answerCallbackQuery(config.enabled ? "Auto-snipe disabled" : "Auto-snipe enabled");
      await navigateToPage(ctx, "snipe");
      return;

    case "toggle_auto":
      if (!config.enabled) {
        await ctx.answerCallbackQuery("Enable auto-snipe first");
        return;
      }
      await updateSnipeConfig(userContext.userId, {
        autoTrading: !config.autoTrading,
      });
      await ctx.answerCallbackQuery(
        config.autoTrading ? "Auto-trading paused" : "Auto-trading enabled"
      );
      await navigateToPage(ctx, "snipe");
      return;

    case "set_amount": {
      const solValue = Number(params[0]);
      if (!Number.isFinite(solValue) || solValue <= 0) {
        await ctx.answerCallbackQuery("Invalid amount");
        return;
      }
      const lamports = BigInt(Math.round(solValue * 1e9));
      await updateSnipeConfig(userContext.userId, {
        buyAmountLamports: lamports,
      });
      await ctx.answerCallbackQuery(`Buy amount set to ${solValue} SOL`);
      await navigateToPage(ctx, "snipe");
      return;
    }

    case "set_risk": {
      const risk = parseInt(params[0] ?? "30", 10);
      if (Number.isNaN(risk) || risk < 5 || risk > 95) {
        await ctx.answerCallbackQuery("Invalid risk score");
        return;
      }
      await updateSnipeConfig(userContext.userId, {
        maxHoneypotRisk: risk,
      });
      await ctx.answerCallbackQuery(`Max risk set to ${risk}`);
      await navigateToPage(ctx, "snipe");
      return;
    }

    case "grant_auto": {
      const hasAutomation = await automationLeaseActive(userContext.userId);
      if (hasAutomation) {
        await ctx.answerCallbackQuery("Automation already active");
        return;
      }
      ctx.session.awaitingPasswordForSnipe = true;
      ctx.session.pendingSnipeAction = { type: "automation" };
      scheduleSnipePasswordTimeout(ctx);
      await ctx.answerCallbackQuery("Send password securely");
      await ctx.reply(
        "🔐 *Grant Automation Access*\n\n" +
          "Send your wallet password in this chat. It will be deleted immediately.\n\n" +
          "Automation leases expire automatically after 15 minutes.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    case "revoke_auto":
      await revokeAutomationLease(userContext.userId);
      ctx.session.awaitingPasswordForSnipe = false;
      ctx.session.pendingSnipeAction = undefined;
      await ctx.answerCallbackQuery("Automation revoked");
      await navigateToPage(ctx, "snipe");
      return;

    case "history":
      await ctx.answerCallbackQuery("Execution history coming soon");
      return;

    case "refresh":
      await ctx.answerCallbackQuery("Refreshing...");
      await navigateToPage(ctx, "snipe");
      return;

    default:
      await ctx.answerCallbackQuery("❌ Unknown action");
  }
}

export async function handleSnipeAutomationPasswordInput(
  ctx: Context,
  password: string
): Promise<void> {
  cancelSnipePasswordTimeout(ctx);
  ctx.session.awaitingPasswordForSnipe = false;

  // SECURITY: Delete password message immediately to prevent visibility
  try {
    await ctx.deleteMessage();
  } catch (error) {
    // Best effort - message may already be deleted or inaccessible
  }

  if (!ctx.session.pendingSnipeAction) {
    await ctx.reply(
      "⚠️ No automation request pending. Tap *Grant Automation* again.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const userContext = await getUserContext(ctx);
  const result = await establishAutomationLease(userContext.userId, password);

  ctx.session.pendingSnipeAction = undefined;

  if (!result.success) {
    await ctx.reply(
      `❌ Failed to grant automation access:\n${result.error}\n\nPlease try again.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const expiresAt = result.value.toLocaleTimeString();
  await ctx.reply(
    `✅ Automation lease active until ${expiresAt}\nAuto-trading will pause automatically when the lease expires.`,
    { parse_mode: "Markdown" }
  );

  await navigateToPage(ctx, "snipe");
}

function scheduleSnipePasswordTimeout(ctx: Context): void {
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (!telegramId || !chatId) {
    return;
  }

  const key = buildConversationKey(
    telegramId,
    CONVERSATION_TOPICS.snipePassword
  );

  scheduleConversationTimeout(key, DEFAULT_CONVERSATION_TTL_MS, async () => {
    if (!ctx.session.awaitingPasswordForSnipe) {
      return;
    }
    ctx.session.awaitingPasswordForSnipe = false;
    ctx.session.pendingSnipeAction = undefined;
    await ctx.api.sendMessage(
      chatId,
      "⏰ Automation setup timed out. Tap *Grant Automation* again.",
      { parse_mode: "Markdown" }
    );
  });
}

function cancelSnipePasswordTimeout(ctx: Context): void {
  const telegramId = ctx.from?.id;
  if (!telegramId) {
    return;
  }

  const key = buildConversationKey(
    telegramId,
    CONVERSATION_TOPICS.snipePassword
  );
  cancelConversationTimeout(key);
}
