import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  APILayerResult,
  HoneypotDetectorConfig,
  HoneypotProviderName,
  APIProvider,
} from '../../../src/types/honeypot.js';

const createMetrics = () => ({
  state: 'CLOSED' as const,
  failureCount: 0,
  successCount: 0,
  lastFailureTime: null,
  lastSuccessTime: null,
  nextAttemptTime: null,
});

type ProviderCheck = ReturnType<typeof vi.fn<[string], Promise<APILayerResult | null>>>;

const createMockProvider = (
  name: HoneypotProviderName,
  priority: number,
  fn: ProviderCheck
): APIProvider => ({
  name,
  priority,
  isAvailable: () => true,
  check: fn,
  getMetrics: () => createMetrics(),
  reset: () => {},
});

const baseConfig: HoneypotDetectorConfig = {
  providers: {
    goplus: { enabled: false, priority: 1, timeout: 1000 },
    rugcheck: { enabled: false, priority: 2, timeout: 1000 },
    tokensniffer: { enabled: false, priority: 3, timeout: 1000 },
  },
  fallbackChain: {
    enabled: true,
    stopOnFirstSuccess: true,
    maxProviders: 3,
  },
  highRiskThreshold: 70,
  mediumRiskThreshold: 30,
  cacheTTL: 3600,
  cacheEnabled: true,
  enableOnChainChecks: true,
};

describe('FallbackChain', () => {
  let goPlusCheck: ProviderCheck;
  let rugCheck: ProviderCheck;

  beforeEach(() => {
    goPlusCheck = vi.fn();
    rugCheck = vi.fn();
  });

  it('stops after first successful provider when configured', async () => {
    const { FallbackChain } = await import(
      '../../../src/services/honeypot/fallbackChain.js'
    );

    goPlusCheck.mockResolvedValue({
      source: 'goplus',
      score: 20,
      flags: [],
      data: {},
      timeMs: 50,
    });
    rugCheck.mockResolvedValue({
      source: 'rugcheck',
      score: 80,
      flags: [],
      data: {},
      timeMs: 60,
    });

    const chain = new FallbackChain(baseConfig);
    (chain as any).providers = [
      createMockProvider('goplus', 1, goPlusCheck),
      createMockProvider('rugcheck', 2, rugCheck),
    ];

    const result = await chain.execute('TOKEN');

    expect(result?.source).toBe('goplus');
    expect(goPlusCheck).toHaveBeenCalledTimes(1);
    expect(rugCheck).not.toHaveBeenCalled();
  });

  it('aggregates results when stopOnFirstSuccess is false', async () => {
    const { FallbackChain } = await import(
      '../../../src/services/honeypot/fallbackChain.js'
    );

    goPlusCheck.mockResolvedValue({
      source: 'goplus',
      score: 10,
      flags: [],
      data: {},
      timeMs: 40,
    });
    rugCheck.mockResolvedValue({
      source: 'rugcheck',
      score: 90,
      flags: ['MINT_AUTHORITY'],
      data: {},
      timeMs: 60,
    });

    const chain = new FallbackChain({
      ...baseConfig,
      fallbackChain: {
        ...baseConfig.fallbackChain,
        stopOnFirstSuccess: false,
        maxProviders: 2,
      },
    });

    (chain as any).providers = [
      createMockProvider('goplus', 1, goPlusCheck),
      createMockProvider('rugcheck', 2, rugCheck),
    ];

    const result = await chain.execute('TOKEN');

    expect(result?.source).toBe('rugcheck');
    expect(goPlusCheck).toHaveBeenCalledTimes(1);
    expect(rugCheck).toHaveBeenCalledTimes(1);
  });
});
