// The Playwright-backed CDP transport (browser-runtime §4).
//
// Internal on purpose: `createPageCdp` takes a Playwright `Page`, and this module is not
// re-exported from `src/index.ts`, which is what keeps Playwright types out of the public
// surface (P2-04 acceptance, CODING_AGENT rule 6). Callers reach it through
// `PageHandle.cdp()`.

import type { Page } from 'playwright-core';
import type { CdpTransport } from './transport.js';

/**
 * Domains enabled once per page. `Runtime` is absent by design (SECURITY S19): the isolated
 * world does not need it, and enabling it would stream console and exception traffic for
 * every page we touch.
 */
export const PAGE_DOMAINS = ['Page', 'DOM', 'DOMSnapshot', 'Accessibility', 'Network'] as const;

/**
 * The slice of a Playwright `CDPSession` this transport uses. Narrowing it here means the
 * class's own signature carries no Playwright type, so the cast is the only place that
 * knows about Playwright at all.
 */
export interface RawCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): void;
  off(event: string, listener: (payload: unknown) => void): void;
}

export class PlaywrightCdpTransport implements CdpTransport {
  private readonly session: RawCdpSession;

  constructor(session: RawCdpSession) {
    this.session = session;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return await this.session.send(method, params);
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    this.session.on(event, listener);
    return () => {
      this.session.off(event, listener);
    };
  }
}

/** The domain-prefixed names of everything `createPageCdp` asks the browser for. */
export function enabledDomains(): string[] {
  return PAGE_DOMAINS.map((domain) => `${domain}.enable`);
}

/**
 * Creates the page's CDP session and enables the spec's domains. Called once per page by
 * `PageHandleImpl.cdp()`.
 */
export async function createPageCdp(page: Page): Promise<CdpTransport> {
  const session = (await page.context().newCDPSession(page)) as unknown as RawCdpSession;
  for (const enable of enabledDomains()) {
    await session.send(enable);
  }
  return new PlaywrightCdpTransport(session);
}
