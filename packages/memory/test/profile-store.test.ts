import { beforeEach, expect, test } from 'vitest';
import { openStore } from '../src/store.js';
import { ProfileStore } from '../src/stores/profile-store.js';

let store: ProfileStore;

beforeEach(() => {
  const db = openStore(':memory:');
  store = new ProfileStore(db.db);
});

test('create and get profile', () => {
  const p = store.create('alice');
  expect(p.id).toBeTypeOf('string');
  expect(p.name).toBe('alice');
  expect(p.channel).toBe('chrome');
  const got = store.getByName('alice');
  expect(got).toEqual(p);
  expect(store.getById(p.id)).toEqual(p);
});

test('duplicate name throws INVALID_REQUEST', () => {
  store.create('bob');
  expect(() => store.create('bob')).toThrow('INVALID_REQUEST');
});

test('list profiles', () => {
  store.create('a');
  store.create('b');
  const list = store.list();
  expect(list.length).toBe(2);
});

test('delete profile', () => {
  const p = store.create('del');
  store.delete(p.id);
  expect(store.getById(p.id)).toBeUndefined();
});

test('touch updates last_used_at', () => {
  const p = store.create('touch');
  const before = p.last_used_at;
  store.touch(p.id);
  const after = store.getById(p.id)?.last_used_at ?? 0;
  expect(after).toBeGreaterThanOrEqual(before ?? 0);
});

test('channel option is stored', () => {
  const p = store.create('edge', { channel: 'msedge', user_data_dir: 'C:/profiles/edge' });
  expect(p.channel).toBe('msedge');
  expect(p.user_data_dir).toBe('C:/profiles/edge');
  expect(p.headless).toBe(0);
});
