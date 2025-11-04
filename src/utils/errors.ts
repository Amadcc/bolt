/**
 * Custom error classes with operational error handling
 * Following Node.js best practices for error handling
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, "AUTH_ERROR", 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = "Access denied") {
    super(message, "AUTHORIZATION_ERROR", 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, "NOT_FOUND", 404);
  }
}

export class RateLimitError extends AppError {
  constructor(
    message: string = "Rate limit exceeded",
    public readonly retryAfter?: number
  ) {
    super(message, "RATE_LIMIT", 429);
  }
}

export class BlockchainError extends AppError {
  constructor(
    message: string,
    public readonly txSignature?: string,
    public readonly chain: string = "solana"
  ) {
    super(message, "BLOCKCHAIN_ERROR", 500);
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
  constructor(message: string) {
    super(message, "ENCRYPTION_ERROR", 500);
  }
}

export class DecryptionError extends AppError {
  constructor(message: string) {
    super(message, "DECRYPTION_ERROR", 500);
  }
}

export class WalletError extends AppError {
  constructor(message: string) {
    super(message, "WALLET_ERROR", 500);
  }
}

export class SessionError extends AppError {
  constructor(message: string) {
    super(message, "SESSION_ERROR", 401);
  }
}

export class HoneypotError extends AppError {
  constructor(message: string, public readonly tokenMint: string) {
    super(message, "HONEYPOT_ERROR", 400);
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
