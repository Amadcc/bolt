import type { HoneypotCheckResult } from "../../types/honeypot.js";
import { getHoneypotDetector } from "../../services/honeypot/detector.js";
import { retry } from "../../utils/helpers.js";

const HONEYPOT_RETRY_OPTIONS = {
  maxRetries: 3,
  backoff: "exponential" as const,
  baseDelay: 500,
};

export async function performHoneypotAnalysis(
  tokenMint: string
): Promise<HoneypotCheckResult> {
  const detector = getHoneypotDetector();

  return retry(async () => {
    const result = await detector.check(tokenMint);
    if (!result.success) {
      throw new Error(result.error?.type ?? "HONEYPOT_CHECK_FAILED");
    }
    return result.value;
  }, HONEYPOT_RETRY_OPTIONS);
}
