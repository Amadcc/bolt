import { snipeOrchestrator } from "./orchestrator.js";
import { logger } from "../../utils/logger.js";

let initialized = false;

export async function initializeSnipe(): Promise<void> {
  const enabled = process.env.SNIPE_ENABLED !== "false";
  if (!enabled) {
    logger.warn("Token Sniper disabled via SNIPE_ENABLED env flag");
    return;
  }

  if (initialized) {
    return;
  }

  await snipeOrchestrator.start();
  initialized = true;
}

export async function shutdownSnipe(): Promise<void> {
  if (!initialized) {
    return;
  }
  await snipeOrchestrator.stop();
  initialized = false;
}
