// LaunchProvider: the MVP default provider (browser-runtime §2).
//
// Launches the profile's own channel as a persistent context over Playwright's
// pipe transport, so no TCP debugging port is ever opened on the logged-in
// profile (SECURITY §2 S2). `chromium` is the only channel allowed to fall back to
// Playwright's bundled build; `chrome`/`msedge` must be installed (integration §13).

import { existsSync } from 'node:fs';
import type { BosPlatform, BrowserChannel, BrowserProfile } from '@browser-os/protocol';
import { BosError } from '@browser-os/protocol';
import type { BrowserContext } from 'playwright-core';
import { chromium } from 'playwright-core';
import { findExecutable } from '../executables.js';
import type { PageHandle } from '../page-handle.js';
import { PageRegistry } from '../page-registry.js';
import { isProfileLocked } from '../profiles.js';
import type { BrowserHandle, BrowserProvider, OpenOptions, ProviderCapabilities } from '../provider.js';

const CAPABILITIES: ProviderCapabilities = {
  persistentProfile: true,
  screenshots: true,
  oopif: true,
  headful: true,
  uploads: true,
  downloads: true,
};

/** The subset of Playwright's launch options this provider controls. */
export interface LaunchOptions {
  channel: BrowserChannel;
  headless: boolean;
  viewport: { width: number; height: number } | null;
  acceptDownloads: boolean;
}

/**
 * The launch options, as a separate pure function so they can be asserted without
 * a browser (SECURITY §2 S4). Playwright's defaults are left alone: nothing here
 * hides automation, and there is deliberately no `ignoreDefaultArgs`,
 * `--disable-blink-features=AutomationControlled` or `userAgent` override
 * (SECURITY §7). `headless` follows the profile when the caller does not say.
 */
export function buildLaunchOptions(
  profile: BrowserProfile,
  opts: { headless?: boolean; viewport?: { width: number; height: number } | null } = {},
): LaunchOptions {
  return {
    channel: profile.channel,
    headless: opts.headless ?? profile.headless,
    viewport: opts.viewport ?? null,
    acceptDownloads: true,
  };
}

/** Seams for the two pre-flight checks, so they can be unit-tested without a browser. */
export interface LaunchProviderDeps {
  findExecutable(channel: BrowserChannel): string | null;
  isProfileLocked(dir: string): Promise<boolean>;
}

function defaultDeps(): LaunchProviderDeps {
  const platform: BosPlatform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return {
    findExecutable: (channel) => findExecutable(channel, { platform, env: process.env, exists: existsSync }),
    isProfileLocked,
  };
}

/**
 * Sessions from this provider own their browser process, which is what the session manager
 * records as `ownership: 'launched'` (data-models §2). That fact rides on `kind`; there is
 * no separate ownership field on `BrowserHandle`.
 */
export class LaunchProvider implements BrowserProvider {
  readonly kind = 'launch' as const;
  readonly capabilities = CAPABILITIES;

  private readonly deps: LaunchProviderDeps;

  constructor(deps: LaunchProviderDeps = defaultDeps()) {
    this.deps = deps;
  }

  async open(opts: OpenOptions): Promise<BrowserHandle> {
    const { profile } = opts;
    const options = buildLaunchOptions(profile, opts);

    // No silent fallback for a real channel: a machine without Chrome must hear
    // BROWSER_NOT_FOUND, not Playwright's own "distribution not found" (integration §13).
    if (profile.channel !== 'chromium' && this.deps.findExecutable(profile.channel) === null) {
      throw new BosError(
        'BROWSER_NOT_FOUND',
        `The ${profile.channel} channel is not installed; install it or use the chromium channel`,
        { details: { channel: profile.channel } },
      );
    }

    if (await this.deps.isProfileLocked(profile.userDataDir)) {
      throw new BosError('PROFILE_LOCKED', `Profile ${profile.name} is already open in another process`, {
        details: { userDataDir: profile.userDataDir },
      });
    }

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profile.userDataDir, options);
    } catch (error) {
      throw new BosError('BROWSER_LAUNCH_FAILED', `Failed to launch ${profile.channel} for profile ${profile.name}`, {
        cause: error,
      });
    }

    return new LaunchBrowserHandle(context);
  }
}

class LaunchBrowserHandle implements BrowserHandle {
  /** Always null: `launchPersistentContext` does not expose the browser process (integration §13). */
  readonly pid: number | null = null;

  private readonly context: BrowserContext;
  private readonly registry: PageRegistry;

  constructor(context: BrowserContext) {
    this.context = context;
    this.registry = new PageRegistry(context.pages());
    // `newPage()` also emits this event, so tracking is idempotent per page.
    context.on('page', (page) => void this.registry.track(page));
    context.on('close', () => this.registry.emitDisconnected('context closed'));
    context.browser()?.on('disconnected', () => this.registry.emitDisconnected('browser disconnected'));
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

  async close(): Promise<void> {
    await this.context.close();
  }
}
