/**
 * Custom error classes with operational error handling
 * Following Node.js best practices for error handling
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly isOperational: boolean = true,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
    if (cause?.stack) {
      this.stack = `${this.stack ?? ""}\nCaused by: ${cause.stack}`;
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      ...(this.cause
        ? {
            cause: {
              name: this.cause.name,
              message: this.cause.message,
            },
          }
        : {}),
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, "VALIDATION_ERROR", 400, true, cause);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = "Authentication required", cause?: Error) {
    super(message, "AUTH_ERROR", 401, true, cause);
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = "Access denied", cause?: Error) {
    super(message, "AUTHORIZATION_ERROR", 403, true, cause);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, cause?: Error) {
    super(`${resource} not found`, "NOT_FOUND", 404, true, cause);
  }
}

export class RateLimitError extends AppError {
  constructor(
    message: string = "Rate limit exceeded",
    public readonly retryAfter?: number,
    cause?: Error
  ) {
    super(message, "RATE_LIMIT", 429, true, cause);
  }
}

export class BlockchainError extends AppError {
  constructor(
    message: string,
    public readonly txSignature?: string,
    public readonly chain: string = "solana",
    cause?: Error
  ) {
    super(message, "BLOCKCHAIN_ERROR", 500, true, cause);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      txSignature: this.txSignature,
      chain: this.chain,
    };
  }
}

export class EncryptionError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, "ENCRYPTION_ERROR", 500, true, cause);
  }
}

export class DecryptionError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, "DECRYPTION_ERROR", 500, true, cause);
  }
}

export class WalletError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, "WALLET_ERROR", 500, true, cause);
  }
}

export class SessionError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, "SESSION_ERROR", 401, true, cause);
  }
}

export class HoneypotError extends AppError {
  constructor(message: string, public readonly tokenMint: string, cause?: Error) {
    super(message, "HONEYPOT_ERROR", 400, true, cause);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      tokenMint: this.tokenMint,
    };
  }
}

/**
 * Type guard to check if error is operational
 */
export function isOperationalError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

/**
 * Sanitize error for user display (no sensitive info)
 */
export function sanitizeError(error: unknown): {
  message: string;
  code?: string;
} {
  if (error instanceof AppError) {
    return {
      message: error.message,
      code: error.code,
    };
  }

  if (error instanceof Error) {
    return {
      message: "An unexpected error occurred",
      code: "INTERNAL_ERROR",
    };
  }

  return {
    message: "An unexpected error occurred",
    code: "UNKNOWN_ERROR",
  };
}
