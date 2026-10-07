import type { RiskLevel } from '@browser-os/protocol';
import { MASKED_VALUE } from '@browser-os/protocol';
import type { SqliteDatabase } from '../migrate.js';

export interface AuditEntry {
  kind: string;
  sessionId?: string | null;
  taskId?: string | null;
  origin?: string | null;
  risk?: RiskLevel | null;
  /**
   * Already masked by the caller (memory §3). This store only *verifies* that:
   * a key named `value`/`secret` holding an unmasked string throws INTERNAL.
   */
  summary: Record<string, unknown>;
}

/** Summary keys that must never carry a raw string. */
const FORBIDDEN_KEYS = new Set(['value', 'secret', 'secrets']);

/**
 * Walks the summary and throws if any `value`/`secret` key holds a string that
 * is not the mask. Numbers, booleans, null and references are fine: only
 * strings can leak a secret.
 */
function assertMasked(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      assertMasked(item, `${path}[${i}]`);
    });
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, child] of Object.entries(node)) {
    const at = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      if (typeof child === 'string' && child !== '' && child !== MASKED_VALUE) {
        throw new Error(`INTERNAL: unmasked string under "${at}" in audit summary`);
      }
    }
    assertMasked(child, at);
  }
}

/**
 * `audit_log` rows (memory §3). `summary_json` is stored verbatim once the
 * defensive check passes, so the store never rewrites what the caller wrote.
 */
export class AuditStore {
  constructor(private db: SqliteDatabase) {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO audit_log (ts, kind, session_id, task_id, origin, risk, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtPrune = this.db.prepare('DELETE FROM audit_log WHERE ts < ?');
  }

  private stmtInsert: ReturnType<SqliteDatabase['prepare']>;
  private stmtPrune: ReturnType<SqliteDatabase['prepare']>;

  insert(entry: AuditEntry, ts: number = Date.now()): number {
    assertMasked(entry.summary, '');
    const res = this.stmtInsert.run(
      Math.floor(ts / 1000),
      entry.kind,
      entry.sessionId ?? null,
      entry.taskId ?? null,
      entry.origin ?? null,
      entry.risk ?? null,
      JSON.stringify(entry.summary),
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
