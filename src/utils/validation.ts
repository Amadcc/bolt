/**
 * Input Validation Utilities (WEEK 3 - DAY 15)
 *
 * Security Protection:
 * - Prevents DoS via oversized inputs
 * - Prevents memory exhaustion attacks
 * - Prevents regex DoS (ReDoS)
 * - Sanitizes user input
 *
 * Why Input Validation Matters:
 * - Long strings can cause memory issues
 * - Long strings can slow down parsing/regex
 * - Long strings can fill logs/databases
 * - Defense in depth (multiple validation layers)
 */

import { logger } from "./logger.js";
import type { Result } from "../types/common.js";
import { Ok, Err } from "../types/common.js";

// ============================================================================
// Constants (WEEK 3 - DAY 15)
// ============================================================================

/**
 * Maximum length for token addresses/symbols
 * Solana addresses are 32-44 characters, add safety margin
 */
export const MAX_TOKEN_ARG_LENGTH = 100;

/**
 * Maximum length for amount strings
 * Even large amounts like "999999999.123456789" fit easily
 */
export const MAX_AMOUNT_ARG_LENGTH = 50;

/**
 * Maximum length for passwords
 * bcrypt has 72 byte limit, we use Argon2id but keep reasonable limit
 */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Minimum password length for security
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Maximum length for wallet names
 */
export const MAX_WALLET_NAME_LENGTH = 50;

/**
 * Maximum length for generic text input
 */
export const MAX_TEXT_INPUT_LENGTH = 500;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate token input (address or symbol)
 *
 * @param input - Token address or symbol from user
 * @returns Result with validated input or error
 */
export function validateTokenInput(input: string): Result<string, string> {
  // Check null/undefined
  if (!input || typeof input !== "string") {
    return Err("Token input is required");
  }

  // Trim whitespace
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return Err("Token input cannot be empty");
  }

  // WEEK 3: Length validation (DoS prevention)
  if (trimmed.length > MAX_TOKEN_ARG_LENGTH) {
    logger.warn("Token input too long", {
      length: trimmed.length,
      max: MAX_TOKEN_ARG_LENGTH,
    });
    return Err(`Token input too long (max ${MAX_TOKEN_ARG_LENGTH} characters)`);
  }

  // Check for obviously malicious patterns
  if (containsSuspiciousPatterns(trimmed)) {
    logger.warn("Suspicious token input detected", { input: trimmed.slice(0, 20) });
    return Err("Invalid token format");
  }

  return Ok(trimmed);
}

/**
 * Validate amount input
 *
 * @param input - Amount from user
 * @returns Result with validated input or error
 */
export function validateAmountInput(input: string): Result<string, string> {
  // Check null/undefined
  if (!input || typeof input !== "string") {
    return Err("Amount is required");
  }

  // Trim whitespace
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return Err("Amount cannot be empty");
  }

  // WEEK 3: Length validation (DoS prevention)
  if (trimmed.length > MAX_AMOUNT_ARG_LENGTH) {
    logger.warn("Amount input too long", {
      length: trimmed.length,
      max: MAX_AMOUNT_ARG_LENGTH,
    });
    return Err(`Amount too long (max ${MAX_AMOUNT_ARG_LENGTH} characters)`);
  }

  // Check format (must be numeric with optional decimal)
  const numericPattern = /^[0-9]+\.?[0-9]*$/;
  if (!numericPattern.test(trimmed)) {
    return Err("Amount must be a valid number");
  }

  // Check for obviously malicious patterns (e.g., many zeros)
  if (trimmed.length > 20 && /^0+$/.test(trimmed)) {
    logger.warn("Suspicious amount input detected", { input: trimmed.slice(0, 20) });
    return Err("Invalid amount format");
  }

  return Ok(trimmed);
}

/**
 * Validate password input
 *
 * @param password - Password from user
 * @returns Result with validated password or error
 */
export function validatePasswordInput(password: string): Result<string, string> {
  // Check null/undefined
  if (!password || typeof password !== "string") {
    return Err("Password is required");
  }

  // WEEK 3: Length validation
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Err(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    logger.warn("Password too long", {
      length: password.length,
      max: MAX_PASSWORD_LENGTH,
    });
    return Err(`Password too long (max ${MAX_PASSWORD_LENGTH} characters)`);
  }

  // Check for common weak passwords
  const weakPasswords = ["password", "12345678", "qwerty123", "admin123"];
  if (weakPasswords.includes(password.toLowerCase())) {
    return Err("Password too weak, please choose a stronger password");
  }

  return Ok(password);
}

/**
 * Validate wallet name
 *
 * @param name - Wallet name from user
 * @returns Result with validated name or error
 */
export function validateWalletName(name: string): Result<string, string> {
  // Check null/undefined
  if (!name || typeof name !== "string") {
    return Err("Wallet name is required");
  }

  // Trim whitespace
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return Err("Wallet name cannot be empty");
  }

  // WEEK 3: Length validation
  if (trimmed.length > MAX_WALLET_NAME_LENGTH) {
    logger.warn("Wallet name too long", {
      length: trimmed.length,
      max: MAX_WALLET_NAME_LENGTH,
    });
    return Err(`Wallet name too long (max ${MAX_WALLET_NAME_LENGTH} characters)`);
  }

  // Check for alphanumeric + spaces/underscores only
  const validPattern = /^[a-zA-Z0-9\s_-]+$/;
  if (!validPattern.test(trimmed)) {
    return Err("Wallet name can only contain letters, numbers, spaces, and underscores");
  }

  return Ok(trimmed);
}

/**
 * Validate generic text input
 *
 * @param input - Text input from user
 * @param fieldName - Name of field (for error messages)
 * @returns Result with validated input or error
 */
export function validateTextInput(
  input: string,
  fieldName: string = "Input"
): Result<string, string> {
  // Check null/undefined
  if (!input || typeof input !== "string") {
    return Err(`${fieldName} is required`);
  }

  // Trim whitespace
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return Err(`${fieldName} cannot be empty`);
  }

  // WEEK 3: Length validation
  if (trimmed.length > MAX_TEXT_INPUT_LENGTH) {
    logger.warn("Text input too long", {
      fieldName,
      length: trimmed.length,
      max: MAX_TEXT_INPUT_LENGTH,
    });
    return Err(`${fieldName} too long (max ${MAX_TEXT_INPUT_LENGTH} characters)`);
  }

  // Check for suspicious patterns
  if (containsSuspiciousPatterns(trimmed)) {
    logger.warn("Suspicious text input detected", {
      fieldName,
      input: trimmed.slice(0, 20),
    });
    return Err(`Invalid ${fieldName.toLowerCase()} format`);
  }

  return Ok(trimmed);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check for suspicious patterns (potential attacks)
 *
 * Detects:
 * - Excessive control characters
 * - Null bytes
 * - Excessive newlines (log injection)
 * - Script tags (XSS attempt)
 */
function containsSuspiciousPatterns(input: string): boolean {
  // Check for null bytes
  if (input.includes("\0")) {
    return true;
  }

  // Check for excessive control characters (>10% of string)
  const controlCharCount = (input.match(/[\x00-\x1F\x7F-\x9F]/g) || []).length;
  if (controlCharCount > input.length * 0.1) {
    return true;
  }

  // Check for excessive newlines (log injection attempt)
  const newlineCount = (input.match(/\n/g) || []).length;
  if (newlineCount > 5) {
    return true;
  }

  // Check for script tags (XSS attempt - shouldn't happen in Telegram but be safe)
  if (/<script|<iframe|javascript:/i.test(input)) {
    return true;
  }

  return false;
}

/**
 * Sanitize input for logging
 * Truncate and remove sensitive patterns
 */
export function sanitizeForLog(input: string, maxLength: number = 50): string {
  if (!input || typeof input !== "string") {
    return "[invalid]";
  }

  // Truncate
  let sanitized = input.slice(0, maxLength);

  // Replace control characters with �
  sanitized = sanitized.replace(/[\x00-\x1F\x7F-\x9F]/g, "�");

  // Add ellipsis if truncated
  if (input.length > maxLength) {
    sanitized += "...";
  }

  return sanitized;
}

// ============================================================================
// Validation Summary (for testing)
// ============================================================================

/**
 * Get validation limits (useful for displaying to users or testing)
 */
export function getValidationLimits() {
  return {
    token: {
      max: MAX_TOKEN_ARG_LENGTH,
    },
    amount: {
      max: MAX_AMOUNT_ARG_LENGTH,
    },
    password: {
      min: MIN_PASSWORD_LENGTH,
      max: MAX_PASSWORD_LENGTH,
    },
    walletName: {
      max: MAX_WALLET_NAME_LENGTH,
    },
    text: {
      max: MAX_TEXT_INPUT_LENGTH,
    },
  };
}
