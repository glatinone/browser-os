// P7-07 TaskManager (memory §7, protocol §4 `task.*`, ARCHITECTURE §5).
//
// The composition root's owner of every task in the process. It does NOT
// re-implement recording or replay: it owns the *lifecycle* — the `tasks`
// rows, the recorder scope opened when a recording task starts, the replayer
// driven by `task.run`, per-task stats folded into `Task.stats`, the `task.*`
// events, and the one-running-task-per-session rule (memory §7: a second
// `task.start` while a session still runs one is `INVALID_REQUEST`).
//
// The router stays the only executor. Recording happens because the manager is
// the router's `TrajectoryRecorderPort` and forwards each appended step to the
// recorder of the task named by `ctx.taskId`; replay happens because `task.run`
// hands the live trajectory to `TrajectoryReplayer`, which calls
// `router.execute` per step. S9 holds by construction: nothing here bypasses
// the router or lowers a recorded risk.

import type { TaskStore, TrajectoryStore } from '@browser-os/memory';
import {
  type ActionResult,
  BosError,
  type BrowserAction,
  type Clock,
  type EventBus,
  type ExecutionContext,
  newId,
  type SecretResolver,
  type Task,
  type TaskMode,
  type TaskStats,
} from '@browser-os/protocol';
import type { ExecuteOptions, TrajectoryRecorderPort } from '../router/types.js';
import { chain, MapSecretResolver } from '../secrets.js';
import type { TrajectoryRecorder } from './recorder.js';
import { type ReplayResult, TrajectoryReplayer } from './replayer.js';

/**
 * The per-task recording scope: `TrajectoryRecorderPort` plus the `start`
 * the concrete `TrajectoryRecorder` takes (the port the router consumes
 * deliberately hides it — only the lifecycle owner opens a scope).
 */
export type RecordingScope = TrajectoryRecorderPort & Pick<TrajectoryRecorder, 'start'>;

/** Live manager state for one running task (memory §7: at most one per session). */
interface LiveTask {
  taskId: string;
  sessionId: string;
  key: string;
  resolvedMode: 'record' | 'replay';
  recorder: RecordingScope | null;
  stats: TaskStats;
  startedAtMs: number;
}

export interface TaskManagerDeps {
  /** The router the manager forwards to; also the only executor of replayed steps. */
  router: {
    execute(action: BrowserAction, ctx: ExecutionContext, opts?: ExecuteOptions): Promise<ActionResult>;
  };
  tasks: TaskStore;
  trajectories: TrajectoryStore;
  events: Pick<EventBus, 'emit'>;
  clock: Clock;
  /** Fallback secret source (usually the `BOS_SECRET_*` environment). */
  secrets: SecretResolver;
  /** Active page URL of a session: seeds the recorder's `startUrl`. */
  currentUrl(sessionId: string): string | Promise<string>;
  /** Builds the per-task recorder (one recording scope per task, memory §6.1). */
  makeRecorder(input: { taskKey: string; params: Record<string, string>; secretNames: string[] }): RecordingScope;
  /** Builds the execution context replayed steps run under (one per `task.run`). */
  makeContext(input: {
    sessionId: string;
    taskId: string;
    params: Record<string, string>;
    secrets: SecretResolver;
  }): ExecutionContext | Promise<ExecutionContext>;
  /** Precondition poll budget forwarded to the replayer. */
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
  /** Injectable sleep so tests never wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

function emptyStats(): TaskStats {
  return {
    actions: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    visionCalls: 0,
    humanInterventions: 0,
    cacheHits: 0,
    healedSteps: 0,
    ms: 0,
  };
}

/** Fold one executed step's usage into the running task's stats. */
function foldResult(stats: TaskStats, result: ActionResult): void {
  stats.actions += 1;
  stats.llmCalls += result.llm.calls;
  stats.inputTokens += result.llm.inputTokens;
  stats.outputTokens += result.llm.outputTokens;
  if (result.tier === 'cache') stats.cacheHits += 1;
  if (result.tier === 'human') stats.humanInterventions += 1;
  stats.ms += result.ms;
}

/** Map a `tasks` row (snake_case) onto the protocol `Task` (camelCase). */
export function toProtocolTask(row: ReturnType<TaskStore['get']> & object): Task {
  return {
    id: row.id,
    key: row.key,
    sessionId: row.session_id,
    mode: row.mode as TaskMode,
    resolvedMode: row.resolved_mode as 'record' | 'replay' | null,
    params: row.params as Record<string, string>,
    secretNames: row.secret_names,
    status: row.status as Task['status'],
    trajectoryId: row.trajectory_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    stats: { ...emptyStats(), ...(row.stats as Partial<TaskStats>) },
  };
}

export class TaskManager implements TrajectoryRecorderPort {
  private readonly deps: TaskManagerDeps;
  private readonly live = new Map<string, LiveTask>();

  constructor(deps: TaskManagerDeps) {
    this.deps = deps;
  }

  /** The task a session is running, if any (memory §7: at most one). */
  liveForSession(sessionId: string): LiveTask | null {
    for (const task of this.live.values()) {
      if (task.sessionId === sessionId) return task;
    }
    return null;
  }

  /** Protocol-facing view of a live task, or null after it ended / never started. */
  get(taskId: string): Task | null {
    const row = this.deps.tasks.get(taskId);
    return row === undefined ? null : toProtocolTask(row);
  }

  /** `task.list`: newest first, optional key filter. */
  list(opts: { key?: string; limit?: number } = {}): Task[] {
    return this.deps.tasks.list(opts).map((row) => toProtocolTask(row));
  }

  /**
   * `task.start` (memory §7): resolve `auto` against the live trajectory
   * (replay if one exists, record otherwise), enforce one running task per
   * session, open the recorder scope for replay, persist the row, emit
   * `task.started`.
   */
  async start(input: {
    sessionId: string;
    key: string;
    mode?: TaskMode;
    params?: Record<string, string>;
    secretNames?: string[];
  }): Promise<Task> {
    const mode: TaskMode = input.mode ?? 'auto';
    const params = input.params ?? {};
    const secretNames = input.secretNames ?? [];

    const running = this.liveForSession(input.sessionId);
    if (running !== null) {
      throw new BosError(
        'INVALID_REQUEST',
        `session ${input.sessionId} already runs task ${running.taskId}; end it before starting another`,
        { details: { sessionId: input.sessionId, taskId: running.taskId } },
      );
    }

    const liveTrajectory = this.deps.trajectories.getLive(input.key);
    const resolvedMode: 'record' | 'replay' = mode === 'auto' ? (liveTrajectory === null ? 'record' : 'replay') : mode;

    // integration §10: an explicit `record` over a live trajectory is ALLOWED —
    // the live row is replaced when the task ends with success (end() calls
    // `invalidate(key)` before the recorder's `createRecorded`). Only replay
    // needs something to replay.
    if (resolvedMode === 'replay' && liveTrajectory === null) {
      throw new BosError('TRAJECTORY_NOT_FOUND', `no trajectory to replay for "${input.key}"`, {
        details: { taskKey: input.key },
      });
    }

    const row = this.deps.tasks.insert({
      id: newId('tsk'),
      key: input.key,
      session_id: input.sessionId,
      mode,
      resolved_mode: resolvedMode,
      params,
      secret_names: secretNames,
      status: 'running',
      stats: emptyStats() as unknown as Record<string, unknown>,
    });

    let recorder: RecordingScope | null = null;
    if (resolvedMode === 'record') {
      recorder = this.deps.makeRecorder({ taskKey: input.key, params, secretNames });
      const url = await this.deps.currentUrl(input.sessionId);
      recorder.start(url === '' ? null : url);
    }

    const nowMs = this.deps.clock.now();
    this.live.set(row.id, {
      taskId: row.id,
      sessionId: input.sessionId,
      key: input.key,
      resolvedMode,
      recorder,
      stats: emptyStats(),
      startedAtMs: nowMs,
    });

    const task = toProtocolTask(row);
    this.deps.events.emit({
      ts: nowMs,
      type: 'task.started',
      sessionId: task.sessionId,
      taskId: task.id,
      data: { task },
    });
    return task;
  }

  /**
   * `task.end` (memory §7): close the recording scope — persist on success,
   * discard on failure (S13) — freeze `stats.ms`, write the final row, emit
   * `task.completed` / `task.failed`.
   */
  async end(taskId: string, success: boolean, errorCode?: string): Promise<Task> {
    const row = this.deps.tasks.get(taskId);
    if (row === undefined) {
      throw new BosError('INVALID_REQUEST', `no such task: ${taskId}`, { details: { taskId } });
    }
    if (row.status !== 'running' && row.status !== 'waiting_for_human') {
      throw new BosError('INVALID_REQUEST', `task ${taskId} is already ${row.status}`, {
        details: { taskId, status: row.status },
      });
    }

    const live = this.live.get(taskId) ?? null;
    let trajectoryId = row.trajectory_id;
    if (live !== null && live.recorder !== null) {
      if (success) {
        // integration §10: a successful re-recording REPLACES the live row —
        // invalidate first (history rows survive), then the recorder's
        // finalize(true) writes the fresh v1 via createRecorded.
        this.deps.trajectories.invalidate(live.key);
      }
      const steps = live.recorder.finalize(success);
      if (steps !== null && steps.length > 0) {
        trajectoryId = this.deps.trajectories.getLive(live.key)?.id ?? trajectoryId;
      }
    }

    const endedAtMs = this.deps.clock.now();
    const stats: TaskStats = { ...(live?.stats ?? emptyStats()) };
    stats.ms = endedAtMs - (live?.startedAtMs ?? row.started_at * 1000);

    const updated = this.deps.tasks.update({
      ...row,
      status: success ? 'completed' : 'failed',
      trajectory_id: trajectoryId,
      stats: stats as unknown as Record<string, unknown>,
      error_code: success ? null : (errorCode ?? row.error_code ?? 'ACTION_FAILED'),
      ended_at: Math.floor(endedAtMs / 1000),
    });

    this.live.delete(taskId);
    const task = toProtocolTask(updated);
    this.deps.events.emit({
      ts: endedAtMs,
      type: success ? 'task.completed' : 'task.failed',
      sessionId: task.sessionId,
      taskId: task.id,
      data: { task },
    });
    return task;
  }

  /**
   * `task.run` (memory §7): start in replay mode, replay every step through
   * the replayer (the router stays the only executor), end the task. A missing
   * live trajectory is `TRAJECTORY_NOT_FOUND`.
   */
  async run(input: {
    sessionId: string;
    key: string;
    params?: Record<string, string>;
    secretNames?: string[];
    secretValues?: Record<string, string>;
  }): Promise<Task> {
    const trajectory = this.deps.trajectories.getLive(input.key);
    if (trajectory === null) {
      throw new BosError('TRAJECTORY_NOT_FOUND', `no live trajectory for "${input.key}"`, {
        details: { taskKey: input.key },
      });
    }

    const params = input.params ?? {};
    const secretNames = input.secretNames ?? [];
    const secrets =
      input.secretValues === undefined
        ? this.deps.secrets
        : chain(new MapSecretResolver(input.secretValues), this.deps.secrets);

    const task = await this.start({
      sessionId: input.sessionId,
      key: input.key,
      mode: 'replay',
      params,
      secretNames,
    });

    const ctx = await this.deps.makeContext({
      sessionId: input.sessionId,
      taskId: task.id,
      params,
      secrets,
    });

    const replayer = new TrajectoryReplayer({
      router: this.deps.router,
      trajectories: this.deps.trajectories,
      currentUrl: () => this.deps.currentUrl(input.sessionId),
      events: this.deps.events,
      probeTimeoutMs: this.deps.probeTimeoutMs,
      probeIntervalMs: this.deps.probeIntervalMs,
      ...(this.deps.sleep === undefined ? {} : { sleep: this.deps.sleep }),
    });

    let replay: ReplayResult;
    try {
      replay = await replayer.replay({ trajectory, params }, ctx);
    } catch (error) {
      // Cancelled / thrown: the replayer never reached its bookkeeping, so
      // the run is recorded here exactly once (memory §6.2).
      const code = error instanceof BosError ? error.code : 'INTERNAL';
      await this.end(task.id, false, code);
      this.deps.trajectories.recordRun(trajectory.id, { success: false });
      throw error;
    }

    const live = this.live.get(task.id);
    if (live !== undefined) {
      for (const result of replay.results) foldResult(live.stats, result);
      live.stats.healedSteps = replay.healed.length;
    }
    if (replay.ok) return this.end(task.id, true);

    // Failed replay: the replayer already did the §6.2 bookkeeping where it
    // applies — `failStep` called `recordRun(false)`, and pre-flight or
    // challenge-shaped failures (`recorded === false`) deliberately must NOT
    // count against the trajectory. Nothing to record here.
    return this.end(task.id, false, String(replay.error.code));
  }

  // --- TrajectoryRecorderPort: the router hands every recorded action here,
  // and the manager forwards it to the recorder of the owning task (memory §7).

  isRecording(): boolean {
    for (const task of this.live.values()) {
      if (task.recorder !== null && task.recorder.isRecording()) return true;
    }
    return false;
  }

  append(
    result: ActionResult,
    ctx: ExecutionContext,
    intent: string | null,
    risk: Parameters<TrajectoryRecorderPort['append']>[3],
  ): void {
    if (ctx.taskId === null) return;
    this.live.get(ctx.taskId)?.recorder?.append(result, ctx, intent, risk);
  }

  finalize(success: boolean): unknown[] | null {
    void success;
    return null;
  }
}
