import { describe, expect, it, vi } from 'vitest';
import { systemClock } from '../src/index.js';

describe('systemClock', () => {
  it('reports the wall clock in epoch milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('reads Date.now() at call time, not at import time', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    expect(systemClock.now()).toBe(1_700_000_000_000);
    spy.mockReturnValue(1_700_000_000_001);
    expect(systemClock.now()).toBe(1_700_000_000_001);
    spy.mockRestore();
  });
});
