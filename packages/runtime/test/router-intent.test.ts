import type { IndexEntry, Observation, ObservationIndex, SemanticElement } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BosError } from '../src/errors.js';
import { learnFromResolution, resolveIntentTarget } from '../src/router/resolve-intent.js';

/**
 * P7-03 intent tier ladder (action-router §5 case `intent`).
 * Unit tests with fakes — no page, no CDP, no network.
 */

function makeElement(
  ref: string,
  role: string,
  name: string,
  tag = 'button',
  state: Record<string, unknown> = {},
): SemanticElement {
  return {
    ref,
    role,
    name,
    tag,
    state,
    inViewport: true,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    frame: 'f0',
    context: [],
    placeholder: '',
    description: '',
  } as unknown as SemanticElement;
}

function makeEntry(el: SemanticElement, backendNodeId?: number): IndexEntry {
  return {
    backendNodeId: backendNodeId ?? (Number(el.ref.replace(/\D/g, '')) || 1),
    frameId: 'f0',
    cdpFrameId: '1',
    locator: {
      v: 1,
      role: el.role,
      name: el.name,
      nameIsDynamic: false,
      tag: el.tag,
      attrs: { 'data-test': el.name.toLowerCase().replace(/\s+/g, '-') },
      context: [],
      cssPath: `#${el.ref}`,
      framePath: [],
      ordinal: 0,
    },
  };
}

function makeObservation(
  id: string,
  elements: SemanticElement[],
  url = 'https://example.test/',
  challenge = null,
): { observation: Observation; index: ObservationIndex } {
  const entries = new Map<string, IndexEntry>();
  for (const el of elements) entries.set(el.ref, makeEntry(el));
  const observation = {
    id,
    sessionId: 's1',
    pageId: 'p1',
    url,
    title: 'Example',
    capturedAt: 1_700_000_000_000,
    frames: [],
    elements,
    text: [],
    dialogs: [],
    challenge,
    warnings: [],
    stats: { domNodes: 3, axNodes: 3, elements: elements.length, captureMs: 1, buildMs: 1, estTokens: 10 },
  } as unknown as Observation;
  return { observation, index: { observationId: id, pageId: 'p1', entries } };
}

function makeDeps(
  obs: { observation: Observation; index: ObservationIndex },
  opts: {
    cacheHit?: { key: string; locator: any } | null;
    slowCapture?: boolean;
    captureError?: Error;
  } = {},
) {
  const { cacheHit = null, slowCapture = false, captureError = null } = opts;
  const events: Array<{ type: string; data: any }> = [];
  const driver: any = {
    cdpPerform: vi.fn(async () => ({
      ok: true,
      effect: 'committed',
      urlBefore: 'https://example.test/',
      urlAfter: 'https://example.test/',
      navigated: false,
    })),
    playwrightPerform: vi.fn(async () => ({
      ok: true,
      effect: 'committed',
      urlBefore: 'https://example.test/',
      urlAfter: 'https://example.test/',
      navigated: false,
    })),
    readValue: vi.fn(async () => 'x'),
  };
  const observer = {
    capture: vi.fn(async () => {
      if (captureError) throw captureError;
      if (slowCapture) await new Promise((r) => setTimeout(r, 10));
      return obs;
    }),
    index: vi.fn(() => obs.index),
    invalidate: vi.fn(),
  };
  const cache = {
    get: vi.fn(() => cacheHit),
    put: vi.fn(),
    recordHit: vi.fn(),
    recordMiss: vi.fn(() => 1),
    invalidate: vi.fn(),
  };
  return { driver, observer, cache, events };
}

function makeInput(
  overrides: Partial<{
    intent: string;
    actionType: 'click' | 'fill' | 'hover';
    url: string;
    sessionId: string;
    pageId: string;
    params: Record<string, string>;
    healIntent: string | null;
    skipCache: boolean;
  }> = {},
) {
  return {
    intent: overrides.intent ?? 'click the save button',
    actionType: overrides.actionType ?? 'click',
    url: overrides.url ?? 'https://example.test/page',
    sessionId: overrides.sessionId ?? 's1',
    pageId: overrides.pageId ?? 'p1',
    params: overrides.params ?? {},
    healIntent: overrides.healIntent ?? null,
    skipCache: overrides.skipCache ?? false,
  };
}

describe('resolveIntentTarget (P7-03 intent tier ladder)', () => {
  it('tier 1: cache hit — cached locator resolves and returns cache tier', async () => {
    const el = makeElement('e1', 'button', 'Save');
    const { observation, index } = makeObservation('obs1', [el]);
    const { driver, observer, cache } = makeDeps(
      { observation, index },
      {
        cacheHit: {
          key: 'cache:key1',
          locator: {
            v: 1,
            role: 'button',
            name: 'Save',
            nameIsDynamic: false,
            tag: 'button',
            attrs: {},
            context: [],
            cssPath: '#e1',
            framePath: [],
            ordinal: 0,
          },
        },
      },
    );
    const attempts: any[] = [];

    const result = await resolveIntentTarget(makeInput(), attempts, {
      driver,
      observer,
      cache,
      cdp: null,
      worlds: null,
      mainCdpFrameId: '',
    });

    expect(result.tier).toBe('cache');
    expect(result.entry).toMatchObject({ locator: { role: 'button', name: 'Save' } });
    expect(attempts).toEqual([{ tier: 'cache', ok: true, ms: expect.any(Number) }]);
    expect(cache.get).toHaveBeenCalledTimes(1);
    // resolution alone must not dispatch anything — the driver runs later, in the router
    expect(driver.cdpPerform).not.toHaveBeenCalled();
    expect(driver.playwrightPerform).not.toHaveBeenCalled();
  });

  it('tier 1: cache miss — cached locator not found in fresh observation, falls to deterministic', async () => {
    const el = makeElement('e1', 'button', 'Save');
    const { observation, index } = makeObservation('obs1', [el]);
    const { driver, observer, cache } = makeDeps(
      { observation, index },
      {
        // the page changed: the cached 'Delete' button is gone, 'Save' is back
        cacheHit: {
          key: 'cache:key1',
          locator: {
            v: 1,
            role: 'button',
            name: 'Delete',
            nameIsDynamic: false,
            tag: 'button',
            attrs: {},
            context: [],
            cssPath: '#e9',
            framePath: [],
            ordinal: 0,
          },
        },
      },
    );
    const attempts: any[] = [];

    const result = await resolveIntentTarget(makeInput(), attempts, {
      driver,
      observer,
      cache,
      cdp: null,
      worlds: null,
      mainCdpFrameId: '',
    });

    expect(result.tier).toBe('deterministic');
    expect(attempts).toContainEqual(expect.objectContaining({ tier: 'cache', ok: false, reason: 'locator_not_found' }));
    expect(attempts).toContainEqual(expect.objectContaining({ tier: 'deterministic', ok: true }));
    expect(cache.recordMiss).toHaveBeenCalledWith('cache:key1');
    expect(driver.cdpPerform).not.toHaveBeenCalled();
  });

  it('tier 2: deterministic — unique lexical match returns deterministic tier', async () => {
    const el = makeElement('e1', 'button', 'Save');
    const { observation, index } = makeObservation('obs1', [el]);
    const { driver, observer, cache } = makeDeps({ observation, index });
    const attempts: any[] = [];

    const result = await resolveIntentTarget(makeInput({ intent: 'click the save button' }), attempts, {
      driver,
      observer,
      cache,
      cdp: null,
      worlds: null,
      mainCdpFrameId: '',
    });

    expect(result.tier).toBe('deterministic');
    expect(result.element).toMatchObject({ ref: 'e1', role: 'button', name: 'Save' });
    expect(attempts).toContainEqual(expect.objectContaining({ tier: 'deterministic', ok: true }));
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(driver.cdpPerform).not.toHaveBeenCalled();
  });

  it('tier 2: ambiguous — multiple matching elements throws TARGET_NOT_FOUND', async () => {
    const { observation, index } = makeObservation('obs1', [
      makeElement('e1', 'button', 'Save'),
      makeElement('e2', 'button', 'Save'),
    ]);
    const { driver, observer, cache } = makeDeps({ observation, index });
    const attempts: any[] = [];

    await expect(
      resolveIntentTarget(makeInput({ intent: 'click the save button' }), attempts, {
        driver,
        observer,
        cache,
        cdp: null,
        worlds: null,
        mainCdpFrameId: '',
      }),
    ).rejects.toThrow(BosError);

    expect(attempts).toContainEqual(
      expect.objectContaining({ tier: 'deterministic', ok: false, reason: 'TARGET_AMBIGUOUS' }),
    );
    expect(driver.cdpPerform).not.toHaveBeenCalled();
  });

  it('tier 2: no match — no elements match throws TARGET_NOT_FOUND', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { driver, observer, cache } = makeDeps({ observation, index });
    const attempts: any[] = [];

    await expect(
      resolveIntentTarget(makeInput({ intent: 'cancel' }), attempts, {
        driver,
        observer,
        cache,
        cdp: null,
        worlds: null,
        mainCdpFrameId: '',
      }),
    ).rejects.toThrow(BosError);

    expect(attempts).toContainEqual(
      expect.objectContaining({ tier: 'deterministic', ok: false, reason: 'TARGET_NOT_FOUND' }),
    );
    expect(driver.cdpPerform).not.toHaveBeenCalled();
  });

  it('tier 2: healIntent — when the caller intent fails, the ladder continues from tier 2 with the healed intent', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e7', 'button', 'Save')]);
    const { driver, observer, cache } = makeDeps({ observation, index });
    const attempts: any[] = [];

    const result = await resolveIntentTarget(
      makeInput({ intent: 'original', healIntent: 'click the save button' }),
      attempts,
      { driver, observer, cache, cdp: null, worlds: null, mainCdpFrameId: '' },
    );

    expect(result.tier).toBe('deterministic');
    expect(result.element).toMatchObject({ ref: 'e7', role: 'button', name: 'Save' });
    expect(attempts).toContainEqual(expect.objectContaining({ tier: 'deterministic', ok: true }));
    // tier 1 was consulted once for the caller's intent, then the recursion
    // continues from tier 2 with the healed intent (skipCache) — never twice.
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(driver.cdpPerform).not.toHaveBeenCalled();
  });

  it('learnFromResolution: a param value inside the name becomes a dynamic-name locator', () => {
    const cache = { get: vi.fn(), put: vi.fn(), recordHit: vi.fn(), recordMiss: vi.fn(), invalidate: vi.fn() };
    const locator = makeEntry(makeElement('e1', 'button', 'Save order 123')).locator as any;
    const query = {
      origin: 'https://example.test',
      pathTemplate: '/page',
      actionType: 'click',
      intent: 'save the order',
    };
    const params = { orderId: '123' };

    learnFromResolution(locator, query, params, cache);

    // memory §4.2: the literal param value is stripped from the name and the
    // locator is marked dynamic, so a later cache hit substitutes it back.
    expect(cache.put).toHaveBeenCalledWith(
      query,
      expect.objectContaining({
        role: 'button',
        nameIsDynamic: true,
        name: '',
      }),
    );
  });

  it('learnFromResolution: an unrelated param leaves the locator literal and still caches it', () => {
    const cache = { get: vi.fn(), put: vi.fn(), recordHit: vi.fn(), recordMiss: vi.fn(), invalidate: vi.fn() };
    const locator = makeEntry(makeElement('e1', 'button', 'Save')).locator as any;
    const query = { origin: 'https://example.test', pathTemplate: '/page', actionType: 'click', intent: 'save' };

    learnFromResolution(locator, query, { orderId: '123' }, cache);

    expect(cache.put).toHaveBeenCalledWith(
      query,
      expect.objectContaining({
        name: 'Save',
        nameIsDynamic: false,
      }),
    );
  });
});
