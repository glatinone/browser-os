import { beforeEach, expect, test } from 'vitest';
import { openStore, type Store } from '../src/store.js';
import { ProfileStore } from '../src/stores/profile-store.js';
import { SessionStore } from '../src/stores/session-store.js';
import { type Task, TaskStore } from '../src/stores/task-store.js';

let open: Store;
let store: TaskStore;
let sessionId: string;

beforeEach(() => {
  open = openStore(':memory:');
  const profileId = new ProfileStore(open.db).create('alice').id;
  sessionId = new SessionStore(open.db).upsert({ profile_id: profileId, ownership: 'launched' }).id;
  store = new TaskStore(open.db);
});

function input(overrides: Partial<Parameters<TaskStore['insert']>[0]> = {}) {
  return {
    key: 'login:example.com',
    session_id: sessionId,
    mode: 'auto',
    params: { username: 'alice' },
    secret_names: ['password'],
    status: 'running',
    ...overrides,
  };
}

test('insert round-trips JSON columns', () => {
  const t = store.insert(input());
  expect(t.key).toBe('login:example.com');
  expect(t.params).toEqual({ username: 'alice' });
  expect(t.secret_names).toEqual(['password']);
  expect(t.status).toBe('running');
  expect(t.ended_at).toBeNull();
  expect(store.get(t.id)).toEqual(t);
});

test('update persists new state', () => {
  const t = store.insert(input());
  const next: Task = { ...t, status: 'done', resolved_mode: 'auto', ended_at: 1_700_000_000 };
  const saved = store.update(next);
  expect(saved.status).toBe('done');
  expect(saved.resolved_mode).toBe('auto');
  expect(saved.ended_at).toBe(1_700_000_000);
});

test('list filters by key and respects limit', () => {
  store.insert(input({ key: 'a' }));
  store.insert(input({ key: 'a' }));
  store.insert(input({ key: 'b' }));
  expect(store.list({ key: 'a' })).toHaveLength(2);
  expect(store.list({ key: 'b' })).toHaveLength(1);
  expect(store.list({ limit: 2 })).toHaveLength(2);
  expect(store.list()).toHaveLength(3);
});

test('get unknown id returns undefined', () => {
  expect(store.get('nope')).toBeUndefined();
});
