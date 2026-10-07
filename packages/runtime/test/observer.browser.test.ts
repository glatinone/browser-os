import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BrowserProvider, CdpEndpointProvider, ensureProfileDir, LaunchProvider } from '@browser-os/browser';
import { captureRaw } from '@browser-os/dom';
import { type BosEvent, type BrowserProfile, EventBus } from '@browser-os/protocol';
import { dummyProfile, withFixtureServer } from '@browser-os/tests/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Observer } from '../src/observer/observer.js';
import { type ProviderKind, SessionManager } from '../src/sessions/session-manager.js';

describe('Observer (browser)', () => {
  let bosHome: string;
  let profile: BrowserProfile;

  function makeManager(): SessionManager {
    const providers: Partial<Record<ProviderKind, BrowserProvider>> = {
      launch: new LaunchProvider(),
      'cdp-endpoint': new CdpEndpointProvider(),
    };
    return new SessionManager({
      providers,
      profiles: { getByName: () => profile },
      events: new EventBus(),
      clock: { now: () => Date.now() },
      persist: { upsert: () => {} },
    });
  }

  beforeEach(async () => {
    bosHome = await mkdtemp(path.join(tmpdir(), 'bos-observer-'));
    profile = {
      ...dummyProfile('observer'),
      userDataDir: await ensureProfileDir(bosHome, 'observer'),
    };
  });

  afterEach(async () => {
    await rm(bosHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });

  it('captures once, reuses while the page is unchanged, re-captures after a real navigation', async () => {
    const manager = makeManager();

    await withFixtureServer(async (server) => {
      const session = await manager.open({ profileName: 'observer' });
      const page = await manager.newPage(session.id, `${server.baseUrl}/basic/index.html`);

      let captures = 0;
      const events: BosEvent[] = [];
      const bus = new EventBus();
      bus.on('*', (event) => events.push(event));

      const observer = new Observer({
        events: bus,
        getPage: (sessionId, pageId) => manager.page(sessionId, pageId),
        captureRaw: async (cdp) => {
          captures += 1;
          return captureRaw(cdp as Parameters<typeof captureRaw>[0]);
        },
      });

      const first = await observer.capture(session.id, page.id);
      expect(captures).toBe(1);
      expect(first.observation.elements.length).toBeGreaterThan(0);
      expect(first.observation.url).toContain('/basic/index.html');

      // Second call: unchanged page, so the reuse check must cost one
      // mutation-counter round trip and no second full capture.
      const second = await observer.capture(session.id, page.id);
      expect(captures).toBe(1);
      expect(second.observation).toBe(first.observation);
      expect(second.index).toBe(first.index);

      // The last indices stay resolvable for stale-ref healing.
      expect(observer.index(first.observation.id)).toBe(first.index);

      // A real main-frame navigation replaces the DOM, so reuse is impossible.
      const target = `${server.baseUrl}/login/index.html`;
      const nav = await manager.page(session.id, page.id).driver().navigate(target, 20_000);
      expect(nav.ok).toBe(true);

      const third = await observer.capture(session.id, page.id);
      expect(captures).toBe(2);
      expect(third.observation).not.toBe(first.observation);
      expect(third.observation.url).toContain('/login/index.html');

      // One event per real capture, none for the reused call.
      const captured = events.filter((event) => event.type === 'observation.captured');
      expect(captured).toHaveLength(2);

      await manager.close(session.id);
    });
  }, 60_000);

  it('re-captures after an explicit invalidate even when nothing changed', async () => {
    const manager = makeManager();

    await withFixtureServer(async (server) => {
      const session = await manager.open({ profileName: 'observer' });
      const page = await manager.newPage(session.id, `${server.baseUrl}/basic/index.html`);

      let captures = 0;
      const observer = new Observer({
        getPage: (sessionId, pageId) => manager.page(sessionId, pageId),
        captureRaw: async (cdp) => {
          captures += 1;
          return captureRaw(cdp as Parameters<typeof captureRaw>[0]);
        },
      });

      await observer.capture(session.id, page.id);
      expect(captures).toBe(1);

      // The router calls this after every executed action.
      observer.invalidate(page.id);
      const fresh = await observer.capture(session.id, page.id);
      expect(captures).toBe(2);
      expect(fresh.observation.id).not.toBe('');

      await manager.close(session.id);
    });
  }, 60_000);
});
