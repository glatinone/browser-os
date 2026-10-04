import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '@browser-os/tests/helpers';
import type { Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IsolatedWorlds } from '../src/cdp/isolated-worlds.js';
import type { CdpTransport } from '../src/cdp/transport.js';
import type { PageHandle } from '../src/page-handle.js';
import { rawFirstPage } from './support/raw-page.js';

async function mainFrameId(transport: CdpTransport): Promise<string> {
  const tree = (await transport.send('Page.getFrameTree')) as {
    frameTree?: { frame?: { id?: string } };
  };
  const id = tree.frameTree?.frame?.id;
  if (typeof id !== 'string') throw new Error('Page.getFrameTree returned no main frame id');
  return id;
}

describe('CDP and isolated worlds (browser)', () => {
  let browser: TestBrowser;
  let handle: PageHandle;
  let page: Page;

  beforeEach(async () => {
    browser = await launchTestBrowser();
    const first = browser.handle().pages()[0];
    if (first === undefined) throw new Error('the launched browser has no page');
    handle = first;
    page = rawFirstPage(browser.handle());
  });

  afterEach(async () => {
    await browser.dispose();
  });

  it('creates the CDP session once per page', async () => {
    const first = await handle.cdp();

    expect(await handle.cdp()).toBe(first);
  });

  it('never enables the Runtime domain (S19)', async () => {
    const transport = await handle.cdp();
    const leaked: unknown[] = [];
    transport.on('Runtime.executionContextCreated', (payload) => {
      leaked.push(payload);
    });

    // Control: the same subscription on a session that does enable the domain fires, so the
    // assertion below cannot be passing merely because the event never arrives at all.
    const control = await page.context().newCDPSession(page);
    const controlEvents: unknown[] = [];
    control.on('Runtime.executionContextCreated', (payload) => {
      controlEvents.push(payload);
    });
    await control.send('Runtime.enable');

    await withFixtureServer(async (server) => {
      await page.goto(`${server.baseUrl}/basic/index.html`);
    });

    expect(controlEvents.length).toBeGreaterThan(0);
    expect(leaked).toEqual([]);
    await control.detach();
  });

  it('puts __bos in the bos world and nowhere else (S19)', async () => {
    const transport = await handle.cdp();
    const worlds = new IsolatedWorlds(transport);
    const frameId = await mainFrameId(transport);

    expect(typeof (await worlds.get(frameId))).toBe('number');
    expect(await worlds.mutationCount(frameId)).toBe(0);

    const inMainWorld = await page.evaluate(() => typeof (globalThis as unknown as { __bos?: unknown }).__bos);
    expect(inMainWorld).toBe('undefined');
  });

  it('counts DOM mutations made from the page', async () => {
    const transport = await handle.cdp();
    const worlds = new IsolatedWorlds(transport);
    const frameId = await mainFrameId(transport);
    const before = await worlds.mutationCount(frameId);

    await page.evaluate(() => {
      document.body.append(document.createElement('div'));
    });

    await expect.poll(async () => await worlds.mutationCount(frameId), { timeout: 5000 }).toBeGreaterThan(before);
  });

  it('builds a fresh world after a navigation', async () => {
    const transport = await handle.cdp();
    const worlds = new IsolatedWorlds(transport);
    const firstFrame = await mainFrameId(transport);
    const firstWorld = await worlds.get(firstFrame);
    await page.evaluate(() => {
      document.body.append(document.createElement('div'));
    });
    await expect.poll(async () => await worlds.mutationCount(firstFrame), { timeout: 5000 }).toBeGreaterThan(0);

    await withFixtureServer(async (server) => {
      await page.goto(`${server.baseUrl}/basic/index.html`);
    });

    // Same frame, new document: the cached id belonged to the document that just went away.
    const secondFrame = await mainFrameId(transport);
    const secondWorld = await worlds.get(secondFrame);

    expect(secondWorld).not.toBe(firstWorld);
    expect(await worlds.mutationCount(secondFrame)).toBe(0);
  });
});

// No browser needed, but the card files this guard with the CDP tests.
describe('CDP source guards', () => {
  it('asks the browser for no runtime domain (S19)', async () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const files = (await readdir(srcDir, { recursive: true })).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of files) {
      const text = await readFile(path.join(srcDir, name), 'utf8');
      if (/Runtime\.enable/.test(text)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });
});
