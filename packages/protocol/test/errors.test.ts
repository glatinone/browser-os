import { describe, expect, it } from 'vitest';
import { BosError, ERROR_CODES, type ErrorCode, isBosError, RETRYABLE_BY_DEFAULT } from '../src/errors.js';

const RETRYABLE_EXPECTED: readonly ErrorCode[] = [
  'STALE_REF',
  'TARGET_OBSCURED',
  'TIMEOUT',
  'BROWSER_DISCONNECTED',
  'LLM_UNAVAILABLE',
];

describe('ERROR_CODES', () => {
  it('lists every code exactly once', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES.length).toBeGreaterThan(25);
  });
});

describe('BosError', () => {
  it('is a real Error with a stable name', () => {
    const error = new BosError('TARGET_NOT_FOUND', 'no match');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BosError);
    expect(error.name).toBe('BosError');
    expect(error.message).toBe('no match');
    expect(error.stack).toBeTypeOf('string');
  });

  it('defaults retryable per code (data-models §2) for every code in the list', () => {
    for (const code of ERROR_CODES) {
      const error = new BosError(code, 'x');
      expect(error.retryable, `${code} retryable default`).toBe(RETRYABLE_EXPECTED.includes(code));
    }
  });

  it('lets the caller override retryable in both directions', () => {
    expect(new BosError('ACTION_FAILED', 'x').retryable).toBe(false);
    expect(new BosError('ACTION_FAILED', 'x', { retryable: true }).retryable).toBe(true);
    expect(new BosError('TIMEOUT', 'x', { retryable: false }).retryable).toBe(false);
  });

  it('keeps the cause on the standard Error cause field', () => {
    const root = new Error('socket closed');
    const error = new BosError('BROWSER_DISCONNECTED', 'browser gone', { cause: root });
    expect(error.cause).toBe(root);
  });

  it('has no own `cause` property when none was passed', () => {
    expect('cause' in new BosError('INTERNAL', 'x')).toBe(false);
  });

  it('carries details and omits them from toJSON when absent', () => {
    const withDetails = new BosError('TARGET_AMBIGUOUS', 'two matches', {
      details: { candidates: ['e1', 'e2'] },
    });
    expect(withDetails.toJSON()).toEqual({
      code: 'TARGET_AMBIGUOUS',
      message: 'two matches',
      details: { candidates: ['e1', 'e2'] },
      retryable: false,
    });

    const withoutDetails = new BosError('INTERNAL', 'boom');
    expect(withoutDetails.toJSON()).toEqual({ code: 'INTERNAL', message: 'boom', retryable: false });
    expect(withoutDetails.toJSON()).not.toHaveProperty('details');
  });

  it('survives a JSON round trip', () => {
    const error = new BosError('TIMEOUT', 'too slow', { details: { timeoutMs: 1500 } });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'TIMEOUT',
      message: 'too slow',
      details: { timeoutMs: 1500 },
      retryable: true,
    });
  });
});

describe('isBosError', () => {
  it('accepts a real BosError', () => {
    expect(isBosError(new BosError('INTERNAL', 'x'))).toBe(true);
  });

  it('accepts a structurally similar error from another realm', () => {
    // Simulates an error created by a different copy of the package or a worker:
    // `instanceof` would fail here, the structural check must not.
    const foreign = Object.assign(new Error('x'), { name: 'BosError', code: 'TIMEOUT' });
    expect(isBosError(foreign)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const value of [
      null,
      undefined,
      0,
      '',
      'BROWSER_NOT_FOUND',
      new Error('plain'),
      {},
      { name: 'BosError' },
      { code: 'X' },
    ]) {
      expect(isBosError(value), `isBosError(${JSON.stringify(value)})`).toBe(false);
    }
  });
});

describe('RETRYABLE_BY_DEFAULT', () => {
  it('matches the documented set', () => {
    expect([...RETRYABLE_BY_DEFAULT].sort()).toEqual([...RETRYABLE_EXPECTED].sort());
  });
});
