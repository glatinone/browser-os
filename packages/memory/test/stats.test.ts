import type { ActionResult } from '@browser-os/protocol';
import { beforeEach, expect, test } from 'vitest';
import { stats } from '../src/stats.js';
import { openStore, type Store } from '../src/store.js';
import { type RunContext, RunStore } from '../src/stores/run-store.js';
import { TaskStore } from '../src/stores/task-store.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

let open: Store;
let runs: RunStore;
let taskId: string;

function result(over: Partial<ActionResult> = {}): ActionResult {
  return {
    ok: true,
    action: { type: 'click', target: { kind: 'intent', text: 'the button' } },
    tier: 'cache',
    driver: 'cdp',
    attempts: [],
    url: 'https://example.com/',
    pageChanged: false,
    ms: 10,
    llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
    risk: 'low',
    ...over,
  };
}

/**
 * Five rows with metrics computed by hand (see each expectation below):
 *
 *  A  cache  ok   attempts cache 10ms                        -> cache hit
 *  B  cache  fail cache 20ms + deterministic 30ms, VERIFICATION_FAILED
 *                                                          -> false hit, escalated
 *  C  det    ok   cache 5ms miss + deterministic 15ms        -> escalated
 *  D  llm    ok   cache 5ms + det 8ms + llm 100ms, 1 call    -> escalated, llm spend
 *  E  null   ok   no attempts                                 -> targetless
 */
function seed(): void {
  const ctx: RunContext = { sessionId: 's1', taskId, origin: 'https://example.com', ts: NOW };

  runs.insert(ctx, result({ attempts: [{ tier: 'cache', ok: true, ms: 10 }] }));

  runs.insert(
    ctx,
    result({
      ok: false,
      error: { code: 'VERIFICATION_FAILED', message: 'mismatch' },
      attempts: [
        { tier: 'cache', ok: true, ms: 20 },
        { tier: 'deterministic', ok: false, ms: 30 },
      ],
    }),
  );

  runs.insert(
    ctx,
    result({
      tier: 'deterministic',
      attempts: [
        { tier: 'cache', ok: false, ms: 5 },
        { tier: 'deterministic', ok: true, ms: 15 },
      ],
    }),
  );

  runs.insert(
    ctx,
    result({
      tier: 'llm',
      attempts: [
        { tier: 'cache', ok: false, ms: 5 },
        { tier: 'deterministic', ok: false, ms: 8 },
        { tier: 'llm', ok: true, ms: 100 },
      ],
      llm: { calls: 1, inputTokens: 500, outputTokens: 50 },
    }),
  );

  runs.insert(ctx, result({ tier: null, attempts: [] }));

  // Both sit 3 hours back, so they fall outside a 1-hour window but inside a
  // 5-hour one: one isolates the `since` filter, the other the `origin` filter.
  runs.insert({ ...ctx, ts: NOW - 3 * HOUR }, result());
  runs.insert({ ...ctx, ts: NOW - 3 * HOUR, origin: 'https://other.test' }, result());
}

beforeEach(() => {
  open = openStore(':memory:');
  runs = new RunStore(open.db);
  taskId = new TaskStore(open.db).insert({
    key: 'example.search',
    session_id: 's1',
    mode: 'record',
    params: {},
    secret_names: [],
    status: 'running',
  }).id;
  seed();
});

test('tier distribution, success rate and escalation', () => {
  const s = stats(open.db, { since: NOW - HOUR });

  expect(s.total).toBe(5);
  expect(s.ok).toBe(4);
  expect(s.successRate).toBeCloseTo(0.8, 6);

  // All six tiers are always present, even at zero.
  expect(s.tiers.map((t) => t.tier)).toEqual(['ref', 'cache', 'deterministic', 'llm', 'vision', 'human']);
  const byTier = Object.fromEntries(s.tiers.map((t) => [t.tier, t]));
  expect(byTier.cache.count).toBe(2);
  expect(byTier.deterministic.count).toBe(1);
  expect(byTier.llm.count).toBe(1);
  expect(byTier.ref.count).toBe(0);
  // Shares are over the 4 resolved actions, not the 5 rows.
  expect(byTier.cache.pct).toBeCloseTo(0.5, 6);

  // B, C and D each needed more than one tier.
  expect(s.escalationRate).toBeCloseTo(0.6, 6);
});

test('cache hit rate and false-hit rate', () => {
  const s = stats(open.db, { since: NOW - HOUR });

  // A-D consulted the cache tier; only A was resolved by it.
  expect(s.cache.entries).toBe(4);
  expect(s.cache.hits).toBe(1);
  expect(s.cache.hitRate).toBeCloseTo(0.25, 6);

  // Cache resolved A and B; B then failed verification.
  expect(s.cache.falseHits).toBe(1);
  expect(s.cache.falseHitRate).toBeCloseTo(0.5, 6);
});

test('llm spend per action', () => {
  const s = stats(open.db, { since: NOW - HOUR });
  expect(s.llm.callsPerAction).toBeCloseTo(0.2, 6);
  expect(s.llm.inputTokensPerAction).toBeCloseTo(100, 6);
  expect(s.llm.outputTokensPerAction).toBeCloseTo(10, 6);
});

test('p50/p95 latency per tier come from attempts[].ms', () => {
  const s = stats(open.db, { since: NOW - HOUR });
  const byTier = Object.fromEntries(s.tiers.map((t) => [t.tier, t]));

  // cache ms across rows: 10, 20, 5, 5 -> [5,5,10,20]
  expect(byTier.cache.p50).toBe(5);
  expect(byTier.cache.p95).toBe(20);
  // deterministic ms: 30, 15, 8 -> [8,15,30]
  expect(byTier.deterministic.p50).toBe(15);
  expect(byTier.deterministic.p95).toBe(30);
  expect(byTier.llm.p50).toBe(100);
  // Never attempted -> 0 rather than NaN.
  expect(byTier.human.p50).toBe(0);
  expect(byTier.human.p95).toBe(0);
});

test('since, origin and taskKey each narrow the selection', () => {
  // The 1-hour window holds exactly the five crafted rows.
  expect(stats(open.db, { since: NOW - HOUR }).total).toBe(5);
  // A 5-hour window also takes in the two backdated rows.
  expect(stats(open.db, { since: NOW - 5 * HOUR }).total).toBe(7);

  expect(stats(open.db, { since: NOW - 5 * HOUR, origin: 'https://example.com' }).total).toBe(6);
  expect(stats(open.db, { since: NOW - 5 * HOUR, origin: 'https://other.test' }).total).toBe(1);

  expect(stats(open.db, { since: 0, taskKey: 'example.search' }).total).toBe(7);
  expect(stats(open.db, { since: 0, taskKey: 'nobody.home' }).total).toBe(0);
});

test('an empty selection reports zeros instead of NaN', () => {
  // Strictly after every seeded row: nothing matches.
  const s = stats(open.db, { since: NOW + HOUR });
  expect(s.total).toBe(0);
  expect(s.successRate).toBe(0);
  expect(s.cache.hitRate).toBe(0);
  expect(s.cache.falseHitRate).toBe(0);
  expect(s.llm.callsPerAction).toBe(0);
  expect(s.escalationRate).toBe(0);
  expect(s.tiers.every((t) => t.pct === 0 && t.p50 === 0 && t.p95 === 0)).toBe(true);
});

test('prune drops only rows older than the retention window', () => {
  // prune compares against the wall clock, so this case brings its own rows
  // stamped relative to now rather than reusing the fixed-date fixture.
  const fresh = openStore(':memory:');
  const store = new RunStore(fresh.db);
  const ctx = { sessionId: 's', origin: 'https://example.com' };
  store.insert({ ...ctx, ts: Date.now() - 3 * HOUR }, result());
  store.insert({ ...ctx, ts: Date.now() - 30 * 60_000 }, result());

  expect(store.prune(2 * HOUR)).toBe(1);
  expect(stats(fresh.db, { since: 0 }).total).toBe(1);
  expect(store.prune(2 * HOUR)).toBe(0);
  fresh.close();
});
