import fs from 'node:fs/promises';
import path from 'node:path';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '@browser-os/tests/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchProvider } from '../src/providers/launch-provider.js';
import { rawFirstPage, rawPage } from './support/raw-page.js';

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe('LaunchProvider (browser)', () => {
  let browser: TestBrowser;

  beforeEach(async () => {
    browser = await launchTestBrowser();
  });

  afterEach(async () => {
    await browser.dispose();
  });

  it('launches a persistent context with a first page', () => {
    expect(browser.handle().pages().length).toBeGreaterThanOrEqual(1);
  });

  it('reports a null pid, because a persistent context exposes none (integration §13)', () => {
    expect(browser.handle().pid).toBeNull();
  });

  it('opens no DevToolsActivePort file in the profile (S2)', async () => {
    // The pipe transport never opens a TCP debugging port, so even the marker file
    // Chrome writes when one is opened must be absent.
    await expect(fs.access(path.join(browser.profile.userDataDir, 'DevToolsActivePort'))).rejects.toThrow();
  });

  it('creates a new page with a Browser-OS id', async () => {
    const before = browser.handle().pages().length;

    const page = await browser.handle().newPage();

    expect(page.id).toMatch(/^pg_/);
    expect(browser.handle().pages().length).toBe(before + 1);
    await page.close();
  });

  it('reports a page closed, in our own view and in the handle', async () => {
    const page = browser.handle().pages()[0];
    if (page === undefined) throw new Error('no page');

    let closed = false;
    page.onClose(() => {
      closed = true;
    });

    await page.close();

    expect(closed).toBe(true);
    expect(browser.handle().pages()).not.toContain(page);
  });

  it('fires onPage when a page opens a window', async () => {
    const opened = new Promise<string>((resolve) => {
      browser.handle().onPage((page) => resolve(page.id));
    });

    await rawFirstPage(browser.handle()).evaluate(() => {
      window.open('about:blank');
    });

    expect(await opened).toMatch(/^pg_/);
  });

  it('fires onDisconnected when the browser closes', async () => {
    let reason: string | null = null;
    browser.handle().onDisconnected((r) => {
      reason = r;
    });

    await browser.handle().close();

    expect(await until(() => reason !== null, 10000)).toBe(true);
  });

  it('refuses to open a profile another process already owns', async () => {
    // The launched Chromium holds the profile, so this is the real lock, not a mock:
    // one Chrome per user-data-dir is enforced by Chrome itself (browser-runtime §1).
    const provider = new LaunchProvider();

    await expect(provider.open({ profile: browser.profile })).rejects.toMatchObject({
      code: 'PROFILE_LOCKED',
    });
  });

  it('keeps cookies across a close and relaunch of the same profile', async () => {
    await withFixtureServer(async (server) => {
      const first = rawFirstPage(browser.handle());
      await first.goto(server.baseUrl);
      await first.evaluate(() => {
        // max-age matters: a bare `document.cookie = ...` is a session cookie, which
        // no browser writes to disk, so it would prove nothing about the profile.
        // biome-ignore lint/suspicious/noDocumentCookie: the card prescribes document.cookie for this check
        document.cookie = 'bos_persist=1; path=/; max-age=3600';
      });
      expect(await first.evaluate(() => document.cookie)).toContain('bos_persist=1');

      const relaunched = await browser.relaunch();
      const second = rawPage(relaunched.pages()[0]);
      await second.goto(server.baseUrl);

      expect(await second.evaluate(() => document.cookie)).toContain('bos_persist=1');
    });
  });
});
