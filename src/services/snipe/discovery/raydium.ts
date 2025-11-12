import { ProgramLogMonitor } from "./programLogs.js";
import type { DiscoverySource } from "../../../types/snipe.js";

const DEFAULT_PROGRAMS = [
  // Raydium Liquidity Pool V4
  "RVKd61ztZW9DsoN2qvN8EEEorDNCzyYp8eDRFe4hoVk",
  // Raydium Concentrated Liquidity (AmmV3)
  "CLMMfnrjJwyGt7sHkCv9iqWL8GMDJ9Zhutt8aNs5BDw",
];

function resolveProgramIds(envVar: string | undefined, fallback: string[]): string[] {
  if (!envVar || envVar.trim().length === 0) {
    return fallback;
  }

  return envVar
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export class RaydiumLogMonitor extends ProgramLogMonitor {
  constructor() {
    const programIds = resolveProgramIds(
      process.env.SNIPE_RAYDIUM_PROGRAM_IDS,
      DEFAULT_PROGRAMS
    );

    super({
      source: "raydium" as DiscoverySource,
      programIds,
    });
  }
}
