/**
 * Environment Variable Validation (HIGH-4)
 *
 * Production-grade environment configuration with Zod validation.
 * Fail-fast on startup if configuration is invalid.
 *
 * Security principles:
 * - Validate ALL environment variables before use
 * - Type-safe access to config
 * - Clear error messages for misconfiguration
 * - No silent fallbacks for critical config
 */

import { z } from "zod";
import { logger } from "../utils/logger.js";

// ============================================================================
// Schema Definition
// ============================================================================

const envSchema = z.object({
  // Node Environment
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development")
    .describe("Node environment"),

  // Server Configuration
  PORT: z.coerce
    .number()
    .int()
    .min(1024, "PORT must be >= 1024")
    .max(65535, "PORT must be <= 65535")
    .default(3000)
    .describe("HTTP server port"),

  // Telegram Bot
  BOT_TOKEN: z
    .string()
    .min(40, "BOT_TOKEN must be at least 40 characters")
    .regex(/^\d+:[A-Za-z0-9_-]+$/, "BOT_TOKEN format is invalid")
    .describe("Telegram bot token"),

  // Database
  DATABASE_URL: z
    .string()
    .url("DATABASE_URL must be a valid URL")
    .startsWith("postgresql://", "DATABASE_URL must be a PostgreSQL URL")
    .describe("PostgreSQL connection URL"),

  // Redis
  REDIS_URL: z
    .string()
    .url("REDIS_URL must be a valid URL")
    .startsWith("redis://", "REDIS_URL must start with redis://")
    .describe("Redis connection URL"),

  // Solana RPC (HIGH-1: Support for RPC Pool)
  // For backwards compatibility, support single URL or comma-separated list
  SOLANA_RPC_URL: z
    .string()
    .optional()
    .describe("Primary Solana RPC endpoint (legacy, use SOLANA_RPC_URLS for pool)"),

  SOLANA_RPC_URLS: z
    .string()
    .optional()
    .describe("Comma-separated list of Solana RPC endpoints for connection pool"),

  SOLANA_NETWORK: z
    .enum(["mainnet-beta", "mainnet", "devnet", "testnet"])
    .default("mainnet-beta")
    .describe("Solana network identifier"),

  // Jupiter API
  JUPITER_API_URL: z
    .string()
    .url("JUPITER_API_URL must be a valid URL")
    .default("https://lite-api.jup.ag")
    .describe("Jupiter aggregator API endpoint"),

  // Platform Fee Configuration
  PLATFORM_FEE_BPS: z.coerce
    .number()
    .int()
    .min(0, "PLATFORM_FEE_BPS must be >= 0")
    .max(10000, "PLATFORM_FEE_BPS must be <= 10000 (100%)")
    .default(50)
    .describe("Platform fee in basis points (1 bps = 0.01%)"),

  PLATFORM_FEE_ACCOUNT: z
    .string()
    .length(44, "PLATFORM_FEE_ACCOUNT must be 44 characters (base58 pubkey)")
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "PLATFORM_FEE_ACCOUNT must be valid base58")
    .describe("Platform fee recipient wallet address"),

  // Session Security (CRITICAL!)
  SESSION_MASTER_SECRET: z
    .string()
    .min(32, "SESSION_MASTER_SECRET must be at least 32 characters")
    .describe("Master secret for HKDF session key derivation (CRITICAL)"),

  // Logging
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info")
    .describe("Logging level"),

  // Optional: Honeypot Detection
  GOPLUS_API_KEY: z
    .string()
    .optional()
    .describe("GoPlus API key for honeypot detection"),
});

// ============================================================================
// Type Exports
// ============================================================================

export type Env = z.infer<typeof envSchema>;

// ============================================================================
// Validation & Initialization
// ============================================================================

let validatedEnv: Env | null = null;

/**
 * Validate environment variables on startup
 *
 * @throws {Error} If validation fails
 * @returns {Env} Validated and type-safe environment configuration
 */
export function validateEnv(): Env {
  try {
    // Parse and validate
    const parsed = envSchema.parse(process.env);

    // Additional security checks
    validateSecurityConstraints(parsed);

    validatedEnv = parsed;

    logger.info("Environment validation successful", {
      nodeEnv: parsed.NODE_ENV,
      network: parsed.SOLANA_NETWORK,
      port: parsed.PORT,
      logLevel: parsed.LOG_LEVEL,
    });

    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `  • ${err.path.join(".")}: ${err.message}`)
        .join("\n");

      logger.error("❌ Environment validation failed:\n" + errorMessages);

      throw new Error(
        `Environment validation failed:\n${errorMessages}\n\n` +
          `Please check your .env file and ensure all required variables are set correctly.`
      );
    }

    throw error;
  }
}

/**
 * Additional security constraint validation
 */
function validateSecurityConstraints(env: Env): void {
  // HIGH-1: Validate RPC configuration
  if (!env.SOLANA_RPC_URL && !env.SOLANA_RPC_URLS) {
    throw new Error(
      "Either SOLANA_RPC_URL or SOLANA_RPC_URLS must be set. " +
        "Set SOLANA_RPC_URLS for connection pooling (recommended)."
    );
  }

  // Get RPC URLs for validation
  const rpcUrls = getRpcEndpointsFromEnv(env);

  // Validate all RPC URLs
  for (const url of rpcUrls) {
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid RPC URL format: ${url}`);
    }

    // Ensure HTTPS in production
    if (env.NODE_ENV === "production" && !url.startsWith("https://")) {
      throw new Error(
        `RPC URL must use HTTPS in production: ${url}`
      );
    }
  }

  // Production-specific checks
  if (env.NODE_ENV === "production") {
    if (!env.JUPITER_API_URL.startsWith("https://")) {
      throw new Error(
        "JUPITER_API_URL must use HTTPS in production environment"
      );
    }

    // Ensure strong session secret in production
    if (env.SESSION_MASTER_SECRET.length < 64) {
      logger.warn(
        "⚠️  SESSION_MASTER_SECRET is less than 64 characters in production. " +
          "Consider using a longer secret for maximum security."
      );
    }

    // Warn about default RPC URL in production
    const hasPublicRpc = rpcUrls.some(
      (url) => url === "https://api.mainnet-beta.solana.com"
    );
    if (hasPublicRpc) {
      logger.warn(
        "⚠️  Using public Solana RPC in production. " +
          "Consider using a dedicated RPC provider (QuickNode, Helius, Triton) for better performance and reliability."
      );
    }
  }

  // Validate platform fee account is not placeholder
  if (
    env.PLATFORM_FEE_ACCOUNT === "YOUR_PLATFORM_FEE_ACCOUNT" ||
    env.PLATFORM_FEE_ACCOUNT === "11111111111111111111111111111111"
  ) {
    throw new Error(
      "PLATFORM_FEE_ACCOUNT is not configured. Please set a valid Solana address."
    );
  }

  // Validate session secret is not example/placeholder
  if (
    env.SESSION_MASTER_SECRET === "your-secret-key-here" ||
    env.SESSION_MASTER_SECRET === "changeme" ||
    env.SESSION_MASTER_SECRET === "secret"
  ) {
    throw new Error(
      "SESSION_MASTER_SECRET is using a placeholder value. " +
        "Generate a strong secret: openssl rand -base64 64"
    );
  }
}

/**
 * Get validated environment configuration
 *
 * @throws {Error} If env has not been validated yet
 * @returns {Env} Type-safe environment configuration
 */
export function getEnv(): Env {
  if (!validatedEnv) {
    throw new Error(
      "Environment has not been validated yet. Call validateEnv() first."
    );
  }

  return validatedEnv;
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
  return getEnv().NODE_ENV === "production";
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
  return getEnv().NODE_ENV === "development";
}

/**
 * Check if running in test mode
 */
export function isTest(): boolean {
  return getEnv().NODE_ENV === "test";
}

// ============================================================================
// Helper: RPC Endpoints (HIGH-1: RPC Connection Pool)
// ============================================================================

/**
 * Internal helper to parse RPC endpoints from env (used in validation)
 */
function getRpcEndpointsFromEnv(env: Env): string[] {
  // Priority: SOLANA_RPC_URLS > SOLANA_RPC_URL
  if (env.SOLANA_RPC_URLS) {
    return env.SOLANA_RPC_URLS.split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
  }

  if (env.SOLANA_RPC_URL) {
    return [env.SOLANA_RPC_URL];
  }

  return [];
}

/**
 * Get list of RPC endpoints for connection pooling
 * Returns array of validated RPC URLs
 *
 * @returns Array of RPC endpoint URLs
 */
export function getRpcEndpoints(): string[] {
  return getRpcEndpointsFromEnv(getEnv());
}

// ============================================================================
// Helper: Generate secure session secret
// ============================================================================

/**
 * Generate a cryptographically secure session master secret
 *
 * Usage: bun run src/config/env.ts
 *
 * This will generate a 64-byte base64-encoded secret suitable for
 * SESSION_MASTER_SECRET environment variable.
 */
export function generateSessionSecret(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

// ============================================================================
// CLI: Generate session secret
// ============================================================================

// If this file is run directly, generate a session secret
if (import.meta.main) {
  console.log("\n🔐 Generate Session Master Secret\n");
  console.log("Add this to your .env file:\n");
  console.log(`SESSION_MASTER_SECRET="${generateSessionSecret()}"\n`);
  console.log("⚠️  Keep this secret secure and NEVER commit it to Git!\n");
}
