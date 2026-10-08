import type { ElementLocator } from '@browser-os/protocol';

interface CacheEntry {
  locator: ElementLocator;
  status: 'active' | 'invalid';
  misses: number;
  createdAt: number;
  lastHit: number;
}

const CACHE_MAX_CONSECUTIVE_MISSES = 3;

const cacheMap = new Map<string, CacheEntry>();

export const cache = {
  async get(key: string): Promise<{ locator: any; status: 'active' | 'invalid' } | null> {
    const entry = cache.get(key);
    if (!entry || entry.status === 'invalid') return null;
    return { locator: entry.locator, status: entry.status };
  },

  async put(key: string, locator: any): Promise<void> {
    cache.set(key, {
      locator,
      status: 'active',
      misses: 0,
      createdAt: Date.now(),
      lastHit: Date.now(),
    });
  },

  async recordHit(key: string): Promise<void> {
    const entry = cache.get(key);
    if (entry) {
      entry.misses = 0;
      entry.lastHit = Date.now();
    }
  },

  async recordMiss(key: string): Promise<void> {
    const entry = cache.get(key);
    if (entry) {
      entry.misses++;
      if (entry.misses >= 3) {
        entry.status = 'invalid';
      }
    }
  },
};

export function cacheKey(origin: string, pathTemplate: string, actionType: string, intent: string): string {
  const normalized = intent.toLowerCase().trim().replace(/\s+/g, ' ');
  return `intent:${origin}:${pathTemplate}:${actionType}:${intent.toLowerCase().trim().replace(/\s+/g, ' ')}`;
}

function pathTemplate(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/[^/]+/g, (m) => m.match(/\d+/) ? '/:id' : m);
  } catch {
    return '/';
  }
}

function normalizeIntent(intent: string): string {
  return intent.toLowerCase().trim().replace(/\s+/g, ' ');
}