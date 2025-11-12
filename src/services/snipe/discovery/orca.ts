import { ProgramLogMonitor } from "./programLogs.js";
import type { DiscoverySource } from "../../../types/snipe.js";

const DEFAULT_PROGRAMS = [
  // Orca Whirlpool program
  "whirLbMiicVwqY9oi4xP4Gggq9fyVwZ7ZTf5JvhCz9w",
  // Orca legacy token-swap program
  "9W5oKCL1n6AuF4XHzkwmo7aXstixSeKuuNHYsYdM9a7r",
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

export class OrcaLogMonitor extends ProgramLogMonitor {
  constructor() {
    const programIds = resolveProgramIds(
      process.env.SNIPE_ORCA_PROGRAM_IDS,
      DEFAULT_PROGRAMS
    );

    super({
      source: "orca" as DiscoverySource,
      programIds,
    });
  }
}
