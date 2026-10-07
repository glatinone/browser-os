import type { ElementLocator, TrajectoryStep } from '@browser-os/protocol';
import { beforeEach, expect, test } from 'vitest';
import { openStore, type Store } from '../src/store.js';
import { TrajectoryStore } from '../src/stores/trajectory-store.js';

let open: Store;
let store: TrajectoryStore;

const KEY = 'example.search';

/** A complete ElementLocator: `TrajectorySchema` validates it end to end. */
function locator(name: string): ElementLocator {
  return {
    v: 1,
    role: 'button',
    name,
    nameIsDynamic: false,
    tag: 'button',
    attrs: {},
    context: ['Main'],
    cssPath: 'main > button:nth-of-type(1)',
    framePath: [],
    ordinal: 0,
  };
}

const OLD = locator('Search');
const NEW = locator('Go');

function steps(): TrajectoryStep[] {
  return [
    {
      index: 0,
      action: { type: 'navigate', url: 'https://example.com/{{page}}' },
      intent: null,
      pre: { urlPattern: '/' },
      risk: 'low',
    },
    {
      index: 1,
      action: { type: 'click', target: { kind: 'locator', locator: OLD } },
      intent: 'the search box',
      pre: { urlPattern: '/search' },
      risk: 'medium',
    },
  ];
}

function versions(id: string): Array<{ version: number; reason: string }> {
  return open.db
    .prepare('SELECT version, reason FROM trajectory_versions WHERE trajectory_id = ? ORDER BY version')
    .all(id) as Array<{ version: number; reason: string }>;
}

function countVersions(): number {
  return (open.db.prepare('SELECT COUNT(*) AS n FROM trajectory_versions').get() as { n: number }).n;
}

beforeEach(() => {
  open = openStore(':memory:');
  store = new TrajectoryStore(open.db);
});

test('createRecorded persists v1 active plus a recorded version row', () => {
  const t = store.createRecorded({
    taskKey: KEY,
    origin: 'https://example.com',
    startUrl: 'https://example.com/{{page}}',
    params: ['page'],
    secretNames: ['password'],
    steps: steps(),
  });
  expect(t.id.startsWith('trj_')).toBe(true);
  expect(t.version).toBe(1);
  expect(t.status).toBe('active');
  expect(t.startUrl).toBe('https://example.com/{{page}}');
  expect(t.secretNames).toEqual(['password']);
  expect(store.getLive(KEY)).toEqual(t);
  expect(store.getById(t.id)).toEqual(t);
  expect(versions(t.id)).toEqual([{ version: 1, reason: 'recorded' }]);
});

test('createRecorded rejects a key that still has a live trajectory', () => {
  const input = { taskKey: KEY, origin: 'https://example.com', params: [], secretNames: [], steps: steps() };
  store.createRecorded(input);
  expect(() => store.createRecorded(input)).toThrow('INVALID_REQUEST');
});

test('invalidate keeps history and frees the key for a new recording', () => {
  const first = store.createRecorded({
    taskKey: KEY,
    origin: 'https://example.com',
    params: [],
    secretNames: [],
    steps: steps(),
  });
  expect(store.invalidate(KEY)).toBe(1);
  expect(store.getLive(KEY)).toBeNull();
  expect(store.getById(first.id)?.status).toBe('invalid');

  const second = store.createRecorded({
    taskKey: KEY,
    origin: 'https://example.com',
    params: [],
    secretNames: [],
    steps: steps(),
  });
  expect(second.status).toBe('active');
  // The replaced row is still there for history.
  expect(store.getById(first.id)).not.toBeNull();
});

test('recordRun success bumps counters and resets the failure streak', () => {
  const t = store.createRecorded({ taskKey: KEY, origin: 'o', params: [], secretNames: [], steps: steps() });
  store.recordRun(t.id, { success: false });
  const suspect = store.recordRun(t.id, { success: false });
  expect(suspect.stats.consecutiveFailures).toBe(2);

  const ok = store.recordRun(t.id, { success: true });
  expect(ok.status).toBe('active');
  expect(ok.stats).toMatchObject({
    runs: 3,
    successes: 1,
    failures: 2,
    consecutiveFailures: 0,
  });
  expect(ok.stats.lastSuccessAt).toBeGreaterThan(0);
});

test('one consecutive failure makes it suspect, two make it invalid', () => {
  const t = store.createRecorded({ taskKey: KEY, origin: 'o', params: [], secretNames: [], steps: steps() });
  expect(store.recordRun(t.id, { success: false }).status).toBe('suspect');
  expect(store.recordRun(t.id, { success: false }).status).toBe('invalid');
  // Suspect trajectories are still replayable; invalid ones are not.
  expect(store.getLive(KEY)).toBeNull();
});

test('healing rewrites the locator, bumps the version and records history', () => {
  const t = store.createRecorded({ taskKey: KEY, origin: 'o', params: [], secretNames: [], steps: steps() });
  const healed = store.recordRun(t.id, { success: true, healed: [{ index: 1, locator: NEW }] });

  expect(healed.version).toBe(2);
  expect(healed.steps[1].action).toMatchObject({ target: { kind: 'locator', locator: NEW } });
  // Intent survives the rewrite, and the navigate step is untouched.
  expect(healed.steps[1].intent).toBe('the search box');
  expect(healed.steps[0].action).toEqual(t.steps[0].action);
  expect(versions(t.id)).toEqual([
    { version: 1, reason: 'recorded' },
    { version: 2, reason: 'healed' },
  ]);
});

test('recordRun on an unknown id is rejected', () => {
  expect(() => store.recordRun('trj_nope', { success: true })).toThrow('INVALID_REQUEST');
});

test('export/import round trip preserves steps and frees the original key', () => {
  const t = store.createRecorded({
    taskKey: KEY,
    origin: 'https://example.com',
    startUrl: 'https://example.com/search',
    params: ['page'],
    secretNames: ['password'],
    steps: steps(),
  });
  const json = store.exportJson(KEY);

  // Importing over a live key is refused...
  expect(() => store.importJson(json)).toThrow('INVALID_REQUEST');

  // ...but after a delete the payload lands as a fresh v1 active trajectory.
  expect(store.delete(KEY)).toBe(1);
  expect(store.list()).toHaveLength(0);

  const imported = store.importJson(json);
  expect(imported.id).toBe(t.id);
  expect(imported.taskKey).toBe(KEY);
  expect(imported.version).toBe(1);
  expect(imported.status).toBe('active');
  expect(imported.steps).toEqual(t.steps);
  expect(imported.params).toEqual(['page']);
  expect(versions(imported.id)).toEqual([{ version: 1, reason: 'imported' }]);
  expect(store.getLive(KEY)).toEqual(imported);
});

test('importing a malformed payload fails validation', () => {
  expect(() => store.importJson('{"id":"nope"}')).toThrow();
});

test('delete removes every row for the key including version history', () => {
  const a = store.createRecorded({ taskKey: KEY, origin: 'o', params: [], secretNames: [], steps: steps() });
  store.recordRun(a.id, { success: false });
  store.invalidate(KEY);
  store.createRecorded({ taskKey: KEY, origin: 'o', params: [], secretNames: [], steps: steps() });

  expect(store.list()).toHaveLength(2);
  expect(countVersions()).toBe(2);
  expect(store.delete(KEY)).toBe(2);
  expect(store.list()).toHaveLength(0);
  expect(countVersions()).toBe(0);
  expect(store.getLive(KEY)).toBeNull();
});

test('list filters by origin and status, and honours limit', () => {
  store.createRecorded({ taskKey: 'a.one', origin: 'https://a.test', params: [], secretNames: [], steps: steps() });
  store.createRecorded({ taskKey: 'a.two', origin: 'https://a.test', params: [], secretNames: [], steps: steps() });
  store.createRecorded({ taskKey: 'b.one', origin: 'https://b.test', params: [], secretNames: [], steps: steps() });

  expect(store.list({ origin: 'https://a.test' })).toHaveLength(2);
  expect(store.list({ status: 'active' })).toHaveLength(3);
  expect(store.list({ origin: 'https://b.test', status: 'active' })).toHaveLength(1);
  expect(store.list({ limit: 2 })).toHaveLength(2);
  expect(store.list()).toHaveLength(3);
});
