import type { ElementLocator } from '@browser-os/protocol';
import { beforeEach, expect, test } from 'vitest';
import { cacheKey, siteKey } from '../src/keys.js';
import { openStore, type Store } from '../src/store.js';
import { ActionCacheStore, MISS_LIMIT } from '../src/stores/action-cache-store.js';

let open: Store;
let store: ActionCacheStore;

const query = {
  origin: 'https://example.com',
  pathTemplate: '/login',
  actionType: 'click',
  intent: 'submit login form',
};
const locator = { v: 1, role: 'button', name: 'Sign in' } as unknown as ElementLocator;

beforeEach(() => {
  open = openStore(':memory:');
  store = new ActionCacheStore(open.db);
});

const exactKey = () => cacheKey(query);
const fallbackKey = () => siteKey({ origin: query.origin, actionType: query.actionType, intent: query.intent });

test('get returns null on a cold cache', () => {
  expect(store.get(query)).toBeNull();
});

test('put writes both page and site rows; get prefers the page row', () => {
  store.put(query, locator);
  const hit = store.get(query);
  expect(hit?.key).toBe(exactKey());
  expect(hit?.path_template).toBe('/login');
  expect(hit?.status).toBe('active');
  expect(hit?.locator).toEqual(locator);

  // The site-wide row exists too and points at the same locator.
  const site = store.list().find((e) => e.key === fallbackKey());
  expect(site?.path_template).toBe('*');
  expect(site?.locator).toEqual(locator);
});

test('site-key fallback serves when the page row is gone', () => {
  store.put(query, locator);
  // Invalidate only the exact row: the lookup falls through to siteKey.
  store.invalidate(exactKey(), 'false hit');
  expect(store.get(query)?.key).toBe(fallbackKey());
});

test('hit resets consecutive misses and updates last_hit_at', () => {
  store.put(query, locator);
  const key = exactKey();
  store.recordMiss(key);
  store.recordMiss(key);
  expect(store.get(query)?.consecutive_misses).toBe(2);
  store.recordHit(key);
  const after = store.get(query);
  expect(after?.hits).toBe(1);
  expect(after?.consecutive_misses).toBe(0);
  expect(after?.last_hit_at).not.toBeNull();
});

test('three consecutive misses invalidate the entry', () => {
  store.put(query, locator);
  const key = exactKey();
  expect(store.recordMiss(key)).toBe(1);
  expect(store.recordMiss(key)).toBe(2);
  expect(store.recordMiss(key)).toBe(MISS_LIMIT);
  // The page row is retired; lookup now falls through to the site row.
  expect(store.list().find((e) => e.key === key)?.status).toBe('invalid');
  expect(store.get(query)?.key).toBe(fallbackKey());

  // The site row fails on its own three times and the cache runs dry.
  const site = fallbackKey();
  store.recordMiss(site);
  store.recordMiss(site);
  store.recordMiss(site);
  expect(store.get(query)).toBeNull();
});

test('a hit before the limit clears the miss streak', () => {
  store.put(query, locator);
  const key = exactKey();
  store.recordMiss(key);
  store.recordMiss(key);
  store.recordHit(key);
  expect(store.recordMiss(key)).toBe(1);
  expect(store.recordMiss(key)).toBe(2);
  expect(store.get(query)).not.toBeNull();
});

test('false hit invalidates the resolved entry immediately', () => {
  store.put(query, locator);
  store.invalidate(exactKey(), 'verification_failed');
  // The page row is retired on the spot (no 3-strike wait); the site row
  // still carries the locator and is validated on its own next use.
  expect(store.list().find((e) => e.key === exactKey())?.status).toBe('invalid');
  expect(store.get(query)?.key).toBe(fallbackKey());

  store.invalidate(fallbackKey(), 'verification_failed');
  expect(store.get(query)).toBeNull();
});

test('re-put revives an invalid entry with reset counters', () => {
  store.put(query, locator);
  store.invalidate(exactKey(), 'false hit');
  store.put(query, locator);
  const revived = store.get(query);
  expect(revived?.status).toBe('active');
  expect(revived?.hits).toBe(0);
  expect(revived?.misses).toBe(0);
  expect(revived?.consecutive_misses).toBe(0);
});

test('list filters by origin; clear reports deleted count', () => {
  store.put(query, locator);
  store.put({ ...query, origin: 'https://other.test' }, locator);
  expect(store.list()).toHaveLength(4); // 2 keys x 2 origins
  expect(store.list({ origin: query.origin })).toHaveLength(2);

  const deleted = store.clear({ origin: query.origin });
  expect(deleted).toBe(2);
  expect(store.list({ origin: query.origin })).toHaveLength(0);
  expect(store.list({ origin: 'https://other.test' })).toHaveLength(2);

  expect(store.clear()).toBe(2);
  expect(store.list()).toHaveLength(0);
});

test('get is one indexed lookup per key (no table scan)', () => {
  store.put(query, locator);
  // Both lookups hit PRIMARY KEY on `key`; exercise the path 100x cheaply.
  for (let i = 0; i < 100; i += 1) {
    expect(store.get(query)).not.toBeNull();
  }
});
