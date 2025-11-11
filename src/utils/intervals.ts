import { logger } from "./logger.js";

const activeIntervals = new Map<NodeJS.Timeout, string>();

export function registerInterval(
  callback: () => void,
  intervalMs: number,
  label: string
): NodeJS.Timeout {
  const wrappedCallback = () => {
    try {
      callback();
    } catch (error) {
      logger.error("Interval callback failed", { label, error });
    }
  };

  const handle = setInterval(wrappedCallback, intervalMs);
  activeIntervals.set(handle, label);
  return handle;
}

export function clearRegisteredInterval(handle: NodeJS.Timeout): void {
  clearInterval(handle);
  activeIntervals.delete(handle);
}

export function clearAllIntervals(): void {
  for (const [handle, label] of activeIntervals.entries()) {
    clearInterval(handle);
    logger.info("Cleared interval", { label });
    activeIntervals.delete(handle);
  }
}
