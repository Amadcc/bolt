import { prisma } from "../../utils/db.js";
import type { SnipeConfig } from "@prisma/client";

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  config: SnipeConfig;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function setCache(config: SnipeConfig): void {
  cache.set(config.userId, { config, cachedAt: Date.now() });
}

function getCache(userId: string): SnipeConfig | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(userId);
    return null;
  }
  return entry.config;
}

export async function getSnipeConfig(userId: string): Promise<SnipeConfig> {
  const cached = getCache(userId);
  if (cached) {
    return cached;
  }

  // Use upsert to prevent race condition when multiple requests
  // try to create config simultaneously
  const config = await prisma.snipeConfig.upsert({
    where: { userId },
    update: {}, // No updates on conflict, just return existing
    create: { userId },
  });

  setCache(config);
  return config;
}

type MutableConfigFields = Omit<
  SnipeConfig,
  "id" | "userId" | "createdAt" | "updatedAt" | "user"
>;

export async function updateSnipeConfig(
  userId: string,
  data: Partial<MutableConfigFields>
): Promise<SnipeConfig> {
  const config = await prisma.snipeConfig.upsert({
    where: { userId },
    create: {
      user: {
        connect: { id: userId },
      },
      ...data,
    },
    update: data,
  });

  setCache(config);
  return config;
}

export async function listActiveConfigs(): Promise<SnipeConfig[]> {
  const configs = await prisma.snipeConfig.findMany({
    where: { enabled: true },
  });

  configs.forEach(setCache);
  return configs;
}

export function invalidateSnipeConfig(userId: string): void {
  cache.delete(userId);
}
