import { prisma } from "../../utils/db.js";
import { logger } from "../../utils/logger.js";
import type { Context, SessionData } from "../views/index.js";

const USER_CACHE_TTL_MS = 60_000; // 60s cache – balances refresh faster anyway

export interface CachedWalletSummary {
  id: string;
  publicKey: string;
  encryptedPrivateKey: string;
  chain: string;
  isActive: boolean;
  createdAt: Date;
}

export interface CachedUserContext {
  userId: string;
  telegramId: bigint;
  username: string | null;
  subscriptionTier: string;
  allowPasswordReuse: boolean;
  wallets: CachedWalletSummary[];
  activeWallet?: CachedWalletSummary;
  cachedAt: number;
}

type RuntimeContext = Context & { __userContext?: CachedUserContext };

function setContextCache(ctx: Context, payload: CachedUserContext): void {
  ctx.session.cachedUserContext = payload;
  (ctx as RuntimeContext).__userContext = payload;
}

function getContextCache(
  ctx: Context,
  options?: { forceRefresh?: boolean }
): CachedUserContext | undefined {
  if (options?.forceRefresh) {
    return undefined;
  }

  const runtime = ctx as RuntimeContext;
  if (runtime.__userContext) {
    return runtime.__userContext;
  }

  const cached = ctx.session.cachedUserContext;
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL_MS) {
    runtime.__userContext = cached;
    return cached;
  }

  return undefined;
}

export async function getUserContext(
  ctx: Context,
  options?: { forceRefresh?: boolean }
): Promise<CachedUserContext> {
  if (!ctx.from) {
    throw new Error("Missing Telegram sender context");
  }

  const cached = getContextCache(ctx, options);
  if (cached) {
    return cached;
  }

  const telegramId = BigInt(ctx.from.id);

  let user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: { orderBy: { createdAt: "desc" } } },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId,
        username: ctx.from.username ?? null,
      },
      include: { wallets: { orderBy: { createdAt: "desc" } } },
    });

    logger.info("Provisioned user automatically during getUserContext()", {
      telegramId,
    });
  }

  const activeWallet =
    user.wallets.find((wallet: { isActive: boolean }) => wallet.isActive) ??
    user.wallets[0];

  const payload: CachedUserContext = {
    userId: user.id,
    telegramId: user.telegramId,
    username: user.username,
    subscriptionTier: user.subscriptionTier,
    allowPasswordReuse: user.allowPasswordReuse,
    wallets: user.wallets.map(
      (wallet: {
        id: string;
        publicKey: string;
        encryptedPrivateKey: string;
        chain: string;
        isActive: boolean;
        createdAt: Date;
      }) => ({
        id: wallet.id,
        publicKey: wallet.publicKey,
        encryptedPrivateKey: wallet.encryptedPrivateKey,
        chain: wallet.chain,
        isActive: wallet.isActive,
        createdAt: wallet.createdAt,
      })
    ),
    activeWallet,
    cachedAt: Date.now(),
  };

  setContextCache(ctx, payload);
  logger.debug("User context refreshed from database", {
    telegramId: ctx.from.id,
    walletCount: payload.wallets.length,
  });
  return payload;
}

export function invalidateUserContext(ctx: Context): void {
  const runtime = ctx as RuntimeContext;
  runtime.__userContext = undefined;
  delete (ctx.session as SessionData).cachedUserContext;
}
