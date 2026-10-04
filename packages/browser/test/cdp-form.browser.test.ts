import { type CdpTransport, type PageDriver, type PageHandle, resolveCss } from '@browser-os/browser';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '@browser-os/tests/helpers';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Type-only: `PageHandleImpl` is deliberately not public (rule 6).
import type { PageHandleImpl } from '../src/page-handle.js';

interface OpenPage {
  handle: PageHandle;
  raw: Page;
  driver: PageDriver;
  transport: CdpTransport;
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
  return {
    handle,
    raw: (handle as PageHandleImpl).raw(),
    driver: handle.driver(),
    transport: await handle.cdp(),
  };
}

/** Fills through the executor, the way the router would. */
async function fill(page: OpenPage, css: string, value: string, submit = false) {
  const target = await resolveCss(page.transport, css);
  return await page.driver.cdpPerform({ type: 'fill', target: { kind: 'intent', text: css }, submit }, target, value);
}

describe('DefaultPageDriver form input', () => {
  it('fills an input, a textarea and a contenteditable', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        expect((await fill(page, '#name', 'Ada Lovelace')).ok).toBe(true);
        expect(await page.driver.readValue(await resolveCss(page.transport, '#name'))).toBe('Ada Lovelace');

        expect((await fill(page, '#notes', 'Two lines')).ok).toBe(true);
        expect(await page.driver.readValue(await resolveCss(page.transport, '#notes'))).toBe('Two lines');

        await page.driver.navigate(`${server.baseUrl}/contenteditable/`, 15000);
        const editor = await resolveCss(page.transport, '#editor');
        expect(await page.driver.readValue(editor)).toContain('Hello');
        expect((await fill(page, '#editor', 'Rewritten')).ok).toBe(true);
        expect(await page.driver.readValue(editor)).toBe('Rewritten');
      } finally {
        await page.handle.close();
      }
    });
  });

  it('fills a field that re-renders itself, and one only the native setter reaches', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);

        const controlled = await fill(page, '#controlled', 'From the driver');
        expect(controlled.ok).toBe(true);
        // The field writes its own state back on a timer, so a value that survived is a value it
        // was told about.
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(await page.driver.readValue(await resolveCss(page.transport, '#controlled'))).toBe('From the driver');

        // `readonly` refuses inserted text, which is exactly what the native-setter path is for.
        const locked = await fill(page, '#locked', 'Set anyway');
        expect(locked.ok).toBe(true);
        expect(locked.effect).toBe('committed');
        expect(await page.driver.readValue(await resolveCss(page.transport, '#locked'))).toBe('Set anyway');
      } finally {
        await page.handle.close();
      }
    });
  });

  it('submits the form when the fill asks for it', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const target = await resolveCss(page.transport, '#name');

        const result = await page.driver.cdpPerform(
          { type: 'fill', target: { kind: 'intent', text: 'the full name field' }, submit: true },
          target,
          'Ada',
        );

        expect(result.ok).toBe(true);
        expect(result.effect).toBe('committed');
        expect(result.navigated).toBe(true);
        expect(result.urlAfter).toBe(`${server.baseUrl}/echo`);
      } finally {
        await page.handle.close();
      }
    });
  });

  it('presses key combinations', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        await fill(page, '#name', 'Ada Lovelace');
        const name = await resolveCss(page.transport, '#name');

        // Control+A then Delete is only meaningful if the modifier mask reaches the browser.
        const selectAll = await page.driver.cdpPerform({ type: 'press', key: 'Control+A' }, name);
        expect(selectAll.ok).toBe(true);
        // The whole value is selected, whatever its length.
        expect(
          await page.raw.evaluate(
            'const field = document.querySelector("#name"); field.selectionEnd - field.selectionStart',
          ),
        ).toBe('Ada Lovelace'.length);

        expect((await page.driver.cdpPerform({ type: 'press', key: 'Delete' }, name)).ok).toBe(true);
        expect(await page.driver.readValue(name)).toBe('');

        expect(
          (await page.driver.cdpPerform({ type: 'press', key: 'NotAKey', target: { kind: 'intent', text: 'x' } }, name))
            .error?.code,
        ).toBe('INVALID_REQUEST');
      } finally {
        await page.handle.close();
      }
    });
  });

  it('selects an option by value and by label', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const country = await resolveCss(page.transport, '#country');

        const byValue = await page.driver.cdpPerform(
          { type: 'select', target: { kind: 'intent', text: 'the country dropdown' } },
          country,
          'id',
        );
        expect(byValue.ok).toBe(true);
        expect(await page.driver.readValue(country)).toBe('id');

        // The label, trimmed and case-insensitive, as a person would say it.
        const byLabel = await page.driver.cdpPerform(
          { type: 'select', target: { kind: 'intent', text: 'the country dropdown' } },
          country,
          '  japan ',
        );
        expect(byLabel.ok).toBe(true);
        expect(await page.driver.readValue(country)).toBe('jp');

        const missing = await page.driver.cdpPerform(
          { type: 'select', target: { kind: 'intent', text: 'the country dropdown' } },
          country,
          'atlantis',
        );
        expect(missing.ok).toBe(false);
        expect(missing.effect).toBe('none');
        expect(missing.error?.code).toBe('TARGET_NOT_FOUND');
      } finally {
        await page.handle.close();
      }
    });
  });

  it('scrolls the page, with and without a target', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        expect(await page.raw.evaluate('window.scrollY')).toBe(0);

        const down = await page.driver.cdpPerform({ type: 'scroll', direction: 'down' }, null);
        expect(down.ok).toBe(true);
        const afterWheel = await page.raw.evaluate('window.scrollY');
        expect(afterWheel).toBeGreaterThan(0);

        const up = await page.driver.cdpPerform({ type: 'scroll', direction: 'up' }, null);
        expect(up.ok).toBe(true);
        expect(await page.raw.evaluate('window.scrollY')).toBe(0);

        // A scroll to a target takes the geometry path and needs no hit-test: the point only has
        // to be on screen.
        const far = await resolveCss(page.transport, '#far-button');
        const toTarget = await page.driver.cdpPerform(
          { type: 'scroll', target: { kind: 'intent', text: 'Far away' }, direction: 'down' },
          far,
        );
        expect(toTarget.ok).toBe(true);
        expect(await page.raw.evaluate('window.scrollY')).toBeGreaterThan(0);
      } finally {
        await page.handle.close();
      }
    });
  });
});
