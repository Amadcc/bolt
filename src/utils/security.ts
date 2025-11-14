/**
 * Security Utilities - Secret Redaction & Validation
 *
 * Prevents accidental logging of sensitive data:
 * - API keys
 * - Private keys
 * - Passwords
 * - Session tokens
 */

// ============================================================================
// Secret Redaction
// ============================================================================

/**
 * Redact sensitive parts of URLs (API keys, tokens, etc)
 *
 * Examples:
 * - https://api.example.com/?api-key=SECRET123 → https://api.example.com/?api-key=***
 * - https://rpc.com/SECRET → https://rpc.com/***
 */
export function redactUrl(url: string): string {
  if (!url) return url;

  try {
    const urlObj = new URL(url);

    // Redact query parameters containing sensitive keywords
    const sensitiveParams = ['api-key', 'apikey', 'api_key', 'token', 'secret', 'password', 'key'];

    for (const param of sensitiveParams) {
      if (urlObj.searchParams.has(param)) {
        urlObj.searchParams.set(param, '***REDACTED***');
      }
    }

    // Redact path segments that look like API keys (long alphanumeric strings)
    const pathSegments = urlObj.pathname.split('/');
    const redactedSegments = pathSegments.map(segment => {
      // If segment is >20 chars and alphanumeric (likely an API key/token)
      if (segment.length > 20 && /^[a-zA-Z0-9-_]+$/.test(segment)) {
        return '***REDACTED***';
      }
      return segment;
    });

    urlObj.pathname = redactedSegments.join('/');

    return urlObj.toString();
  } catch (error) {
    // If URL parsing fails, do basic string replacement
    return url.replace(/([?&](api[-_]?key|apikey|token|secret|password)=)[^&]+/gi, '$1***REDACTED***');
  }
}

/**
 * Redact sensitive fields in objects before logging
 *
 * Example:
 * redactObject({ password: "secret123", user: "john" })
 * → { password: "***REDACTED***", user: "john" }
 */
export function redactObject<T extends Record<string, unknown>>(
  obj: T,
  sensitiveKeys: string[] = [
    'password',
    'privateKey',
    'private_key',
    'secretKey',
    'secret_key',
    'apiKey',
    'api_key',
    'token',
    'sessionToken',
    'session_token',
    'masterSecret',
    'master_secret',
  ]
): T {
  if (!obj || typeof obj !== 'object') return obj;

  const redacted: Record<string, unknown> = { ...obj };

  for (const key of Object.keys(redacted)) {
    const lowerKey = key.toLowerCase();

    // Check if key matches sensitive patterns
    const isSensitive = sensitiveKeys.some(sensitiveKey =>
      lowerKey.includes(sensitiveKey.toLowerCase())
    );

    if (isSensitive) {
      redacted[key] = '***REDACTED***';
    } else if (typeof redacted[key] === 'string' && key === 'url') {
      // Special handling for URL fields
      redacted[key] = redactUrl(redacted[key] as string);
    } else if (redacted[key] && typeof redacted[key] === 'object') {
      // Recursively redact nested objects
      redacted[key] = redactObject(redacted[key] as Record<string, unknown>);
    }
  }

  return redacted as T;
}

/**
 * Mask middle portion of sensitive string (for display)
 *
 * Example:
 * maskString("sk_live_abcdefghijklmnop", 4, 4)
 * → "sk_l************mnop"
 */
export function maskString(
  value: string,
  visibleStart = 4,
  visibleEnd = 4
): string {
  if (!value || value.length <= visibleStart + visibleEnd) {
    return '***';
  }

  const start = value.slice(0, visibleStart);
  const end = value.slice(-visibleEnd);
  const masked = '*'.repeat(value.length - visibleStart - visibleEnd);

  return `${start}${masked}${end}`;
}

/**
 * Check if string looks like a secret (heuristic)
 */
export function looksLikeSecret(value: string): boolean {
  if (!value || value.length < 16) return false;

  // Patterns that look like secrets:
  // - Long alphanumeric strings (API keys)
  // - Hex strings (private keys)
  // - Base64 strings (tokens)
  const secretPatterns = [
    /^[a-f0-9]{32,}$/i, // Hex (32+ chars)
    /^[A-Za-z0-9+/]{40,}={0,2}$/, // Base64 (40+ chars)
    /^[a-zA-Z0-9_-]{32,}$/, // Alphanumeric (32+ chars)
  ];

  return secretPatterns.some(pattern => pattern.test(value));
}

// ============================================================================
// Environment Variable Validation
// ============================================================================

/**
 * Validate required environment variables at startup
 * Throws error if critical variables are missing
 */
export function validateRequiredEnvVars(required: string[]): void {
  const missing: string[] = [];

  for (const varName of required) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Please check your .env file against .env.example'
    );
  }
}

/**
 * Validate environment variable format
 * Returns validation errors or empty array if valid
 */
export interface EnvVarRule {
  name: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  validator?: (value: string) => boolean;
}

export function validateEnvVars(rules: EnvVarRule[]): string[] {
  const errors: string[] = [];

  for (const rule of rules) {
    const value = process.env[rule.name];

    // Check if required
    if (rule.required && !value) {
      errors.push(`${rule.name} is required`);
      continue;
    }

    // Skip validation if not required and not provided
    if (!value && !rule.required) {
      continue;
    }

    // Length validation
    if (value && rule.minLength && value.length < rule.minLength) {
      errors.push(
        `${rule.name} must be at least ${rule.minLength} characters`
      );
    }

    if (value && rule.maxLength && value.length > rule.maxLength) {
      errors.push(
        `${rule.name} must be at most ${rule.maxLength} characters`
      );
    }

    // Pattern validation
    if (value && rule.pattern && !rule.pattern.test(value)) {
      errors.push(`${rule.name} format is invalid`);
    }

    // Custom validator
    if (value && rule.validator && !rule.validator(value)) {
      errors.push(`${rule.name} validation failed`);
    }
  }

  return errors;
}

// ============================================================================
// Rate Limit Protection
// ============================================================================

/**
 * Simple in-memory rate limiter for sensitive operations
 */
export class RateLimiter {
  private attempts: Map<string, number[]> = new Map();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number
  ) {}

  /**
   * Check if key has exceeded rate limit
   * Returns true if allowed, false if rate limited
   */
  check(key: string): boolean {
    const now = Date.now();
    const attempts = this.attempts.get(key) || [];

    // Remove expired attempts
    const validAttempts = attempts.filter(
      timestamp => now - timestamp < this.windowMs
    );

    if (validAttempts.length >= this.maxAttempts) {
      return false; // Rate limited
    }

    // Record new attempt
    validAttempts.push(now);
    this.attempts.set(key, validAttempts);

    return true; // Allowed
  }

  /**
   * Reset rate limit for key
   */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  /**
   * Clear all rate limits (for testing)
   */
  clearAll(): void {
    this.attempts.clear();
  }
}

// ============================================================================
// Input Sanitization
// ============================================================================

/**
 * Sanitize user input to prevent injection attacks
 */
export function sanitizeInput(input: string): string {
  if (!input) return '';

  return input
    .trim()
    .replace(/[<>]/g, '') // Remove HTML tags
    .replace(/['"]/g, '') // Remove quotes (SQL injection prevention)
    .slice(0, 1000); // Limit length
}

/**
 * Validate Solana address format
 */
export function isValidSolanaAddress(address: string): boolean {
  // Solana addresses are 32-44 characters, base58 encoded
  if (!address || address.length < 32 || address.length > 44) {
    return false;
  }

  // Base58 alphabet (no 0, O, I, l)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(address);
}

/**
 * Validate transaction signature format
 */
export function isValidSignature(signature: string): boolean {
  // Solana signatures are 88 characters, base58 encoded
  if (!signature || signature.length !== 88) {
    return false;
  }

  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(signature);
}
