import { randomUUID } from 'node:crypto';
import type { ElementLocator, Trajectory, TrajectoryStep } from '@browser-os/protocol';
import { TrajectorySchema } from '@browser-os/protocol';
import type { SqliteDatabase } from '../migrate.js';

/** Raw `trajectories` row with JSON columns still stringified. */
interface TrajectoryRow {
  id: string;
  task_key: string;
  origin: string;
  start_url: string;
  version: number;
  params_json: string;
  secret_names_json: string;
  steps_json: string;
  status: Trajectory['status'];
  runs: number;
  successes: number;
  failures: number;
  consecutive_failures: number;
  last_success_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateRecordedInput {
  taskKey: string;
  origin: string;
  /** URL before the first step, `{{param}}` placeholders intact. */
  startUrl?: string;
  params: string[];
  secretNames: string[];
  steps: TrajectoryStep[];
}

/** One healed step from a replay: step `index` got a new locator (memory §6.2). */
export interface HealedStep {
  index: number;
  locator: ElementLocator;
}

export interface RunOutcome {
  success: boolean;
  healed?: HealedStep[];
}

export interface TrajectoryListOptions {
  origin?: string;
  status?: Trajectory['status'];
  limit?: number;
}

/** Consecutive failures that retire a trajectory (memory §6.2). */
export const SUSPECT_AFTER = 1;
export const INVALID_AFTER = 2;

export class TrajectoryStore {
  constructor(private db: SqliteDatabase) {
    this.prepare();
  }

  private stmtByTaskKey!: ReturnType<SqliteDatabase['prepare']>;
  private stmtLiveByTaskKey!: ReturnType<SqliteDatabase['prepare']>;
  private stmtById!: ReturnType<SqliteDatabase['prepare']>;
  private stmtList!: ReturnType<SqliteDatabase['prepare']>;
  private stmtInsert!: ReturnType<SqliteDatabase['prepare']>;
  private stmtUpdate!: ReturnType<SqliteDatabase['prepare']>;
  private stmtInsertVersion!: ReturnType<SqliteDatabase['prepare']>;
  private stmtDeleteByTaskKey!: ReturnType<SqliteDatabase['prepare']>;
  private stmtDeleteVersions!: ReturnType<SqliteDatabase['prepare']>;
  private stmtInvalidate!: ReturnType<SqliteDatabase['prepare']>;

  private prepare() {
    const cols =
      'id, task_key, origin, start_url, version, params_json, secret_names_json, steps_json, status, runs, successes, failures, consecutive_failures, last_success_at, created_at, updated_at';
    this.stmtByTaskKey = this.db.prepare(
      `SELECT ${cols} FROM trajectories WHERE task_key = ?
       ORDER BY CASE status WHEN 'invalid' THEN 1 ELSE 0 END, updated_at DESC LIMIT 1`,
    );
    this.stmtLiveByTaskKey = this.db.prepare(
      `SELECT ${cols} FROM trajectories WHERE task_key = ? AND status != 'invalid'
       ORDER BY updated_at DESC LIMIT 1`,
    );
    this.stmtById = this.db.prepare(`SELECT ${cols} FROM trajectories WHERE id = ?`);
    this.stmtList = this.db.prepare(
      `SELECT ${cols} FROM trajectories
       WHERE (? IS NULL OR origin = ?) AND (? IS NULL OR status = ?)
       ORDER BY updated_at DESC`,
    );
    this.stmtInsert = this.db.prepare(
      `INSERT INTO trajectories (id, task_key, origin, start_url, version, params_json,
         secret_names_json, steps_json, status, runs, successes, failures,
         consecutive_failures, last_success_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?)`,
    );
    this.stmtUpdate = this.db.prepare(
      `UPDATE trajectories SET version = ?, steps_json = ?, status = ?, runs = ?,
         successes = ?, failures = ?, consecutive_failures = ?, last_success_at = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.stmtInsertVersion = this.db.prepare(
      `INSERT INTO trajectory_versions (trajectory_id, version, steps_json, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmtDeleteByTaskKey = this.db.prepare('DELETE FROM trajectories WHERE task_key = ?');
    this.stmtDeleteVersions = this.db.prepare('DELETE FROM trajectory_versions WHERE trajectory_id = ?');
    this.stmtInvalidate = this.db.prepare(
      "UPDATE trajectories SET status = 'invalid', updated_at = ? WHERE task_key = ? AND status != 'invalid'",
    );
  }

  /** Replay mode looks here: `active` or `suspect` (memory §6). */
  getLive(taskKey: string): Trajectory | null {
    return this.hydrate(this.stmtLiveByTaskKey.get(taskKey) as TrajectoryRow | undefined);
  }

  getById(id: string): Trajectory | null {
    return this.hydrate(this.stmtById.get(id) as TrajectoryRow | undefined);
  }

  list(opts: TrajectoryListOptions = {}): Trajectory[] {
    const rows = this.stmtList.all(
      opts.origin ?? null,
      opts.origin ?? null,
      opts.status ?? null,
      opts.status ?? null,
    ) as TrajectoryRow[];
    const all = rows.map((row) => this.hydrate(row)).filter((t): t is Trajectory => t !== null);
    return opts.limit ? all.slice(0, opts.limit) : all;
  }

  /** Drops every trajectory (live or history) for the key, versions included. */
  delete(taskKey: string): number {
    return this.transaction(() => {
      for (const id of this.allIdsFor(taskKey)) this.stmtDeleteVersions.run(id);
      const res = this.stmtDeleteByTaskKey.run(taskKey) as { changes: number };
      return res.changes ?? 0;
    });
  }

  /** Live → invalid, keeping history. TaskManager calls this before replacing (integration §10). */
  invalidate(taskKey: string): number {
    const res = this.stmtInvalidate.run(Math.floor(Date.now() / 1000), taskKey) as {
      changes: number;
    };
    return res.changes ?? 0;
  }

  /**
   * Persist a fresh recording as version 1 `active`. Existing `invalid` rows for
   * the key are kept for history; an existing *live* row is the caller's problem
   * to clear first (the partial unique index would reject it anyway).
   */
  createRecorded(input: CreateRecordedInput): Trajectory {
    if (this.getLive(input.taskKey)) {
      throw new Error(
        'INVALID_REQUEST: a live trajectory already exists for this task key; delete or invalidate it first',
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const id = `trj_${randomUUID()}`;
    return this.transaction(() => {
      this.stmtInsert.run(
        id,
        input.taskKey,
        input.origin,
        input.startUrl ?? '',
        1,
        JSON.stringify(input.params),
        JSON.stringify(input.secretNames),
        JSON.stringify(input.steps),
        'active',
        now,
        now,
      );
      this.stmtInsertVersion.run(id, 1, JSON.stringify(input.steps), 'recorded', now);
      return this.requireById(id, 'createRecorded');
    });
  }

  /**
   * Apply one replay outcome (memory §6.2) inside a single transaction:
   * success bumps counters, resets the failure streak, returns the trajectory to
   * `active` and folds healed locators into a new version; failure pushes the
   * trajectory to `suspect` after 1 and `invalid` after 2 consecutive failures.
   */
  recordRun(id: string, outcome: RunOutcome): Trajectory {
    const row = this.stmtById.get(id) as TrajectoryRow | undefined;
    if (!row) throw new Error('INVALID_REQUEST: unknown trajectory id');
    const now = Math.floor(Date.now() / 1000);

    return this.transaction(() => {
      const steps = JSON.parse(row.steps_json) as TrajectoryStep[];
      let version = row.version;
      let nextSteps = steps;
      let versionReason: string | null = null;

      let runs = row.runs;
      let successes = row.successes;
      let failures = row.failures;
      let consecutive = row.consecutive_failures;
      let lastSuccessAt = row.last_success_at;
      let status: Trajectory['status'] = row.status;

      if (outcome.success) {
        runs += 1;
        successes += 1;
        consecutive = 0;
        lastSuccessAt = now;
        status = 'active';
        const healed = outcome.healed ?? [];
        if (healed.length > 0) {
          nextSteps = applyHealed(steps, healed);
          version = row.version + 1;
          versionReason = 'healed';
        }
      } else {
        runs += 1;
        failures += 1;
        consecutive += 1;
        if (consecutive >= INVALID_AFTER) status = 'invalid';
        else if (consecutive >= SUSPECT_AFTER) status = 'suspect';
      }

      this.stmtUpdate.run(
        version,
        JSON.stringify(nextSteps),
        status,
        runs,
        successes,
        failures,
        consecutive,
        lastSuccessAt,
        now,
        id,
      );
      if (versionReason) {
        this.stmtInsertVersion.run(id, version, JSON.stringify(nextSteps), versionReason, now);
      }
      return this.requireById(id, 'recordRun');
    });
  }

  /**
   * Serialize a trajectory as JSON. Safe by construction: trajectories hold
   * secret *names* only, never values (memory §6.1).
   */
  exportJson(taskKey: string): string {
    const row =
      (this.stmtLiveByTaskKey.get(taskKey) as TrajectoryRow | undefined) ??
      (this.stmtByTaskKey.get(taskKey) as TrajectoryRow | undefined);
    if (!row) throw new Error('INVALID_REQUEST: no trajectory for this task key');
    const trajectory = this.hydrate(row);
    if (!trajectory) throw new Error('INTERNAL: trajectory row failed to hydrate');
    return JSON.stringify(trajectory);
  }

  /**
   * Import a trajectory as a fresh version 1 `active` row. The payload is
   * validated against `TrajectorySchema`; a live row for the same key must be
   * cleared first. A fresh id is issued when the exported one is taken, so
   * copying a trajectory between databases never collides.
   */
  importJson(json: string | unknown): Trajectory {
    const raw = typeof json === 'string' ? JSON.parse(json) : json;
    const parsed = TrajectorySchema.parse(raw);
    if (this.getLive(parsed.taskKey)) {
      throw new Error(
        'INVALID_REQUEST: a live trajectory already exists for this task key; delete or invalidate it first',
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const id = this.stmtById.get(parsed.id) ? `trj_${randomUUID()}` : parsed.id;
    const steps = parsed.steps as TrajectoryStep[];
    return this.transaction(() => {
      this.stmtInsert.run(
        id,
        parsed.taskKey,
        parsed.origin,
        parsed.startUrl,
        1,
        JSON.stringify(parsed.params),
        JSON.stringify(parsed.secretNames),
        JSON.stringify(steps),
        'active',
        now,
        now,
      );
      this.stmtInsertVersion.run(id, 1, JSON.stringify(steps), 'imported', now);
      return this.requireById(id, 'importJson');
    });
  }

  private allIdsFor(taskKey: string): string[] {
    const rows = this.db.prepare('SELECT id FROM trajectories WHERE task_key = ?').all(taskKey) as Array<{
      id: string;
    }>;
    return rows.map((row) => row.id);
  }

  private requireById(id: string, op: string): Trajectory {
    const trajectory = this.getById(id);
    if (!trajectory) throw new Error(`INTERNAL: trajectory row missing after ${op}`);
    return trajectory;
  }

  private hydrate(row: TrajectoryRow | undefined): Trajectory | null {
    if (!row) return null;
    return {
      id: row.id,
      taskKey: row.task_key,
      origin: row.origin,
      startUrl: row.start_url,
      version: row.version,
      params: JSON.parse(row.params_json),
      secretNames: JSON.parse(row.secret_names_json),
      steps: JSON.parse(row.steps_json),
      status: row.status,
      stats: {
        runs: row.runs,
        successes: row.successes,
        failures: row.failures,
        consecutiveFailures: row.consecutive_failures,
        lastSuccessAt: row.last_success_at,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * Rewrite the healed steps in place: the step keeps its position and intent,
 * only its locator target is replaced (memory §6.2). Steps whose action has no
 * target (`navigate`) are left alone.
 */
function applyHealed(steps: TrajectoryStep[], healed: HealedStep[]): TrajectoryStep[] {
  const next = steps.map((step) => ({ ...step }));
  for (const fix of healed) {
    const target = next.find((step) => step.index === fix.index) ?? next[fix.index];
    if (!target) continue;
    if (!('target' in target.action)) continue;
    target.action = { ...target.action, target: { kind: 'locator', locator: fix.locator } };
  }
  return next;
}
