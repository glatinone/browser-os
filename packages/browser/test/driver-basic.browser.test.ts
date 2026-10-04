import { createServer } from 'node:net';
import { type PageDriver, type PageHandle, resolveCss } from '@browser-os/browser';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '@browser-os/tests/helpers';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Type-only: `PageHandleImpl` is deliberately not public (rule 6), and a type import adds no
// runtime module, so there is no second constructor to confuse `instanceof` with.
import type { PageHandleImpl } from '../src/page-handle.js';

interface OpenPage {
  handle: PageHandle;
  /** The raw Playwright page, for the parts of a test the driver does not own. */
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

/** A fresh page of the shared browser. Close it when the test is done with it. */
async function openPage(): Promise<OpenPage> {
  const handle = await browser.handle().newPage();
  return { handle, raw: (handle as PageHandleImpl).raw(), driver: handle.driver() };
}

/** The url of a port nobody is listening on: bind one, note it, let it go. */
async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/`;
}

describe('DefaultPageDriver navigation', () => {
  it('navigates to the fixture and reports where it landed', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        const target = `${server.baseUrl}/basic/`;

        const result = await driver.navigate(target, 15000);

        expect(result.ok).toBe(true);
        expect(result.navigated).toBe(true);
        expect(result.effect).toBe('committed');
        expect(result.urlBefore).toBe('about:blank');
        expect(result.urlAfter).toBe(target);
        expect(raw.url()).toBe(target);
      } finally {
        await handle.close();
      }
    });
  });

  it('refuses a url it cannot send, and says so before anything happens', async () => {
    const { handle, driver } = await openPage();
    try {
      const result = await driver.navigate('not a url', 5000);

      expect(result.ok).toBe(false);
      expect(result.effect).toBe('none');
      expect(result.navigated).toBe(false);
      expect(result.error?.code).toBe('NAVIGATION_FAILED');
    } finally {
      await handle.close();
    }
  });

  it('reports a navigation nothing answers as failed, not as empty', async () => {
    const { handle, driver } = await openPage();
    try {
      const result = await driver.navigate(await closedPortUrl(), 15000);

      expect(result.ok).toBe(false);
      expect(result.effect).toBe('unknown');
      expect(result.navigated).toBe(false);
      expect(result.error?.code).toBe('NAVIGATION_FAILED');
    } finally {
      await handle.close();
    }
  });
});

describe('DefaultPageDriver reading and extraction', () => {
  it('reads the value a control holds, as the page sees it', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        // Typed through Playwright on purpose: the driver has to agree with what the page holds,
        // whichever path put it there.
        await raw.fill('#name', 'Ada Lovelace');
        await raw.selectOption('#country', 'id');
        await raw.check('#newsletter');
        const transport = await handle.cdp();

        expect(await driver.readValue(await resolveCss(transport, '#name'))).toBe('Ada Lovelace');
        expect(await driver.readValue(await resolveCss(transport, '#country'))).toBe('id');
        expect(await driver.readValue(await resolveCss(transport, '#newsletter'))).toBe('true');
        // Untouched, it is false rather than empty.
        expect(await driver.readValue(await resolveCss(transport, '#terms'))).toBe('false');
      } finally {
        await handle.close();
      }
    });
  });

  it('extracts the text of a target and of the document', async () => {
    await withFixtureServer(async (server) => {
      const { handle, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();

        const page = (await driver.extract(null, 'text')) as string;
        expect(page).toContain('Create your account');
        expect(page).toContain('Full name');
        expect(page.length).toBeLessThanOrEqual(20_000);

        // A targeted extraction is scoped to the target.
        const main = (await driver.extract(await resolveCss(transport, 'main'), 'text')) as string;
        expect(main).toContain('Create your account');
        expect(main).not.toContain('Pricing');
      } finally {
        await handle.close();
      }
    });
  });

  it('extracts links with their text and absolute href', async () => {
    await withFixtureServer(async (server) => {
      const { handle, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const transport = await handle.cdp();

        const links = (await driver.extract(null, 'links')) as { text: string; href: string }[];
        // The hover menu's items are anchors as well, and they are included: the format reports
        // the links a page has, not only the ones it happens to be showing (§5).
        expect(links.map((link) => link.text)).toEqual([
          'Home',
          'Docs',
          'Pricing',
          'Contact',
          'Account',
          'Billing',
        ]);
        expect(links[0]?.href).toBe(`${server.baseUrl}/basic/`);
        expect(links[1]?.href).toBe(`${server.baseUrl}/basic/docs`);

        // The nav lives outside <main>, so a scoped extraction does not see it.
        const scoped = (await driver.extract(await resolveCss(transport, 'main'), 'links')) as unknown[];
        expect(scoped).toEqual([]);
      } finally {
        await handle.close();
      }
    });
  });

  it('extracts the first table as rows, and nothing when there is no table', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        expect(await driver.extract(null, 'table')).toEqual([]);

        await raw.setContent('<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Monthly</td><td>9</td></tr></table>');

        expect(await driver.extract(null, 'table')).toEqual([
          ['Plan', 'Price'],
          ['Monthly', '9'],
        ]);
      } finally {
        await handle.close();
      }
    });
  });

  it('keeps its page-side javascript in the bos world', async () => {
    await withFixtureServer(async (server) => {
      const { handle, raw, driver } = await openPage();
      try {
        await driver.navigate(`${server.baseUrl}/basic/`, 15000);
        // Use the world first, so this asserts "not visible" and not "not created yet".
        expect(await driver.extract(null, 'text')).toContain('Create your account');

        // Playwright's evaluate runs in the page's own world.
        expect(await raw.evaluate('typeof window.__bos')).toBe('undefined');
      } finally {
        await handle.close();
      }
    });
  });
});
