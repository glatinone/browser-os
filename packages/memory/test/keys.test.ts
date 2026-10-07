import { expect, test } from 'vitest';
import { cacheKey, normalizeIntent, pathTemplate, siteKey, urlMatches } from '../src/keys.js';

test('pathTemplate strips query, hash and trailing slash', () => {
  expect(pathTemplate('https://example.com/search/results/people/?q=x#top')).toBe('/search/results/people');
  expect(pathTemplate('https://example.com/')).toBe('/');
});

test('pathTemplate masks volatile segments', () => {
  expect(pathTemplate('https://example.com/in/john-smith-a1b2c3/')).toBe('/in/*');
  expect(pathTemplate('https://example.com/orders/12345/invoice')).toBe('/orders/*/invoice');
  expect(pathTemplate('https://example.com/u/550e8400-e29b-41d4-a716-446655440000/profile')).toBe('/u/*/profile');
  expect(pathTemplate('https://example.com/p/deadbeef99')).toBe('/p/*');
  expect(pathTemplate('https://example.com/tag/news2026')).toBe('/tag/*');
});

test('pathTemplate masks current task param values', () => {
  expect(pathTemplate('https://example.com/profile/alice/settings', { user: 'alice' })).toBe('/profile/*/settings');
});

test('pathTemplate truncates beyond 6 segments', () => {
  expect(pathTemplate('https://example.com/a/b/c/d/e/f/g/h')).toBe('/a/b/c/d/e/f/**');
});

test('pathTemplate handles scheme-less input', () => {
  expect(pathTemplate('/orders/99/invoice?x=1')).toBe('/orders/*/invoice');
});

test('normalizeIntent lowercases, parametrizes and drops articles', () => {
  expect(normalizeIntent('Log in as Alice!', { user: 'Alice' })).toBe('log in as {user}');
  expect(normalizeIntent('The search results for the flights')).toBe('search results for flights');
  expect(normalizeIntent('Submit  the  form...')).toBe('submit form');
});

test('normalizeIntent keeps braces and underscores', () => {
  expect(normalizeIntent('set user_name to {val}')).toBe('set user_name to {val}');
});

test('cacheKey is deterministic sha256 over newline-joined parts', () => {
  const a = cacheKey({ origin: 'https://a.com', pathTemplate: '/p', actionType: 'click', intent: 'ok' });
  const b = cacheKey({ origin: 'https://a.com', pathTemplate: '/p', actionType: 'click', intent: 'ok' });
  expect(a).toBe(b);
  expect(a).toMatch(/^[a-f0-9]{64}$/);
  expect(cacheKey({ origin: 'https://a.com', pathTemplate: '/q', actionType: 'click', intent: 'ok' })).not.toBe(a);
});

test('siteKey uses the wildcard path slot', () => {
  const s = siteKey({ origin: 'https://a.com', actionType: 'click', intent: 'ok' });
  const c = cacheKey({ origin: 'https://a.com', pathTemplate: '*', actionType: 'click', intent: 'ok' });
  expect(s).toBe(c);
});

test('urlMatches exact and prefix with /**', () => {
  expect(urlMatches('/p', '/p')).toBe(true);
  expect(urlMatches('/p', '/q')).toBe(false);
  expect(urlMatches('/p/**', '/p/a/b')).toBe(true);
  expect(urlMatches('/p/**', '/p')).toBe(true);
  expect(urlMatches('/p/**', '/pq')).toBe(false);
});
