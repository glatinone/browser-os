import type { HealedStep } from '@browser-os/memory';
import { openStore, TrajectoryStore } from '@browser-os/memory';
import type {
  ActionResult,
  BrowserAction,
  Clock,
  ElementLocator,
  ErrorCode,
  ExecutionContext,
  Trajectory,
  TrajectoryStep,
} from '@browser-os/protocol';
import { BosError } from '@browser-os/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteOptions } from '../src/router/types.js';
import {
  isNonTrajectoryFailure,
  type ReplayFailure,
  type ReplayResult,
  type ReplayRouterPort,
  substituteParams,
  TrajectoryReplayer,
} from '../src/tasks/replayer.js';

/**
 * P7-06 trajectory replayer, unit tier (card:
 * docs/tasks/phase-07-router-and-tasks.md P7-06). Covers the memory §6.2 replay
 * algorithm (param/secret pre-flight, precondition poll, heal detection, the
 * single recordRun call per replay), the §6.1 / integration §8 rule that
 * challenge and permission failures never burn the trajectory, and S9: the
 * step's recorded risk is handed to the router as `recordedRisk` only — the
 * live classification always runs and can only ever be raised, never lowered.
 */

function locator(name: string): ElementLocator {
  return {
    v: 1,
    role: 'button',
    name,
    nameIsDynamic: false,
    tag: 'button',
    attrs: {},
    context: [],
    cssPath: '#go',
    framePath: [],
    ordinal: 0,
  };
}

const OLD = locator('Search');
const NEW = locator('Go');

const CLICK: BrowserAction = { type: 'click', target: { kind: 'locator', locator: OLD } };

function steps(): TrajectoryStep[] {
  return [
    {
      index: 0,
      action: { type: 'navigate', url: 'https://shop.test/buy/{{product}}' },
      intent: null,
      pre: { urlPattern: '/' },
      risk: 'low',
    },
    {
      index: 1,
      action: CLICK,
      intent: 'the search box',
      pre: { urlPattern: '/buy/**' },
      risk: 'medium',
    },
  ];
}

function trajectoryRow(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    id: 'trj_test',
    taskKey: 'shop.search',
    origin: 'https://shop.test',
    startUrl: 'https://shop.test/',
    version: 3,
    params: ['product'],
    secretNames: [],
    steps: steps(),
    status: 'active',
    stats: { runs: 0, successes: 0, failures: 0, consecutiveFailures: 0, lastSuccessAt: null },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function resultOf(action: BrowserAction, overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    ok: true,
    action,
    tier: 'cache',
    driver: 'cdp',
    attempts: [],
    url: 'https://shop.test/buy/widget',
    pageChanged: false,
    ms: 1,
    llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
    risk: 'low',
    ...overrides,
  };
}

/** A router stand-in: canned results in order, every call recorded verbatim. */
function fakeRouter(results: ActionResult[]) {
  const calls: Array<{ action: BrowserAction; opts: ExecuteOptions | undefined }> = [];
  let i = 0;
  const router: ReplayRouterPort = {
    execute: vi.fn(async (action, _ctx, opts) => {
      calls.push({ action, opts });
      const next = results[Math.min(i, results.length - 1)] ?? results[results.length - 1]!;
      i += 1;
      return next;
    }),
  };
  return { router, calls };
}

interface Harness {
  replayer: TrajectoryReplayer;
  router: ReplayRouterPort;
  calls: Array<{ action: BrowserAction; opts: ExecuteOptions | undefined }>;
  store: TrajectoryStore;
  events: Array<{ type: string; data: unknown }>;
  ctx: ExecutionContext;
  url: (next: string) => void;
  advance: (ms: number) => void;
  polls: () => number;
}

function harness(results: ActionResult[], opts: { secret?: (name: string) => Promise<string> } = {}): Harness {
  const open = openStore(':memory:');
  const store = new TrajectoryStore(open.db);
  const { router, calls } = fakeRouter(results);
  const events: Array<{ type: string; data: unknown }> = [];
  let urlNow = 'https://shop.test/';
  let now = 1_000;
  const polls = { n: 0 };
  const replayer = new TrajectoryReplayer({
    router,
    trajectories: store,
    currentUrl: () => {
      polls.n += 1;
      return urlNow;
    },
    events: { emit: (e) => events.push({ type: e.type, data: e.data }) },
    probeTimeoutMs: 100,
    probeIntervalMs: 50,
    // Virtual clock: each poll tick advances ctx time by the interval, so the
    // probe budget is consumed without real waiting.
    sleep: async () => {
      now += 50;
    },
  });
  // The fake router moves the page like a real one: a result's `url` becomes
  // the live URL, so preconditions see the navigation the previous step caused.
  const inner = router.execute.bind(router);
  router.execute = (async (action, ctx, opts) => {
    const res = await inner(action, ctx, opts);
    urlNow = res.url;
    return res;
  }) as ReplayRouterPort['execute'];
  const ctx = {
    sessionId: 's1',
    pageId: 'p1',
    taskId: 't1',
    policy: {},
    params: { product: 'widget' },
    secrets: { resolve: opts.secret ?? (async (name: string) => `value-of-${name}`) },
    budget: {},
    signal: new AbortController().signal,
    clock: { now: () => now } as Clock,
  } as unknown as ExecutionContext;
  return {
    replayer,
    router,
    calls,
    store,
    events,
    ctx,
    url: (next) => {
      urlNow = next;
    },
    advance: (ms) => {
      now += ms;
    },
    polls: () => polls.n,
  };
}

/** Persist a real store row so recordRun has something to write counters on. */
function seed(store: TrajectoryStore, overrides: Partial<Trajectory> = {}): Trajectory {
  const row = trajectoryRow(overrides);
  return store.createRecorded({
    taskKey: row.taskKey,
    origin: row.origin,
    startUrl: row.startUrl,
    params: row.params,
    secretNames: row.secretNames,
    steps: row.steps,
  });
}

const PARAMS = { product: 'widget' };

/** Narrow a ReplayResult to its failure branch (fails the test if it succeeded). */
function failed(res: ReplayResult): ReplayFailure {
  if (res.ok) throw new Error(`expected a failed replay, got success: ${JSON.stringify(res.results.length)} steps`);
  return res;
}

function cacheResults(): ActionResult[] {
  return [
    resultOf(
      { type: 'navigate', url: 'https://shop.test/buy/widget' },
      {
        pageChanged: true,
        url: 'https://shop.test/buy/widget',
      },
    ),
    resultOf(CLICK, { locator: OLD, risk: 'medium' }),
  ];
}

describe('TrajectoryReplayer — happy path (memory §6.2)', () => {
  let h: Harness;
  let trj: Trajectory;

  beforeEach(() => {
    h = harness(cacheResults());
    trj = seed(h.store);
    // The page starts at the trajectory startUrl '/'; the fake router's step 0
    // navigates to /buy/widget, satisfying step 1's precondition.
  });

  it('all-cache replay → zero model calls, zero heals, counters bumped once', async () => {
    const res = await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.healed).toEqual([]);
    expect(res.results).toHaveLength(2);
    for (const r of res.results) {
      expect(r.llm.calls).toBe(0);
    }
    // one recordRun per replay: exactly one run recorded
    expect(res.trajectory).toMatchObject({ stats: { runs: 1, successes: 1, failures: 0, consecutiveFailures: 0 } });
    expect(h.events).toEqual([]);
  });

  it('substitutes {{param}} in the navigate URL and passes healIntent + recordedRisk (S9)', async () => {
    await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.action).toEqual({ type: 'navigate', url: 'https://shop.test/buy/widget' });
    expect(h.calls[0]!.opts).toEqual({ healIntent: null, recordedRisk: 'low' });
    expect(h.calls[1]!.action).toEqual(CLICK);
    // S9: the step risk travels ONLY as ExecuteOptions.recordedRisk, whose
    // router-side contract is max(live, recorded) — never a direct risk override.
    expect(h.calls[1]!.opts).toEqual({ healIntent: 'the search box', recordedRisk: 'medium' });
    expect(JSON.stringify(h.calls.map((c) => c.opts))).not.toContain('riskOverride');
  });

  it('a healed step → recordRun folds the locator into a new version + trajectory.healed event', async () => {
    h = harness([cacheResults()[0]!, resultOf(CLICK, { tier: 'deterministic', locator: NEW, risk: 'medium' })]);
    trj = seed(h.store);

    const res = await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.healed).toEqual([{ index: 1, locator: NEW }] satisfies HealedStep[]);
    expect(res.trajectory).toMatchObject({ version: 2, status: 'active' });
    // the healed locator really landed in the stored steps of the new version
    const stored = h.store.getById(trj.id)!;
    expect(stored.version).toBe(2);
    const storedStep = stored.steps[1]!;
    expect(storedStep.action).toMatchObject({ target: { kind: 'locator', locator: { name: 'Go' } } });
    expect(h.events).toEqual([
      {
        type: 'trajectory.healed',
        data: { trajectoryId: trj.id, step: 1, newVersion: 2 },
      },
    ]);
  });

  it('a cache-tier locator step is never counted as healed', async () => {
    const res = await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx);
    expect(res.ok && res.healed).toEqual([]);
  });
});

describe('TrajectoryReplayer — failure ladder (memory §6.2)', () => {
  it('a failing step → suspect; a second failure → invalid', async () => {
    const fail = resultOf(CLICK, {
      ok: false,
      tier: null,
      url: 'https://shop.test/buy/widget', // the page is where step 1 expects it
      error: { code: 'ACTION_FAILED', message: 'element disappeared' },
    });
    const h = harness([cacheResults()[0]!, fail]);
    const trj = seed(h.store);

    const first = failed(await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx));
    expect(first.step).toBe(1);
    expect(first.recorded).toBe(true);
    expect(first.results).toHaveLength(2);
    expect(h.store.getById(trj.id)).toMatchObject({
      status: 'suspect',
      stats: { runs: 1, failures: 1, consecutiveFailures: 1 },
    });

    const second = await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx);
    expect(second.ok).toBe(false);
    expect(h.store.getById(trj.id)).toMatchObject({
      status: 'invalid',
      stats: { runs: 2, consecutiveFailures: 2 },
    });
  });
});

describe('TrajectoryReplayer — §6.1 / integration §8 non-trajectory failures', () => {
  const challengeErrors: Array<{ code: ErrorCode; message: string; details?: Record<string, unknown> }> = [
    { code: 'SECURITY_CHALLENGE', message: 'captcha' },
    { code: 'HUMAN_REQUIRED', message: 'login needed', details: { reason: 'login' } },
    { code: 'PERMISSION_DENIED', message: 'site blocked' },
  ];

  for (const error of challengeErrors) {
    it(`${error.code} fails the task but does NOT call recordRun`, async () => {
      const h = harness([cacheResults()[0]!, resultOf(CLICK, { ok: false, tier: null, error })]);
      const trj = seed(h.store);

      const res = failed(await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx));

      expect(res.error.code).toBe(error.code);
      expect(res.step).toBe(1);
      expect(res.recorded).toBe(false);
      const after = h.store.getById(trj.id)!;
      expect(after).toMatchObject({ status: 'active', stats: { runs: 0, failures: 0, consecutiveFailures: 0 } });
    });
  }

  it('isNonTrajectoryFailure keeps ordinary failures and non-challenge human requests as real failures', () => {
    expect(isNonTrajectoryFailure({ code: 'ACTION_FAILED' })).toBe(false);
    expect(isNonTrajectoryFailure({ code: 'HUMAN_REQUIRED', details: { reason: 'decision' } })).toBe(false);
    expect(isNonTrajectoryFailure({ code: 'HUMAN_REQUIRED', details: { reason: 'captcha' } })).toBe(true);
    expect(isNonTrajectoryFailure(undefined)).toBe(false);
  });
});

describe('TrajectoryReplayer — precondition wait (memory §6.2)', () => {
  it('precondition mismatch within the probe budget → TRAJECTORY_STEP_FAILED, step never executed', async () => {
    // step 0 "navigates" but the page stays on '/' (a failed SPA navigation),
    // so step 1's /buy/* precondition never lands within the 100 ms budget.
    const h = harness([
      resultOf(
        { type: 'navigate', url: 'https://shop.test/buy/widget' },
        {
          pageChanged: false,
          url: 'https://shop.test/',
        },
      ),
      resultOf(CLICK, { locator: OLD, risk: 'medium' }),
    ]);
    const trj = seed(h.store);

    const res = failed(await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx));

    expect(res.error.code).toBe('TRAJECTORY_STEP_FAILED');
    expect(res.step).toBe(1);
    expect(res.recorded).toBe(true);
    expect(res.error.details).toMatchObject({ step: 1, reason: 'precondition', expected: '/buy/**' });
    // only step 0 reached the router
    expect(h.calls).toHaveLength(1);
    expect(h.store.getById(trj.id)).toMatchObject({
      status: 'suspect',
      stats: { consecutiveFailures: 1 },
    });
  });

  it('an SPA route that lands mid-budget is waited for, not failed', async () => {
    const h = harness(cacheResults());
    const trj = seed(h.store);
    const before = h.polls();

    const res = await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx);

    expect(res.ok).toBe(true);
    expect(h.polls()).toBeGreaterThan(before); // currentUrl was polled at least once
    expect(h.calls).toHaveLength(2);
  });
});

describe('TrajectoryReplayer — pre-flight (memory §6.2 step 1)', () => {
  it('missing task param → INVALID_REQUEST before any action executes', async () => {
    const h = harness(cacheResults());
    const trj = seed(h.store);

    const res = failed(await h.replayer.replay({ trajectory: trj, params: {} }, h.ctx));

    expect(res.error.code).toBe('INVALID_REQUEST');
    expect(res.error.message).toContain('product');
    expect(res.step).toBeUndefined();
    expect(res.recorded).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.store.getById(trj.id)).toMatchObject({ stats: { runs: 0 } });
  });

  it('unresolvable secret → INVALID_REQUEST, the value never appears in the error', async () => {
    const h = harness(cacheResults(), {
      secret: async () => {
        throw new BosError('PERMISSION_DENIED', 'no vault entry for "checkout.card"');
      },
    });
    const trj = seed(h.store, { secretNames: ['checkout.card'] });

    const res = failed(await h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx));

    expect(res.error.code).toBe('INVALID_REQUEST');
    expect(res.error.message).toContain('checkout.card'); // name kept
    expect(h.calls).toHaveLength(0);
  });

  it('an aborted signal cancels the replay as a CANCELLED error', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness(cacheResults());
    const trj = seed(h.store);
    (h.ctx as { signal: AbortSignal }).signal = controller.signal;

    await expect(h.replayer.replay({ trajectory: trj, params: PARAMS }, h.ctx)).rejects.toThrow(/cancel/i);
  });
});

describe('substituteParams', () => {
  it('expands placeholders in navigate URLs only', () => {
    expect(substituteParams({ type: 'navigate', url: 'https://x.test/{{q}}/go' }, { q: 'a b' })).toEqual({
      type: 'navigate',
      url: 'https://x.test/a b/go',
    });
    expect(substituteParams(CLICK, { q: 'a b' })).toBe(CLICK);
  });
});
