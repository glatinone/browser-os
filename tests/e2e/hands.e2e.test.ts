// Milestone M1, "Hands" (ROADMAP M1): a browser is opened, a form is driven entirely through the
// CDP executor, the result is read back off the page, a cookie survives the browser being closed
// and reopened, and a target that the CDP path refuses is clicked by the Playwright fallback.
//
// Everything here goes through the public surface — `SessionManager`, `PageHandle`, `PageDriver` —
// which is the point of an end-to-end test.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureProfileDir, isProfileLocked, LaunchProvider, resolveCss } from '@browser-os/browser';
import { type FixtureServer, startFixtureServer } from '@browser-os/fixtures/server';
import { type BrowserProfile, EventBus, newId, type Session } from '@browser-os/protocol';
import { SessionManager } from '@browser-os/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let bosHome: string;
let server: FixtureServer;
let profile: BrowserProfile;
let manager: SessionManager;
let liveSession: Session | null = null;

beforeAll(async () => {
  bosHome = await mkdtemp(path.join(tmpdir(), 'bos-hands-'));
  server = await startFixtureServer();
  profile = {
    id: newId('prf'),
    name: 'hands',
    channel: 'chromium',
    userDataDir: await ensureProfileDir(bosHome, 'hands'),
    headless: true,
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  manager = new SessionManager({
    providers: { launch: new LaunchProvider() },
    profiles: { getByName: (name) => (name === 'hands' ? profile : null) },
    events: new EventBus(),
    clock: { now: () => Date.now() },
  });
});

afterAll(async () => {
  // Closed first: a live browser holds files in the temp home and the removal would only retry
  // against them until the hook's own timeout.
  if (liveSession !== null) {
    await manager.close(liveSession.id).catch(() => {
      // Already gone.
    });
  }
  await server.close();
  await rm(bosHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

async function openHands() {
  const session: Session = await manager.open({ profileName: 'hands' });
  liveSession = session;
  const page = manager.page(session.id);
  return { session, page, driver: page.driver(), transport: await page.cdp() };
}

/** Extraction answers with plain data; the assertions want the text. */
function asText(extracted: unknown): string {
  return typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
}

/** A browser that has just quit holds its profile for a moment while the OS reaps it. */
async function waitForProfileRelease(): Promise<void> {
  const deadline = Date.now() + 10000;
  while (await isProfileLocked(profile.userDataDir)) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('M1: hands', () => {
  it('fills the form and submits it entirely through CDP', async () => {
    const { session, driver, transport } = await openHands();

    const nav = await driver.navigate(`${server.baseUrl}/basic/`, 20000);
    expect(nav.ok).toBe(true);
    expect(nav.effect).toBe('committed');

    const fill = async (css: string, value: string, intent: string) =>
      await driver.cdpPerform(
        { type: 'fill', target: { kind: 'intent', text: intent } },
        await resolveCss(transport, css),
        value,
      );

    expect((await fill('#name', 'Ada Lovelace', 'the full name field')).ok).toBe(true);
    expect((await fill('#email', 'ada@example.com', 'the email field')).ok).toBe(true);
    expect(
      (
        await driver.cdpPerform(
          { type: 'select', target: { kind: 'intent', text: 'the country dropdown' } },
          await resolveCss(transport, '#country'),
          'id',
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'the newsletter checkbox' } },
          await resolveCss(transport, '#newsletter'),
        )
      ).ok,
    ).toBe(true);
    expect(await driver.readValue(await resolveCss(transport, '#newsletter'))).toBe('true');

    const submit = await driver.cdpPerform(
      { type: 'click', target: { kind: 'intent', text: 'Create account' } },
      await resolveCss(transport, 'button[type=submit]'),
    );
    expect(submit.ok).toBe(true);
    expect(submit.navigated).toBe(true);
    expect(submit.urlAfter).toBe(`${server.baseUrl}/echo`);

    // The fixture echoes what it received as JSON, and the page is showing it.
    const body = asText(await driver.extract(null, 'text'));
    expect(body).toContain('Ada Lovelace');
    expect(body).toContain('ada@example.com');
    expect(body).toContain('"country":"id"');
    expect(body).toContain('"newsletter":"yes"');
    expect(session.status).toBe('ready');
  });

  it('keeps a cookie across closing and reopening the browser', async () => {
    const { session, driver } = await openHands();

    await driver.navigate(`${server.baseUrl}/cookie/set?value=hands`, 20000);
    await driver.navigate(`${server.baseUrl}/cookie/get`, 20000);
    expect(asText(await driver.extract(null, 'text'))).toContain('bos=hands');

    await manager.close(session.id);
    expect(manager.get(session.id)?.status).toBe('closed');
    await waitForProfileRelease();

    const reopened = await openHands();
    expect(reopened.session.id).not.toBe(session.id);
    await reopened.driver.navigate(`${server.baseUrl}/cookie/get`, 20000);
    // A cookie that was only in memory would be gone by now.
    expect(asText(await reopened.driver.extract(null, 'text'))).toContain('bos=hands');
  });

  it('refuses a covered target, and the Playwright fallback clicks it anyway', async () => {
    const { driver, transport } = await openHands();

    // The cover lifts when the pointer moves, which the fallback does and a refused click does not.
    await driver.navigate(`${server.baseUrl}/overlay/?variant=reveal`, 20000);
    const button = await resolveCss(transport, '#covered-button');
    const action = { type: 'click', target: { kind: 'intent', text: 'Pay invoice' } } as const;

    const refused = await driver.cdpPerform(action, button);
    expect(refused.ok).toBe(false);
    expect(refused.effect).toBe('none');
    expect(refused.error?.code).toBe('TARGET_OBSCURED');

    const clicked = await driver.playwrightPerform(action, button);
    expect(clicked.ok).toBe(true);
    expect(clicked.effect).toBe('committed');
    expect(asText(await driver.extract(null, 'text'))).toContain('Paid');
  });
});
