import type {
  BrowserHandle,
  BrowserProvider,
  CdpTransport,
  OpenOptions,
  PageDriver,
  PageHandle,
  ProviderCapabilities,
} from '@browser-os/browser';
import { BosError, type BosEvent, EventBus, newId, type Session } from '@browser-os/protocol';
import { dummyProfile, fakeClock } from '@browser-os/tests/helpers';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../src/sessions/session-manager.js';

const CAPABILITIES: ProviderCapabilities = {
  persistentProfile: true,
  screenshots: true,
  oopif: true,
  headful: true,
  uploads: true,
  downloads: true,
};

/** A page that remembers where it was sent, without a browser. */
class FakePage implements PageHandle {
  readonly id = newId('pg');
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  #url: string;
  #title: string;
  #opener: PageHandle | null;
  readonly #closed = new Set<() => void>();

  constructor(opts: { url?: string; title?: string; opener?: PageHandle | null } = {}) {
    this.#url = opts.url ?? 'about:blank';
    this.#title = opts.title ?? '';
    this.#opener = opts.opener ?? null;
  }

  url(): string {
    return this.#url;
  }

  async title(): Promise<string> {
    return this.#title;
  }

  opener(): PageHandle | null {
    return this.#opener;
  }

  readonly #navigated = new Set<(payload: unknown) => void>();
  #transport: CdpTransport | null = null;

  async cdp(): Promise<CdpTransport> {
    const page = this;
    this.#transport ??= {
      async send(method: string, params?: Record<string, unknown>) {
        page.sent.push(params === undefined ? { method } : { method, params });
        if (method === 'Page.navigate') {
          page.#url = String(params?.url);
          // A real browser commits a navigation and announces it; the manager waits for that.
          for (const listener of [...page.#navigated]) listener({ frame: { id: 'F1' } });
        }
        return {};
      },
      on(event: string, listener: (payload: unknown) => void) {
        if (event !== 'Page.frameNavigated') return () => {};
        page.#navigated.add(listener);
        return () => {
          page.#navigated.delete(listener);
        };
      },
    };
    return this.#transport;
  }

  driver(): PageDriver {
    throw new BosError('INTERNAL', 'the driver arrives in P3-01', {});
  }

  async bringToFront(): Promise<void> {}

  async close(): Promise<void> {
    for (const cb of this.#closed) cb();
  }

  onClose(cb: () => void): () => void {
    this.#closed.add(cb);
    return () => {
      this.#closed.delete(cb);
    };
  }
}

class FakeHandle implements BrowserHandle {
  /** Like LaunchProvider: a persistent context exposes no pid. */
  readonly pid: number | null = null;
  readonly pagesById: FakePage[] = [];
  readonly #pageCallbacks = new Set<(page: PageHandle) => void>();
  readonly #disconnected = new Set<(reason: string) => void>();

  constructor(pages: FakePage[] = []) {
    this.pagesById.push(...pages);
  }

  pages(): PageHandle[] {
    return [...this.pagesById];
  }

  async newPage(): Promise<PageHandle> {
    // A page opened from within the browser is opened by the page that was there.
    const page = new FakePage({ opener: this.pagesById.at(-1) ?? null });
    this.addPage(page);
    return page;
  }

  onPage(cb: (page: PageHandle) => void): () => void {
    this.#pageCallbacks.add(cb);
    return () => {
      this.#pageCallbacks.delete(cb);
    };
  }

  onDisconnected(cb: (reason: string) => void): () => void {
    this.#disconnected.add(cb);
    return () => {
      this.#disconnected.delete(cb);
    };
  }

  async close(): Promise<void> {}

  // — test controls, not part of BrowserHandle —
  addPage(page: FakePage): void {
    this.pagesById.push(page);
    for (const cb of this.#pageCallbacks) cb(page);
  }

  crash(reason = 'browser disconnected'): void {
    for (const cb of this.#disconnected) cb(reason);
  }
}

class FakeProvider implements BrowserProvider {
  readonly kind = 'launch' as const;
  readonly capabilities = CAPABILITIES;
  readonly opens: Array<{ profileId: string; cdpEndpoint?: string }> = [];
  readonly handles: FakeHandle[] = [];
  /** Pages the next handle starts with. */
  initial: FakePage[] = [new FakePage()];

  async open(opts: OpenOptions): Promise<BrowserHandle> {
    this.opens.push({
      profileId: opts.profile.id,
      ...(opts.cdpEndpoint === undefined ? {} : { cdpEndpoint: opts.cdpEndpoint }),
    });
    const handle = new FakeHandle(this.initial.map(() => new FakePage()));
    this.handles.push(handle);
    return handle;
  }

  get latest(): FakeHandle {
    const handle = this.handles.at(-1);
    if (handle === undefined) throw new Error('no handle was opened');
    return handle;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeManager(opts: { provider?: FakeProvider; profileName?: string } = {}) {
  const provider = opts.provider ?? new FakeProvider();
  const name = opts.profileName ?? 'test';
  const profile = { ...dummyProfile(name) };
  const events: BosEvent[] = [];
  const bus = new EventBus();
  bus.on('*', (event) => events.push(event));
  const persisted: Session[] = [];
  const clock = fakeClock(1000);

  const manager = new SessionManager({
    providers: { launch: provider },
    profiles: { getByName: (asked) => (asked === name ? profile : null) },
    events: bus,
    clock,
    persist: {
      upsert: (session) => {
        persisted.push({ ...session });
      },
    },
  });

  return { manager, provider, events, persisted, profile, name };
}

describe('SessionManager.open', () => {
  it('returns the session that is already live instead of a second browser', async () => {
    const { manager, provider, name } = makeManager();

    const first = await manager.open({ profileName: name });
    const second = await manager.open({ profileName: name });

    expect(second.id).toBe(first.id);
    expect(provider.opens).toHaveLength(1);
    expect(manager.list()).toHaveLength(1);
    expect(first.status).toBe('ready');
    expect(first.ownership).toBe('launched');
  });

  it('reports the first page as active and persists the session', async () => {
    const { manager, persisted, name } = makeManager();

    const session = await manager.open({ profileName: name });

    expect(session.activePageId).toMatch(/^pg_/);
    expect(manager.page(session.id).id).toBe(session.activePageId);
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('refuses a profile it does not have, and a provider it does not have', async () => {
    const { manager, provider } = makeManager();

    await expect(manager.open({ profileName: 'nope' })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
    await expect(manager.open({ profileName: 'test', provider: 'cdp-endpoint' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(provider.opens).toEqual([]);
  });
});

describe('SessionManager pages', () => {
  it('makes a new page active and says why', async () => {
    const { manager, events, name } = makeManager();
    const session = await manager.open({ profileName: name });

    const opened = await manager.newPage(session.id, 'https://example.test/two');

    expect(manager.get(session.id)?.activePageId).toBe(opened.id);
    expect(manager.pages(session.id)).toHaveLength(2);
    expect(opened.url).toBe('https://example.test/two');
    expect(events.at(-1)).toMatchObject({
      type: 'session.status',
      data: { status: 'ready', reason: 'active-page-changed' },
    });
  });

  it('falls back to the opener when the active page closes', async () => {
    const { manager, name } = makeManager();
    const session = await manager.open({ profileName: name });
    const first = manager.page(session.id);
    const popup = await manager.newPage(session.id);

    await manager.closePage(session.id, popup.id);

    // The popup's parent is the page that was active before it.
    expect(manager.get(session.id)?.activePageId).toBe(first.id);
  });

  it('falls back to the most recent page when the closed page has no opener', async () => {
    const { manager, name } = makeManager();
    const session = await manager.open({ profileName: name });
    // The first page of a session has no opener, so closing it has nothing to fall back to
    // but the newest page still open.
    const first = manager.page(session.id);
    const second = await manager.newPage(session.id);

    await manager.selectPage(session.id, first.id);
    await manager.closePage(session.id, first.id);

    expect(manager.get(session.id)?.activePageId).toBe(second.id);
  });

  it('has no active page once the last one is gone', async () => {
    const { manager, name } = makeManager();
    const session = await manager.open({ profileName: name });

    await manager.closePage(session.id, manager.page(session.id).id);

    expect(manager.get(session.id)?.activePageId).toBeNull();
    expect(() => manager.page(session.id)).toThrowError(/has no pages/);
  });

  it('refuses a page that is not in the session', async () => {
    const { manager, name } = makeManager();
    const session = await manager.open({ profileName: name });

    await expect(manager.selectPage(session.id, 'pg_missing')).rejects.toMatchObject({
      code: 'PAGE_NOT_FOUND',
    });
    expect(() => manager.page('ses_missing')).toThrowError(/No session/);
  });
});

describe('SessionManager disconnect and reconnect', () => {
  it('marks the session disconnected, then comes back on the same url', async () => {
    const { manager, events, provider, name } = makeManager();
    const session = await manager.open({ profileName: name });
    await manager.newPage(session.id, 'https://example.test/keep-me');

    provider.latest.crash('browser gone');

    expect(manager.get(session.id)?.status).toBe('disconnected');
    expect(events.at(-1)).toMatchObject({
      type: 'session.status',
      data: { status: 'disconnected', reason: 'browser gone' },
    });

    const reconnected = await manager.reconnect(session.id);

    expect(reconnected.status).toBe('ready');
    expect(provider.opens).toHaveLength(2);
    // A fresh browser, on the page we were on when the old one died.
    const active = manager.page(session.id);
    expect(active.url()).toBe('https://example.test/keep-me');
    expect(events.at(-1)).toMatchObject({ data: { status: 'ready', reason: 'reconnected' } });
  });

  it('leaves a live session alone', async () => {
    const { manager, provider, name } = makeManager();
    const session = await manager.open({ profileName: name });

    await manager.reconnect(session.id);

    expect(provider.opens).toHaveLength(1);
    expect(manager.get(session.id)?.status).toBe('ready');
  });

  it('closes the handle and reports the session closed', async () => {
    const { manager, name } = makeManager();
    const session = await manager.open({ profileName: name });

    await manager.close(session.id);

    expect(manager.get(session.id)?.status).toBe('closed');
    // A closed profile is free again: opening it starts a new session.
    const next = await manager.open({ profileName: name });
    expect(next.id).not.toBe(session.id);
  });
});

describe('SessionManager.withPageLock', () => {
  it('runs two calls for one page in order', async () => {
    const { manager, name } = makeManager();
    const session = await manager.open({ profileName: name });
    const pageId = manager.page(session.id).id;
    const order: string[] = [];
    const firstHolds = deferred();
    const firstStarted = deferred();

    const first = manager.withPageLock(session.id, pageId, async () => {
      order.push('first:start');
      firstStarted.resolve();
      await firstHolds.promise;
      order.push('first:end');
      return 'first';
    });
    await firstStarted.promise;

    const second = manager.withPageLock(session.id, pageId, async () => {
      order.push('second:start');
      return 'second';
    });

    // The session reports busy while the page is held.
    expect(manager.get(session.id)?.status).toBe('busy');
    // The second call is queued, not started.
    expect(order).toEqual(['first:start']);

    firstHolds.resolve();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(manager.get(session.id)?.status).toBe('ready');
  });

  it('lets two pages run at the same time', async () => {
    const { manager, name } = makeManager();
    const session = await manager.open({ profileName: name });
    const firstPage = manager.page(session.id).id;
    const secondPage = (await manager.newPage(session.id)).id;
    const firstHolds = deferred();
    const firstStarted = deferred();

    const first = manager.withPageLock(session.id, firstPage, async () => {
      firstStarted.resolve();
      await firstHolds.promise;
      return 'first';
    });
    await firstStarted.promise;

    // Different page: it finishes while the first is still holding its own page.
    const second = manager.withPageLock(session.id, secondPage, async () => 'second');
    expect(await second).toBe('second');

    firstHolds.resolve();
    expect(await first).toBe('first');
  });

  it('releases the page when the work throws', async () => {
    const { manager, name } = makeManager();
    const session = await manager.open({ profileName: name });
    const pageId = manager.page(session.id).id;

    await expect(
      manager.withPageLock(session.id, pageId, async () => {
        throw new BosError('ACTION_FAILED', 'nope', {});
      }),
    ).rejects.toMatchObject({ code: 'ACTION_FAILED' });

    // The next caller is not stuck behind a rejected promise.
    await expect(manager.withPageLock(session.id, pageId, async () => 'after')).resolves.toBe('after');
    expect(manager.get(session.id)?.status).toBe('ready');
  });
});
