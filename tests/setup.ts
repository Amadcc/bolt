/**
 * Vitest global setup file
 * Runs before all tests
 */

import { beforeAll, afterAll, vi } from "vitest";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

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

// Mock console methods to reduce noise during tests
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};

beforeAll(() => {
  // Suppress console output during tests (unless explicitly needed)
  if (process.env.VERBOSE_TESTS !== 'true') {
    console.log = vi.fn();
    console.info = vi.fn();
    console.warn = vi.fn();
    // Keep console.error for debugging
  }
});

afterAll(() => {
  // Restore console methods
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.info = originalConsole.info;
});
