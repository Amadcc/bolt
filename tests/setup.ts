/**
 * Global Test Setup for Vitest
 * Runs before all tests
 *
 * Features:
 * - Load test environment variables
 * - Set up Redis mock for all tests
 * - Set up Jupiter mock for all tests
 * - Suppress verbose logging
 */

import { beforeAll, afterAll, beforeEach } from "vitest";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { createMockRedis } from "./mocks/redis.mock";
import { createMockJupiter } from "./mocks/jupiter.mock";

// ============================================================================
// Environment Setup
// ============================================================================

// Load test environment variables
const defaultEnvPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(defaultEnvPath)) {
  dotenv.config({ path: defaultEnvPath });
}

const envFile = process.env.TEST_ENV_FILE ?? ".env.test";
const envPath = path.resolve(process.cwd(), envFile);

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
} else if (envFile !== ".env") {
  console.warn(
    `[tests] Environment file "${envFile}" not found. Falling back to base .env values.`
  );
  dotenv.config();
}

// Set test environment
process.env.NODE_ENV = "test";

// ============================================================================
// Global Mocks Setup
// ============================================================================

// Create global mock instances
export const mockRedis = createMockRedis();
export const mockJupiter = createMockJupiter();

// Make mocks available globally for all tests
(globalThis as any).__TEST_REDIS_MOCK__ = mockRedis;
(globalThis as any).__TEST_JUPITER_MOCK__ = mockJupiter;

// ============================================================================
// Console Suppression
// ============================================================================

// Mock console methods to reduce noise during tests
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};

beforeAll(() => {
  // Suppress console output during tests (unless explicitly needed)
  if (process.env.VERBOSE_TESTS !== "true") {
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    // Keep console.error for debugging
  }
});

beforeEach(async () => {
  // Clear Redis mock before each test
  await mockRedis.flushall();

  // Reset Jupiter mock to default configuration
  mockJupiter.reset();
});

afterAll(() => {
  // Restore console methods
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.info = originalConsole.info;

  // Clean up mocks
  mockRedis.quit();
});
