import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type PageDriver, type PageHandle, resolveCss } from '@browser-os/browser';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '@browser-os/tests/helpers';
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enableDownloads, sanitizeFileName } from '../src/driver/files.js';
// Type-only: `PageHandleImpl` is deliberately not public (rule 6).
import type { PageHandleImpl } from '../src/page-handle.js';

interface OpenPage {
  handle: PageHandle;
  raw: Page;
  driver: PageDriver;
}

let browser: TestBrowser;
let workDir: string;

beforeAll(async () => {
  browser = await launchTestBrowser();
});

afterAll(async () => {
  await browser.dispose();
});

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'bos-files-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function openPage(): Promise<OpenPage> {
  const handle = await browser.handle().newPage();
  return { handle, raw: (handle as PageHandleImpl).raw(), driver: handle.driver() };
}

/** Reads a file, or nothing if it is not there yet (or still being written). */
async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** Clicks a link the page never had, so the fixture's own links stay as they are. */
async function clickDownloadLink(raw: Page, href: string): Promise<void> {
  await raw.evaluate(`(() => {
    const link = document.createElement('a');
    link.href = ${JSON.stringify(href)};
    link.textContent = 'download';
    document.body.appendChild(link);
    link.click();
  })()`);
}

describe('sanitizeFileName', () => {
  it('strips what would let a page choose where its file lands', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('..\\..\\windows\\system32\\evil.exe')).toBe('_.._windows_system32_evil.exe');
    expect(sanitizeFileName('/absolute/path.txt')).toBe('_absolute_path.txt');
  });

  it('strips control characters, which is how a name gets truncated in a shell', () => {
    expect(sanitizeFileName('invoice\u0000.txt')).toBe('invoice.txt');
    expect(sanitizeFileName('a\nb\rc.txt')).toBe('abc.txt');
    expect(sanitizeFileName('tab\tname.txt')).toBe('tabname.txt');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFileName('...')).toBe('download');
    expect(sanitizeFileName('   ')).toBe('download');
  });

  it('leaves an ordinary name alone', () => {
    expect(sanitizeFileName('quarterly report (final).pdf')).toBe('quarterly report (final).pdf');
  });
});

describe('DefaultPageDriver files', () => {
  it('uploads the files it is given', async () => {
    const document = path.join(workDir, 'contract.txt');
    await writeFile(document, 'signed\n', 'utf8');

    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/upload/`, 15000);
        const transport = await page.handle.cdp();

        const result = await page.driver.uploadFiles(await resolveCss(transport, '#file'), [document]);

        expect(result.ok).toBe(true);
        expect(result.effect).toBe('committed');
        expect(await page.raw.evaluate('document.querySelector("#file").files[0].name')).toBe('contract.txt');

        // The fixture echoes the name once the form is submitted.
        const submit = await page.driver.cdpPerform(
          { type: 'click', target: { kind: 'intent', text: 'Upload' } },
          await resolveCss(transport, 'button[type=submit]'),
        );
        expect(submit.ok).toBe(true);
        expect(await page.raw.locator('#echo-name').textContent()).toBe('contract.txt');
      } finally {
        await page.handle.close();
      }
    });
  });

  it('saves a download where it is told, and numbers a second one', async () => {
    const saved: string[] = [];

    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const detach = enableDownloads(page.raw, workDir, (download) => saved.push(download.path));

        await clickDownloadLink(page.raw, `${server.baseUrl}/download/sample.txt`);
        // The file appears before it is finished, so the content is what is waited for.
        await expect
          .poll(async () => await readText(path.join(workDir, 'sample.txt')), { timeout: 5000 })
          .toContain('browser-os fixture');

        expect(await readdir(workDir)).toEqual(['sample.txt']);

        await clickDownloadLink(page.raw, `${server.baseUrl}/download/sample.txt`);
        await expect
          .poll(async () => await readText(path.join(workDir, 'sample (1).txt')), { timeout: 5000 })
          .toContain('browser-os fixture');

        expect((await readdir(workDir)).sort()).toEqual(['sample (1).txt', 'sample.txt']);
        expect(saved).toHaveLength(2);

        detach();
      } finally {
        await page.handle.close();
      }
    });
  });

  it('writes nothing anywhere until downloads are enabled', async () => {
    let told = 0;

    await withFixtureServer(async (server) => {
      const page = await openPage();
      try {
        await page.driver.navigate(`${server.baseUrl}/basic/`, 15000);
        const detach = enableDownloads(page.raw, null, () => {
          told += 1;
        });

        await clickDownloadLink(page.raw, `${server.baseUrl}/download/sample.txt`);
        // Give the page the same window the enabled case needs, then check nothing was written.
        await new Promise((resolve) => setTimeout(resolve, 750));

        expect(await readdir(workDir)).toEqual([]);
        expect(told).toBe(0);
        detach();
      } finally {
        await page.handle.close();
      }
    });
  });
});
