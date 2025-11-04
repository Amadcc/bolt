/**
 * Structured logging utility with security-aware sanitization
 * NO sensitive data (private keys, passwords, etc) should ever be logged
 */

import pino from "pino";

const isDevelopment = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),
  transport: isDevelopment
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  redact: {
    paths: [
      // Redact sensitive fields automatically
      "*.password",
      "*.privateKey",
      "*.encryptedPrivateKey",
      "*.sessionToken",
      "*.secret",
      "*.apiKey",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    remove: true,
  },
  serializers: {
    error: pino.stdSerializers.err,
  },
});

/**
 * Sanitize object before logging to remove sensitive data
 */
export function sanitizeForLogging(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  const sanitized: Record<string, unknown> = {};
  const sensitiveKeys = [
    "password",
    "privateKey",
    "encryptedPrivateKey",
    "sessionToken",
    "secret",
    "apiKey",
    "mnemonic",
    "seed",
  ];

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object") {
      sanitized[key] = sanitizeForLogging(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Create a child logger with context
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(sanitizeForLogging(context));
}

export default logger;
