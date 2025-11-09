/**
 * Encryption Worker - Argon2 in Worker Thread
 *
 * Runs CPU-intensive Argon2 hashing in separate thread to avoid blocking main event loop.
 * This prevents bot freezing during wallet encryption/decryption.
 *
 * Performance:
 * - Before: 2-5 seconds blocking main thread
 * - After: <100ms on main thread (Argon2 runs in background)
 */

import { parentPort } from "worker_threads";
import argon2 from "argon2";

// ============================================================================
// Worker Message Types
// ============================================================================

interface WorkerRequest {
  password: string;
  salt: Buffer;
  config: {
    type: typeof argon2.argon2id;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
    hashLength: number;
  };
}

interface WorkerResponse {
  success: boolean;
  hash?: Buffer;
  error?: string;
}

// ============================================================================
// Worker Logic
// ============================================================================

if (!parentPort) {
  throw new Error("This file must be run as a Worker");
}

/**
 * Listen for hash requests from main thread
 */
parentPort.on("message", async (request: WorkerRequest) => {
  try {
    // Validate input
    if (!request.password || !request.salt || !request.config) {
      const response: WorkerResponse = {
        success: false,
        error: "Invalid request: missing password, salt, or config",
      };
      parentPort!.postMessage(response);
      return;
    }

    // Convert salt to Buffer if needed (worker_threads serialization)
    const saltBuffer = Buffer.isBuffer(request.salt)
      ? request.salt
      : Buffer.from(request.salt);

    // Perform Argon2 hashing (CPU-intensive operation)
    const hash = await argon2.hash(request.password, {
      ...request.config,
      salt: saltBuffer,
      raw: true, // Return raw hash bytes
    });

    // Send result back to main thread
    const response: WorkerResponse = {
      success: true,
      hash: Buffer.from(hash),
    };
    parentPort!.postMessage(response);
  } catch (error) {
    // Send error back to main thread
    const response: WorkerResponse = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort!.postMessage(response);
  }
});
