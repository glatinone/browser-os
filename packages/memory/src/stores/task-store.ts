import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../migrate.js';

export interface Task {
  id: string;
  key: string;
  session_id: string;
  mode: string;
  resolved_mode: string | null;
  params: Record<string, unknown>;
  secret_names: string[];
  status: string;
  trajectory_id: string | null;
  stats: Record<string, unknown>;
  error_code: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface TaskInput {
  id?: string;
  key: string;
  session_id: string;
  mode: string;
  resolved_mode?: string | null;
  params: Record<string, unknown>;
  secret_names: string[];
  status: string;
  trajectory_id?: string | null;
  stats?: Record<string, unknown>;
}

/** Raw `tasks` row with the JSON columns still stringified. */
interface TaskRow {
  id: string;
  key: string;
  session_id: string;
  mode: string;
  resolved_mode: string | null;
  params_json: string;
  secret_names_json: string;
  status: string;
  trajectory_id: string | null;
  stats_json: string;
  error_code: string | null;
  started_at: number;
  ended_at: number | null;
}

export class TaskStore {
  constructor(private db: SqliteDatabase) {
    this.prepare();
  }

  private stmtInsert!: ReturnType<SqliteDatabase['prepare']>;
  private stmtUpdate!: ReturnType<SqliteDatabase['prepare']>;
  private stmtGet!: ReturnType<SqliteDatabase['prepare']>;
  private stmtList!: ReturnType<SqliteDatabase['prepare']>;
  private stmtListByKey!: ReturnType<SqliteDatabase['prepare']>;

  private prepare() {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO tasks (id, key, session_id, mode, resolved_mode, params_json, secret_names_json,
         status, trajectory_id, stats_json, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtUpdate = this.db.prepare(
      `UPDATE tasks SET mode = ?, resolved_mode = ?, params_json = ?, secret_names_json = ?,
         status = ?, trajectory_id = ?, stats_json = ?, error_code = ?, ended_at = ? WHERE id = ?`,
    );
    this.stmtGet = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    this.stmtList = this.db.prepare('SELECT * FROM tasks ORDER BY started_at DESC');
    this.stmtListByKey = this.db.prepare('SELECT * FROM tasks WHERE key = ? ORDER BY started_at DESC');
  }

  insert(input: TaskInput): Task {
    const id = input.id ?? `${input.key}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    this.stmtInsert.run(
      id,
      input.key,
      input.session_id,
      input.mode,
      input.resolved_mode ?? null,
      JSON.stringify(input.params),
      JSON.stringify(input.secret_names),
      input.status,
      input.trajectory_id ?? null,
      JSON.stringify(input.stats ?? {}),
      Math.floor(Date.now() / 1000),
    );
    return this.require(id, 'insert');
  }

  update(task: Task): Task {
    this.stmtUpdate.run(
      task.mode,
      task.resolved_mode,
      JSON.stringify(task.params),
      JSON.stringify(task.secret_names),
      task.status,
      task.trajectory_id,
      JSON.stringify(task.stats),
      task.error_code,
      task.ended_at,
      task.id,
    );
    return this.require(task.id, 'update');
  }

  get(id: string): Task | undefined {
    const row = this.stmtGet.get(id) as TaskRow | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  list(opts: { key?: string; limit?: number } = {}): Task[] {
    const rows = (opts.key ? this.stmtListByKey.all(opts.key) : this.stmtList.all()) as TaskRow[];
    const limited = opts.limit ? rows.slice(0, opts.limit) : rows;
    return limited.map((row) => this.hydrate(row));
  }

  private require(id: string, op: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`INTERNAL: task row missing after ${op}`);
    return task;
  }

  private hydrate(row: TaskRow): Task {
    return {
      id: row.id,
      key: row.key,
      session_id: row.session_id,
      mode: row.mode,
      resolved_mode: row.resolved_mode,
      params: JSON.parse(row.params_json),
      secret_names: JSON.parse(row.secret_names_json),
      status: row.status,
      trajectory_id: row.trajectory_id,
      stats: JSON.parse(row.stats_json),
      error_code: row.error_code,
      started_at: row.started_at,
      ended_at: row.ended_at,
    };
  }
}
