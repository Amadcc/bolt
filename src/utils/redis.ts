import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL!);

redis.on("error", (err) => console.error("Redis error:", err));
redis.on("connect", () => console.log("✅ Redis connected"));

/**
 * MEDIUM-6: Non-blocking SCAN helper (replaces blocking KEYS)
 *
 * Iterates through all keys matching pattern using cursor-based SCAN.
 * This is non-blocking and safe for production use.
 *
 * @param pattern Redis key pattern (e.g., "session:*")
 * @param count Number of keys to scan per iteration (default: 100)
 * @returns Array of matching keys
 */
export async function redisScan(
  pattern: string,
  count: number = 100
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    // SCAN returns [cursor, keys]
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      count
    );

    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys;
}
