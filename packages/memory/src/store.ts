import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations, type SqliteDatabase } from './migrate.js';

export interface Store {
  db: SqliteDatabase & { pragma?: (sql: string) => unknown };
  close(): void;
}

export function openStore(path: string): Store {
  const Database = loadDatabase();
  const db = new Database(path) as SqliteDatabase & { pragma?: (sql: string) => unknown };
  db.pragma?.('foreign_keys = ON');
  db.pragma?.('busy_timeout = 2000');
  db.pragma?.('synchronous = NORMAL');
  if (path !== ':memory:') db.pragma?.('journal_mode = WAL');
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  if (!existsSync(migrationsDir)) throw new Error(`Missing migrations directory: ${migrationsDir}`);
  runMigrations(db, migrationsDir);
  return { db, close: () => (db as SqliteDatabase & { close?: () => void }).close?.() };
}

function loadDatabase(): new (path: string) => SqliteDatabase {
  try {
    return createRequire(import.meta.url)('better-sqlite3') as new (
      path: string,
    ) => SqliteDatabase;
  } catch {
    throw new Error('better-sqlite3 is required to open the memory store');
  }
}
