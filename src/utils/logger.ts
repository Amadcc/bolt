/**
 * Structured logging utility with security-aware sanitization
 * NO sensitive data (private keys, passwords, etc) should ever be logged
 */

import pino from "pino";

const isDevelopment = process.env.NODE_ENV !== "production";

const pinoLogger = pino({
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
 * Logger wrapper with convenient API
 * Accepts (message, context) instead of pino's (context, message)
 */
export const logger = {
  info: (message: string, context?: object) => {
    if (context) {
      pinoLogger.info(context, message);
    } else {
      pinoLogger.info(message);
    }
  },
  error: (message: string, context?: object) => {
    if (context) {
      pinoLogger.error(context, message);
    } else {
      pinoLogger.error(message);
    }
  },
  warn: (message: string, context?: object) => {
    if (context) {
      pinoLogger.warn(context, message);
    } else {
      pinoLogger.warn(message);
    }
  },
  debug: (message: string, context?: object) => {
    if (context) {
      pinoLogger.debug(context, message);
    } else {
      pinoLogger.debug(message);
    }
  },
  fatal: (message: string, context?: object) => {
    if (context) {
      pinoLogger.fatal(context, message);
    } else {
      pinoLogger.fatal(message);
    }
  },
  trace: (message: string, context?: object) => {
    if (context) {
      pinoLogger.trace(context, message);
    } else {
      pinoLogger.trace(message);
    }
  },
  child: (bindings: Record<string, unknown>) => {
    const childPino = pinoLogger.child(bindings);
    return {
      info: (message: string, context?: object) => {
        if (context) {
          childPino.info(context, message);
        } else {
          childPino.info(message);
        }
      },
      error: (message: string, context?: object) => {
        if (context) {
          childPino.error(context, message);
        } else {
          childPino.error(message);
        }
      },
      warn: (message: string, context?: object) => {
        if (context) {
          childPino.warn(context, message);
        } else {
          childPino.warn(message);
        }
      },
      debug: (message: string, context?: object) => {
        if (context) {
          childPino.debug(context, message);
        } else {
          childPino.debug(message);
        }
      },
      fatal: (message: string, context?: object) => {
        if (context) {
          childPino.fatal(context, message);
        } else {
          childPino.fatal(message);
        }
      },
      trace: (message: string, context?: object) => {
        if (context) {
          childPino.trace(context, message);
        } else {
          childPino.trace(message);
        }
      },
    };
  },
};

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
  return logger.child(sanitizeForLogging(context) as Record<string, unknown>);
}

export default logger;
