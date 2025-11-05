/**
 * Honeypot Detector Tests
 * Tests multi-layer detection system with basic mocking
 */

import { describe, it, expect, vi } from 'vitest';
import { asRiskScore } from '../../../src/types/honeypot.js';

describe('HoneypotDetector - Types & Utilities', () => {
  describe('asRiskScore', () => {
    it('should create valid risk score within range', () => {
      expect(() => asRiskScore(0)).not.toThrow();
      expect(() => asRiskScore(50)).not.toThrow();
      expect(() => asRiskScore(100)).not.toThrow();
    });

    it('should reject negative risk scores', () => {
      expect(() => asRiskScore(-1)).toThrow('Risk score must be 0-100');
    });

    it('should reject risk scores over 100', () => {
      expect(() => asRiskScore(101)).toThrow('Risk score must be 0-100');
    });

    it('should return branded type', () => {
      const score = asRiskScore(75);
      expect(score).toBe(75);
    });
  });
});

describe('HoneypotDetector - Basic Functionality', () => {
  // These tests verify core logic without complex mocking

  it('should export detector classes and functions', async () => {
    const { HoneypotDetector, initializeHoneypotDetector, getHoneypotDetector } =
      await import('../../../src/services/honeypot/detector.js');

    expect(HoneypotDetector).toBeDefined();
    expect(initializeHoneypotDetector).toBeDefined();
    expect(getHoneypotDetector).toBeDefined();
  });

  it('should create detector instance with default config', async () => {
    const { HoneypotDetector } = await import(
      '../../../src/services/honeypot/detector.js'
    );

    const detector = new HoneypotDetector();
    expect(detector).toBeTruthy();
  });

  it('should create detector with custom config', async () => {
    const { HoneypotDetector } = await import(
      '../../../src/services/honeypot/detector.js'
    );

    const detector = new HoneypotDetector({
      highRiskThreshold: 80,
      mediumRiskThreshold: 40,
      cacheTTL: 7200,
      goPlusTimeout: 3000,
      cacheEnabled: false,
      enableGoPlusAPI: false,
      enableOnChainChecks: false,
    });

    expect(detector).toBeTruthy();
  });

  it('should reject invalid token mint', async () => {
    const { HoneypotDetector } = await import(
      '../../../src/services/honeypot/detector.js'
    );

    const detector = new HoneypotDetector({
      cacheEnabled: false,
      enableGoPlusAPI: false,
      enableOnChainChecks: false,
    });

    const result = await detector.check('invalid-address');

    expect(result.success).toBe(false);
    if (result.success) return;

    // TypeScript doesn't narrow after return guard, but runtime is safe
    expect((result as any).error.type).toBe('INVALID_TOKEN');
    expect((result as any).error.tokenMint).toBe('invalid-address');
  });

  it('should return success with valid Solana address (even with no data)', async () => {
    const { HoneypotDetector } = await import(
      '../../../src/services/honeypot/detector.js'
    );

    const detector = new HoneypotDetector({
      cacheEnabled: false,
      enableGoPlusAPI: false, // Disable to avoid external API calls
      enableOnChainChecks: false, // Disable to avoid RPC calls
    });

    // Valid Solana address (Wrapped SOL)
    const result = await detector.check('So11111111111111111111111111111111111111112');

    // Should succeed even with no data (0 score, low confidence)
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.value.tokenMint).toBe('So11111111111111111111111111111111111111112');
    expect(result.value.riskScore).toBeDefined();
    expect(result.value.confidence).toBeDefined();
    expect(result.value.checkedAt).toBeInstanceOf(Date);
    expect(result.value.analysisTimeMs).toBeGreaterThanOrEqual(0); // Can be 0 on fast machines
  });

  it('should include required result fields', async () => {
    const { HoneypotDetector } = await import(
      '../../../src/services/honeypot/detector.js'
    );

    const detector = new HoneypotDetector({
      cacheEnabled: false,
      enableGoPlusAPI: false,
      enableOnChainChecks: false,
    });

    const result = await detector.check('So11111111111111111111111111111111111111112');

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Verify all required fields exist
    expect(result.value).toHaveProperty('tokenMint');
    expect(result.value).toHaveProperty('isHoneypot');
    expect(result.value).toHaveProperty('riskScore');
    expect(result.value).toHaveProperty('confidence');
    expect(result.value).toHaveProperty('flags');
    expect(result.value).toHaveProperty('checkedAt');
    expect(result.value).toHaveProperty('analysisTimeMs');
    expect(result.value).toHaveProperty('layers');

    // Verify types
    expect(typeof result.value.isHoneypot).toBe('boolean');
    expect(typeof result.value.riskScore).toBe('number');
    expect(typeof result.value.confidence).toBe('number');
    expect(Array.isArray(result.value.flags)).toBe(true);
    expect(result.value.checkedAt).toBeInstanceOf(Date);
    expect(typeof result.value.analysisTimeMs).toBe('number');
  });

  it('should calculate risk threshold correctly', async () => {
    const { HoneypotDetector } = await import(
      '../../../src/services/honeypot/detector.js'
    );

    const detector = new HoneypotDetector({
      highRiskThreshold: 70,
      cacheEnabled: false,
      enableGoPlusAPI: false,
      enableOnChainChecks: false,
    });

    const result = await detector.check('So11111111111111111111111111111111111111112');

    expect(result.success).toBe(true);
    if (!result.success) return;

    // With no data, should be low risk (< 70)
    expect(result.value.isHoneypot).toBe(false);
    expect(result.value.riskScore).toBeLessThan(70);
  });
});

describe('HoneypotDetector - Singleton Pattern', () => {
  it('should create and return singleton instance', async () => {
    // Reset singleton for testing
    const detector = await import('../../../src/services/honeypot/detector.js');

    const instance1 = detector.initializeHoneypotDetector();
    const instance2 = detector.getHoneypotDetector();

    expect(instance1).toBe(instance2);
  });
});
