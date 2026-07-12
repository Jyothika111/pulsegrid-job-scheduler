const { computeRetryDelayMs } = require('../src/services/retryService');

describe('computeRetryDelayMs', () => {
  test('FIXED strategy always returns baseDelay', () => {
    expect(computeRetryDelayMs('FIXED', 1, 1000, 60000)).toBe(1000);
    expect(computeRetryDelayMs('FIXED', 5, 1000, 60000)).toBe(1000);
  });

  test('LINEAR strategy scales with attempt number', () => {
    expect(computeRetryDelayMs('LINEAR', 1, 1000, 60000)).toBe(1000);
    expect(computeRetryDelayMs('LINEAR', 3, 1000, 60000)).toBe(3000);
  });

  test('EXPONENTIAL strategy roughly doubles each attempt, within jitter bounds', () => {
    const d1 = computeRetryDelayMs('EXPONENTIAL', 1, 1000, 600000);
    const d2 = computeRetryDelayMs('EXPONENTIAL', 2, 1000, 600000);
    const d3 = computeRetryDelayMs('EXPONENTIAL', 3, 1000, 600000);
    // attempt 1: base * 2^0 = 1000, +/-20% jitter -> [800, 1200]
    expect(d1).toBeGreaterThanOrEqual(800);
    expect(d1).toBeLessThanOrEqual(1200);
    // attempt 2: base * 2^1 = 2000, +/-20% -> [1600, 2400]
    expect(d2).toBeGreaterThanOrEqual(1600);
    expect(d2).toBeLessThanOrEqual(2400);
    // attempt 3: base * 2^2 = 4000, +/-20% -> [3200, 4800]
    expect(d3).toBeGreaterThanOrEqual(3200);
    expect(d3).toBeLessThanOrEqual(4800);
  });

  test('EXPONENTIAL strategy is capped at maxDelayMs', () => {
    const d = computeRetryDelayMs('EXPONENTIAL', 20, 1000, 5000);
    expect(d).toBeLessThanOrEqual(5000);
  });

  test('NONE strategy returns null (no retry)', () => {
    expect(computeRetryDelayMs('NONE', 1, 1000, 60000)).toBeNull();
  });
});
