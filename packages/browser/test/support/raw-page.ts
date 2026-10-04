import type { Page } from 'playwright-core';
import type { PageHandle } from '../../src/page-handle.js';

/**
 * The raw Playwright page behind a page handle, for tests inside this package.
 *
 * Duck-typed rather than `instanceof`: a workspace package can be loaded through two module
 * graphs in one Vitest run (Vite's pipeline and Node's ESM loader), which yields two distinct
 * `PageHandleImpl` classes for the same file. Shape is the stable contract here.
 */
export function rawPage(handle: PageHandle | undefined): Page {
  if (handle === undefined) throw new Error('the handle has no page');
  const page = (handle as { raw?: () => Page }).raw?.();
  if (page === undefined) {
    throw new Error('this page handle does not expose the raw Playwright page');
  }
  return page;
}

/** The first page of a browser handle as a raw Playwright page. */
export function rawFirstPage(browser: { pages(): PageHandle[] }): Page {
  return rawPage(browser.pages()[0]);
}
