import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown;
  };
}

export function runMigrations(db: SqliteDatabase, migrationsDir: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  const applied = new Set(rows.map((row) => row.version));
  const files = readdirSync(migrationsDir)
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort((a, b) => Number(a.split('_', 1)[0]) - Number(b.split('_', 1)[0]));
  for (const file of files) {
    const version = Number(file.split('_', 1)[0]);
    if (applied.has(version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
