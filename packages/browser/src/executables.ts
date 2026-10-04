// Browser executable discovery (browser-runtime §1.1, task P2-01).
//
// Resolving a channel to an executable path is the one place where Browser-OS
// has to know where a real Chrome/Edge lives on the OS. Manual setup mode
// (P2-06) needs the path itself; automated launches hand the channel to
// Playwright instead (integration §13).
//
// Pure by construction, like `protocol/paths.ts`: platform, environment and the
// filesystem probe are all injected. That keeps every OS testable on any host,
// makes the no-filesystem-in-tests rule of the card achievable, and means no
// caller can reach the real process environment through this module. Paths are
// built with the separator of the *platform argument*, never of the host.

import path from 'node:path';
import type { BosPlatform, BrowserChannel } from '@browser-os/protocol';

export interface FindExecutableOptions {
  platform: BosPlatform;
  env: Record<string, string | undefined>;
  /** Injected filesystem probe — the only I/O the caller supplies. */
  exists: (candidate: string) => boolean;
}

/**
 * The env var that overrides each channel's search. `chromium` reuses
 * `BOS_CHROME_PATH`: a caller asking for `chromium` is asking for "the Chromium
 * family binary", and the override names one explicitly.
 */
const ENV_OVERRIDE: Record<BrowserChannel, string> = {
  chrome: 'BOS_CHROME_PATH',
  msedge: 'BOS_EDGE_PATH',
  chromium: 'BOS_CHROME_PATH',
};

const MAC_LOCATIONS: Record<BrowserChannel, readonly string[]> = {
  chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  // Playwright's bundled Chromium is not a system install and has no path here.
  chromium: [],
};

const LINUX_LOCATIONS: Record<BrowserChannel, readonly string[]> = {
  chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  msedge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
  chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Windows install roots, most specific first. `%LOCALAPPDATA%` holds per-user
 * installs and is only searched when the variable is set, because the fallback
 * would have to guess the user's profile directory.
 */
function windowsRoots(env: Record<string, string | undefined>): string[] {
  const roots = [
    nonEmpty(env.PROGRAMFILES) ?? 'C:\\Program Files',
    nonEmpty(env['PROGRAMFILES(X86)']) ?? 'C:\\Program Files (x86)',
  ];
  const localAppData = nonEmpty(env.LOCALAPPDATA);
  if (localAppData !== undefined) roots.push(localAppData);
  return roots;
}

function windowsLocations(channel: BrowserChannel, env: Record<string, string | undefined>): string[] {
  if (channel === 'chromium') return [];
  const relative =
    channel === 'chrome'
      ? ['Google', 'Chrome', 'Application', 'chrome.exe']
      : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  return windowsRoots(env).map((root) => path.win32.join(root, ...relative));
}

function knownLocations(
  channel: BrowserChannel,
  platform: BosPlatform,
  env: Record<string, string | undefined>,
): readonly string[] {
  if (platform === 'win32') return windowsLocations(channel, env);
  if (platform === 'darwin') return MAC_LOCATIONS[channel];
  return LINUX_LOCATIONS[channel];
}

/** The override, when set, is tried first and the known locations after it. */
function candidatesFor(
  channel: BrowserChannel,
  platform: BosPlatform,
  env: Record<string, string | undefined>,
): readonly string[] {
  const known = knownLocations(channel, platform, env);
  const override = nonEmpty(env[ENV_OVERRIDE[channel]]);
  return override === undefined ? known : [override, ...known];
}

/**
 * Returns the executable for `channel`, or `null` when nothing matches.
 * `null` for `chromium` is not a failure: the caller lets Playwright use its
 * managed Chromium (browser-runtime §1.1). The caller raises `BROWSER_NOT_FOUND`
 * for a `chrome`/`msedge` miss, never silently falling back (integration §13).
 */
export function findExecutable(channel: BrowserChannel, opts: FindExecutableOptions): string | null {
  for (const candidate of candidatesFor(channel, opts.platform, opts.env)) {
    if (opts.exists(candidate)) return candidate;
  }
  return null;
}

/** `chrome` when installed, else `msedge`, else `chromium` (browser-runtime §1). */
export function defaultChannel(opts: FindExecutableOptions): BrowserChannel {
  if (findExecutable('chrome', opts) !== null) return 'chrome';
  if (findExecutable('msedge', opts) !== null) return 'msedge';
  return 'chromium';
}
