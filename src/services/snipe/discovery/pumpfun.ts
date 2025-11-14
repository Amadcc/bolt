import EventEmitter from "events";
import { Buffer } from "buffer";
import { logger } from "../../../utils/logger.js";
import type { NewTokenEvent } from "../../../types/snipe.js";
import { asTokenMint, asLamports } from "../../../types/common.js";
import { RateLimiter } from "../../../utils/security.js";
import {
  recordPumpFunTokenDetected,
  recordPumpFunMessageSkipped,
  recordPumpFunParseError,
  recordPumpFunReconnection,
  setPumpFunConnectionState,
  updatePumpFunLastMessageTimestamp,
  observePumpFunMessageProcessing,
} from "../../../utils/metrics.js";

interface PumpFunNewTokenPayload {
  mint: string;
  name?: string;
  symbol?: string;
  creator?: string;
  traderPublicKey?: string;
  usd_market_cap?: number;
  marketCapSol?: number;
  liquidity?: number;
  initialBuyAmountSol?: number;
  signature?: string;
  tx?: string;
}

interface PumpFunSubscriptionMessage {
  message: string;
}

type PumpFunMessage = PumpFunNewTokenPayload | PumpFunSubscriptionMessage;

export declare interface PumpFunMonitor {
  on(event: "ready", listener: () => void): this;
  on(event: "newToken", listener: (event: NewTokenEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export class PumpFunMonitor extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnects = 10;
  private readonly reconnectBaseDelayMs = 2000; // Start with 2 seconds
  private readonly wsUrl: string;
  private readonly WebSocketImpl: typeof WebSocket;

  // ========== 2025 OPTIMIZATIONS: Health Monitoring ==========
  private pingIntervalId: NodeJS.Timeout | null = null;
  private lastMessageTime = Date.now();
  private readonly pingIntervalMs = 30000; // 30 seconds - check connection health
  private readonly messageTimeoutMs = 90000; // 90 seconds - no messages = stale connection

  // ========== 2025 OPTIMIZATIONS: Rate Limiting ==========
  private readonly messageRateLimiter = new RateLimiter(
    100, // max 100 messages
    60000 // per 60 seconds (prevents spam/DDoS)
  );

  constructor(url?: string) {
    super();
    this.wsUrl = url ?? process.env.PUMPFUN_WS_URL ?? "wss://pumpportal.fun/api/data";
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSocket API not available in this runtime");
    }
    this.WebSocketImpl = WebSocket;

    // Initial state
    setPumpFunConnectionState("disconnected");
  }

  start(): void {
    if (this.ws) {
      return;
    }

    logger.info("Connecting to Pump.fun stream", { url: this.wsUrl });
    setPumpFunConnectionState("reconnecting");
    this.ws = new this.WebSocketImpl(this.wsUrl);

    this.ws.addEventListener("open", () => {
      logger.info("Connected to Pump.fun stream");
      this.reconnectAttempts = 0;
      this.lastMessageTime = Date.now();
      setPumpFunConnectionState("connected");
      this.emit("ready");

      // Subscribe to new tokens
      this.ws?.send(
        JSON.stringify({
          method: "subscribeNewToken",
        })
      );

      // ========== 2025 OPTIMIZATION: Start heartbeat monitoring ==========
      this.startHeartbeat();
    });

    this.ws.addEventListener("message", (event: { data: unknown }) => {
      // ========== 2025 OPTIMIZATION: Update last message time for heartbeat ==========
      this.lastMessageTime = Date.now();
      updatePumpFunLastMessageTimestamp();

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
      setPumpFunConnectionState("disconnected");
      recordPumpFunReconnection("error");
      this.emit("error", error ?? new Error("Pump.fun stream error"));
    });

    this.ws.addEventListener("close", (event) => {
      logger.warn("Pump.fun stream closed", {
        code: event.code,
        reason: event.reason || "(no reason provided)",
        wasClean: event.wasClean,
        timestamp: new Date().toISOString()
      });
      setPumpFunConnectionState("disconnected");
      recordPumpFunReconnection("close");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.stopHeartbeat();
    this.ws = null;

    if (this.reconnectAttempts >= this.maxReconnects) {
      logger.error("Pump.fun monitor exhausted reconnect attempts");
      setPumpFunConnectionState("disconnected");
      this.emit("error", new Error("Pump.fun stream unavailable"));
      return;
    }

    this.reconnectAttempts += 1;

    // ========== 2025 OPTIMIZATION: Exponential backoff with jitter ==========
    // delay = base * 2^attempt + random jitter
    // Example: 2s → 4s → 8s → 16s → 32s (max)
    const exponentialDelay = this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts - 1);
    const maxDelay = 30000; // Cap at 30 seconds
    const jitter = Math.random() * 1000; // 0-1000ms random jitter
    const delay = Math.min(exponentialDelay, maxDelay) + jitter;

    logger.info("Reconnecting Pump.fun stream", {
      attempt: this.reconnectAttempts,
      delayMs: Math.round(delay),
      strategy: "exponential-backoff-with-jitter",
    });

    setPumpFunConnectionState("reconnecting");
    setTimeout(() => this.start(), delay);
  }

  private handleMessage(raw: string): void {
    const startTime = Date.now();

    try {
      // ========== 2025 OPTIMIZATION: Rate limiting ==========
      if (!this.messageRateLimiter.check("pumpfun-messages")) {
        logger.warn("Pump.fun message rate limit exceeded, dropping message");
        recordPumpFunMessageSkipped("rate_limited");
        return;
      }

      const payload = JSON.parse(raw) as PumpFunMessage;

      // Skip subscription confirmation messages
      if ("message" in payload && typeof payload.message === "string") {
        logger.debug("Pump.fun subscription message", { message: payload.message });
        recordPumpFunMessageSkipped("subscription");
        return;
      }

      // Check if this is a new token event (has mint field)
      if (!("mint" in payload) || typeof payload.mint !== "string") {
        logger.debug("Skipping non-token Pump.fun message", {
          hasType: "type" in payload,
          hasMint: "mint" in payload,
          keys: Object.keys(payload)
        });
        recordPumpFunMessageSkipped("no_mint");
        return;
      }

      // Parse as token creation event
      let tokenMint;
      try {
        tokenMint = asTokenMint(payload.mint);
      } catch {
        logger.warn("Pump.fun emitted invalid mint", { mint: payload.mint });
        recordPumpFunMessageSkipped("invalid_mint");
        return;
      }

      const event: NewTokenEvent = {
        source: "pumpfun",
        mint: tokenMint,
        name: payload.name || "Unknown",
        symbol: payload.symbol || "UNKNOWN",
        creator: payload.creator || payload.traderPublicKey,
        liquidityLamports: asLamports(BigInt(Math.max(0, payload.liquidity ?? (payload.initialBuyAmountSol ? Math.floor(payload.initialBuyAmountSol * 1e9) : 0)))),
        marketCapUsd: payload.usd_market_cap ?? (payload.marketCapSol ? payload.marketCapSol * 150 : undefined),
        tx: payload.signature || "",
        timestamp: new Date(),
      };

      logger.info("New Pump.fun token detected", {
        mint: event.mint,
        symbol: event.symbol,
        signature: event.tx
      });

      // ========== 2025 OPTIMIZATION: Metrics ==========
      recordPumpFunTokenDetected();
      const processingTime = Date.now() - startTime;
      observePumpFunMessageProcessing(processingTime);

      this.emit("newToken", event);
    } catch (error) {
      logger.error("Failed to parse Pump.fun payload", { raw, error });
      recordPumpFunParseError();
    }
  }

  stop(): void {
    this.stopHeartbeat();
    setPumpFunConnectionState("disconnected");

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ========== 2025 OPTIMIZATION: Heartbeat / Health Monitoring ==========

  /**
   * Start heartbeat monitoring
   * Checks if WebSocket is still receiving messages
   * Reconnects if connection becomes stale
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.pingIntervalId = setInterval(() => {
      const timeSinceLastMessage = Date.now() - this.lastMessageTime;

      if (timeSinceLastMessage > this.messageTimeoutMs) {
        logger.warn("Pump.fun connection stale, reconnecting", {
          timeSinceLastMessage,
          messageTimeoutMs: this.messageTimeoutMs,
        });
        recordPumpFunReconnection("stale");
        this.ws?.close();
        return;
      }

      // Optional: Send ping if WebSocket supports it
      // Pump.fun doesn't require explicit pings, but we can add it here
      if (this.ws?.readyState === 1) {
        // OPEN state
        try {
          // Some WebSocket servers support ping method
          // For Pump.fun, just checking message recency is enough
          logger.debug("Pump.fun connection healthy", {
            timeSinceLastMessage,
            lastMessageTime: new Date(this.lastMessageTime).toISOString(),
          });
        } catch (error) {
          logger.error("Failed to check connection health", { error });
        }
      }
    }, this.pingIntervalMs);

    logger.debug("Pump.fun heartbeat monitoring started", {
      pingIntervalMs: this.pingIntervalMs,
      messageTimeoutMs: this.messageTimeoutMs,
    });
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeat(): void {
    if (this.pingIntervalId) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
      logger.debug("Pump.fun heartbeat monitoring stopped");
    }
  }
}
