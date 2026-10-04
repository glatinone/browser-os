import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ActionType,
  type BrowserAction,
  DEFAULT_POLICY,
  type DeepPartial,
  hasTarget,
  mergePolicy,
  type Policy,
  TARGETLESS,
  type Target,
  type ValueSource,
} from '../src/index.js';

describe('discriminated unions', () => {
  it('keeps the compile-time shapes the spec defines', () => {
    // `type` / `kind` are the discriminants every resolver switches on.
    expectTypeOf<BrowserAction['type']>().toEqualTypeOf<ActionType>();
    expectTypeOf<Extract<BrowserAction, { type: 'navigate' }>['url']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<BrowserAction, { type: 'fill' }>['value']>().toEqualTypeOf<ValueSource>();
    expectTypeOf<Extract<BrowserAction, { type: 'fill' }>['submit']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Extract<BrowserAction, { type: 'click' }>['clickCount']>().toEqualTypeOf<1 | 2 | undefined>();

    expectTypeOf<Extract<Target, { kind: 'ref' }>['ref']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<Target, { kind: 'ref' }>['observationId']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<Target, { kind: 'intent' }>['text']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<Target, { kind: 'query' }>['nth']>().toEqualTypeOf<number | undefined>();

    expectTypeOf<Extract<ValueSource, { kind: 'literal' }>['value']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<ValueSource, { kind: 'param' }>['name']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<ValueSource, { kind: 'secret' }>['name']>().toEqualTypeOf<string>();
  });

  it('narrows on the discriminant at runtime', () => {
    const actions: BrowserAction[] = [
      { type: 'navigate', url: 'https://example.com' },
      { type: 'click', target: { kind: 'intent', text: 'the search box' } },
      {
        type: 'fill',
        target: { kind: 'ref', ref: 'e3', observationId: 'obs_1' },
        value: { kind: 'param', name: 'query' },
      },
      { type: 'wait', until: 'settled' },
    ];
    const kinds = actions.map((a) => (a.type === 'fill' ? a.value.kind : a.type === 'navigate' ? a.url : a.type));
    expect(kinds).toEqual(['https://example.com', 'click', 'param', 'wait']);
  });
});

describe('TARGETLESS and hasTarget', () => {
  it('lists only the action types that never take a target', () => {
    expect([...TARGETLESS].sort()).toEqual(['navigate', 'wait']);
  });

  it('decides per action, not per type', () => {
    expect(hasTarget({ type: 'navigate', url: 'https://example.com' })).toBe(false);
    expect(hasTarget({ type: 'wait', until: 'load' })).toBe(false);
    expect(hasTarget({ type: 'press', key: 'Enter' })).toBe(false);
    expect(hasTarget({ type: 'scroll', direction: 'down' })).toBe(false);
    expect(hasTarget({ type: 'extract', format: 'text' })).toBe(false);
    expect(hasTarget({ type: 'press', key: 'Enter', target: { kind: 'intent', text: 'the form' } })).toBe(true);
    expect(hasTarget({ type: 'scroll', direction: 'up', target: { kind: 'intent', text: 'the list' } })).toBe(true);
    expect(hasTarget({ type: 'extract', format: 'links', target: { kind: 'intent', text: 'the footer' } })).toBe(true);
    expect(hasTarget({ type: 'click', target: { kind: 'intent', text: 'Sign in' } })).toBe(true);
    expect(hasTarget({ type: 'upload', target: { kind: 'query', css: '#file' }, paths: ['/tmp/a.pdf'] })).toBe(true);
  });
});

describe('DEFAULT_POLICY', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_POLICY).toEqual({
      risk: { low: 'allow', medium: 'allow', high: 'confirm' },
      sites: [],
      tiers: { llm: true, vision: false, human: true },
      budgets: {
        maxLlmCallsPerAction: 2,
        maxLlmCallsPerTask: 20,
        maxRetriesPerAction: 2,
        actionTimeoutMs: 15000,
        humanTimeoutMs: 600000,
      },
      uploads: { allowedDirs: [] },
      downloads: { enabled: false, dir: null },
    });
  });

  it('is frozen against accidental mutation by a shared importer', () => {
    const snapshot = structuredClone(DEFAULT_POLICY);
    const merged = mergePolicy(DEFAULT_POLICY, { risk: { high: 'deny' } });
    expect(merged.risk.high).toBe('deny');
    expect(DEFAULT_POLICY).toEqual(snapshot);
  });
});

describe('mergePolicy', () => {
  it('returns the base unchanged when there is no override', () => {
    expect(mergePolicy(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    expect(mergePolicy(DEFAULT_POLICY, {})).toEqual(DEFAULT_POLICY);
  });

  it('merges nested objects key by key', () => {
    const merged = mergePolicy(DEFAULT_POLICY, { budgets: { maxLlmCallsPerTask: 5 }, risk: { high: 'deny' } });
    expect(merged.budgets.maxLlmCallsPerTask).toBe(5);
    expect(merged.budgets.maxLlmCallsPerAction).toBe(2); // untouched
    expect(merged.risk).toEqual({ low: 'allow', medium: 'allow', high: 'deny' });
  });

  it('replaces arrays instead of concatenating them', () => {
    const merged = mergePolicy(DEFAULT_POLICY, { uploads: { allowedDirs: ['/tmp/uploads'] } });
    expect(merged.uploads.allowedDirs).toEqual(['/tmp/uploads']);
    expect(mergePolicy(merged, { uploads: { allowedDirs: [] } }).uploads.allowedDirs).toEqual([]);
  });

  it('replaces the sites list wholesale, because order decides the match', () => {
    const sites: Policy['sites'] = [
      { originPattern: '*.bank.example', access: 'deny' },
      { originPattern: 'https://app.example.com', risk: { low: 'confirm' } },
    ];
    const merged = mergePolicy(DEFAULT_POLICY, { sites });
    expect(merged.sites).toEqual(sites);
    expect(mergePolicy(merged, { sites: [] }).sites).toEqual([]);
  });

  it('never mutates its arguments', () => {
    const base = structuredClone(DEFAULT_POLICY);
    const override: DeepPartial<Policy> = { downloads: { enabled: true, dir: 'C:/tmp/dl' }, tiers: { vision: true } };
    const overrideSnapshot = structuredClone(override);
    mergePolicy(base, override);
    expect(base).toEqual(DEFAULT_POLICY);
    expect(override).toEqual(overrideSnapshot);
  });
});
