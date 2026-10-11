import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BrowserProvider, CdpEndpointProvider, ensureProfileDir, LaunchProvider } from '@browser-os/browser';
import { RunStore, openStore, type Store } from '@browser-os/memory';
import { type BrowserProfile, DEFAULT_POLICY, EventBus } from '@browser-os/protocol';
import { dummyProfile, withFixtureServer } from '@browser-os/tests/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Observer } from '../src/observer/observer.js';
import { createExecutionContext } from '../src/router/context.js';
import { ActionRouter } from '../src/router/router.js';
import { type ProviderKind, SessionManager } from '../src/sessions/session-manager.js';
import { PolicyPermissionGate, StaticRiskClassifier } from '../src/security/stubs.js';
import type { SessionsPort } from '../src/router/types.js';

/**
 * P7-02 against a real Chromium: real PageDriver, real Observer, the *real*
 * SessionManager page lock, and a real `action_runs` table. Only the classifier and
 * the permission gate are phase stubs (security/stubs.ts), because the risk model
 * lands in phase 9.
 *
 * The unit tier (router-core.test.ts) carries the tier ladder, the effect rule and
 * the heal path; this file exists to prove the three wiring requirements against
 * something that can actually fail: requirement 1 (row in the table), requirement 4
 * (the lock that is held), requirement 7 (the active page that follows).
 */
describe('ActionRouter core (P7-02, browser)', () => {
  let bosHome: string;
  let profile: BrowserProfile;
  let manager: SessionManager;
  let store: Store;
  let runs: RunStore;
  let sessionId: string | undefined;
  let activePages: string[];
  let lockCalls: string[];

  /** Router wired to this test's session: real driver, real observer, real lock. */
  function makeRouter(pageId: string) {
    if (sessionId === undefined) throw new Error('no session opened');
    const owner = sessionId;
    const events = new EventBus();
    const observer = new Observer({ events, getPage: (s, p) => manager.page(s, p) });
    const sessions: SessionsPort = {
      withPageLock: (s, p, fn) => {
        lockCalls.push(`${s}/${p}`);
        return manager.withPageLock(s, p, fn);
      },
      reconnect: (s) => manager.reconnect(s),
      setActivePage: (s, p) => {
        activePages.push(`${s}/${p}`);
        // integration §5: the port is sync, SessionManager's own method is async —
        // this is the P7-07 wiring seam, recorded here so the test can assert on it.
        void manager.selectPage(s, p).catch(() => {});
      },
    };
    const router = new ActionRouter({
      driver: manager.page(owner, pageId).driver(),
      observer,
      sessions,
      runs,
      cache: {
        get: () => null,
        put: () => {},
        recordHit: () => {},
        recordMiss: () => 0,
        invalidate: () => {},
      },
      risk: new StaticRiskClassifier(),
      permissions: new PolicyPermissionGate(),
      human: null,
      events,
      recorder: null,
      constants: {},
      disabledTiers: [],
    });
    return { router, observer, events };
  }

  function makeCtx(pageId: string) {
    if (sessionId === undefined) throw new Error('no session opened');
    return createExecutionContext({
      sessionId,
      pageId,
      policy: DEFAULT_POLICY,
      secrets: { resolve: async () => '' },
      clock: { now: () => Date.now() },
      signal: new AbortController().signal,
    });
  }

  beforeEach(async () => {
    bosHome = await mkdtemp(path.join(tmpdir(), 'bos-router-'));
    profile = { ...dummyProfile('router'), userDataDir: await ensureProfileDir(bosHome, 'router') };
    const providers: Partial<Record<ProviderKind, BrowserProvider>> = {
      launch: new LaunchProvider(),
      'cdp-endpoint': new CdpEndpointProvider(),
    };
    manager = new SessionManager({
      providers,
      profiles: { getByName: () => profile },
      events: new EventBus(),
      clock: { now: () => Date.now() },
      persist: { upsert: () => {} },
    });
    store = openStore(':memory:');
    runs = new RunStore(store.db);
    activePages = [];
    lockCalls = [];
    sessionId = undefined;
  });

  afterEach(async () => {
    if (sessionId !== undefined) await manager.close(sessionId).catch(() => {});
    sessionId = undefined;
    store.close();
    await rm(bosHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });

  function actionRuns(): Array<Record<string, unknown>> {
    return store.db
      .prepare('SELECT origin, action_type, tier, driver, ok, error_code FROM action_runs ORDER BY ts, rowid')
      .all() as Array<Record<string, unknown>>;
  }

  it('navigates through the real driver, under the real lock, and leaves one action_runs row', async () => {
    await withFixtureServer(async (server) => {
      const session = await manager.open({ profileName: 'router' });
      sessionId = session.id;
      const page = await manager.newPage(session.id, `${server.baseUrl}/basic/index.html`);
      const { router } = makeRouter(page.id);

      const result = await router.execute(
        { type: 'navigate', url: `${server.baseUrl}/basic/docs` },
        makeCtx(page.id),
      );

      expect(result.ok).toBe(true);
      expect(result.pageChanged).toBe(true);
      expect(result.url).toContain('/basic/docs');
      expect(result.ms).toBeGreaterThanOrEqual(0);

      // requirement 4: the real SessionManager lock was taken for this action only,
      // and the session is not stuck in `busy` afterwards.
      expect(lockCalls).toEqual([`${session.id}/${page.id}`]);
      expect((await manager.reconnect(session.id)).status).toBe('ready');

      // requirement 7: a page-changing action became the session's active page.
      expect(activePages).toContain(`${session.id}/${page.id}`);

      // requirement 1: the row landed in the real table, with the real origin.
      expect(actionRuns()).toEqual([
        {
          origin: new URL(server.baseUrl).origin,
          action_type: 'navigate',
          tier: null,
          driver: 'cdp',
          ok: 1,
          error_code: null,
        },
      ]);
    });
  });

  it('fills a real field and verifies it by reading the value back', async () => {
    await withFixtureServer(async (server) => {
      const session = await manager.open({ profileName: 'router' });
      sessionId = session.id;
      const page = await manager.newPage(session.id, `${server.baseUrl}/basic/index.html`);
      const { router, observer } = makeRouter(page.id);

      const result = await router.execute(
        {
          type: 'fill',
          target: { kind: 'query', role: 'textbox', name: 'Full name' },
          value: { kind: 'literal', value: 'Kiell' },
        },
        makeCtx(page.id),
      );

      // `ok` here means step G read the field back through CDP and got 'Kiell'.
      expect(result.ok).toBe(true);
      expect(result.tier).toBe('deterministic');
      expect(result.element).toMatchObject({ role: 'textbox', name: 'Full name' });
      expect(result.pageChanged).toBe(false);

      // The router invalidated the observation after dispatch, so this capture is fresh
      // and shows the value the action put there.
      const { observation } = await observer.capture(session.id, page.id);
      const field = observation.elements.find((e) => e.name === 'Full name');
      expect(field?.value).toBe('Kiell');

      expect(actionRuns()).toEqual([
        expect.objectContaining({ action_type: 'fill', tier: 'deterministic', driver: 'cdp', ok: 1, error_code: null }),
      ]);
      // still on the same page: nothing to re-point the session at
      expect(activePages).toEqual([]);
      expect(lockCalls).toEqual([`${session.id}/${page.id}`]);
    });
  });

  it('follows a real navigation into the session active page (requirement 7)', async () => {
    await withFixtureServer(async (server) => {
      const session = await manager.open({ profileName: 'router' });
      sessionId = session.id;
      const page = await manager.newPage(session.id, `${server.baseUrl}/basic/index.html`);
      const { router, observer } = makeRouter(page.id);

      // A link click that crosses a document boundary: the driver waits for the
      // navigation, so `pageChanged` is the truth and not a guess.
      const result = await router.execute(
        { type: 'click', target: { kind: 'query', role: 'link', name: 'Docs' } },
        makeCtx(page.id),
      );

      expect(result.ok).toBe(true);
      expect(result.pageChanged).toBe(true);
      expect(result.url).toContain('/basic/docs');
      expect(activePages).toContain(`${session.id}/${page.id}`);

      // the session follows: the next capture is of the new document
      const { observation } = await observer.capture(session.id, page.id);
      expect(observation.url).toContain('/basic/docs');

      expect(actionRuns()).toEqual([
        expect.objectContaining({ action_type: 'click', tier: 'deterministic', driver: 'cdp', ok: 1, error_code: null }),
      ]);
      expect((await manager.reconnect(session.id)).status).toBe('ready');
    });
  });
});
