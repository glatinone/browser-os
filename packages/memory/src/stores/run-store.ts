import type { ActionResult } from '@browser-os/protocol';
import type { SqliteDatabase } from '../migrate.js';

export interface RunContext {
  sessionId: string;
  taskId?: string | null;
  origin: string;
  /** epoch **milliseconds**; stored as seconds, defaults to now. */
  ts?: number;
}

/**
 * One `action_runs` row per executed action (memory §3, action-router §8).
 * The per-tier breakdown rides along as `attempts_json`, which is what
 * `stats()` reads back for latency percentiles.
 */
export class RunStore {
  constructor(private db: SqliteDatabase) {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO action_runs (ts, session_id, task_id, origin, action_type, tier, driver,
         ok, error_code, ms, llm_calls, input_tokens, output_tokens, attempts_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtPrune = this.db.prepare('DELETE FROM action_runs WHERE ts < ?');
  }

  private stmtInsert: ReturnType<SqliteDatabase['prepare']>;
  private stmtPrune: ReturnType<SqliteDatabase['prepare']>;

  insert(ctx: RunContext, result: ActionResult): number {
    const ts = Math.floor((ctx.ts ?? Date.now()) / 1000);
    const res = this.stmtInsert.run(
      ts,
      ctx.sessionId,
      ctx.taskId ?? null,
      ctx.origin,
      result.action.type,
      result.tier,
      result.driver,
      result.ok ? 1 : 0,
      result.error?.code ?? null,
      result.ms,
      result.llm.calls,
      result.llm.inputTokens,
      result.llm.outputTokens,
      JSON.stringify(result.attempts),
    ) as { lastInsertRowid: number | bigint };
    return Number(res.lastInsertRowid);
  }

  /** Daemon-start retention: drop rows older than `olderThanMs`. Returns deletions. */
  prune(olderThanMs: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - Math.floor(olderThanMs / 1000);
    const res = this.stmtPrune.run(cutoff) as { changes: number };
    return res.changes ?? 0;
  }
}
