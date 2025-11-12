import EventEmitter from "events";
import { Buffer } from "buffer";
import { logger } from "../../../utils/logger.js";
import type { NewTokenEvent } from "../../../types/snipe.js";
import { asTokenMint, asLamports } from "../../../types/common.js";

interface PumpFunNewTokenPayload {
  mint: string;
  name: string;
  symbol: string;
  creator?: string;
  usd_market_cap?: number;
  liquidity?: number;
  tx?: string;
}

type PumpFunEvent = {
  type: string;
  data?: PumpFunNewTokenPayload;
};

export declare interface PumpFunMonitor {
  on(event: "ready", listener: () => void): this;
  on(event: "newToken", listener: (event: NewTokenEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export class PumpFunMonitor extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnects = 10;
  private readonly reconnectDelayMs = 5000;
  private readonly wsUrl: string;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(url?: string) {
    super();
    this.wsUrl = url ?? process.env.PUMPFUN_WS_URL ?? "wss://pumpportal.fun/api/data";
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSocket API not available in this runtime");
    }
    this.WebSocketImpl = WebSocket;
  }

  start(): void {
    if (this.ws) {
      return;
    }

    logger.info("Connecting to Pump.fun stream", { url: this.wsUrl });
    this.ws = new this.WebSocketImpl(this.wsUrl);

    this.ws.addEventListener("open", () => {
      logger.info("Connected to Pump.fun stream");
      this.reconnectAttempts = 0;
      this.emit("ready");

      this.ws?.send(
        JSON.stringify({
          method: "subscribeNewToken",
        })
      );
    });

    this.ws.addEventListener("message", (event: { data: unknown }) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : Buffer.isBuffer(event.data)
            ? event.data.toString("utf-8")
            : Buffer.from(event.data as ArrayBuffer).toString("utf-8");

      // DEBUG: Log all incoming messages to diagnose subscription issues
      logger.debug("Pump.fun message received", {
        messageLength: raw.length,
        messagePreview: raw.substring(0, 200)
      });

      this.handleMessage(raw);
    });

    this.ws.addEventListener("error", (event: Event) => {
      const error = (event as { error?: Error }).error ?? null;
      logger.error("Pump.fun stream error", {
        error,
        type: event.type,
        timestamp: new Date().toISOString()
      });
      this.emit("error", error ?? new Error("Pump.fun stream error"));
    });

    this.ws.addEventListener("close", (event) => {
      logger.warn("Pump.fun stream closed", {
        code: event.code,
        reason: event.reason || "(no reason provided)",
        wasClean: event.wasClean,
        timestamp: new Date().toISOString()
      });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.ws = null;

    if (this.reconnectAttempts >= this.maxReconnects) {
      logger.error("Pump.fun monitor exhausted reconnect attempts");
      this.emit("error", new Error("Pump.fun stream unavailable"));
      return;
    }

    this.reconnectAttempts += 1;
    const delay = this.reconnectDelayMs * this.reconnectAttempts;
    logger.info("Reconnecting Pump.fun stream", {
      attempt: this.reconnectAttempts,
      delay,
    });

    setTimeout(() => this.start(), delay);
  }

  private handleMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw) as any;

      // Skip subscription confirmation messages
      if ("message" in payload && typeof payload.message === "string") {
        logger.debug("Pump.fun subscription message", { message: payload.message });
        return;
      }

      // Check if this is a new token event (has mint field)
      if (!("mint" in payload) || typeof payload.mint !== "string") {
        logger.debug("Skipping non-token Pump.fun message", {
          hasType: "type" in payload,
          hasMint: "mint" in payload,
          keys: Object.keys(payload)
        });
        return;
      }

      // Parse as token creation event
      let tokenMint;
      try {
        tokenMint = asTokenMint(payload.mint);
      } catch {
        logger.warn("Pump.fun emitted invalid mint", { mint: payload.mint });
        return;
      }

      const event: NewTokenEvent = {
        source: "pumpfun",
        mint: tokenMint,
        name: payload.name || "Unknown",
        symbol: payload.symbol || "UNKNOWN",
        creator: payload.creator || payload.traderPublicKey,
        liquidityLamports: asLamports(BigInt(Math.max(0, payload.liquidity ?? payload.initialBuyAmountSol ? Math.floor((payload.initialBuyAmountSol * 1e9)) : 0))),
        marketCapUsd: payload.usd_market_cap ?? payload.marketCapSol ? payload.marketCapSol * 150 : undefined,
        tx: payload.signature || "",
        timestamp: new Date(),
      };

      logger.info("New Pump.fun token detected", {
        mint: event.mint,
        symbol: event.symbol,
        signature: event.tx
      });

      this.emit("newToken", event);
    } catch (error) {
      logger.error("Failed to parse Pump.fun payload", { raw, error });
    }
  }

  stop(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
