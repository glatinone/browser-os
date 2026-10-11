import type { IndexEntry, Observation, ObservationIndex, SemanticElement } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ActionRouter } from '../src/router/router.js';

/**
 * P7-02 router core, unit tier with fakes (card: docs/tasks/phase-07-router-and-tasks.md).
 * Everything here is a fake driver/observer — no page, no CDP, no network. The page lock
 * is the one fake that is real: a working mutex, because requirement 4 is about mutual
 * exclusion and a pass-through fake would prove nothing.
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

/** A working mutex standing in for SessionManager.withPageLock (requirement 4). */
function makePageLock() {
  let held = false;
  let concurrent = 0;
  let peak = 0;
  const waiting: Array<() => void> = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (held) await new Promise<void>((resolve) => waiting.push(resolve));
      held = true;
      concurrent += 1;
      if (concurrent > peak) peak = concurrent;
      try {
        return await fn();
      } finally {
        concurrent -= 1;
        const next = waiting.shift();
        if (next) next();
        else held = false;
      }
    },
    isHeld: () => held,
    peak: () => peak,
  };
}

/** A `DriverResult` for a driver that answered without dispatching anything interesting. */
function stayed(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    effect: 'committed',
    urlBefore: 'https://example.test/',
    urlAfter: 'https://example.test/',
    navigated: false,
    ...overrides,
  };
}

interface Fakes {
  router: ActionRouter;
  driver: any;
  observer: any;
  sessions: any;
  runs: { insert: ReturnType<typeof vi.fn> };
  lock: ReturnType<typeof makePageLock>;
  /** Whether each driver call saw the lock held (the direct proof of requirement 4). */
  lockSightings: boolean[];
  events: Array<{ type: string; data: any }>;
}

interface MakeRouterOpts {
  /** Index served for `Observer.index()` — the old observation the heal path re-matches. */
  staleIndex?: ObservationIndex;
  /** Adds two event-loop turns to every CDP perform, so overlap would be observable. */
  slowDriver?: boolean;
}

function makeRouter(
  obs: { observation: Observation; index: ObservationIndex },
  opts: MakeRouterOpts = {},
): Fakes {
  const events: Array<{ type: string; data: any }> = [];
  const lock = makePageLock();
  const lockSightings: boolean[] = [];
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const seeLock = () => lockSightings.push(lock.isHeld());
  const driver: any = {
    navigate: vi.fn(async (url: string) => {
      seeLock();
      return stayed({ urlBefore: 'https://example.test/', urlAfter: url, navigated: true });
    }),
    settle: vi.fn(async () => {}),
    cdpPerform: vi.fn(async () => {
      seeLock();
      if (opts.slowDriver) {
        await tick();
        await tick();
      }
      return stayed();
    }),
    playwrightPerform: vi.fn(async () => {
      seeLock();
      return stayed();
    }),
    readValue: vi.fn(async () => 'x'), // matches the fill value used by the tests
  };
  const observer = {
    capture: vi.fn(async () => obs),
    index: vi.fn(() => opts.staleIndex),
    invalidate: vi.fn(),
  };
  const sessions: any = {
    withPageLock: vi.fn(async (_sessionId: string, _pageId: string, fn: () => Promise<any>) => await lock.run(fn)),
    setActivePage: vi.fn(),
    reconnect: vi.fn(async () => ({})),
  };
  const runs = { insert: vi.fn(() => 1) };
  const router = new ActionRouter({
    driver,
    observer,
    sessions,
    runs,
    cache: { get: vi.fn(() => null), put: vi.fn(), recordHit: vi.fn(), recordMiss: vi.fn(), invalidate: vi.fn() },
    risk: { classify: vi.fn(() => ({ risk: 'low' as const, reasons: [] as string[] })) },
    permissions: {
      decide: vi.fn((): 'allow' => 'allow'),
      requestConfirmation: vi.fn(async (): Promise<'approve'> => 'approve'),
    },
    human: null,
    events: { emit: (e: any) => events.push({ type: e.type, data: e.data }) },
    recorder: { isRecording: () => false, append: vi.fn(), finalize: vi.fn() },
    constants: {},
    disabledTiers: [],
  });
  return { router, driver, observer, sessions, runs, lock, lockSightings, events };
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

  it('heals a stale ref by re-matching the old locator against the fresh observation', async () => {
    // The page re-rendered between capture and click: the old node is gone, the same
    // button came back under a new ref. This is the heal path, not the miss path.
    const old = makeObservation('obs_old', [makeElement('e1', 'button', 'Save')]);
    const { observation, index } = makeObservation('obs_now', [makeElement('e7', 'button', 'Save')]);
    const { router, driver } = makeRouter({ observation, index }, { staleIndex: old.index });

    const result = await router.execute(
      { type: 'click', target: { kind: 'ref', observationId: 'obs_old', ref: 'e1' } },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.tier).toBe('ref');
    expect(result.element).toMatchObject({ ref: 'e7', role: 'button', name: 'Save' });
    // the healed element's own backend node, not the stale ref's
    expect(driver.cdpPerform).toHaveBeenCalledTimes(1);
    expect(driver.cdpPerform.mock.calls[0][1]).toMatchObject({ backendNodeId: 7 });
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

  it('writes one action_runs row per executed action — failures included (§8)', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router, runs } = makeRouter({ observation, index });

    const ok = await router.execute(
      { type: 'click', target: { kind: 'query', role: 'button', name: 'Save' } },
      makeCtx(),
    );
    expect(ok.ok).toBe(true);
    expect(runs.insert).toHaveBeenCalledTimes(1);
    expect(runs.insert.mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      taskId: null,
      origin: 'https://example.test',
    });
    expect(runs.insert.mock.calls[0][1]).toMatchObject({ ok: true, tier: 'deterministic' });

    // A failure that never reached the driver still leaves its row.
    const failed = await router.execute(
      { type: 'click', target: { kind: 'query', role: 'link', name: 'Docs' } },
      makeCtx(),
    );
    expect(failed.ok).toBe(false);
    expect(runs.insert).toHaveBeenCalledTimes(2);
    expect(runs.insert.mock.calls[1][1]).toMatchObject({ ok: false });
    expect(runs.insert.mock.calls[1][1].error?.code).toBe('TARGET_NOT_FOUND');
  });

  it('runs the whole action inside the session page lock (requirement 4)', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router, driver, sessions, lockSightings, lock } = makeRouter({ observation, index });

    await router.execute({ type: 'click', target: { kind: 'query', role: 'button', name: 'Save' } }, makeCtx());

    expect(sessions.withPageLock).toHaveBeenCalledWith('s1', 'p1', expect.any(Function));
    expect(driver.cdpPerform).toHaveBeenCalledTimes(1);
    expect(lockSightings).toEqual([true]); // the driver call happened with the lock held
    expect(lock.peak()).toBe(1);
  });

  it('serializes concurrent actions on the same page instead of interleaving them', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router, lock } = makeRouter({ observation, index }, { slowDriver: true });
    const action = { type: 'click' as const, target: { kind: 'query' as const, role: 'button', name: 'Save' } };

    const results = await Promise.all([
      router.execute(action, makeCtx()),
      router.execute(action, makeCtx()),
      router.execute(action, makeCtx()),
      router.execute(action, makeCtx()),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(lock.peak()).toBe(1); // never two driver calls in flight at once
  });

  it('marks the tab it navigated to as the session active page (requirement 7)', async () => {
    const { router, sessions } = makeRouter(makeObservation('obs1', []));

    const result = await router.execute({ type: 'navigate', url: 'https://example.test/a' }, makeCtx());

    expect(result.pageChanged).toBe(true);
    expect(sessions.setActivePage).toHaveBeenCalledWith('s1', 'p1');
  });

  it('follows a tab the action opened into the session', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router, driver, sessions } = makeRouter({ observation, index });
    driver.cdpPerform.mockResolvedValue(
      stayed({ urlAfter: 'https://other.test/', navigated: true, newPageId: 'pg9' }),
    );

    const result = await router.execute(
      { type: 'click', target: { kind: 'query', role: 'button', name: 'Save' } },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.pageChanged).toBe(true);
    expect(sessions.setActivePage).toHaveBeenCalledWith('s1', 'pg9');
  });

  it('leaves the active page alone when the action stayed put', async () => {
    const { observation, index } = makeObservation('obs1', [makeElement('e1', 'button', 'Save')]);
    const { router, sessions } = makeRouter({ observation, index });

    await router.execute({ type: 'click', target: { kind: 'query', role: 'button', name: 'Save' } }, makeCtx());

    expect(sessions.setActivePage).not.toHaveBeenCalled();
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
