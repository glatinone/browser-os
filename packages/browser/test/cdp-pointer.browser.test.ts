import { type PageDriver, type PageHandle, resolveCss } from '@browser-os/browser';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '@browser-os/tests/helpers';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cdpClick } from '../src/driver/cdp-pointer.js';
// Type-only: `PageHandleImpl` is deliberately not public (rule 6).
import type { PageHandleImpl } from '../src/page-handle.js';

interface OpenPage {
  handle: PageHandle;
  raw: Page;
  driver: PageDriver;
}

let browser: TestBrowser;

beforeAll(async () => {
  browser = await launchTestBrowser();
});

afterAll(async () => {
  await browser.dispose();
});

async function openPage(): Promise<OpenPage> {
  const handle = await browser.handle().newPage();
  return { handle, raw: (handle as PageHandleImpl).raw(), driver: handle.driver() };
}

interface ShadowNode {
  nodeName?: string;
  backendNodeId?: number;
  attributes?: string[];
  children?: ShadowNode[];
  shadowRoots?: ShadowNode[];
}

/**
 * `DOM.querySelector` in this Chrome does not take the `>>>` combinator, so a target inside an
 * open shadow root is found by walking the pierced subtree instead.
 */
async function resolveInShadowRoot(transport: CdpTransport, hostCss: string, id: string): Promise<ResolvedTarget> {
  const host = await resolveCss(transport, hostCss);
  const described = (await transport.send('DOM.describeNode', {
    backendNodeId: host.backendNodeId,
    depth: -1,
    pierce: true,
  })) as { node?: ShadowNode };
  const backendNodeId = findById(described.node, id);
  if (backendNodeId === null) throw new Error(`no #${id} inside ${hostCss}`);
  return {
    ...host,
    backendNodeId,
    locator: { ...host.locator, tag: 'button', cssPath: `${hostCss} >>> #${id}` },
  };
}

function findById(node: ShadowNode | undefined, id: string): number | null {
  if (node === undefined) return null;
  const attributes = node.attributes ?? [];
  const at = attributes.indexOf('id');
  if (at !== -1 && attributes[at + 1] === id && node.backendNodeId !== undefined) {
    return node.backendNodeId;
  }
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findById(child, id);
    if (found !== null) return found;
  }
  return null;
}

/** What the fixture recorded for the last click, read straight from the page. */
async function recorded(raw: Page): Promise<string> {
  return (await raw.locator('#probe-log').textContent()) ?? '';
}

describe('DefaultPageDriver pointer input', () => {
  it('clicks the submit button and the form submits', async () => {
    await withFixtureServer(async (server) => {
      const { handle, driver } = await openPage();
      try {
        const before = `${server.baseUrl}/basic/`;
        await driver.navigate(before, 15000);
        const transport = await handle.cdp();

        const result = await driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Create account' } },
          await resolveCss(transport, 'button[type=submit]'),
        );

        expect(result.ok).toBe(true);
        expect(result.effect).toBe('committed');
        expect(result.urlBefore).toBe(before);
        expect(result.navigated).toBe(true);
        expect(result.urlAfter).toBe(`${server.baseUrl}/echo`);
      } finally {
        await handle.close();
      }
    });
  });

  it('reports a double click as a double click', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();

        const result = await driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Probe' }, clickCount: 2 },
          await resolveCss(transport, '#probe'),
        );

        expect(result.ok).toBe(true);
        expect(await recorded(raw)).toBe('dblclick');
      } finally {
        await handle.close();
      }
    });
  });

  it('dispatches the right button for a right click', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();

        const result = await driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Probe' }, button: 'right' },
          await resolveCss(transport, '#probe'),
        );

        expect(result.ok).toBe(true);
        // A right click opens a context menu; it is not a left click, so no `click` event.
        expect(await recorded(raw)).toBe('contextmenu');
      } finally {
        await handle.close();
      }
    });
  });

  it('scrolls a target into view before clicking it', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();
        const target = await resolveCss(transport, '#far-button');
        expect(await raw.evaluate('window.scrollY')).toBe(0);

        const result = await driver.cdpPerform({ type: 'click', target: { kind: 'intent', text: 'Far away' } }, target);

        expect(result.ok).toBe(true);
        expect(await raw.evaluate('window.scrollY')).toBeGreaterThan(0);
        expect(await recorded(raw)).toBe('far-click');
      } finally {
        await handle.close();
      }
    });
  });

  it('dispatches at a disabled button and reports nothing happened', async () => {
    await withFixtureServer(async (server) => {
      const { handle, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();

        const result = await driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Delete everything' } },
          await resolveCss(transport, 'button[disabled]'),
        );

        // Clicking a disabled control is not an error: the input is dispatched, the page
        // simply ignores it.
        expect(result.ok).toBe(true);
        expect(result.effect).toBe('committed');
        expect(result.navigated).toBe(false);
      } finally {
        await handle.close();
      }
    });
  });

  it('hovers a menu open', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw } = await openPage();
      try {
        const driver = handle.driver();
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();
        await expect(raw.locator('.menu-items').isVisible()).resolves.toBe(false);

        const result = await driver.cdpPerform(
          { type: 'hover', target: { kind: 'intent', text: 'More' } },
          await resolveCss(transport, '#menu-trigger'),
        );

        expect(result.ok).toBe(true);
        expect(result.effect).toBe('committed');
        // The renderer applies the hover a moment after the input event, so this is polled.
        await expect.poll(async () => raw.locator('.menu-items').isVisible(), { timeout: 3000 }).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });

  it('accepts a click on the label that protects a transparent checkbox', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();
        const target = await resolveCss(transport, '#switch');
        // The visible box belongs to the label; the input on top of it is transparent.
        expect(await raw.evaluate('document.querySelector(".switch label").getBoundingClientRect().width > 0')).toBe(
          true,
        );

        const result = await driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Enable the beta features' } },
          target,
        );

        expect(result.ok).toBe(true);
        expect(result.effect).toBe('committed');
        expect(await raw.locator('#switch').isChecked()).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });

  it('clicks a button inside an open shadow root', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/shadow/`, 15000);
        const transport = await handle.cdp();
        const target = await resolveInShadowRoot(transport, 'bos-panel', 'shadow-save');
        await raw.evaluate(
          'document.querySelector("bos-panel").shadowRoot.querySelector("#shadow-save").addEventListener("click", () => { document.title = "saved"; })',
        );

        const result = await driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Save nickname' } },
          target,
        );

        expect(result.ok).toBe(true);
        expect(result.effect).toBe('committed');
        expect(await raw.title()).toBe('saved');
      } finally {
        await handle.close();
      }
    });
  });

  it('refuses a target another element covers, and says nothing happened', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/overlay/`, 15000);
        const transport = await handle.cdp();
        // The fixture lifts the cover 800 ms after load; put it back so the target stays covered.
        await raw.evaluate('document.getElementById("cover").style.display = ""');

        const result = await driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Pay invoice' } },
          await resolveCss(transport, '#covered-button'),
        );

        expect(result.ok).toBe(false);
        expect(result.effect).toBe('none');
        expect(result.error?.code).toBe('TARGET_OBSCURED');
        // Nothing happened: the covered button never saw the click.
        expect(await raw.locator('#paid').isVisible()).toBe(false);
      } finally {
        await handle.close();
      }
    });
  });

  it('measures L4 once, for information', async () => {
    await withFixtureServer(async (server) => {
      const { handle, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();
        const target = await resolveCss(transport, '#probe');

        const started = performance.now();
        const result = await cdpClick(transport, target);
        const elapsed = performance.now() - started;

        console.log(
          `L4 cdp click dispatch: ${elapsed.toFixed(1)} ms (PERFORMANCE.md: p50 <= 15 ms, p95 <= 40 ms, report <= 80 ms)`,
        );
        expect(result.ok).toBe(true);
      } finally {
        await handle.close();
      }
    });
  });
});
