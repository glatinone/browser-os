// P7-07 — TaskManager lifecycle (memory §7, protocol §4 `task.*`).
//
// Card tests: "task lifecycle" (docs/tasks/phase-07-router-and-tasks.md P7-07).
// The manager is driven through its own deps: real sqlite stores, a router
// stand-in whose canned results move the page like a real one, and a virtual
// clock so `stats.ms` is exact. Covers: `auto` resolution against the live
// trajectory, one-running-task-per-session, record persist/discard at `end`
// (S13), `task.run` end-to-end with stats folded into `Task.stats`, and the
// `task.started` / `task.completed` / `task.failed` event stream.

import { openStore, TaskStore, TrajectoryStore } from '@browser-os/memory';
import type {
  ActionResult,
  BrowserAction,
  Clock,
  ElementLocator,
  ExecutionContext,
  Trajectory,
  TrajectoryStep,
} from '@browser-os/protocol';
import { BosError, TaskSchema } from '@browser-os/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExecuteOptions } from '../src/router/types.js';
import type { RecordingScope } from '../src/tasks/task-manager.js';
import { TaskManager } from '../src/tasks/task-manager.js';

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

const CLICK: BrowserAction = { type: 'click', target: { kind: 'locator', locator: locator('Search') } };

function steps(): TrajectoryStep[] {
  return [
    {
      index: 0,
      action: { type: 'navigate', url: 'https://shop.test/buy/{{product}}' },
      intent: null,
      pre: { urlPattern: '/' },
      risk: 'low',
    },
    { index: 1, action: CLICK, intent: 'the search box', pre: { urlPattern: '/buy/**' }, risk: 'medium' },
  ];
}

function resultOf(action: BrowserAction, url: string, overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    ok: true,
    action,
    tier: 'cache',
    driver: 'cdp',
    attempts: [],
    url,
    pageChanged: false,
    ms: 10,
    llm: { calls: 1, inputTokens: 40, outputTokens: 8 },
    risk: 'low',
    ...overrides,
  };
}

/** A recording-scope spy shaped like `TrajectoryRecorder`: `finalize(true)`
 * persists to the store exactly as the real recorder does (memory §6.1). */
function fakeRecorder(persist: () => void) {
  const calls: string[] = [];
  const scope: RecordingScope = {
    start: () => void calls.push('start'),
    isRecording: () => true,
    append: () => void calls.push('append'),
    finalize: (success: boolean) => {
      if (success) {
        persist();
        calls.push('finalize:true');
        return steps();
      }
      calls.push('finalize:false');
      return null;
    },
  };
  return { scope, calls };
}

interface Harness {
  manager: TaskManager;
  tasks: TaskStore;
  trajectories: TrajectoryStore;
  events: Array<{ type: string; taskId?: string }>;
  recorderCalls: string[];
  routerCalls: Array<{ action: BrowserAction; opts: ExecuteOptions | undefined }>;
  url: (next: string) => void;
  setResults: (results: ActionResult[]) => void;
  ctx: ExecutionContext;
}

function harness(results: ActionResult[] = []): Harness {
  const open = openStore(':memory:');
  const tasks = new TaskStore(open.db);
  const trajectories = new TrajectoryStore(open.db);
  const events: Array<{ type: string; taskId?: string }> = [];
  const recorder = fakeRecorder(() => {
    // what the real recorder's finalize(true) does (memory §6.1)
    trajectories.createRecorded({
      taskKey: 'shop.search',
      origin: 'https://shop.test',
      startUrl: 'https://shop.test/',
      params: ['product'],
      secretNames: [],
      steps: steps(),
    });
  });
  let urlNow = 'https://shop.test/';
  let now = 10_000; // ms, virtual
  const routerCalls: Harness['routerCalls'] = [];
  let canned = results;
  let cursor = 0;

  const ctx = {
    sessionId: 'ses_fake',
    pageId: 'pg_fake',
    taskId: null,
    policy: {},
    params: {},
    secrets: { resolve: async (name: string) => `value-of-${name}` },
    budget: {},
    signal: new AbortController().signal,
    clock: { now: () => now } as Clock,
  } as unknown as ExecutionContext;

  const manager = new TaskManager({
    router: {
      execute: async (action, _ctx, opts) => {
        routerCalls.push({ action, opts });
        const next = canned[Math.min(cursor, canned.length - 1)] ?? canned[canned.length - 1]!;
        cursor += 1;
        // The fake router moves the page like a real one so replay
        // preconditions see each step's navigation.
        urlNow = next.url || urlNow;
        return next;
      },
    },
    tasks,
    trajectories,
    events: { emit: (e) => events.push({ type: e.type, taskId: e.taskId }) },
    clock: { now: () => now },
    secrets: { resolve: async (name: string) => `env-${name}` },
    currentUrl: () => urlNow,
    makeRecorder: () => recorder.scope,
    makeContext: () => ctx,
    sleep: async () => {
      now += 50;
    },
  });

  return {
    manager,
    tasks,
    trajectories,
    events,
    recorderCalls: recorder.calls,
    routerCalls,
    url: (next) => {
      urlNow = next;
    },
    setResults: (next) => {
      canned = next;
      cursor = 0;
    },
    ctx,
  };
}

function seed(h: Harness, overrides: Partial<Trajectory> = {}): Trajectory {
  return h.trajectories.createRecorded({
    taskKey: 'shop.search',
    origin: 'https://shop.test',
    startUrl: 'https://shop.test/',
    params: ['product'],
    secretNames: [],
    steps: steps(),
    ...overrides,
  });
}

const START = { sessionId: 'ses_fake', key: 'shop.search' };

async function expectBosError(code: string, run: () => Promise<unknown>): Promise<BosError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(BosError);
    const bos = error as BosError;
    expect(bos.code).toBe(code);
    return bos;
  }
  throw new Error(`expected a BosError ${code}, nothing was thrown`);
}

describe('TaskManager.start — auto mode resolution (memory §7)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('no live trajectory → record: row persisted, recorder scope opened, task.started emitted', async () => {
    const task = await h.manager.start(START);

    expect(task).toMatchObject({ key: 'shop.search', mode: 'auto', resolvedMode: 'record', status: 'running' });
    expect(task.id).toMatch(/^tsk_/);
    TaskSchema.parse(task); // protocol §4: `task.start` returns a valid Task
    expect(h.recorderCalls).toEqual(['start']);
    expect(h.tasks.get(task.id)).toMatchObject({ status: 'running', resolved_mode: 'record' });
    expect(h.events).toEqual([{ type: 'task.started', taskId: task.id }]);
  });

  it('a live trajectory → replay: no recorder scope is opened', async () => {
    seed(h);
    const task = await h.manager.start(START);

    expect(task).toMatchObject({ resolvedMode: 'replay', status: 'running' });
    expect(h.recorderCalls).toEqual([]);
  });

  it('a second start on a session that still runs one is INVALID_REQUEST (memory §7)', async () => {
    const first = await h.manager.start(START);
    await expectBosError('INVALID_REQUEST', () => h.manager.start({ ...START, key: 'other.task' }));
    // the refusal does not leak a live entry: the first task still owns the session
    expect(h.manager.liveForSession('ses_fake')?.taskId).toBe(first.id);
  });

  it('an explicit record over a live trajectory is allowed and REPLACES it on success (integration §10)', async () => {
    const old = seed(h);
    const task = await h.manager.start({ ...START, mode: 'record' });
    expect(task).toMatchObject({ mode: 'record', resolvedMode: 'record', status: 'running' });
    expect(h.recorderCalls).toEqual(['start']);
    const ended = await h.manager.end(task.id, true);
    // old live row → invalid (history kept); the fresh recording is the new live row
    expect(h.trajectories.getById(old.id)).toMatchObject({ status: 'invalid' });
    const live = h.trajectories.getLive('shop.search');
    expect(live).not.toBeNull();
    expect(live?.id).not.toBe(old.id);
    expect(ended.trajectoryId).toBe(live?.id);
    // a failed replacement leaves the live row alone (§10: replace happens on success)
    const keep = await h.manager.start({ ...START, mode: 'record' });
    await h.manager.end(keep.id, false);
    expect(h.trajectories.getLive('shop.search')?.id).toBe(live?.id);
  });
});

describe('TaskManager.end — persist or discard (S13)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('success persists the recording and freezes stats.ms on the virtual clock', async () => {
    const task = await h.manager.start(START);
    const ended = await h.manager.end(task.id, true);

    expect(ended).toMatchObject({ status: 'completed', endedAt: 10 }); // 10_000 ms / 1000
    TaskSchema.parse(ended);
    expect(h.recorderCalls).toEqual(['start', 'finalize:true']);
    expect(h.trajectories.getLive('shop.search')).not.toBeNull();
    expect(ended.trajectoryId).toBe(h.trajectories.getLive('shop.search')!.id);
    expect(ended.stats.ms).toBe(0); // start and end on the same virtual instant
    expect(h.events.map((e) => e.type)).toEqual(['task.started', 'task.completed']);
    expect(h.manager.liveForSession('ses_fake')).toBeNull();
  });

  it('failure discards the recording: no trajectory, error_code set, task.failed (S13)', async () => {
    const task = await h.manager.start(START);
    const ended = await h.manager.end(task.id, false);

    expect(ended.status).toBe('failed'); // error_code lives on the row, not the protocol Task
    expect(h.tasks.get(task.id)!.error_code).toBe('ACTION_FAILED');
    expect(h.recorderCalls).toEqual(['start', 'finalize:false']);
    expect(h.trajectories.getLive('shop.search')).toBeNull();
    expect(h.events.map((e) => e.type)).toEqual(['task.started', 'task.failed']);
  });

  it('ending twice is INVALID_REQUEST; the session is free after the first end', async () => {
    const task = await h.manager.start(START);
    await h.manager.end(task.id, true);
    await expectBosError('INVALID_REQUEST', () => h.manager.end(task.id, true));
    // memory §7: one running task per session — after end, a new start is accepted
    await expect(h.manager.start(START)).resolves.toMatchObject({ status: 'running' });
  });

  it('ending an unknown task is INVALID_REQUEST', async () => {
    await expectBosError('INVALID_REQUEST', () => h.manager.end('tsk_nope', true));
  });
});

describe('TaskManager.run — replay end-to-end (memory §6.2 + §7)', () => {
  let h: Harness;

  function replayResults(): ActionResult[] {
    return [
      resultOf({ type: 'navigate', url: 'https://shop.test/buy/widget' }, 'https://shop.test/buy/widget', {
        pageChanged: true,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
      }),
      resultOf(CLICK, 'https://shop.test/buy/widget', { risk: 'medium' }),
    ];
  }

  it('success: steps replay through the router, stats fold into Task.stats, counters recorded', async () => {
    h = harness(replayResults());
    const trj = seed(h);

    const task = await h.manager.run({ sessionId: 'ses_fake', key: 'shop.search', params: { product: 'widget' } });

    expect(task).toMatchObject({ resolvedMode: 'replay', status: 'completed' });
    TaskSchema.parse(task);
    // the whole trajectory ran, in order, via the router (the only executor)
    expect(h.routerCalls.map((c) => c.action.type)).toEqual(['navigate', 'click']);
    expect(h.routerCalls[1]?.opts).toEqual({ healIntent: 'the search box', recordedRisk: 'medium' });
    // usage of every step landed on the task (requirement 1: stats aggregation)
    expect(task.stats).toMatchObject({
      actions: 2,
      llmCalls: 1,
      inputTokens: 40,
      outputTokens: 8,
      cacheHits: 2,
      healedSteps: 0,
    });
    expect(task.trajectoryId).toBeNull(); // tasks.trajectory_id is stamped by a *recording* end, not a replay (memory §7)
    // no recorder on a replay task (S13 keeps the two scopes apart)
    expect(h.recorderCalls).toEqual([]);
    expect(h.trajectories.getById(trj.id)).toMatchObject({
      stats: { runs: 1, successes: 1, failures: 0, consecutiveFailures: 0 },
    });
    expect(h.events.map((e) => e.type)).toEqual(['task.started', 'task.completed']);
  });

  it('a failing step fails the task with the step code and pushes the trajectory to suspect', async () => {
    const fail = resultOf(CLICK, 'https://shop.test/buy/widget', {
      ok: false,
      tier: null,
      error: { code: 'ACTION_FAILED', message: 'element disappeared' },
    });
    h = harness([replayResults()[0]!, fail]);
    const trj = seed(h);

    const task = await h.manager.run({ sessionId: 'ses_fake', key: 'shop.search', params: { product: 'widget' } });

    expect(task.status).toBe('failed');
    expect((h.tasks.get(task.id) as { error_code: string }).error_code).toBe('TRAJECTORY_STEP_FAILED');
    expect(h.trajectories.getById(trj.id)).toMatchObject({
      status: 'suspect',
      stats: { runs: 1, failures: 1, consecutiveFailures: 1 },
    });
    expect(h.events.map((e) => e.type)).toEqual(['task.started', 'task.failed']);
  });

  it('no live trajectory → TRAJECTORY_NOT_FOUND, nothing started', async () => {
    h = harness();
    await expectBosError('TRAJECTORY_NOT_FOUND', () =>
      h.manager.run({ sessionId: 'ses_fake', key: 'shop.search', params: { product: 'widget' } }),
    );
    expect(h.events).toEqual([]);
    expect(h.routerCalls).toEqual([]);
  });

  it('a replay whose param is missing fails INVALID_REQUEST before any action (memory §6.2)', async () => {
    h = harness(replayResults());
    seed(h);

    const task = await h.manager.run({ sessionId: 'ses_fake', key: 'shop.search' }); // no params
    expect(task.status).toBe('failed');
    expect(h.routerCalls).toEqual([]); // pre-flight refusal precedes any dispatch
  });
});
