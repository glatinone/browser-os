import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/store.js';

const stores: Array<{ close(): void }> = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** Shipped migration files, so the assertion tracks the package rather than a number. */
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const shipped = readdirSync(migrationsDir).filter((file) => /^\d+_.*\.sql$/.test(file)).length;

describe('memory store', () => {
  it('opens, applies every shipped migration, and is idempotent', () => {
    expect(shipped).toBeGreaterThan(0);
    const store = openStore(':memory:');
    stores.push(store);
    const tables = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'schema_migrations',
        'profiles',
        'sessions',
        'action_cache',
        'trajectories',
        'tasks',
        'action_runs',
        'audit_log',
      ]),
    );
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: shipped,
    });
  });

  it('uses WAL for file-backed stores', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bos-memory-')), 'memory.db');
    const store = openStore(path);
    stores.push(store);
    expect(store.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    store.close();
    const reopened = openStore(path);
    stores.push(reopened);
    // Reopening must not re-run anything.
    expect(reopened.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: shipped,
    });
  });
});
