import type { ElementLocator } from '@browser-os/protocol';
import { cacheKey, siteKey } from '../keys.js';
import type { SqliteDatabase } from '../migrate.js';

/** Raw `action_cache` row exactly as SQLite returns it. */
interface ActionCacheRow {
  key: string;
  origin: string;
  path_template: string;
  action_type: string;
  intent: string;
  locator_json: string;
  hits: number;
  misses: number;
  consecutive_misses: number;
  status: 'active' | 'invalid';
  created_at: number;
  updated_at: number;
  last_hit_at: number | null;
}

export interface ActionCacheEntry {
  key: string;
  origin: string;
  path_template: string;
  action_type: string;
  intent: string;
  locator: ElementLocator;
  hits: number;
  misses: number;
  consecutive_misses: number;
  status: 'active' | 'invalid';
  created_at: number;
  updated_at: number;
  last_hit_at: number | null;
}

export interface ActionCacheQuery {
  origin: string;
  pathTemplate: string;
  actionType: string;
  intent: string;
}

/** consecutive misses that retire an entry (memory §5). */
export const MISS_LIMIT = 3;

export class ActionCacheStore {
  constructor(private db: SqliteDatabase) {
    this.prepare();
  }

  private stmtByPk!: ReturnType<SqliteDatabase['prepare']>;
  private stmtBySite!: ReturnType<SqliteDatabase['prepare']>;
  private stmtPut!: ReturnType<SqliteDatabase['prepare']>;
  private stmtHit!: ReturnType<SqliteDatabase['prepare']>;
  private stmtMiss!: ReturnType<SqliteDatabase['prepare']>;
  private stmtInvalidate!: ReturnType<SqliteDatabase['prepare']>;
  private stmtList!: ReturnType<SqliteDatabase['prepare']>;
  private stmtListByOrigin!: ReturnType<SqliteDatabase['prepare']>;
  private stmtClear!: ReturnType<SqliteDatabase['prepare']>;
  private stmtClearByOrigin!: ReturnType<SqliteDatabase['prepare']>;

  private prepare() {
    const cols =
      'key, origin, path_template, action_type, intent, locator_json, hits, misses, consecutive_misses, status, created_at, updated_at, last_hit_at';
    this.stmtByPk = this.db.prepare(`SELECT ${cols} FROM action_cache WHERE key = ?`);
    this.stmtBySite = this.db.prepare(`SELECT ${cols} FROM action_cache WHERE key = ?`);
    this.stmtPut = this.db.prepare(
      `INSERT INTO action_cache (key, origin, path_template, action_type, intent, locator_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(key) DO UPDATE SET locator_json = excluded.locator_json, status = 'active',
         hits = 0, misses = 0, consecutive_misses = 0, updated_at = excluded.updated_at, last_hit_at = NULL`,
    );
    this.stmtHit = this.db.prepare(
      `UPDATE action_cache SET hits = hits + 1, consecutive_misses = 0, last_hit_at = ?, updated_at = ?
       WHERE key = ? AND status = 'active'`,
    );
    this.stmtMiss = this.db.prepare(
      `UPDATE action_cache SET misses = misses + 1, consecutive_misses = consecutive_misses + 1, updated_at = ?
       WHERE key = ? AND status = 'active'`,
    );
    this.stmtInvalidate = this.db.prepare("UPDATE action_cache SET status = 'invalid', updated_at = ? WHERE key = ?");
    this.stmtList = this.db.prepare(`SELECT ${cols} FROM action_cache ORDER BY updated_at DESC`);
    this.stmtListByOrigin = this.db.prepare(
      `SELECT ${cols} FROM action_cache WHERE origin = ? ORDER BY updated_at DESC`,
    );
    this.stmtClear = this.db.prepare('DELETE FROM action_cache');
    this.stmtClearByOrigin = this.db.prepare('DELETE FROM action_cache WHERE origin = ?');
  }

  /**
   * Lookup: cacheKey first, then the site-wide fallback. Invalid rows are
   * skipped, so both attempts return null rather than a stale locator.
   */
  get(query: ActionCacheQuery): ActionCacheEntry | null {
    const pk = this.deriveKeys(query);
    const exact = this.hydrate(this.stmtByPk.get(pk.cache) as ActionCacheRow | undefined);
    if (exact && exact.status === 'active') return exact;
    const site = this.hydrate(this.stmtBySite.get(pk.site) as ActionCacheRow | undefined);
    if (site && site.status === 'active') return site;
    return null;
  }

  /**
   * Write both the page-level and site-level rows with the same locator.
   * Counters reset because this follows a successful non-cache resolution.
   */
  put(query: ActionCacheQuery, locator: ElementLocator): void {
    const { cache, site } = this.deriveKeys(query);
    const now = Math.floor(Date.now() / 1000);
    const rows: Array<[string, string]> = [
      [cache, query.pathTemplate],
      [site, '*'],
    ];
    for (const [key, path] of rows) {
      this.stmtPut.run(key, query.origin, path, query.actionType, query.intent, JSON.stringify(locator), now, now);
    }
  }

  /** Cache tier resolved and the action verified. */
  recordHit(key: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.stmtHit.run(now, now, key);
  }

  /**
   * Cache tier could not resolve. Returns the new consecutive miss count so
   * the caller can see when the entry crosses MISS_LIMIT; the invalidation
   * itself is applied here to keep the transition in one place.
   */
  recordMiss(key: string): number {
    const now = Math.floor(Date.now() / 1000);
    this.stmtMiss.run(now, key);
    const row = this.hydrate(this.stmtByPk.get(key) as ActionCacheRow | undefined);
    const consecutive = row?.consecutive_misses ?? 0;
    if (consecutive >= MISS_LIMIT) this.invalidate(key, 'consecutive_misses');
    return consecutive;
  }

  /** False hit or human correction: retire the entry immediately. */
  invalidate(key: string, _reason: string): void {
    this.stmtInvalidate.run(Math.floor(Date.now() / 1000), key);
  }

  list(opts: { origin?: string } = {}): ActionCacheEntry[] {
    const rows = (opts.origin ? this.stmtListByOrigin.all(opts.origin) : this.stmtList.all()) as ActionCacheRow[];
    const entries: ActionCacheEntry[] = [];
    for (const row of rows) {
      const entry = this.hydrate(row);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** `bos cache clear [--origin]` — returns the number of rows removed. */
  clear(opts: { origin?: string } = {}): number {
    const result = (opts.origin ? this.stmtClearByOrigin.run(opts.origin) : this.stmtClear.run()) as {
      changes: number;
    };
    return result.changes ?? 0;
  }

  private deriveKeys(query: ActionCacheQuery): { cache: string; site: string } {
    return {
      cache: cacheKey({
        origin: query.origin,
        pathTemplate: query.pathTemplate,
        actionType: query.actionType,
        intent: query.intent,
      }),
      site: siteKey({ origin: query.origin, actionType: query.actionType, intent: query.intent }),
    };
  }

  private hydrate(row: ActionCacheRow | undefined): ActionCacheEntry | null {
    if (!row) return null;
    return { ...row, locator: JSON.parse(row.locator_json) as ElementLocator };
  }
}
