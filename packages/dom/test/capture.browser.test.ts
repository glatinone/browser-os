import { buildObservation, captureRaw } from '@browser-os/dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withFixtureServer } from '../../../tests/helpers/index.js';
import { launchTestBrowser, type TestBrowser } from '../../../tests/helpers/launch-test-browser.js';

let browser: TestBrowser;

beforeAll(async () => {
  browser = await launchTestBrowser();
});

afterAll(async () => {
  await browser.dispose();
});

describe('captureRaw', () => {
  it('captures nodes, layout and AX for the main frame on basic', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/basic/`, 15_000);
        await driver.settle(100, 5_000);

        const raw = await captureRaw(await handle.cdp());
        const mainFrameId = raw.frames[0]?.id;

        expect(raw.documents.length).toBeGreaterThan(0);
        expect(raw.documents[0]?.nodes.length).toBeGreaterThan(5);
        expect(raw.documents[0]?.layout.length).toBeGreaterThan(0);
        expect(raw.frames.length).toBe(1);
        expect(raw.viewport.width).toBeGreaterThan(0);
        expect(raw.viewport.height).toBeGreaterThan(0);

        const mainAx = raw.axTrees.find((tree) => tree.frameId === mainFrameId);
        expect(mainAx).toBeDefined();
        expect(mainAx?.nodes.length).toBeGreaterThan(0);
        // Some AX nodes are synthetic and intentionally have no DOM join key.
        expect(mainAx?.nodes.some((node) => node.backendDOMNodeId > 0)).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });

  it('captures the iframe child document and its AX tree', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/iframe/`, 15_000);
        await driver.settle(100, 5_000);

        const raw = await captureRaw(await handle.cdp());
        const mainFrameId = raw.frames[0]?.id;
        expect(raw.frames.length).toBeGreaterThan(1);

        const childFrames = raw.frames.filter((frame) => frame.id !== mainFrameId);
        expect(childFrames.length).toBeGreaterThan(0);

        // The child document is inlined in the snapshot with its own frameId.
        const childDocuments = raw.documents.filter((doc) => doc.frameId !== undefined && doc.frameId !== mainFrameId);
        expect(childDocuments.length).toBeGreaterThan(0);

        // The child frame has a non-empty AX tree.
        const childAx = raw.axTrees.filter((tree) => tree.frameId !== mainFrameId && tree.nodes.length > 0);
        expect(childAx.length).toBeGreaterThan(0);
      } finally {
        await handle.close();
      }
    });
  });

  it('omits a timed-out AX frame with a warning while keeping the main capture', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/iframe/`, 15_000);
        await driver.settle(100, 5_000);

        const raw = await captureRaw(await handle.cdp(), { frameAxTimeoutMs: 0 });
        const mainFrameId = raw.frames[0]?.id;

        // The snapshot/documents part of the capture is unaffected by AX timeouts.
        expect(raw.documents.length).toBeGreaterThan(0);
        expect(raw.documents[0]?.nodes.length).toBeGreaterThan(5);

        // Every non-main frame timed out and was omitted with a warning naming it.
        const childFrameIds = raw.frames.filter((frame) => frame.id !== mainFrameId).map((frame) => frame.id);
        for (const frameId of childFrameIds) {
          const ax = raw.axTrees.find((tree) => tree.frameId === frameId);
          expect(ax?.nodes.length ?? 0).toBe(0);
          expect(raw.warnings.some((warning) => warning.includes(frameId))).toBe(true);
        }
      } finally {
        await handle.close();
      }
    });
  });

  it('serializes a live basic capture to the same element contract as the golden', async () => {
    await withFixtureServer(async (server) => {
      const handle = await browser.handle().newPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/basic/`, 15_000);
        await driver.settle(100, 5_000);

        const raw = await captureRaw(await handle.cdp());
        const { observation } = buildObservation(raw, {
          url: `${server.baseUrl}/basic/`,
          title: 'Basic form page',
        });
        const signature = observation.elements.map((element) => `${element.role} ${element.name}`);
        for (const expected of [
          'link Home',
          'link Docs',
          'button More',
          'button Settings',
          'textbox Full name',
          'combobox Country',
          'radio Yearly',
          'checkbox Send me the newsletter',
          'button Create account',
          'button Delete everything',
        ]) {
          expect(signature).toContain(expected);
        }
        expect(observation.elements.some((element) => element.state.disabled)).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });
});
