import { PumpFunMonitor } from "./discovery/pumpfun.js";
import { RaydiumLogMonitor } from "./discovery/raydium.js";
import { OrcaLogMonitor } from "./discovery/orca.js";
import { listActiveConfigs } from "./configService.js";
import { snipeFilter } from "./filter.js";
import { snipeExecutor } from "./executor.js";
import { logger } from "../../utils/logger.js";
import type { NewTokenEvent } from "../../types/snipe.js";
import { batchAutomationLeaseActive } from "./automationService.js";
import { recordSnipeOpportunity } from "../../utils/metrics.js";

interface DiscoveryMonitor {
  name: string;
  enabled: boolean;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  on: (event: "newToken", listener: (event: NewTokenEvent) => void) => void;
  onError?: (listener: (error: Error) => void) => void;
}

export class SnipeOrchestrator {
  private readonly monitors: DiscoveryMonitor[] = [];
  private running = false;
  private activeUsers = new Set<string>();

  constructor() {
    if (process.env.SNIPE_SOURCE_PUMPFUN_ENABLED !== "false") {
      const monitor = new PumpFunMonitor();
      this.monitors.push({
        name: "pumpfun",
        enabled: true,
        start: () => monitor.start(),
        stop: () => monitor.stop(),
        on: (event, listener) => monitor.on(event, listener),
        onError: (listener) => monitor.on("error", listener),
      });
    }

    if (process.env.SNIPE_SOURCE_RAYDIUM_ENABLED !== "false") {
      const monitor = new RaydiumLogMonitor();
      this.monitors.push({
        name: "raydium",
        enabled: true,
        start: () => monitor.start(),
        stop: () => monitor.stop(),
        on: (event, listener) => monitor.on(event, listener),
        onError: (listener) => monitor.on("error", listener),
      });
    }

    if (process.env.SNIPE_SOURCE_ORCA_ENABLED !== "false") {
      const monitor = new OrcaLogMonitor();
      this.monitors.push({
        name: "orca",
        enabled: true,
        start: () => monitor.start(),
        stop: () => monitor.stop(),
        on: (event, listener) => monitor.on(event, listener),
        onError: (listener) => monitor.on("error", listener),
      });
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    for (const monitor of this.monitors) {
      monitor.on("newToken", (event) => {
        this.handleEvent(event).catch((error) => {
          logger.error("Snipe orchestrator event handler failed", {
            error,
            source: monitor.name,
          });
        });
      });

      monitor.onError?.((error) => {
        logger.error("Snipe discovery error", {
          source: monitor.name,
          error,
        });
      });

      await monitor.start();
      logger.info("Snipe discovery monitor started", { monitor: monitor.name });
    }

    logger.info("Snipe orchestrator started", {
      monitorCount: this.monitors.length,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    await Promise.all(
      this.monitors.map(async (monitor) => {
        await monitor.stop();
        logger.info("Snipe discovery monitor stopped", { monitor: monitor.name });
      })
    );
    this.activeUsers.clear();
    logger.info("Snipe orchestrator stopped");
  }

  private async handleEvent(event: NewTokenEvent): Promise<void> {
    logger.debug("Orchestrator received token event", {
      source: event.source,
      mint: event.mint,
      symbol: event.symbol
    });

    const configs = await listActiveConfigs();
    logger.debug("Active configs count", { count: configs.length });

    // Batch check all automation leases in one Redis call (N+1 optimization)
    const userIds = configs.map((c) => c.userId);
    const leaseMap = await batchAutomationLeaseActive(userIds);

    await Promise.allSettled(
      configs.map(async (config) => {
        if (!config.autoTrading) {
          return;
        }

        if (!this.running) {
          return;
        }

        const hasLease = leaseMap.get(config.userId) ?? false;
        if (!hasLease) {
          return;
        }

        const filterResult = snipeFilter.apply(config, event);

        if (!filterResult.success) {
          logger.debug("Token rejected by filter", {
            userId: config.userId,
            reason: filterResult.error,
          });
          recordSnipeOpportunity("rejected");
          return;
        }

        const accepted = filterResult.value;
        if (!accepted) {
          recordSnipeOpportunity("rejected");
          return;
        }

        if (this.activeUsers.has(config.userId)) {
          logger.debug("Skipping snipe, user already executing", {
            userId: config.userId,
          });
          return;
        }

        this.activeUsers.add(config.userId);

        try {
          recordSnipeOpportunity("accepted");
          const result = await snipeExecutor.execute(
            config.userId,
            config,
            event
          );

          if (!result.success) {
            logger.warn("Auto-snipe execution failed", {
              userId: config.userId,
              reason: result.error,
            });
          }
        } finally {
          this.activeUsers.delete(config.userId);
        }
      })
    );
  }
}

export const snipeOrchestrator = new SnipeOrchestrator();
