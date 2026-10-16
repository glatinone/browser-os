// P7-07 — RuntimeApi (protocol §4, ARCHITECTURE §5 line 12).
//
// One method per protocol method, named exactly like the RPC method, with the
// param and result types *derived from* `RPC_METHODS` itself (`RpcParams<M>` /
// `RpcResult<M>`). The card's acceptance criterion — "method names and
// param/result types match RPC_METHODS" — therefore holds by construction:
// renaming or retyping a protocol method breaks this file at compile time.
//
// `system.*` and `events.subscribe` are deliberately absent: they are
// daemon-level concerns (P8 owns the socket, the process, the subscriber
// fan-out). Everything here works in-process, which is also what P7-08 and
// P10 consume.
//
// The api never bypasses the ladder: `act`/`upload` build an
// `ExecutionContext` and call `routerFor(...).execute(...)` — the router stays
// the only executor (S9). Secrets passed per call are honoured for that call
// only and never persisted.

import type { ManualLaunchDeps } from '@browser-os/browser';
import { openManual } from '@browser-os/browser';
import { stats as computeStats } from '@browser-os/memory';
import {
  BosError,
  newId,
  type ActionResult,
  type BrowserProfile,
  type HumanAnswer,
  type HumanRequest,
  type PageInfo,
  type PermissionDecisionRecord,
  type PermissionRequest,
  type RpcParams,
  type RpcResult,
  type SecretResolver,
  type Session,
  type Task,
  type Trajectory,
} from '@browser-os/protocol';
import { serializeLines } from '@browser-os/dom';
import { createExecutionContext } from './router/context.js';
import { EnvSecretResolver, chain, MapSecretResolver } from './secrets.js';
import type { Runtime } from './runtime.js';

/** Methods §4 lists but the daemon (P8) — not the runtime — must answer. */
export const DAEMON_ONLY_METHODS = ['system.hello', 'system.shutdown', 'events.subscribe'] as const;

export interface RuntimeApiOptions {
  /** Default `process.env` — the `BOS_SECRET_*` fallback for per-call secrets. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable spawn seams for `profile.openManual` (P2-02 test surface). */
  manualLaunch?: ManualLaunchDeps;
}

/** The protocol §4 surface this runtime answers, types pinned to RPC_METHODS. */
export interface RuntimeApi {
  'profile.create'(params: RpcParams<'profile.create'>): Promise<RpcResult<'profile.create'>>;
  'profile.list'(params: RpcParams<'profile.list'>): Promise<RpcResult<'profile.list'>>;
  'profile.delete'(params: RpcParams<'profile.delete'>): Promise<RpcResult<'profile.delete'>>;
  'profile.openManual'(params: RpcParams<'profile.openManual'>): Promise<RpcResult<'profile.openManual'>>;

  'session.open'(params: RpcParams<'session.open'>): Promise<RpcResult<'session.open'>>;
  'session.list'(params: RpcParams<'session.list'>): Promise<RpcResult<'session.list'>>;
  'session.get'(params: RpcParams<'session.get'>): Promise<RpcResult<'session.get'>>;
  'session.close'(params: RpcParams<'session.close'>): Promise<RpcResult<'session.close'>>;
  'session.reconnect'(params: RpcParams<'session.reconnect'>): Promise<RpcResult<'session.reconnect'>>;

  'page.list'(params: RpcParams<'page.list'>): Promise<RpcResult<'page.list'>>;
  'page.new'(params: RpcParams<'page.new'>): Promise<RpcResult<'page.new'>>;
  'page.select'(params: RpcParams<'page.select'>): Promise<RpcResult<'page.select'>>;
  'page.close'(params: RpcParams<'page.close'>): Promise<RpcResult<'page.close'>>;

  observe(params: RpcParams<'observe'>): Promise<RpcResult<'observe'>>;
  act(params: RpcParams<'act'>): Promise<RpcResult<'act'>>;
  upload(params: RpcParams<'upload'>): Promise<RpcResult<'upload'>>;

  'task.start'(params: RpcParams<'task.start'>): Promise<RpcResult<'task.start'>>;
  'task.end'(params: RpcParams<'task.end'>): Promise<RpcResult<'task.end'>>;
  'task.run'(params: RpcParams<'task.run'>): Promise<RpcResult<'task.run'>>;
  'task.get'(params: RpcParams<'task.get'>): Promise<RpcResult<'task.get'>>;
  'task.list'(params: RpcParams<'task.list'>): Promise<RpcResult<'task.list'>>;

  'trajectory.list'(params: RpcParams<'trajectory.list'>): Promise<RpcResult<'trajectory.list'>>;
  'trajectory.get'(params: RpcParams<'trajectory.get'>): Promise<RpcResult<'trajectory.get'>>;
  'trajectory.delete'(params: RpcParams<'trajectory.delete'>): Promise<RpcResult<'trajectory.delete'>>;
  'trajectory.export'(params: RpcParams<'trajectory.export'>): Promise<RpcResult<'trajectory.export'>>;
  'trajectory.import'(params: RpcParams<'trajectory.import'>): Promise<RpcResult<'trajectory.import'>>;

  'cache.list'(params: RpcParams<'cache.list'>): Promise<RpcResult<'cache.list'>>;
  'cache.clear'(params: RpcParams<'cache.clear'>): Promise<RpcResult<'cache.clear'>>;

  'human.pending'(params: RpcParams<'human.pending'>): Promise<RpcResult<'human.pending'>>;
  'human.resume'(params: RpcParams<'human.resume'>): Promise<RpcResult<'human.resume'>>;

  'permission.pending'(params: RpcParams<'permission.pending'>): Promise<RpcResult<'permission.pending'>>;
  'permission.decide'(params: RpcParams<'permission.decide'>): Promise<RpcResult<'permission.decide'>>;

  'stats.get'(params: RpcParams<'stats.get'>): Promise<RpcResult<'stats.get'>>;
}

/** Sessions carry `ses_...`; validate before touching any map so a typo is INVALID_REQUEST. */
function requireSessionId(id: string): string {
  if (!/^ses_/.test(id)) {
    throw new BosError('INVALID_REQUEST', `not a session id: ${id}`, { details: { sessionId: id } });
  }
  return id;
}

/**
 * The `createRuntime(config, options)` api: every protocol §4 method except
 * the daemon-only trio, bound to one runtime instance.
 */
export function createRuntimeApi(runtime: Runtime, options: RuntimeApiOptions = {}): RuntimeApi {
  const env = options.env ?? process.env;
  const envSecrets: SecretResolver = new EnvSecretResolver(env);

  // human/permission bridges listen once; the maps are the single source of
  // what `*.pending` reports (see the method comments below).
  const pendingHuman = new Map<string, HumanRequest>();
  const pendingPermission = new Map<string, PermissionRequest>();
  runtime.events.on('human.required', (event) => {
    const sessionId = event.sessionId;
    if (sessionId === undefined) return;
    const data = event.data as { reason: HumanRequest['reason']; message: string };
    const request: HumanRequest = {
      id: newId('req'),
      sessionId,
      taskId: event.taskId ?? null,
      reason: data.reason,
      message: data.message,
      createdAt: event.ts,
    };
    pendingHuman.set(request.id, request);
  });
  runtime.events.on('human.resolved', (event) => {
    for (const [id, request] of pendingHuman) {
      if (request.sessionId === event.sessionId) pendingHuman.delete(id);
    }
  });
  runtime.events.on('permission.requested', (event) => {
    const request = (event.data as { request: PermissionRequest }).request;
    pendingPermission.set(request.id, request);
  });
  runtime.events.on('permission.decided', (event) => {
    const record = (event.data as { record: PermissionDecisionRecord }).record;
    pendingPermission.delete(record.requestId);
  });

  /** Refuse store-backed calls when the runtime runs with `persist: false`. */
  function needStore<T>(value: T | null, what: string): T {
    if (value === null) {
      throw new BosError('INTERNAL', `this runtime has no store (persist: false); ${what} is unavailable`, {});
    }
    return value;
  }

  function liveSession(id: string): Session {
    const session = runtime.sessions.get(requireSessionId(id));
    if (session === null) {
      throw new BosError('SESSION_NOT_FOUND', `no session ${id}`, { details: { sessionId: id } });
    }
    return session;
  }

  function liveProfile(name: string): BrowserProfile {
    const store = needStore(runtime.profiles, 'profiles');
    const row = store.getByName(name);
    if (row === undefined) {
      throw new BosError('PROFILE_NOT_FOUND', `no profile named ${name}`, { details: { name } });
    }
    return {
      id: row.id,
      name: row.name,
      channel: row.channel,
      userDataDir: row.user_data_dir,
      headless: row.headless === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }

  /** `act`/`upload`: the caller's context, or the running task's (memory §7). */
  function buildContext(params: { sessionId: string; pageId?: string; taskId?: string; secretValues?: Record<string, string> }) {
    const session = liveSession(params.sessionId);
    const pageId = params.pageId ?? session.activePageId;
    if (pageId === null || pageId === undefined) {
      throw new BosError('PAGE_NOT_FOUND', `session ${session.id} has no active page`, { details: { sessionId: session.id } });
    }
    let taskParams: Record<string, string> = {};
    let secrets: SecretResolver = envSecrets;
    if (params.taskId !== undefined) {
      const task: Task | null = runtime.tasks.get(params.taskId);
      if (task === null || (task.status !== 'running' && task.status !== 'waiting_for_human')) {
        throw new BosError('INVALID_REQUEST', `task ${params.taskId} is not running`, {
          details: { taskId: params.taskId, status: task?.status ?? null },
        });
      }
      taskParams = task.params;
    }
    if (params.secretValues !== undefined) {
      secrets = chain(new MapSecretResolver(params.secretValues), envSecrets);
    }
    return {
      session,
      pageId,
      ctx: createExecutionContext({
        sessionId: session.id,
        pageId,
        taskId: params.taskId ?? null,
        policy: runtime.config.policy,
        params: taskParams,
        secrets,
        clock: runtime.clock,
        signal: new AbortController().signal,
      }),
    };
  }

  async function executeAction(
    params: { sessionId: string; pageId?: string; taskId?: string; secretValues?: Record<string, string> },
    action: Parameters<ReturnType<Runtime['routerFor']>['execute']>[0],
  ): Promise<ActionResult> {
    const built = buildContext(params);
    return runtime.routerFor(built.session.id, built.pageId).execute(action, built.ctx);
  }

  const api: RuntimeApi = {
    async 'profile.create'(params) {
      return runtime.createProfile(params.name, params.channel);
    },

    async 'profile.list'() {
      const store = needStore(runtime.profiles, 'profile.list');
      return store.list().map((row) => ({
        id: row.id,
        name: row.name,
        channel: row.channel,
        userDataDir: row.user_data_dir,
        headless: row.headless === 1,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      }));
    },

    async 'profile.delete'(params) {
      const store = needStore(runtime.profiles, 'profile.delete');
      const profile = liveProfile(params.name);
      // §4: refuse while a session on that profile is live.
      for (const session of runtime.sessions.list()) {
        if (session.profileId === profile.id && session.status !== 'closed') {
          throw new BosError('INVALID_REQUEST', `profile ${params.name} is in use by session ${session.id}`, {
            details: { name: params.name, sessionId: session.id },
          });
        }
      }
      store.delete(profile.id);
      return { ok: true };
    },

    async 'profile.openManual'(params) {
      const profile = liveProfile(params.name);
      const pid = options.manualLaunch === undefined
        ?await openManual(profile)
        :await openManual(profile, options.manualLaunch);
      if (pid === null || pid <= 0) {
        throw new BosError('INTERNAL', 'the manual browser did not report a pid', { details: { name: params.name } });
      }
      return { pid };
    },

    async 'session.open'(params) {
      return runtime.sessions.open({
        profileName: params.profile,
        ...(params.provider === undefined ? {} : { provider: params.provider }),
        ...(params.headless === undefined ? {} : { headless: params.headless }),
        ...(params.cdpEndpoint === undefined ? {} : { cdpEndpoint: params.cdpEndpoint }),
      });
    },

    async 'session.list'(params) {
      const all = runtime.sessions.list();
      return params.sessionId === undefined ? all : all.filter((s) => s.id === params.sessionId);
    },

    async 'session.get'(params) {
      return liveSession(params.sessionId);
    },

    async 'session.close'(params) {
      await runtime.sessions.close(requireSessionId(params.sessionId));
      return { ok: true };
    },

    async 'session.reconnect'(params) {
      return runtime.sessions.reconnect(requireSessionId(params.sessionId));
    },
    async 'page.list'(params) {
      liveSession(params.sessionId);
      return runtime.sessions.pages(requireSessionId(params.sessionId));
    },

    async 'page.new'(params) {
      liveSession(params.sessionId);
      return runtime.sessions.newPage(params.sessionId, params.url);
    },

    async 'page.select'(params) {
      liveSession(params.sessionId);
      await runtime.sessions.selectPage(params.sessionId, params.pageId);
      return { ok: true };
    },

    async 'page.close'(params) {
      liveSession(params.sessionId);
      await runtime.sessions.closePage(params.sessionId, params.pageId);
      return { ok: true };
    },

    async observe(params) {
      liveSession(params.sessionId);
      const pageId = params.pageId ?? liveSession(params.sessionId).activePageId;
      if (pageId === null || pageId === undefined) {
        throw new BosError('PAGE_NOT_FOUND', `session ${params.sessionId} has no active page`, {
          details: { sessionId: params.sessionId },
        });
      }
      const { observation } = await runtime.observer.capture(params.sessionId, pageId, {
        includeText: params.includeText,
      });
      if (params.format === 'lines') {
        return { observationId: observation.id, lines: serializeLines(observation, { viewportOnly: params.viewportOnly }) };
      }
      return observation;
    },

    async act(params) {
      return executeAction(params, params.action);
    },

    async upload(params) {
      return executeAction(params, { type: 'upload', target: params.target, paths: params.paths });
    },

    async 'task.start'(params) {
      liveSession(params.sessionId);
      return runtime.tasks.start(params);
    },

    async 'task.end'(params) {
      return runtime.tasks.end(params.taskId, params.success);
    },

    async 'task.run'(params) {
      liveSession(params.sessionId);
      return runtime.tasks.run(params);
    },

    async 'task.get'(params) {
      const task = runtime.tasks.get(params.taskId);
      if (task === null) {
        throw new BosError('INVALID_REQUEST', `no such task: ${params.taskId}`, { details: { taskId: params.taskId } });
      }
      return task;
    },

    async 'task.list'(params) {
      return runtime.tasks.list(params);
    },

    async 'trajectory.list'(params) {
      const store = needStore(runtime.trajectories, 'trajectory.list');
      const all = store.list();
      return params.taskKey === undefined ? all : all.filter((t) => t.taskKey === params.taskKey);
    },

    async 'trajectory.get'(params) {
      const store = needStore(runtime.trajectories, 'trajectory.get');
      const found = store.getLive(params.key);
      if (found === null) {
        throw new BosError('TRAJECTORY_NOT_FOUND', `no live trajectory for "${params.key}"`, {
          details: { key: params.key },
        });
      }
      return found;
    },

    async 'trajectory.delete'(params) {
      const store = needStore(runtime.trajectories, 'trajectory.delete');
      store.delete(params.key);
      return { ok: true };
    },

    async 'trajectory.export'(params) {
      const store = needStore(runtime.trajectories, 'trajectory.export');
      try {
        return { key: params.key, json: store.exportJson(params.key) };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('INVALID_REQUEST')) {
          throw new BosError('TRAJECTORY_NOT_FOUND', error.message, { details: { key: params.key } });
        }
        throw error;
      }
    },

    async 'trajectory.import'(params) {
      const store = needStore(runtime.trajectories, 'trajectory.import');
      try {
        return store.importJson(params.json);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('INVALID_REQUEST')) {
          throw new BosError('INVALID_REQUEST', error.message, {});
        }
        throw error;
      }
    },

    async 'cache.list'(params) {
      const store = needStore(runtime.actionCache, 'cache.list');
      return store.list(params).map((row) => ({
        key: row.key,
        origin: row.origin,
        pathTemplate: row.path_template,
        actionType: row.action_type as RpcResult<'cache.list'>[number]['actionType'],
        intent: row.intent,
        locator: row.locator,
        hits: row.hits,
        misses: row.misses,
        consecutiveMisses: row.consecutive_misses,
        status: row.status,
        createdAt: row.created_at,
        lastHitAt: row.last_hit_at,
      }));
    },

    async 'cache.clear'(params) {
      const store = needStore(runtime.actionCache, 'cache.clear');
      return { deleted: store.clear(params) };
    },
    // --- human / permission bridges (§4). The runtime's gates are the
    // phase-9 stubs, so nothing raises these today; the api listens on the
    // event bus so that when the real gates arrive the methods keep working
    // without any change here. Pending state lives in memory only.
    async 'human.pending'(params) {
      return params.sessionId === undefined
        ? [...pendingHuman.values()]
        : [...pendingHuman.values()].filter((r) => r.sessionId === params.sessionId);
    },

    async 'human.resume'(params) {
      const answer: HumanAnswer = params.answer;
      let resolved = 0;
      for (const [id, request] of pendingHuman) {
        if (request.sessionId !== params.sessionId) continue;
        pendingHuman.delete(id);
        resolved += 1;
        runtime.events.emit({
          ts: runtime.clock.now(),
          type: 'human.resolved',
          sessionId: params.sessionId,
          data: { outcome: answer.choice === 'abort' ? 'aborted' : 'resumed' },
        });
      }
      if (resolved === 0) {
        throw new BosError('INVALID_REQUEST', `session ${params.sessionId} has no pending human request`, {
          details: { sessionId: params.sessionId },
        });
      }
      return { ok: true };
    },

    async 'permission.pending'(params) {
      return params.sessionId === undefined
        ? [...pendingPermission.values()]
        : [...pendingPermission.values()].filter((r) => r.sessionId === params.sessionId);
    },

    async 'permission.decide'(params) {
      const request = pendingPermission.get(params.requestId);
      if (request === undefined) {
        throw new BosError('INVALID_REQUEST', `no pending permission request ${params.requestId}`, {
          details: { requestId: params.requestId },
        });
      }
      pendingPermission.delete(params.requestId);
      const record: PermissionDecisionRecord = {
        requestId: request.id,
        decision: params.decision,
        decidedBy: 'human',
        decidedAt: runtime.clock.now(),
      };
      runtime.events.emit({
        ts: record.decidedAt,
        type: 'permission.decided',
        sessionId: request.sessionId,
        data: { record },
      });
      return record;
    },

    async 'stats.get'(params) {
      const db = needStore(runtime.statsDb, 'stats.get');
      const since = params.since ?? 0;
      const measured = computeStats(db, {
        since,
        ...(params.origin === undefined ? {} : { origin: params.origin }),
        ...(params.taskKey === undefined ? {} : { taskKey: params.taskKey }),
      });
      const tierDistribution: Record<string, number> = {};
      const latencyByTier: Record<string, { p50: number; p95: number }> = {};
      for (const tier of measured.tiers) {
        tierDistribution[tier.tier] = tier.count;
        latencyByTier[tier.tier] = { p50: tier.p50, p95: tier.p95 };
      }
      const cacheConsulted = measured.cache.entries > 0;
      return {
        since: params.since ?? null,
        actions: measured.total,
        tierDistribution,
        cacheHitRate: cacheConsulted ? measured.cache.hitRate : null,
        cacheFalseHitRate: cacheConsulted ? measured.cache.falseHitRate : null,
        deterministicPrecision: null, // needs labelled outcomes (P10); §4 allows null
        llmCallsPerAction: measured.llm.callsPerAction,
        tokensPerAction: {
          input: measured.llm.inputTokensPerAction,
          output: measured.llm.outputTokensPerAction,
        },
        latencyByTier,
        escalationRate: measured.total > 0 ? measured.escalationRate : null,
      };
    },
  };
  return api;
}
