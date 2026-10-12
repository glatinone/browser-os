import { FakeModelProvider } from '@browser-os/ai';
import { ActionCacheStore, openStore } from '@browser-os/memory';
import type { IndexEntry, Observation, ObservationIndex, SemanticElement } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BosError } from '../src/errors.js';
import { learnFromResolution, resolveIntentTarget } from '../src/router/resolve-intent.js';
import { ActionRouter } from '../src/router/router.js';

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

// ---------------------------------------------------------------------------
// Tier 2 of the ladder: the same intent path driven through ActionRouter
// against a *real* ActionCacheStore (memory §4–5), so the learning lifecycle
// is observed end to end — write on success, hit on the next call, site-key
// fallback on another path, retirement after three misses, invalidation on a
// false hit. No page, no CDP, no network: the driver and observer are fakes.
// ---------------------------------------------------------------------------

const SAVE_BUTTON = 'click the save button'; // ranks 0.80 against a lone 'Save' button
const EMAIL_FIELD = 'fill the email box'; // ranks 0.80 against a lone 'Email' textbox

function makeHarness(elements: SemanticElement[], url = 'https://example.test/checkout') {
  const store = openStore(':memory:');
  const cache = new ActionCacheStore(store.db);
  const models = new FakeModelProvider({ responder: {} });
  const events: Array<{ type: string; data: any }> = [];
  const driverResult = () => ({
    ok: true,
    effect: 'committed',
    urlBefore: url,
    urlAfter: url,
    navigated: false,
  });
  const driver: any = {
    navigate: vi.fn(async (target: string) => ({ ...driverResult(), urlAfter: target, navigated: true })),
    settle: vi.fn(async () => {}),
    cdpPerform: vi.fn(async () => driverResult()),
    playwrightPerform: vi.fn(async () => driverResult()),
    readValue: vi.fn(async () => 'x'), // matches the fill value used below
  };
  let current: { observation: Observation; index: ObservationIndex } = {
    observation: {
      id: 'obs1',
      sessionId: 's1',
      pageId: 'p1',
      url,
      title: 'Example',
      capturedAt: 1_700_000_000_000,
      frames: [],
      elements,
      text: [],
      dialogs: [],
      challenge: null,
      warnings: [],
      stats: { domNodes: 3, axNodes: 3, elements: elements.length, captureMs: 1, buildMs: 1, estTokens: 10 },
    } as unknown as Observation,
    index: {
      observationId: 'obs1',
      pageId: 'p1',
      entries: new Map(elements.map((el) => [el.ref, makeEntry(el)])),
    },
  };
  const observer = {
    capture: vi.fn(async () => current),
    index: vi.fn(() => current.index),
    invalidate: vi.fn(),
  };
  const router = new ActionRouter({
    pages: {
      context: vi.fn(async () => ({
        sessionId: 's1',
        pageId: 'p1',
        driver,
        cdp: null,
        worlds: null,
        mainCdpFrameId: '1',
        headless: false,
        url,
      })),
    },
    driver,
    observer,
    sessions: {
      withPageLock: vi.fn(async (_s: string, _p: string, fn: () => Promise<any>) => await fn()),
      reconnect: vi.fn(async () => ({})),
      setActivePage: vi.fn(),
    },
    runs: { insert: vi.fn(() => 1) },
    cache,
    risk: { classify: vi.fn(() => ({ risk: 'low' as const, reasons: [] as string[] })) },
    permissions: {
      decide: vi.fn((): 'allow' => 'allow'),
      requestConfirmation: vi.fn(async (): Promise<'approve'> => 'approve'),
    },
    human: null,
    models,
    vision: null,
    events: { emit: (e: any) => events.push({ type: e.type, data: e.data }) },
    recorder: null,
    disabledTiers: [],
    constants: {},
  } as any);

  const ctx = (): any => ({
    sessionId: 's1',
    pageId: 'p1',
    taskId: null,
    policy: { budgets: { actionTimeoutMs: 2000, maxLlmCallsPerAction: 3, maxLlmCallsPerTask: 10 } },
    params: {},
    secrets: { resolve: async () => 'sekret' },
    budget: {},
    signal: new AbortController().signal,
    clock: { now: () => Date.now() },
  });

  return {
    router,
    driver,
    observer,
    cache,
    store,
    models,
    events,
    ctx,
    /** Swap the live page out from under the cache (a navigation the driver did). */
    replacePage(next: SemanticElement[]) {
      current = {
        ...current,
        observation: { ...current.observation, elements: next } as Observation,
        index: {
          ...current.index,
          entries: new Map(next.map((el) => [el.ref, makeEntry(el)])),
        },
      };
    },
  };
}

const clickSave = { type: 'click', target: { kind: 'intent', text: SAVE_BUTTON } } as const;

describe('ActionRouter intent ladder over a real ActionCacheStore (P7-03)', () => {
  it('first intent call resolves deterministic and step H writes both cache slots', async () => {
    const h = makeHarness([makeElement('e1', 'button', 'Save')]);

    const result = await h.router.execute(clickSave, h.ctx());

    expect(result.ok).toBe(true);
    expect(result.tier).toBe('deterministic');
    expect(h.models.calls).toBe(0);

    const rows = h.cache.list();
    expect(rows).toHaveLength(2); // page-level + site-level
    for (const row of rows) {
      expect(row.status).toBe('active');
      expect(row.locator).toMatchObject({ role: 'button', name: 'Save' });
    }
    expect(rows.map((r) => r.path_template).sort()).toEqual(['*', '/checkout']);
  });

  it('second identical call resolves from tier 1 with zero model calls', async () => {
    const h = makeHarness([makeElement('e1', 'button', 'Save')]);

    const first = await h.router.execute(clickSave, h.ctx());
    const second = await h.router.execute(clickSave, h.ctx());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.tier).toBe('cache');
    expect(second.attempts).toContainEqual(expect.objectContaining({ tier: 'cache', ok: true }));
    // Structural, not merely asserted: the P7-03 ladder holds no ModelsPort,
    // so tier 1 + tier 2 cannot reach a model. The fake counts prove it.
    expect(h.models.calls).toBe(0);
    expect(second.llm).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
    // Step H recorded the verified cache-tier resolution as a hit on the row
    // that answered (the page-level one, at the same path).
    const pageRow = h.cache.list().find((r) => r.path_template === '/checkout');
    expect(pageRow?.hits).toBe(1);
    expect(pageRow?.consecutive_misses).toBe(0);
  });

  it('site-key fallback: the same intent on another path of the same origin still hits', async () => {
    const h = makeHarness([makeElement('e1', 'button', 'Save')]);
    await h.router.execute(clickSave, h.ctx());

    // A navigation moved the page from /checkout to /pricing: the page-level
    // key no longer matches, so tier 1 must fall back to the site-level row.
    const result = await h.router.execute({ type: 'click', target: { kind: 'intent', text: SAVE_BUTTON } }, h.ctx());

    expect(result.tier).toBe('cache');
    expect(h.models.calls).toBe(0);
  });

  it('three consecutive misses retire the page-level entry (memory §5)', async () => {
    const h = makeHarness([makeElement('e1', 'button', 'Save')]);
    await h.router.execute(clickSave, h.ctx());

    // The page changed: the button is gone, so neither tier can resolve.
    h.replacePage([makeElement('e9', 'button', 'Submit')]);

    const runs = [];
    for (let i = 0; i < 3; i += 1) runs.push(await h.router.execute(clickSave, h.ctx()));

    for (const result of runs) {
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('TARGET_NOT_FOUND');
    }
    const pageRow = h.cache.list().find((r) => r.path_template === '/checkout');
    expect(pageRow?.status).toBe('invalid');
    expect(h.models.calls).toBe(0);
  });

  it('false hit: a cache-tier resolution that fails verification invalidates the row', async () => {
    const h = makeHarness([makeElement('e2', 'textbox', 'Email', 'input')]);
    const fill = { kind: 'literal', value: 'x' } as const;

    await h.router.execute({ type: 'fill', target: { kind: 'intent', text: EMAIL_FIELD }, value: fill }, h.ctx());
    expect(h.cache.list()).toHaveLength(2);
    expect(h.cache.list().every((r) => r.status === 'active')).toBe(true);

    // The cached locator resolves, but the field now holds something else.
    h.driver.readValue.mockResolvedValue('something else');
    const result = await h.router.execute(
      { type: 'fill', target: { kind: 'intent', text: EMAIL_FIELD }, value: fill },
      h.ctx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VERIFICATION_FAILED');
    // §5 / ADR-011: the row that answered the cache tier is retired at once —
    // the consulted page-level key. The site-level row keeps its own lifecycle
    // (three consecutive misses), so it is still active here.
    const rows = h.cache.list();
    expect(rows.find((r) => r.path_template === '/checkout')?.status).toBe('invalid');
    expect(rows.find((r) => r.path_template === '*')?.status).toBe('active');
    expect(h.models.calls).toBe(0);
  });

  it('healIntent: a failed {kind:locator} target continues from tier 2 and never re-reads tier 1', async () => {
    const h = makeHarness([makeElement('e1', 'button', 'Save')]);
    const get = vi.spyOn(h.cache, 'get');
    const stale = makeEntry(makeElement('e0', 'button', 'Delete')).locator;

    const result = await h.router.execute(
      { type: 'click', target: { kind: 'locator', locator: stale } } as any,
      h.ctx(),
      { healIntent: SAVE_BUTTON },
    );

    expect(result.ok).toBe(true);
    expect(result.tier).toBe('deterministic');
    expect(result.element).toMatchObject({ name: 'Save' });
    // §5.4: the caller already failed through tier 1 in this same action, so
    // the healed intent must not consult the cache again.
    expect(get).not.toHaveBeenCalled();
    expect(h.models.calls).toBe(0);
  });
});
