import type { PageDriver, PageHandle } from '@browser-os/browser';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '@browser-os/tests/helpers';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('DefaultPageDriver settle', () => {
  it('waits for the page to stop moving, then returns', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);

        // A page that keeps changing for 800 ms and then stops: settle has to outlast it rather
        // than call the first lull quiet.
        await page.raw.evaluate(`(() => {
          const stop = Date.now() + 800;
          const tick = () => {
            const mark = document.createElement('span');
            mark.textContent = 'x';
            document.body.appendChild(mark);
            if (Date.now() < stop) setTimeout(tick, 50);
          };
          tick();
        })()`);

        const started = Date.now();
        const settled = await page.driver.settle(200, 5000);
        const elapsed = Date.now() - started;

        expect(settled.capped).toBe(false);
        expect(elapsed).toBeGreaterThanOrEqual(600);
      } finally {
        await page.handle.close();
      }
    });
  });

  it('gives up on a page that never stops moving, at maxMs', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        // The fixture reorders its feed every second, forever. Asking for more quiet than the
        // interval can ever offer is the only way to make that page "never quiet" — with a
        // smaller quietMs it is genuinely quiet for most of every second, and rightly returns.
        await page.driver.navigate(`${server.baseUrl}/dynamic/`, 15000);

        const started = Date.now();
        const settled = await page.driver.settle(1500, 2500);
        const elapsed = Date.now() - started;

        expect(settled.capped).toBe(true);
        // The budget gates the work, so neither a poll nor a CDP read is added on top of it; what
        // is left is scheduler jitter, measured at 3-55 ms when nine browser files run at once on
        // this laptop. CI is quieter, so the allowance is an order of magnitude above that.
        expect(elapsed).toBeLessThanOrEqual(2500 + 100);
        expect(settled.waitedMs).toBeLessThanOrEqual(2500 + 100);
      } finally {
        await page.handle.close();
      }
    });
  });

  it('returns after quietMs on a page that is not moving', async () => {
    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);

        const started = Date.now();
        const settled = await page.driver.settle(150, 5000);
        const elapsed = Date.now() - started;

        expect(settled.capped).toBe(false);
        // Quiet time plus the poll, not the whole budget.
        expect(elapsed).toBeLessThan(150 + 500);
        expect(elapsed).toBeGreaterThanOrEqual(150);
      } finally {
        await page.handle.close();
      }
    });
  });
});
