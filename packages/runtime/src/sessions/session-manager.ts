// SessionManager: the only place that owns browsers (browser-runtime §3).
//
// It holds one live session per profile, keeps the active page in step with what the browser is
// doing, and turns a browser crash into a `disconnected` session that can be reconnected. It
// knows nothing about actions or the router — those arrive in Phase 3.

import type { BrowserHandle, BrowserProvider, PageHandle } from '@browser-os/browser';
import {
  BosError,
  type BrowserProfile,
  type Clock,
  type EventBus,
  newId,
  type PageInfo,
  type Session,
  type SessionStatus,
} from '@browser-os/protocol';
import { SessionPageRegistry } from './page-registry.js';

export type ProviderKind = 'launch' | 'cdp-endpoint';

/** LaunchProvider is the MVP default (browser-runtime §2). */
export const DEFAULT_PROVIDER: ProviderKind = 'launch';

/** A profile is "live" until it is closed or its browser has gone away (§3). */
const LIVE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'starting',
  'ready',
  'busy',
  'waiting_for_human',
]);

export interface OpenSessionOptions {
  profileName: string;
  provider?: ProviderKind;
  headless?: boolean;
  cdpEndpoint?: string;
}

export interface SessionManagerDeps {
  providers: Partial<Record<ProviderKind, BrowserProvider>>;
  profiles: { getByName(name: string): BrowserProfile | null };
  events: EventBus;
  clock: Clock;
  /** Wired to SQLite in P7-07; the manager works without it. */
  persist?: { upsert(session: Session): void };
}

interface LiveSession {
  session: Session;
  profile: BrowserProfile;
  provider: BrowserProvider;
  cdpEndpoint: string | undefined;
  handle: BrowserHandle;
  pages: SessionPageRegistry;
  activePageId: string | null;
  /** The url `reconnect` restores; refreshed whenever the active page changes or dies. */
  lastActiveUrl: string | null;
  /** One chain per page id, so two actions on one page never overlap. */
  locks: Map<string, Promise<void>>;
  heldLocks: number;
}

export class SessionManager {
  readonly #deps: SessionManagerDeps;
  readonly #sessions = new Map<string, LiveSession>();

  constructor(deps: SessionManagerDeps) {
    this.#deps = deps;
  }

  /**
   * Opens a session for `profileName`, or returns the live one that is already there
   * (CODING_AGENT rule 17: a second `open` for the same profile must not start a second
   * browser).
   */
  async open(opts: OpenSessionOptions): Promise<Session> {
    const profile = this.#deps.profiles.getByName(opts.profileName);
    if (profile === null) {
      throw new BosError('PROFILE_NOT_FOUND', `No profile named ${opts.profileName}`, {
        details: { profileName: opts.profileName },
      });
    }

    const existing = this.#liveFor(profile.id);
    if (existing !== undefined) return existing.session;

    const kind = opts.provider ?? DEFAULT_PROVIDER;
    const provider = this.#deps.providers[kind];
    if (provider === undefined) {
      throw new BosError('INVALID_REQUEST', `The ${kind} provider is not registered`, {
        details: { provider: kind },
      });
    }

    const now = this.#now();
    const session: Session = {
      id: newId('ses'),
      profileId: profile.id,
      status: 'starting',
      ownership: kind === 'launch' ? 'launched' : 'attached',
      headless: opts.headless ?? profile.headless,
      browserPid: null,
      cdpPort: null,
      activePageId: null,
      createdAt: now,
      lastUsedAt: now,
    };

    const handle = await provider.open({
      profile,
      headless: opts.headless,
      cdpEndpoint: opts.cdpEndpoint,
    });
    session.browserPid = handle.pid;

    const live = this.#newLive({
      session,
      profile,
      provider,
      cdpEndpoint: opts.cdpEndpoint,
      handle,
      activePageId: null,
      lastActiveUrl: null,
      locks: new Map(),
      heldLocks: 0,
    });
    this.#sessions.set(session.id, live);

    // The first page is active, and the single `session.status` event for this open is the
    // `ready` one below (§3).
    const first = live.pages.info(handle.pages()[0]?.id ?? '');
    live.activePageId = first?.id ?? null;
    live.lastActiveUrl = null;
    this.#rememberUrl(live, first?.url);
    session.activePageId = live.activePageId;

    this.#setStatus(live, 'ready');
    return session;
  }

  get(id: string): Session | null {
    return this.#sessions.get(id)?.session ?? null;
  }

  list(): Session[] {
    return [...this.#sessions.values()].map((live) => live.session);
  }

  /** The page to act on: the active one, or the one named. */
  page(sessionId: string, pageId?: string): PageHandle {
    const live = this.#require(sessionId);
    const id = pageId ?? live.activePageId;
    if (id === null) {
      throw new BosError('PAGE_NOT_FOUND', `Session ${sessionId} has no pages`, {
        details: { sessionId },
      });
    }
    const handle = live.pages.handle(id);
    if (handle === undefined) {
      throw new BosError('PAGE_NOT_FOUND', `Session ${sessionId} has no page ${id}`, {
        details: { sessionId, pageId: id },
      });
    }
    return handle;
  }

  pages(sessionId: string): PageInfo[] {
    return this.#require(sessionId).pages.list();
  }

  async newPage(sessionId: string, url?: string): Promise<PageInfo> {
    const live = this.#require(sessionId);
    // `onPage` fires for this page first and makes it active, so the activation below is a
    // no-op that only matters if a provider ever opens a page silently.
    const handle = await live.handle.newPage();
    const info = live.pages.add(handle);
    if (url !== undefined) await this.#navigate(handle, url);
    this.#activate(live, info.id, 'active-page-changed');
    return live.pages.info(info.id) ?? info;
  }

  async selectPage(sessionId: string, pageId: string): Promise<void> {
    const live = this.#require(sessionId);
    if (!live.pages.has(pageId)) {
      throw new BosError('PAGE_NOT_FOUND', `Session ${sessionId} has no page ${pageId}`, {
        details: { sessionId, pageId },
      });
    }
    this.#activate(live, pageId, 'active-page-changed');
  }

  async closePage(sessionId: string, pageId: string): Promise<void> {
    const live = this.#require(sessionId);
    const handle = live.pages.handle(pageId);
    if (handle === undefined) {
      throw new BosError('PAGE_NOT_FOUND', `Session ${sessionId} has no page ${pageId}`, {
        details: { sessionId, pageId },
      });
    }
    // The close handler in the registry does the bookkeeping and the fallback.
    await handle.close();
  }

  async close(id: string): Promise<void> {
    const live = this.#require(id);
    if (live.session.status === 'closed') return;
    await live.handle.close();
    this.#setStatus(live, 'closed');
  }

  /**
   * Brings a dead session back on the same profile and provider, and reopens the url the
   * active page was on. A session that is still alive is returned untouched.
   */
  async reconnect(id: string): Promise<Session> {
    const live = this.#require(id);
    if (live.session.status !== 'disconnected' && live.session.status !== 'closed') {
      return live.session;
    }

    this.#captureActiveUrl(live);
    const handle = await live.provider.open({
      profile: live.profile,
      headless: live.session.headless,
      cdpEndpoint: live.cdpEndpoint,
    });
    live.handle = handle;
    live.session.browserPid = handle.pid;
    this.#attach(live);
    live.activePageId = null;
    this.#persist(live);

    const url = live.lastActiveUrl;
    if (url === null) {
      live.activePageId = live.pages.list()[0]?.id ?? null;
      live.session.activePageId = live.activePageId;
    } else {
      const restored = live.pages.add(await handle.newPage());
      await this.#navigate(live.pages.handle(restored.id) as PageHandle, url);
      live.activePageId = restored.id;
      live.session.activePageId = restored.id;
    }

    this.#setStatus(live, 'ready', 'reconnected');
    return live.session;
  }

  /**
   * Runs `fn` with the page to itself. Calls for one page run in order; calls for different
   * pages run at the same time, and the session reports `busy` while any of them is held.
   */
  async withPageLock<T>(sessionId: string, pageId: string, fn: () => Promise<T>): Promise<T> {
    const live = this.#require(sessionId);
    const previous = live.locks.get(pageId) ?? Promise.resolve();
    const result = previous.then(fn);
    // Keep the chain alive even when `fn` rejects, or the next caller would wait for a
    // promise that already settled badly.
    live.locks.set(
      pageId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );

    live.heldLocks += 1;
    if (live.heldLocks === 1) this.#setStatus(live, 'busy');
    try {
      return await result;
    } finally {
      live.heldLocks -= 1;
      if (live.heldLocks === 0 && live.session.status === 'busy') this.#setStatus(live, 'ready');
    }
  }

  /** Builds a live session around a handle: registry, initial pages and event wiring. */
  #newLive(init: Omit<LiveSession, 'pages'>): LiveSession {
    // The registry is built inside `#attach`, where the closure over `live` already exists.
    const live = { ...init, pages: new SessionPageRegistry(init.session.id) } as LiveSession;
    this.#attach(live);
    return live;
  }

  /** Rebuilds the page view around the current handle and subscribes to its events. */
  #attach(live: LiveSession): void {
    live.pages = new SessionPageRegistry(live.session.id, (pageId, openerPageId) => {
      this.#onPageClosed(live, pageId, openerPageId);
    });
    for (const page of live.handle.pages()) live.pages.add(page);
    live.handle.onPage((page) => {
      const info = live.pages.add(page);
      this.#activate(live, info.id, 'active-page-changed');
    });
    live.handle.onDisconnected((reason) => {
      this.#captureActiveUrl(live);
      this.#setStatus(live, 'disconnected', reason);
    });
  }

  #onPageClosed(live: LiveSession, pageId: string, openerPageId: string | null): void {
    if (live.activePageId !== pageId) {
      this.#persist(live);
      return;
    }
    const fallback = openerPageId !== null && live.pages.has(openerPageId) ? openerPageId : live.pages.lastId();
    this.#activate(live, fallback, 'active-page-changed');
  }

  #activate(live: LiveSession, pageId: string | null, reason: string | undefined): void {
    const changed = live.activePageId !== pageId;
    live.activePageId = pageId;
    live.session.activePageId = pageId;
    live.session.lastUsedAt = this.#now();
    // Refreshed even when the active page did not change: a page is activated when it opens and
    // only navigates afterwards, and `reconnect` must restore where it ended up.
    const info = pageId === null ? undefined : live.pages.info(pageId);
    this.#rememberUrl(live, info?.url);
    this.#persist(live);
    if (changed) this.#emitStatus(live, reason);
  }

  /**
   * Remembers a url worth coming back to. `about:blank` and an empty url carry no information:
   * a page is activated before it navigates, and when a browser dies its pages close one after
   * another, so accepting those would overwrite the url `reconnect` should restore.
   */
  #rememberUrl(live: LiveSession, url: string | undefined): void {
    if (url !== undefined && url !== '' && url !== 'about:blank') live.lastActiveUrl = url;
  }

  #setStatus(live: LiveSession, status: SessionStatus, reason?: string): void {
    if (live.session.status === status) return;
    live.session.status = status;
    live.session.lastUsedAt = this.#now();
    this.#persist(live);
    this.#emitStatus(live, reason);
  }

  #emitStatus(live: LiveSession, reason: string | undefined): void {
    this.#deps.events.emit({
      ts: this.#now(),
      type: 'session.status',
      sessionId: live.session.id,
      data: reason === undefined ? { status: live.session.status } : { status: live.session.status, reason },
    });
  }

  #captureActiveUrl(live: LiveSession): void {
    if (live.activePageId === null) return;
    this.#rememberUrl(live, live.pages.info(live.activePageId)?.url);
  }

  /**
   * Starts a navigation and waits for it to commit, so the page's url is the one we asked for
   * by the time this resolves. A url that cannot be reached still commits an error page, and a
   * url Chrome rejects outright reports `errorText`, so this does not hang either way. The
   * authoritative navigation (with its own timeout and `NAVIGATION_FAILED`) is the driver's
   * in P3-01; this is the shortcut `newPage(url)` needs.
   */
  async #navigate(handle: PageHandle, url: string): Promise<void> {
    const transport = await handle.cdp();
    let stopWaiting: (() => void) | undefined;
    const commit = new Promise<void>((resolve) => {
      const off = transport.on('Page.frameNavigated', (payload) => {
        const frame = (payload as { frame?: { parentId?: string } }).frame;
        if (frame === undefined || frame.parentId !== undefined) return;
        off();
        resolve();
      });
      stopWaiting = off;
    });

    const answer = (await transport.send('Page.navigate', { url })) as { errorText?: string };
    if (answer.errorText !== undefined) {
      // Chrome refused the url outright, so no commit is coming and nobody should wait for one.
      stopWaiting?.();
      return;
    }
    await commit;
  }

  #persist(live: LiveSession): void {
    this.#deps.persist?.upsert(live.session);
  }

  #require(id: string): LiveSession {
    const live = this.#sessions.get(id);
    if (live === undefined) {
      throw new BosError('SESSION_NOT_FOUND', `No session ${id}`, { details: { sessionId: id } });
    }
    return live;
  }

  #liveFor(profileId: string): LiveSession | undefined {
    for (const live of this.#sessions.values()) {
      if (live.session.profileId === profileId && LIVE_STATUSES.has(live.session.status)) return live;
    }
    return undefined;
  }

  #now(): number {
    return this.#deps.clock.now();
  }
}
