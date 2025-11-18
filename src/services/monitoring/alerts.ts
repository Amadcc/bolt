/**
 * Advanced Alerting System (Sprint 4)
 *
 * Sends real-time notifications to Telegram for critical events:
 * - Circuit breaker opens/closes
 * - High failure rates
 * - Simulation failures
 * - Critical errors
 * - Important successes (exits, large P&L)
 *
 * This allows operators to respond quickly to issues and monitor bot health.
 */

import { Telegraf } from "telegraf";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Alert Types
// ============================================================================

export type AlertSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export interface AlertEvent {
  severity: AlertSeverity;
  title: string;
  message: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

// ============================================================================
// Alert Service Class
// ============================================================================

export class AlertService {
  private bot: Telegraf | null = null;
  private alertChannelId: string | null = null;
  private enabled: boolean = false;

  constructor(botToken?: string, channelId?: string) {
    if (botToken && channelId) {
      this.bot = new Telegraf(botToken);
      this.alertChannelId = channelId;
      this.enabled = true;

      logger.info("AlertService initialized", {
        channelId: this.maskChannelId(channelId),
      });
    } else {
      logger.warn("AlertService disabled - no bot token or channel ID provided");
    }
  }

  /**
   * Send alert to Telegram
   */
  async sendAlert(event: AlertEvent): Promise<void> {
    if (!this.enabled || !this.bot || !this.alertChannelId) {
      logger.debug("Alert not sent - service disabled", {
        severity: event.severity,
        title: event.title,
      });
      return;
    }

    try {
      const emoji = this.getSeverityEmoji(event.severity);
      const message = this.formatAlertMessage(emoji, event);

      await this.bot.telegram.sendMessage(this.alertChannelId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });

      logger.info("Alert sent successfully", {
        severity: event.severity,
        title: event.title,
      });
    } catch (error) {
      logger.error("Failed to send alert", {
        error: error instanceof Error ? error.message : String(error),
        severity: event.severity,
        title: event.title,
      });
    }
  }

  /**
   * Circuit breaker opened alert
   */
  async alertCircuitBreakerOpen(service: string, failureCount: number): Promise<void> {
    await this.sendAlert({
      severity: "CRITICAL",
      title: `Circuit Breaker OPEN: ${service}`,
      message: `Service ${service} circuit breaker is now OPEN after ${failureCount} failures. All requests will be rejected until recovery.`,
      metadata: { service, failureCount },
      timestamp: new Date(),
    });
  }

  /**
   * Circuit breaker closed alert
   */
  async alertCircuitBreakerClosed(service: string): Promise<void> {
    await this.sendAlert({
      severity: "INFO",
      title: `Circuit Breaker Closed: ${service}`,
      message: `Service ${service} has recovered and circuit breaker is now CLOSED.`,
      metadata: { service },
      timestamp: new Date(),
    });
  }

  /**
   * High failure rate alert
   */
  async alertHighFailureRate(
    operation: string,
    failureRate: number,
    window: string
  ): Promise<void> {
    await this.sendAlert({
      severity: "WARNING",
      title: `High Failure Rate: ${operation}`,
      message: `Operation "${operation}" has ${failureRate.toFixed(1)}% failure rate in the last ${window}. Investigate immediately.`,
      metadata: { operation, failureRate, window },
      timestamp: new Date(),
    });
  }

  /**
   * Simulation failure alert
   */
  async alertSimulationFailed(
    positionId: string,
    tokenMint: string,
    reason: string
  ): Promise<void> {
    await this.sendAlert({
      severity: "WARNING",
      title: "Exit Simulation Failed",
      message: `Position ${this.truncate(positionId, 8)} exit simulation failed. Token: ${this.truncate(tokenMint, 8)}. Reason: ${reason}`,
      metadata: { positionId, tokenMint, reason },
      timestamp: new Date(),
    });
  }

  /**
   * Critical error alert
   */
  async alertCriticalError(
    component: string,
    error: string,
    context?: Record<string, any>
  ): Promise<void> {
    await this.sendAlert({
      severity: "CRITICAL",
      title: `Critical Error: ${component}`,
      message: `CRITICAL: ${component} encountered an error: ${error}`,
      metadata: { component, error, ...context },
      timestamp: new Date(),
    });
  }

  /**
   * Successful exit with large P&L alert
   */
  async alertLargePnL(
    positionId: string,
    pnlPercentage: number,
    pnlSol: number
  ): Promise<void> {
    const severity: AlertSeverity = pnlPercentage > 0 ? "INFO" : "WARNING";
    const title = pnlPercentage > 0 ? "Large Profit" : "Large Loss";

    await this.sendAlert({
      severity,
      title,
      message: `Position ${this.truncate(positionId, 8)} closed with ${pnlPercentage > 0 ? "+" : ""}${pnlPercentage.toFixed(2)}% (${pnlSol.toFixed(4)} SOL)`,
      metadata: { positionId, pnlPercentage, pnlSol },
      timestamp: new Date(),
    });
  }

  /**
   * RPC endpoint failure alert
   */
  async alertRpcFailure(endpoint: string, failoverTo?: string): Promise<void> {
    const message = failoverTo
      ? `RPC endpoint ${this.truncate(endpoint, 30)} failed. Failing over to ${this.truncate(failoverTo, 30)}.`
      : `RPC endpoint ${this.truncate(endpoint, 30)} failed. No failover available.`;

    await this.sendAlert({
      severity: failoverTo ? "WARNING" : "CRITICAL",
      title: "RPC Endpoint Failure",
      message,
      metadata: { endpoint, failoverTo },
      timestamp: new Date(),
    });
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private getSeverityEmoji(severity: AlertSeverity): string {
    const emojis: Record<AlertSeverity, string> = {
      INFO: "✅",
      WARNING: "⚠️",
      ERROR: "🔴",
      CRITICAL: "🚨",
    };
    return emojis[severity];
  }

  private formatAlertMessage(emoji: string, event: AlertEvent): string {
    const timestamp = event.timestamp.toISOString();
    let message = `${emoji} <b>${event.title}</b>\n\n`;
    message += `${event.message}\n\n`;
    message += `<i>Time: ${timestamp}</i>`;

    // Add metadata if present
    if (event.metadata && Object.keys(event.metadata).length > 0) {
      message += `\n\n<b>Details:</b>\n`;
      for (const [key, value] of Object.entries(event.metadata)) {
        message += `• ${key}: ${String(value)}\n`;
      }
    }

    return message;
  }

  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return `${str.substring(0, maxLength)}...`;
  }

  private maskChannelId(channelId: string): string {
    if (channelId.length <= 8) return "***";
    return `${channelId.substring(0, 4)}***${channelId.substring(channelId.length - 4)}`;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let alertService: AlertService | null = null;

export function initializeAlertService(
  botToken?: string,
  channelId?: string
): AlertService {
  if (!alertService) {
    alertService = new AlertService(botToken, channelId);
  }
  return alertService;
}

export function getAlertService(): AlertService {
  if (!alertService) {
    // Return disabled service if not initialized
    alertService = new AlertService();
  }
  return alertService;
}
