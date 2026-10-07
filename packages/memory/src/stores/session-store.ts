import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../migrate.js';

export interface Session {
  id: string;
  profile_id: string;
  status: string;
  ownership: 'launched' | 'attached';
  browser_pid: number | null;
  cdp_port: number | null;
  created_at: number;
  last_used_at: number;
  closed_at: number | null;
}

export interface SessionInput {
  id?: string;
  profile_id: string;
  ownership: Session['ownership'];
  browser_pid?: number | null;
  cdp_port?: number | null;
}

export class SessionStore {
  constructor(private db: SqliteDatabase) {
    this.prepare();
  }

  private stmtUpsert!: ReturnType<SqliteDatabase['prepare']>;
  private stmtGet!: ReturnType<SqliteDatabase['prepare']>;
  private stmtListLive!: ReturnType<SqliteDatabase['prepare']>;
  private stmtMarkAllClosed!: ReturnType<SqliteDatabase['prepare']>;
  private stmtTouch!: ReturnType<SqliteDatabase['prepare']>;
  private stmtClose!: ReturnType<SqliteDatabase['prepare']>;

  private prepare() {
    // Reopening an id reactivates the row: closed_at clears, status returns to live.
    this.stmtUpsert = this.db.prepare(
      `INSERT INTO sessions (id, profile_id, status, ownership, browser_pid, cdp_port, created_at, last_used_at, closed_at)
       VALUES (?, ?, 'live', ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET status = 'live', browser_pid = excluded.browser_pid,
         cdp_port = excluded.cdp_port, last_used_at = excluded.last_used_at, closed_at = NULL`,
    );
    this.stmtGet = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    this.stmtListLive = this.db.prepare('SELECT * FROM sessions WHERE closed_at IS NULL');
    this.stmtMarkAllClosed = this.db.prepare(
      "UPDATE sessions SET status = 'closed', closed_at = ? WHERE closed_at IS NULL",
    );
    this.stmtTouch = this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?');
    this.stmtClose = this.db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?");
  }

  upsert(input: SessionInput): Session {
    const id = input.id ?? randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.stmtUpsert.run(
      id,
      input.profile_id,
      input.ownership,
      input.browser_pid ?? null,
      input.cdp_port ?? null,
      now,
      now,
    );
    return this.stmtGet.get(id) as Session;
  }

  get(id: string): Session | undefined {
    return this.stmtGet.get(id) as Session | undefined;
  }

  listLive(): Session[] {
    return this.stmtListLive.all() as Session[];
  }

  touch(id: string): void {
    this.stmtTouch.run(Math.floor(Date.now() / 1000), id);
  }

  close(id: string): void {
    this.stmtClose.run(Math.floor(Date.now() / 1000), id);
  }

  /** Daemon start hook: every session left open is marked closed. */
  markAllLiveClosed(nowSec: number = Math.floor(Date.now() / 1000)): void {
    this.stmtMarkAllClosed.run(nowSec);
  }
}
