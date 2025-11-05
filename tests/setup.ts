/**
 * Vitest global setup file
 * Runs before all tests
 */

import { beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Set test environment
process.env.NODE_ENV = 'test';

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
