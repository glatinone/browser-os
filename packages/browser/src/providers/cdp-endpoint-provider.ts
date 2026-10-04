// CdpEndpointProvider: attach to a browser somebody else started (browser-runtime §2).
//
// Loopback only. Attaching across a network would hand another machine's browser — and every
// session logged into it — to the agent, so anything but this machine is refused before we
// dial out at all (SECURITY §2 S3).

import { BosError } from '@browser-os/protocol';
import type { Browser, BrowserContext } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { PageHandle } from '../page-handle.js';
import { PageRegistry } from '../page-registry.js';
import type { BrowserHandle, BrowserProvider, OpenOptions, ProviderCapabilities } from '../provider.js';

/**
 * `persistentProfile: false`, because that is the honest answer: the profile belongs to
 * whoever started the browser, and whether it outlives us is not ours to claim (§2).
 */
const CAPABILITIES: ProviderCapabilities = {
  persistentProfile: false,
  screenshots: true,
  oopif: true,
  headful: true,
  uploads: true,
  downloads: true,
};

/** Exactly the spellings the spec allows. `[::1]` keeps the brackets `URL` gives it. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ENDPOINT_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:']);

/**
 * True when `endpoint` is a URL pointing at this machine. Anything unparseable is false:
 * refusing an endpoint we do not understand is the whole point of S3.
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return ENDPOINT_PROTOCOLS.has(url.protocol) && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Sessions here attach to a browser we did not start, which the session manager records as
 * `ownership: 'attached'` (data-models §2). That fact rides on `kind`.
 */
export class CdpEndpointProvider implements BrowserProvider {
  readonly kind = 'cdp-endpoint' as const;
  readonly capabilities = CAPABILITIES;

  async open(opts: OpenOptions): Promise<BrowserHandle> {
    const { cdpEndpoint } = opts;
    if (cdpEndpoint === undefined) {
      throw new BosError('INVALID_REQUEST', 'The cdp-endpoint provider needs OpenOptions.cdpEndpoint', {});
    }
    if (!isLoopbackEndpoint(cdpEndpoint)) {
      throw new BosError(
        'PERMISSION_DENIED',
        'The CDP endpoint must be on this machine (127.0.0.1, localhost or [::1])',
        { details: { cdpEndpoint } },
      );
    }

    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
    } catch (error) {
      throw new BosError('BROWSER_LAUNCH_FAILED', `Failed to attach to the CDP endpoint ${cdpEndpoint}`, {
        cause: error,
      });
    }

    // Reuse the browser's first context, and create one only if it has none (§2). A viewport
    // can only be applied to a context we create — the user's own window is theirs.
    const existing = browser.contexts()[0];
    const context = existing ?? (await browser.newContext({ viewport: opts.viewport ?? null }));
    return new AttachedBrowserHandle(browser, context);
  }
}

class AttachedBrowserHandle implements BrowserHandle {
  /** Unknown: we did not start this process, so we cannot name its pid. */
  readonly pid: number | null = null;

  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly registry: PageRegistry;

  constructor(browser: Browser, context: BrowserContext) {
    this.browser = browser;
    this.context = context;
    this.registry = new PageRegistry(context.pages());
    context.on('page', (page) => void this.registry.track(page));
    browser.on('disconnected', () => this.registry.emitDisconnected('cdp connection closed'));
  }

  pages(): PageHandle[] {
    return this.registry.pages();
  }

  async newPage(): Promise<PageHandle> {
    return this.registry.newPageIn(this.context);
  }

  onPage(cb: (page: PageHandle) => void): () => void {
    return this.registry.onPage(cb);
  }

  onDisconnected(cb: (reason: string) => void): () => void {
    return this.registry.onDisconnected(cb);
  }

  /**
   * Disconnects without stopping the browser. For a browser obtained through
   * `connectOverCDP`, Playwright's `close()` drops this client and clears the contexts it
   * created; the process keeps running (`ownership: 'attached'`, §2).
   */
  async close(): Promise<void> {
    await this.browser.close();
  }
}
