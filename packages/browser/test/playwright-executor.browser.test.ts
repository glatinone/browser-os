import { type PageDriver, type PageHandle, resolveCss } from '@browser-os/browser';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '@browser-os/tests/helpers';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playwrightPerform } from '../src/driver/playwright-executor.js';
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
}, 30000);

async function openPage(): Promise<OpenPage> {
  const handle = await browser.handle().newPage();
  return { handle, raw: (handle as PageHandleImpl).raw(), driver: handle.driver() };
}

describe('playwrightPerform', () => {
  it('clicks a target the CDP path refuses, once the cover goes away', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/overlay/`, 15000);
        const transport = await page.handle.cdp();
        const target = await resolveCss(transport, '#covered-button');
        // The fixture lifts the cover on a timer that has long since fired.
        await page.raw.evaluate('document.getElementById("cover").style.display = ""');

        // The CDP executor refuses this one: something is on top of it.
        const refused = await page.driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Pay invoice' } },
          target,
        );
        expect(refused.ok).toBe(false);
        expect(refused.effect).toBe('none');

        // Once the cover is gone the same click goes through.
        await page.raw.evaluate('document.getElementById("cover").style.display = "none"');
        const clicked = await playwrightPerform(
          page.raw,
          { type: 'click', target: { kind: 'intent', text: 'Pay invoice' } },
          target,
        );

        expect(clicked.ok).toBe(true);
        expect(clicked.effect).toBe('committed');
        expect(await page.raw.locator('#paid').isVisible()).toBe(true);
      } finally {
        await page.handle.close();
      }
    });
  });

  it('fills and selects through Playwright', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await page.handle.cdp();

        const filled = await playwrightPerform(
          page.raw,
          { type: 'fill', target: { kind: 'intent', text: 'the full name field' } },
          await resolveCss(transport, '#name'),
          'Ada Lovelace',
        );
        expect(filled.ok).toBe(true);
        expect(await page.raw.inputValue('#name')).toBe('Ada Lovelace');

        const selected = await playwrightPerform(
          page.raw,
          { type: 'select', target: { kind: 'intent', text: 'the country dropdown' } },
          await resolveCss(transport, '#country'),
          'Singapore',
        );
        expect(selected.ok).toBe(true);
        expect(await page.raw.inputValue('#country')).toBe('sg');
      } finally {
        await page.handle.close();
      }
    });
  });

  it('presses a key on the page when there is no target', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        await page.raw.focus('#name');

        const pressed = await playwrightPerform(page.raw, { type: 'press', key: 'X' }, null);

        expect(pressed.ok).toBe(true);
        expect(await page.raw.inputValue('#name')).toBe('X');
      } finally {
        await page.handle.close();
      }
    });
  });

  it('reports a target Playwright never reached as nothing having happened', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/overlay/`, 15000);
        const transport = await page.handle.cdp();
        // Present in the DOM, never visible, so Playwright waits and gives up.
        const hidden = await resolveCss(transport, '#paid');

        const result = await playwrightPerform(
          page.raw,
          { type: 'click', target: { kind: 'intent', text: 'Paid' } },
          hidden,
        );

        expect(result.ok).toBe(false);
        expect(result.effect).toBe('none');
        expect(result.error?.code).toBe('TARGET_NOT_INTERACTABLE');
      } finally {
        await page.handle.close();
      }
    });
  });
});
