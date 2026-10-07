import { beforeEach, expect, test } from 'vitest';
import { openStore, type Store } from '../src/store.js';
import { ProfileStore } from '../src/stores/profile-store.js';
import { SessionStore } from '../src/stores/session-store.js';

let open: Store;
let profileId: string;
let store: SessionStore;

beforeEach(() => {
  open = openStore(':memory:');
  profileId = new ProfileStore(open.db).create('alice').id;
  store = new SessionStore(open.db);
});

test('upsert creates a live session and get round-trips', () => {
  const s = store.upsert({ profile_id: profileId, ownership: 'launched', browser_pid: 123, cdp_port: 9222 });
  expect(s.status).toBe('live');
  expect(s.closed_at).toBeNull();
  expect(store.get(s.id)).toEqual(s);
  expect(store.listLive()).toHaveLength(1);
});

test('re-upserting an id reactivates a closed session', () => {
  const s = store.upsert({ profile_id: profileId, ownership: 'attached' });
  store.close(s.id);
  expect(store.get(s.id)?.closed_at).not.toBeNull();
  expect(store.listLive()).toHaveLength(0);

  const again = store.upsert({ id: s.id, profile_id: profileId, ownership: 'attached' });
  expect(again.closed_at).toBeNull();
  expect(store.listLive()).toHaveLength(1);
});

test('close marks a single session', () => {
  const a = store.upsert({ profile_id: profileId, ownership: 'launched' });
  const b = store.upsert({ profile_id: profileId, ownership: 'launched' });
  store.close(a.id);
  expect(store.listLive().map((s) => s.id)).toEqual([b.id]);
  expect(store.get(a.id)?.status).toBe('closed');
});

test('markAllLiveClosed closes every open session (daemon start)', () => {
  store.upsert({ profile_id: profileId, ownership: 'launched' });
  store.upsert({ profile_id: profileId, ownership: 'launched' });
  store.markAllLiveClosed(1_700_000_000);
  expect(store.listLive()).toHaveLength(0);
  const all = store.listLive();
  expect(all).toHaveLength(0);
});

test('touch updates last_used_at', () => {
  const s = store.upsert({ profile_id: profileId, ownership: 'launched' });
  const before = s.last_used_at;
  store.touch(s.id);
  expect(store.get(s.id)?.last_used_at).toBeGreaterThanOrEqual(before);
});
