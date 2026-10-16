// P7-07 — `createRuntime()` (ARCHITECTURE §5, integration §5).
//
// The single composition root: everything the daemon (P8) and the in-process
// consumers (P7-08 vertical slice, P10 benchmarks, P12 acceptance) use starts
// here. Wiring follows ARCHITECTURE §5 exactly — store → events → models →
// providers → sessions → observer → security → router → tasks → api — and
// every collaborator can be replaced through `options`, because the tests and
// benchmarks run against fakes while the daemon runs against the real thing.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CdpEndpointProvider,
  ensureProfileDir,
  IsolatedWorlds,
  LaunchProvider,
  type BrowserProvider,
  type PageDriver,
} from '@browser-os/browser';
import { ModelRegistry } from '@browser-os/ai';
import { PROBE_HELPER_SOURCE } from '@browser-os/dom';
import {
  BosError,
  EventBus,
  newId,
  resolveBosHome,
  systemClock,
  type BrowserProfile,
  type BosPlatform,
  type CdpTransport,
  type Clock,
  type Config,
  type ExecutionContext,
  type HelperWorlds,
  type SecretResolver,
  type Session,
} from '@browser-os/protocol';
import {
  ActionCacheStore,
  AuditStore,
  openStore,
  ProfileStore,
  RunStore,
  SessionStore,
  stats as computeStats,
  TaskStore,
  TrajectoryStore,
  type Store,
} from '@browser-os/memory';
import { Observer } from './observer/observer.js';
import { ActionRouter } from './router/router.js';
import { createExecutionContext } from './router/context.js';
import type { ModelsPort, PagesPort, RouterCoreDeps, SessionsPort } from './router/types.js';
import { EnvSecretResolver } from './secrets.js';
import { PolicyPermissionGate, RejectingHumanGate, StaticRiskClassifier } from './security/stubs.js';
import type { HumanGate, PermissionGate, RiskClassifier } from './security/interfaces.js';
import { SessionManager, type ProviderKind } from './sessions/session-manager.js';
import { TrajectoryRecorder } from './tasks/recorder.js';
import { TaskManager } from './tasks/task-manager.js';
import { defaultConfig, loadConfig } from './config/load-config.js';

/** What `createRuntime` accepts: a partial config plus the injectable seams. */
export interface RuntimeOptions {
  /** Default `resolveBosHome(env, platform, homedir())`; tests pass a temp dir. */
  bosHome?: string;
  /** Default `process.env` — secret fallback (`BOS_SECRET_*`) and `BOS_HOME`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Default `{ launch: LaunchProvider, 'cdp-endpoint': CdpEndpointProvider }`. */
  providers?: Partial<Record<ProviderKind, BrowserProvider>>;
  /** Default `ModelRegistry.fromConfig(config.models)`; `null` forces no models. */
  models?: ModelsPort | null;
  gates?: {
    risk?: RiskClassifier;
    permissions?: PermissionGate;
    human?: HumanGate | null;
  };
  clock?: Clock;
  /** Set false to skip the sqlite store (pure-fake harnesses). Default true. */
  persist?: boolean;
}

export interface Runtime {
  readonly bosHome: string;
  readonly config: Config;
  readonly clock: Clock;
  readonly store: Store | null;
  readonly events: EventBus;
  readonly sessions: SessionManager;
  readonly observer: Observer;
  /** Router for a page (defaults to the session's active page). */
  routerFor(sessionId: string, pageId?: string): ActionRouter;
  readonly tasks: TaskManager;
  readonly profiles: ProfileStore | null;
  readonly trajectories: TrajectoryStore | null;
  readonly actionCache: ActionCacheStore | null;
  readonly runs: RunStore | null;
  readonly audit: AuditStore | null;
  readonly statsDb: Store['db'] | null;
  /** `profile.create`: validate the name, create the dir under BOS_HOME (ADR-003), persist. */
  createProfile(name: string, channel?: BrowserProfile['channel']): Promise<BrowserProfile>;
  /** Close every live session, then release the sqlite handle. */
  shutdown(): Promise<void>;
}

/**
 * Build the whole object graph. `config` arrives parsed or partial; absent
 * fields take `defaultConfig()`'s values (protocol §6). Throws `INVALID_REQUEST`
 * when an existing `config.json` does not validate.
 */
export function createRuntime(config: Partial<Config> | undefined = {}, options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  const platform: BosPlatform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const bosHome = options.bosHome ?? resolveBosHome(env, platform, process.env.HOME ?? process.cwd());
  mkdirSync(bosHome, { recursive: true });
  const clock = options.clock ?? systemClock;

  const merged: Config = { ...defaultConfig(), ...(config ?? loadConfig(bosHome)) };
  const events = new EventBus();

  // --- memory (ARCHITECTURE §5 line 1): the sqlite store, migrations included.
  const store: Store | null =
    options.persist === false ? null : openStore(join(bosHome, 'browser-os.db'));
  if (store !== null) new SessionStore(store.db).markAllLiveClosed(Math.floor(clock.now() / 1000));

  const profilesDb = store === null ? null : new ProfileStore(store.db);
  const sessionRows = store === null ? null : new SessionStore(store.db);
  const runRows = store === null ? null : new RunStore(store.db);
  const cacheRows = store === null ? null : new ActionCacheStore(store.db);
  const trajectoryRows = store === null ? null : new TrajectoryStore(store.db);
  const taskRows = store === null ? null : new TaskStore(store.db);
  const auditRows = store === null ? null : new AuditStore(store.db);

  // --- models + providers (§5 lines 3–4).
  const models: ModelsPort | null =
    options.models === undefined ? ModelRegistry.fromConfig(merged.models) : options.models;
  const providers: Partial<Record<ProviderKind, BrowserProvider>> = options.providers ?? {
    launch: new LaunchProvider(),
    'cdp-endpoint': new CdpEndpointProvider(),
  };

  // --- profiles: the protocol shape the SessionManager consumes.
  function toProtocolProfile(row: NonNullable<ReturnType<ProfileStore['getByName']>>): BrowserProfile {
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
  const profileLookup = {
    getByName(name: string): BrowserProfile | null {
      if (profilesDb === null) return null;
      const row = profilesDb.getByName(name);
      return row === undefined ? null : toProtocolProfile(row);
    },
  };

  // --- sessions (§5 line 6): SessionManager persists through SessionStore.
  const sessions = new SessionManager({
    providers,
    profiles: profileLookup,
    events,
    clock,
    ...(sessionRows === null ? {} : { persist: { upsert: (s: Session) => sessionRows.upsert(sessionInput(s)) } }),
  });

  // --- observer (§5 line 7) and the per-page CDP worlds the ladder probes through.
  const observer = new Observer({ events, getPage: (s, p) => sessions.page(s, p) });
  const worldsByTransport = new Map<CdpTransport, HelperWorlds>();
  function worldsFor(cdp: CdpTransport): HelperWorlds {
    let worlds = worldsByTransport.get(cdp);
    if (worlds === undefined) {
      const created = new IsolatedWorlds(cdp as unknown as ConstructorParameters<typeof IsolatedWorlds>[0]);
      created.registerHelper('probe', PROBE_HELPER_SOURCE);
      worlds = created as unknown as HelperWorlds;
      worldsByTransport.set(cdp, worlds);
    }
    return worlds;
  }

  const pages: PagesPort = {
    async context(sessionId, pageId) {
      const handle = sessions.page(sessionId, pageId);
      // The browser package's CdpTransport.send returns Promise<unknown>;
      // the protocol interface is generic (Promise<T>). They are structurally
      // compatible at the call sites — same cast shape as worldsFor below.
      const cdp = (await handle.cdp()) as unknown as CdpTransport;
      return {
        sessionId,
        pageId,
        driver: handle.driver(),
        cdp,
        worlds: worldsFor(cdp),
        // Empty → the probe resolves the main frame itself via Page.getFrameTree.
        mainCdpFrameId: '',
        headless: sessions.get(sessionId)?.headless ?? false,
        url: handle.url(),
      };
    },
  };
  const sessionPort: SessionsPort = {
    withPageLock: (s, p, fn) => sessions.withPageLock(s, p, fn),
    reconnect: (s) => sessions.reconnect(s),
    setActivePage: (s, p) => {
      void sessions.selectPage(s, p);
    },
  };

  // --- security (§5 line 8): phase-9 replaces these; the wiring does not change.
  const risk: RiskClassifier = options.gates?.risk ?? new StaticRiskClassifier();
  const permissions: PermissionGate = options.gates?.permissions ?? new PolicyPermissionGate();
  const human: HumanGate | null = options.gates?.human === undefined ? new RejectingHumanGate() : options.gates.human;
  const secrets: SecretResolver = new EnvSecretResolver(env);

  // --- router (§5 line 10). `ActionRouter` takes one `driver`, so the runtime
  // keeps one router per (session, page) — the driver belongs to a page, and
  // the ladder's probe helper needs that page's worlds.
  const routerCache = new Map<string, ActionRouter>();
  /** The router for one page — created on first use, then stable (cache is shared). */
  function routerFor(sessionId: string, pageId?: string): ActionRouter {
    const handle = sessions.page(sessionId, pageId);
    const key = `${sessionId}/${handle.id}`;
    let router = routerCache.get(key);
    if (router === undefined) {
      const deps: RouterCoreDeps = {
        driver: handle.driver(),
        pages,
        sessions: sessionPort,
        observer,
        risk,
        permissions,
        human,
        models,
        runs: runPort(),
        cache: cachePort(),
        events,
        // The task manager forwards each recorded action to the recorder of the
        // task named by `ctx.taskId` (memory §7); it is built just below.
        recorder: {
          isRecording: () => tasks.isRecording(),
          append: (r, c, i, k) => tasks.append(r, c, i, k),
          finalize: (s) => tasks.finalize(s),
        },
      };
      router = new ActionRouter(deps);
      routerCache.set(key, router);
    }
    return router;
  }

  function runPort() {
    return {
      insert(ctx: { sessionId: string; taskId?: string | null; origin: string; ts?: number }, result: Parameters<RunStore['insert']>[1]) {
        if (runRows === null) return 0;
        return runRows.insert(ctx, result);
      },
    };
  }
  function cachePort() {
    // The stores already satisfy `ActionCachePort` structurally; absent a
    // store (pure-fake harness) every lookup is a miss, which is the honest
    // behaviour of a cache with nothing in it.
    const empty = {
      get: () => null,
      put: () => {},
      recordHit: () => {},
      recordMiss: () => 0,
      invalidate: () => {},
    };
    return cacheRows === null ? empty : cacheRows;
  }

  // --- tasks (§5 line 11): the manager owns record/replay lifecycle. The
  // store-backed fakes below keep the type honest when `persist: false`.
  const missingStore = () =>
    new BosError('INTERNAL', 'this runtime was created without a store (persist: false)', {});
  const trajectoryPort: TrajectoryStore =
    trajectoryRows ??
    ({
      getLive: () => null,
      getById: () => null,
      list: () => [],
      delete: () => 0,
      invalidate: () => 0,
      createRecorded: () => {
        throw missingStore();
      },
      recordRun: () => {
        throw missingStore();
      },
      exportJson: () => {
        throw missingStore();
      },
      importJson: () => {
        throw missingStore();
      },
    } as unknown as TrajectoryStore);
  const taskPort: TaskStore =
    taskRows ??
    ({
      insert: () => {
        throw missingStore();
      },
      update: () => {
        throw missingStore();
      },
      get: () => undefined,
      list: () => [],
    } as unknown as TaskStore);

  const tasks = new TaskManager({
    router: { execute: (a, ctx, opts) => routerFor(ctx.sessionId, ctx.pageId).execute(a, ctx, opts) },
    tasks: taskPort,
    trajectories: trajectoryPort,
    events,
    clock,
    secrets,
    currentUrl: (sessionId) => {
      if (sessions.get(sessionId) === null) return '';
      return sessions.page(sessionId).url();
    },
    makeRecorder: ({ taskKey, params, secretNames }) =>
      new TrajectoryRecorder({ store: trajectoryPort, taskKey, params, secretNames }),
    makeContext: ({ sessionId, taskId, params: taskParams, secrets: taskSecrets }) => {
      const session = sessions.get(sessionId);
      const pageId = session?.activePageId ?? sessions.page(sessionId).id;
      return createExecutionContext({
        sessionId,
        pageId,
        taskId,
        policy: merged.policy,
        params: taskParams,
        secrets: taskSecrets,
        clock,
        signal: new AbortController().signal,
      });
    },
  });

  // --- profiles API helper (ADR-003: the dir always lives under BOS_HOME).
  async function createProfile(name: string, channel: BrowserProfile['channel'] = merged.defaultChannel): Promise<BrowserProfile> {
    const dir = await ensureProfileDir(bosHome, name);
    if (profilesDb === null) {
      return { id: newId('prf'), name, channel, userDataDir: dir, headless: false, createdAt: Math.floor(clock.now() / 1000), lastUsedAt: null };
    }
    const existing = profilesDb.getByName(name);
    const row =
      existing === undefined
        ? profilesDb.create(name, { channel, user_data_dir: dir })
        : existing;
    return toProtocolProfile(row);
  }

  async function shutdown(): Promise<void> {
    for (const session of sessions.list()) {
      if (session.status !== 'closed') await sessions.close(session.id).catch(() => undefined);
    }
    store?.close();
  }

  function sessionInput(session: Session) {
    return {
      id: session.id,
      profile_id: session.profileId,
      ownership: session.ownership,
      browser_pid: session.browserPid,
      cdp_port: session.cdpPort,
    };
  }

  return {
    bosHome,
    config: merged,
    clock,
    store,
    events,
    sessions,
    observer,
    routerFor,
    tasks,
    profiles: profilesDb,
    trajectories: trajectoryRows,
    actionCache: cacheRows,
    runs: runRows,
    audit: auditRows,
    statsDb: store === null ? null : store.db,
    createProfile,
    shutdown,
  };
}

