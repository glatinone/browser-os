import type { IndexEntry, Observation, ObservationIndex, SemanticElement } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ActionRouter } from '../src/router/router.js';

/**
 * P7-02 router core, unit tier with fakes (card: docs/tasks/phase-07-router-and-tasks.md).
 * Everything here is a fake driver/observer — no page, no CDP, no network.
 */

function makeElement(ref: string, role: string, name: string, tag = 'button'): SemanticElement {
  return {
    ref,
    role,
    name,
    tag,
    state: {},
    inViewport: true,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    frame: 'f0',
    context: [],
  } as unknown as SemanticElement;
}

function makeEntry(el: SemanticElement): IndexEntry {
  return {
    backendNodeId: Number(el.ref.replace(/\D/g, '')) || 1,
    frameId: 'f0',
    cdpFrameId: '1',
    locator: {
      v: 1,
      role: el.role,
      name: el.name,
      nameIsDynamic: false,
      tag: el.tag,
      attrs: {},
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
): { observation: Observation; index: ObservationIndex } {
  const entries = new Map<string, IndexEntry>();
  for (const el of elements) entries.set(el.ref, makeEntry(el));
  const observation = {
    id,
    sessionId: 's1',
    pageId: 'p1',
    url: 'https://example.test/',
    title: 'Example',
    capturedAt: 1_700_000_000_000,
    frames: [],
    elements,
    text: [],
    dialogs: [],
    challenge: null,
    warnings: [],
    stats: { domNodes: 3, axNodes: 3, elements: elements.length, captureMs: 1, buildMs: 1, estTokens: 10 },
  } as unknown as Observation;
  return { observation, index: { observationId: id, pageId: 'p1', entries } };
}

interface Fakes {
  router: ActionRouter;
  driver: any;
  observer: any;
  events: Array<{ type: string; data: any }>;
}

function makeRouter(
  obs: { observation: Observation; index: ObservationIndex },
  opts: Record<string, unknown> = {},
): Fakes {
  const events: Array<{ type: string; data: any }> = [];
  const driver = {
    navigate: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    cdpPerform: vi.fn(async () => ({
      urlBefore: 'https://example.test/',
      urlAfter: 'https://example.test/',
      navigated: false,
    })),
    playwrightPerform: vi.fn(async () => ({
      urlBefore: 'https://example.test/',
      urlAfter: 'https://example.test/',
      navigated: false,
    })),
    readValue: vi.fn(async () => 'x'), // matches the fill value used by the tests
  };
  const observer = {
    capture: vi.fn(async () => obs),
    index: vi.fn(() => undefined),
    invalidate: vi.fn(),
  };
  const router = new ActionRouter({
    driver,
    observer,
    cache: {},
    model: null,
    risk: { classify: vi.fn(async () => ({ level: 'low' })) },
    permissions: { decide: vi.fn(async () => 'allow'), requestConfirmation: vi.fn(async () => 'approve') },
    human: null,
    events: { emit: (e: any) => events.push({ type: e.type, data: e.data }) },
    recorder: { isRecording: () => false, append: vi.fn(async () => {}) },
    constants: {},
    disabledTiers: [],
    ...opts,
  });
  return { router, driver, observer, events };
}

function makeCtx(): any {
  return {
    sessionId: 's1',
    pageId: 'p1',
    taskId: null,
    policy: { budgets: { actionTimeoutMs: 2000, maxLlmCallsPerAction: 3, maxLlmCallsPerTask: 10 } },
    params: {},
    secrets: { resolve: async () => 'sekret' },
    budget: {},
    signal: new AbortController().signal,
    clock: { now: () => Date.now() },
  };
}

const submit = { kind: 'literal', value: 'x' } as const;

describe('ActionRouter core (P7-02)', () => {
  it('runs a targetless navigate and emits started -> completed', async () => {
    const { router, driver, events } = makeRouter(makeObservation('obs1', []));
    const result = await router.execute({ type: 'navigate', url: 'https://example.test/a' }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.pageChanged).toBe(true);
    expect(driver.navigate).toHaveBeenCalledWith('https://example.test/a', expect.any(Number));
    expect(driver.settle).toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['action.started', 'action.completed']);
  });

  it('resolves a ref target through the observer and executes it', async () => {
    const el = makeElement('e1', 'button', 'Save');
    const { observation, index } = makeObservation('obs1', [el]);
    const { router, driver, observer, events } = makeRouter({ observation, index });

    const result = await router.execute(
      { type: 'click', target: { kind: 'ref', observationId: 'obs1', ref: 'e1' } },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.tier).toBe('ref');
    expect(result.element).toMatchObject({ ref: 'e1', role: 'button', name: 'Save' });
    expect(driver.cdpPerform).toHaveBeenCalledTimes(1);
    // requirement 4: an executed action invalidates the cached observation
    expect(observer.invalidate).toHaveBeenCalledWith('p1');
    expect(events.map((e) => e.type)).toEqual(['action.started', 'action.tier', 'action.completed']);
  });

  it('reports STALE_REF when the old observation is no longer cached', async () => {
    const el = makeElement('e1', 'button', 'Save');
    const { observation, index } = makeObservation('obs2', [el]);
    const { router, driver } = makeRouter({ observation, index });

    const result = await router.execute(
      { type: 'click', target: { kind: 'ref', observationId: 'obs_evicted', ref: 'e1' } },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STALE_REF');
    expect(driver.cdpPerform).not.toHaveBeenCalled();
  });

  it('rejects a ref that is not in the current observation', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router } = makeRouter({ observation, index });

    const result = await router.execute(
      { type: 'click', target: { kind: 'ref', observationId: 'obs1', ref: 'e9' } },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TARGET_NOT_FOUND');
  });

  it('query tier: unique match resolves and executes', async () => {
    const { observation, index } = makeObservation('obs1', [
      makeElement('e1', 'button', 'Save'),
      makeElement('e2', 'textbox', 'Email', 'input'),
    ]);
    const { router } = makeRouter({ observation, index });

    const result = await router.execute(
      { type: 'fill', target: { kind: 'query', role: 'textbox', name: 'Email' }, value: submit },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.tier).toBe('deterministic');
    expect(result.element).toMatchObject({ ref: 'e2' });
    expect(result.attempts.map((a) => a.tier)).toEqual(['deterministic']);
  });

  it('query tier: ambiguous match fails with TARGET_AMBIGUOUS and never runs the driver', async () => {
    const { observation, index } = makeObservation('obs1', [
      makeElement('e1', 'button', 'Save'),
      makeElement('e2', 'button', 'Save'),
    ]);
    const { router, driver } = makeRouter({ observation, index });

    const result = await router.execute(
      { type: 'click', target: { kind: 'query', role: 'button', name: 'Save' } },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TARGET_AMBIGUOUS');
    expect(driver.cdpPerform).not.toHaveBeenCalled();
  });

  it('query tier: no match fails with TARGET_NOT_FOUND', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router } = makeRouter({ observation, index });

    const result = await router.execute(
      { type: 'click', target: { kind: 'query', role: 'link', name: 'Docs' } },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TARGET_NOT_FOUND');
  });

  it('S20: an effect that is not provably none is never retried (ACTION_FAILED + details.effect)', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router, driver } = makeRouter({ observation, index });
    driver.cdpPerform.mockRejectedValue(
      Object.assign(new Error('obscured by overlay'), { code: 'TARGET_OBSCURED', effect: 'unknown' }),
    );

    const result = await router.execute(
      { type: 'click', target: { kind: 'query', role: 'button', name: 'Save' } },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ACTION_FAILED');
    expect(result.error?.details?.effect).toBe('unknown');
    expect(driver.playwrightPerform).not.toHaveBeenCalled();
  });

  it('falls back to Playwright only when the failed action had no effect', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router, driver } = makeRouter({ observation, index });
    driver.cdpPerform.mockRejectedValue(
      Object.assign(new Error('obscured by overlay'), { code: 'TARGET_OBSCURED', effect: 'none' }),
    );

    const result = await router.execute(
      { type: 'click', target: { kind: 'query', role: 'button', name: 'Save' } },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.driver).toBe('playwright');
    expect(driver.playwrightPerform).toHaveBeenCalledTimes(1);
  });

  it('verification failure becomes a failed ActionResult instead of throwing', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e2', 'textbox', 'Email', 'input')]);
    const { router, driver } = makeRouter({ observation, index });
    driver.readValue.mockResolvedValue('something else');

    const result = await router.execute(
      { type: 'fill', target: { kind: 'query', role: 'textbox', name: 'Email' }, value: submit },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VERIFICATION_FAILED');
  });

  it('keeps the router path well under the 5 ms overhead budget (fake driver, fake observer)', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router } = makeRouter({ observation, index });
    const action = { type: 'click' as const, target: { kind: 'query' as const, role: 'button', name: 'Save' } };
    const ctx = makeCtx();

    await router.execute(action, ctx); // warm-up
    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t0 = performance.now();
      await router.execute(action, ctx);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)];
    expect(p50).toBeLessThanOrEqual(5);
  });
});
