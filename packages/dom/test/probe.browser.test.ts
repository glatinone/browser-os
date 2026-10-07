import { PROBE_HELPER_SOURCE, probe } from '@browser-os/dom';
import type { ElementLocator } from '@browser-os/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CountingCdpTransport,
  IsolatedWorlds,
  launchTestBrowser,
  type TestBrowser,
  withFixtureServer,
} from '../../../tests/helpers/index.js';

let browser: TestBrowser;

beforeAll(async () => {
  browser = await launchTestBrowser();
});

afterAll(async () => {
  await browser.dispose();
}, 30000);

function makeLocator(partial: Partial<ElementLocator>): ElementLocator {
  return {
    v: 1,
    role: 'button',
    name: 'Submit',
    nameIsDynamic: false,
    tag: 'button',
    attrs: {},
    context: [],
    cssPath: '',
    framePath: [],
    ordinal: 0,
    ...partial,
  };
}

describe('probe', () => {
  it('probes search box on spa by data-testid="search-input" with round-trip budget <= 4', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/spa/`, 15000);
        await driver.settle(100, 5000);

        const rawCdp = await handle.cdp();
        const tree = (await rawCdp.send('Page.getFrameTree', {})) as {
          frameTree: { frame: { id: string } };
        };
        const mainFrameId = tree.frameTree.frame.id;

        const counting = new CountingCdpTransport(rawCdp);
        const worlds = new IsolatedWorlds(counting);
        worlds.registerHelper('probe', PROBE_HELPER_SOURCE);

        const locator = makeLocator({
          role: 'combobox',
          name: 'Search people',
          tag: 'input',
          attrs: { 'data-testid': 'search-input' },
          cssPath: '#q',
        });

        // Warm up / ensure world is ready
        await worlds.get(mainFrameId);
        counting.reset();

        const started = performance.now();
        const candidates = await probe(counting, worlds, mainFrameId, locator);
        const elapsed = performance.now() - started;

        console.log(`L11 probe latency: ${elapsed.toFixed(2)} ms`);

        expect(candidates).toHaveLength(1);
        const cand = candidates[0];
        expect(cand?.backendNodeId).toBeGreaterThan(0);
        expect(cand?.name).toBe('Search people');
        expect(cand?.rect).not.toBeNull();
        expect(cand?.rect?.w).toBeGreaterThan(0);

        const counts = counting.counts();
        const total = counting.total();

        // Single-candidate round-trip budget <= 4:
        // Exactly: 1 Runtime.callFunctionOn + 1 parallel batch (DOM.describeNode, Accessibility.getPartialAXTree, DOM.getBoxModel)
        expect(total).toBeLessThanOrEqual(4);
        expect(counts['Runtime.callFunctionOn']).toBe(1);
        expect(counts['DOM.describeNode']).toBe(1);
        expect(counts['Accessibility.getPartialAXTree']).toBe(1);
        expect(counts['DOM.getBoxModel']).toBe(1);
      } finally {
        await handle.close();
      }
    });
  });

  it('probes element by name attribute', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/spa/`, 15000);
        await driver.settle(100, 5000);

        const cdp = await handle.cdp();
        const worlds = new IsolatedWorlds(cdp);
        worlds.registerHelper('probe', PROBE_HELPER_SOURCE);

        const locator = makeLocator({
          role: 'combobox',
          name: 'Search people',
          tag: 'input',
          attrs: { name: 'q' },
          cssPath: '',
        });

        const candidates = await probe(cdp, worlds, locator);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.backendNodeId).toBeGreaterThan(0);
        expect(candidates[0]?.attrs?.name).toBe('q');
      } finally {
        await handle.close();
      }
    });
  });

  it('probes element by cssPath only', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/spa/`, 15000);
        await driver.settle(100, 5000);

        const cdp = await handle.cdp();
        const worlds = new IsolatedWorlds(cdp);
        worlds.registerHelper('probe', PROBE_HELPER_SOURCE);

        const locator = makeLocator({
          role: 'combobox',
          name: '',
          tag: 'input',
          attrs: {},
          cssPath: '#q',
        });

        const candidates = await probe(cdp, worlds, locator);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.backendNodeId).toBeGreaterThan(0);
      } finally {
        await handle.close();
      }
    });
  });

  it('probes inside open shadow DOM via >>>', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/shadow/`, 15000);
        await driver.settle(100, 5000);

        const cdp = await handle.cdp();
        const worlds = new IsolatedWorlds(cdp);
        worlds.registerHelper('probe', PROBE_HELPER_SOURCE);

        const locator = makeLocator({
          role: 'button',
          name: 'Save nickname',
          tag: 'button',
          attrs: {},
          cssPath: 'main > bos-panel >>> section > button',
        });

        const candidates = await probe(cdp, worlds, locator);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.backendNodeId).toBeGreaterThan(0);
        expect(candidates[0]?.name).toBe('Save nickname');
      } finally {
        await handle.close();
      }
    });
  });

  it('returns multiple candidates on ambiguous cssPath', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/spa/`, 15000);
        await driver.settle(100, 5000);

        const cdp = await handle.cdp();
        const worlds = new IsolatedWorlds(cdp);
        worlds.registerHelper('probe', PROBE_HELPER_SOURCE);

        const locator = makeLocator({
          role: 'link',
          name: '',
          tag: 'a',
          attrs: {},
          cssPath: 'nav a',
        });

        const candidates = await probe(cdp, worlds, locator);
        expect(candidates.length).toBeGreaterThan(1);
        expect(candidates.length).toBeLessThanOrEqual(5);
      } finally {
        await handle.close();
      }
    });
  });

  it('returns empty array when framePath is non-empty', async () => {
    await withFixtureServer(async (_server) => {
      const handle = await browser.handle().newPage();
      try {
        const cdp = await handle.cdp();
        const counting = new CountingCdpTransport(cdp);
        const worlds = new IsolatedWorlds(counting);

        const locator = makeLocator({
          framePath: ['iframe[name="subframe"]'],
          cssPath: '#btn',
        });

        const candidates = await probe(counting, worlds, locator);
        expect(candidates).toEqual([]);
        expect(counting.total()).toBe(0);
      } finally {
        await handle.close();
      }
    });
  });
});
