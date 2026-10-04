import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BrowserHandle, ensureProfileDir, LaunchProvider } from '@browser-os/browser';
import { type BrowserChannel, type BrowserProfile, newId } from '@browser-os/protocol';

export interface TestBrowser {
  /** The temp BOS_HOME the profile lives in. */
  bosHome: string;
  profile: BrowserProfile;
  /** The current handle; replaced by `relaunch()`. */
  handle(): BrowserHandle;
  /** Closes the browser and launches the same profile again — for persistence tests. */
  relaunch(): Promise<BrowserHandle>;
  /** Closes the browser and deletes the temp BOS_HOME. */
  dispose(): Promise<void>;
}

export interface LaunchTestBrowserOptions {
  name?: string;
  /** Defaults to `chromium`: Playwright's bundled build, so no Chrome is required. */
  channel?: BrowserChannel;
  headless?: boolean;
}

/**
 * A throwaway Browser-OS profile with a private BOS_HOME (TESTING.md §8: never share
 * profiles) and a headless Chromium on top of it. Always `dispose()` in a `finally`.
 */
export async function launchTestBrowser(opts: LaunchTestBrowserOptions = {}): Promise<TestBrowser> {
  const bosHome = await mkdtemp(path.join(tmpdir(), 'bos-launch-'));
  const name = opts.name ?? 'test';
  const userDataDir = await ensureProfileDir(bosHome, name);
  const profile: BrowserProfile = {
    id: newId('prf'),
    name,
    channel: opts.channel ?? 'chromium',
    userDataDir,
    headless: opts.headless ?? true,
    createdAt: Date.now(),
    lastUsedAt: null,
  };

  const provider = new LaunchProvider();
  let handle = await provider.open({ profile });

  return {
    bosHome,
    profile,
    handle: () => handle,
    async relaunch() {
      await handle.close().catch(() => {
        // Already gone: relaunching is still what the caller asked for.
      });
      handle = await openWhenReleased(provider, profile);
      return handle;
    },
    async dispose() {
      await handle.close().catch(() => {
        // Same: disposal must not fail because the browser already went away.
      });
      await rm(bosHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/**
 * Chrome releases its profile lock a moment after the process exits, so a relaunch
 * straight after `close()` can lose a race with the old process. Retry the
 * `PROFILE_LOCKED` answer briefly instead of making the caller sleep.
 */
async function openWhenReleased(provider: LaunchProvider, profile: BrowserProfile): Promise<BrowserHandle> {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      return await provider.open({ profile });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'PROFILE_LOCKED' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
