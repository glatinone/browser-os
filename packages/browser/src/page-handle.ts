// PageHandle: a Browser-OS page id wrapped around a Playwright page.
//
// Playwright types are imported for the implementation only and are never
// re-exported from `src/index.ts` (task P2-04 acceptance; CODING_AGENT rule 6).
// Everything a caller sees is a protocol type or one of our own interfaces.

import { newId } from '@browser-os/protocol';
import type { Page } from 'playwright-core';
import { createPageCdp } from './cdp/playwright.js';
import type { CdpTransport } from './cdp/transport.js';
import { DefaultPageDriver } from './driver/page-driver.js';
import type { PageDriver } from './driver/types.js';

export interface PageHandle {
  readonly id: string;
  url(): string;
  title(): Promise<string>;
  /** The page that opened this one, when it is known; null for a top-level page. */
  opener(): PageHandle | null;
  cdp(): Promise<CdpTransport>;
  driver(): PageDriver;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  onClose(cb: () => void): () => void;
}

export class PageHandleImpl implements PageHandle {
  readonly id: string;
  private readonly page: Page;
  private readonly closeCallbacks = new Set<() => void>();
  private openerHandle: PageHandle | null = null;
  private cdpTransport: Promise<CdpTransport> | null = null;
  private driverInstance: PageDriver | null = null;
  private pageIdsSource: (() => readonly string[]) | null = null;

  constructor(page: Page) {
    this.id = newId('pg');
    this.page = page;
    // Subscribing to Playwright rather than firing on our own `close()` means a tab
    // the user closed by hand is reported too — the session manager (P2-07) needs it.
    page.on('close', () => {
      for (const cb of this.closeCallbacks) cb();
      this.closeCallbacks.clear();
    });
  }

  /** Set by the owning registry: the pages of this session, for `newPageId` (P3-02). */
  setPageIdsSource(source: () => readonly string[]): void {
    this.pageIdsSource = source;
  }

  /** Set by the owning BrowserHandle once Playwright reports the opener. */
  setOpener(opener: PageHandle | null): void {
    this.openerHandle = opener;
  }

  /** The raw Playwright page. Internal: deep imports are not part of the public API. */
  raw(): Page {
    return this.page;
  }

  url(): string {
    return this.page.url();
  }

  async title(): Promise<string> {
    return this.page.title();
  }

  opener(): PageHandle | null {
    return this.openerHandle;
  }

  cdp(): Promise<CdpTransport> {
    // One session per page (browser-runtime §4), created on first use. A failed creation is
    // not cached, so a later call can still succeed.
    this.cdpTransport ??= createPageCdp(this.page).catch((error: unknown) => {
      this.cdpTransport = null;
      throw error;
    });
    return this.cdpTransport;
  }

  driver(): PageDriver {
    // The driver shares this page's CDP session rather than opening a second one (§4).
    this.driverInstance ??= new DefaultPageDriver({
      page: this.page,
      transport: () => this.cdp(),
      knownPageIds: () => this.pageIdsSource?.() ?? [this.id],
    });
    return this.driverInstance;
  }

  async bringToFront(): Promise<void> {
    await this.page.bringToFront();
  }

  async close(): Promise<void> {
    // `page.on('close')` fires the callbacks; nothing to do here but ask.
    await this.page.close();
  }

  onClose(cb: () => void): () => void {
    this.closeCallbacks.add(cb);
    return () => {
      this.closeCallbacks.delete(cb);
    };
  }
}
