// Page bookkeeping shared by the providers (browser-runtime §2).
//
// Internal: `track()` takes a Playwright `Page`, so this module is not re-exported from
// `src/index.ts`.

import type { BrowserContext, Page } from 'playwright-core';
import { type PageHandle, PageHandleImpl } from './page-handle.js';

/**
 * Every provider does the same three things with pages: wrap each Playwright page exactly
 * once in a `PageHandleImpl`, keep them in the order they appeared, and tell listeners about
 * new ones. Only the provider knows what "the connection went away" means, so raising that
 * signal stays with the provider — this class just makes sure it is raised once.
 */
export class PageRegistry {
  private readonly pagesById = new Map<string, PageHandleImpl>();
  /** Keyed by the Playwright page so a page is never wrapped twice. */
  private readonly byPage = new WeakMap<Page, PageHandleImpl>();
  private readonly pageCallbacks = new Set<(page: PageHandle) => void>();
  private readonly disconnectedCallbacks = new Set<(reason: string) => void>();
  private disconnected = false;

  constructor(initialPages: readonly Page[] = []) {
    for (const page of initialPages) this.track(page);
  }

  pages(): PageHandle[] {
    return [...this.pagesById.values()];
  }

  /** Wraps `page` if it is new, notifies `onPage` listeners, and returns its handle. */
  track(page: Page): PageHandleImpl {
    const existing = this.byPage.get(page);
    if (existing !== undefined) return existing;

    const handle = new PageHandleImpl(page);
    this.byPage.set(page, handle);
    this.pagesById.set(handle.id, handle);
    handle.onClose(() => this.pagesById.delete(handle.id));

    // `opener()` is async where `PageHandle.opener()` must be sync, so resolve it once in
    // the background. A page that never gets an opener simply stays null.
    void page
      .opener()
      .then((opener) => {
        if (opener !== null) handle.setOpener(this.byPage.get(opener) ?? null);
      })
      .catch(() => {
        // Best-effort enrichment only; a missing opener is not an error.
      });

    for (const cb of this.pageCallbacks) cb(handle);
    return handle;
  }

  /** Opens a page in `context` and registers it. */
  async newPageIn(context: BrowserContext): Promise<PageHandle> {
    return this.track(await context.newPage());
  }

  onPage(cb: (page: PageHandle) => void): () => void {
    this.pageCallbacks.add(cb);
    return () => {
      this.pageCallbacks.delete(cb);
    };
  }

  onDisconnected(cb: (reason: string) => void): () => void {
    this.disconnectedCallbacks.add(cb);
    return () => {
      this.disconnectedCallbacks.delete(cb);
    };
  }

  /**
   * Idempotent: a provider often sees three signals for one event (page, context and
   * browser all fire), and listeners must hear about it once.
   */
  emitDisconnected(reason: string): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const cb of this.disconnectedCallbacks) cb(reason);
  }
}
