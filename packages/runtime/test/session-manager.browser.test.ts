import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type BrowserProvider,
  CdpEndpointProvider,
  ensureProfileDir,
  isProfileLocked,
  LaunchProvider,
} from '@browser-os/browser';
import { type BosEvent, type BrowserProfile, EventBus, type Session } from '@browser-os/protocol';
import { dummyProfile, withFixtureServer } from '@browser-os/tests/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ProviderKind, SessionManager } from '../src/sessions/session-manager.js';

/** Waits for something to become true, rather than sleeping a guessed amount. */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return await predicate();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('SessionManager (browser)', () => {
  let bosHome: string;
  let profile: BrowserProfile;
  let events: BosEvent[];
  let persisted: Session[];

  function makeManager(): SessionManager {
    const providers: Partial<Record<ProviderKind, BrowserProvider>> = {
      launch: new LaunchProvider(),
      'cdp-endpoint': new CdpEndpointProvider(),
    };
    const bus = new EventBus();
    bus.on('*', (event) => events.push(event));
    return new SessionManager({
      providers,
      profiles: { getByName: () => profile },
      events: bus,
      clock: { now: () => Date.now() },
      persist: {
        upsert: (session: Session) => {
          persisted.push({ ...session });
        },
      },
    });
  }

  beforeEach(async () => {
    bosHome = await mkdtemp(path.join(tmpdir(), 'bos-session-'));
    profile = {
      ...dummyProfile('session'),
      userDataDir: await ensureProfileDir(bosHome, 'session'),
    };
    events = [];
    persisted = [];
  });

  afterEach(async () => {
    await rm(bosHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });

  it('opens a real browser, drives a page and closes it', async () => {
    const manager = makeManager();

    await withFixtureServer(async (server) => {
      const session = await manager.open({ profileName: 'session' });

      expect(session.status).toBe('ready');
      expect(session.ownership).toBe('launched');
      expect(session.browserPid).toBeNull();
      expect(persisted.at(-1)?.status).toBe('ready');

      const target = `${server.baseUrl}/basic/index.html`;
      const page = await manager.newPage(session.id, target);

      expect(page.url).toBe(target);
      expect(manager.pages(session.id)).toHaveLength(2);
      expect(manager.get(session.id)?.activePageId).toBe(page.id);
      expect(manager.page(session.id).url()).toBe(target);

      await manager.close(session.id);
      expect(manager.get(session.id)?.status).toBe('closed');
    });
  });

  it('reports a browser that goes away, then reconnects on the page it was on', async () => {
    const manager = makeManager();

    await withFixtureServer(async (server) => {
      const session = await manager.open({ profileName: 'session' });
      const target = `${server.baseUrl}/basic/index.html`;
      const page = await manager.newPage(session.id, target);

      // The browser goes away behind our back: `Browser.close` on the page's own session is what
      // an external quit or crash looks like from here. LaunchProvider exposes no pid to kill
      // (integration §13), so this is the honest way to produce the same event.
      await (await manager.page(session.id).cdp()).send('Browser.close').catch(() => {
        // Expected: the connection dies with the browser.
      });
      const died = await until(() => manager.get(session.id)?.status === 'disconnected', 15000);

      expect(died).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: 'session.status',
        data: { status: 'disconnected' },
      });

      // Chrome lets go of its profile a moment after it quits, and a reconnect inside that window
      // would be refused with PROFILE_LOCKED.
      const released = await until(() => isProfileLocked(profile.userDataDir).then((held) => !held), 15000);
      expect(released).toBe(true);

      const reconnected = await manager.reconnect(session.id);
      expect(reconnected.status).toBe('ready');
      expect(events.at(-1)).toMatchObject({ data: { status: 'ready', reason: 'reconnected' } });
      // The page we were on is back, in the relaunched browser.
      expect(manager.page(session.id).url()).toBe(target);
      // And it is a new page in the new browser, not the handle from the one that died.
      expect(manager.page(session.id).id).not.toBe(page.id);

      await manager.close(session.id);
    });
  }, 75000);
});
