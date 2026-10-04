// Manual setup mode: open the profile in a real browser window and let a human use it
// (browser-runtime §1.1).
//
// This is the supported way to authenticate. The browser is deliberately plain — no CDP, no
// Playwright, no automation flag of any kind — so identity providers that refuse automated
// browsers see an ordinary human-driven window, and we never pretend otherwise in automated
// sessions (SECURITY §7).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { BosPlatform, BrowserChannel, BrowserProfile } from '@browser-os/protocol';
import { BosError } from '@browser-os/protocol';
import { findExecutable } from './executables.js';
import { isProfileLocked } from './profiles.js';

export interface ManualLaunchCommand {
  command: string;
  args: string[];
}

/**
 * The command that opens `userDataDir` as a normal window. The argument list is short on
 * purpose: `--no-first-run` and `--no-default-browser-check` only stop Chrome's onboarding
 * prompts. There is no debugging flag and nothing that hides automation (§1.1).
 */
export function buildManualLaunchCommand(executable: string, userDataDir: string): ManualLaunchCommand {
  return {
    command: executable,
    args: [`--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check'],
  };
}

/** How the launched process looks from here: only what we actually use. */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  unref(): void;
}

export interface ManualSpawnOptions {
  detached: boolean;
  stdio: 'ignore';
  windowsHide: boolean;
}

/** Seams for `openManual`, so the spawn path is testable without a browser. */
export interface ManualLaunchDeps {
  findExecutable(channel: BrowserChannel): string | null;
  isProfileLocked(dir: string): Promise<boolean>;
  spawn(command: string, args: readonly string[], options: ManualSpawnOptions): SpawnedProcess;
}

function defaultDeps(): ManualLaunchDeps {
  const platform: BosPlatform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return {
    findExecutable: (channel) => findExecutable(channel, { platform, env: process.env, exists: existsSync }),
    isProfileLocked,
    // `detached` + `unref()` so the window outlives the daemon. `windowsHide` matters on
    // Windows: a detached child otherwise gets a console window of its own, which would flash
    // up next to the browser the human just asked for.
    spawn: (command, args, options) => spawn(command, [...args], options),
  };
}

/**
 * Opens `profile` in a real window and returns immediately; the pid is that window's, and
 * Browser-OS stays out of it from then on (§1.1). A Windows pid may be 0 for a short while,
 * which is why the return type allows null.
 */
export async function openManual(
  profile: BrowserProfile,
  deps: ManualLaunchDeps = defaultDeps(),
): Promise<number | null> {
  const executable = deps.findExecutable(profile.channel);
  if (executable === null) {
    throw new BosError(
      'BROWSER_NOT_FOUND',
      `The ${profile.channel} channel is not installed; install it or use the chromium channel`,
      { details: { channel: profile.channel } },
    );
  }

  if (await deps.isProfileLocked(profile.userDataDir)) {
    throw new BosError('PROFILE_LOCKED', `Profile ${profile.name} is already open`, {
      details: { userDataDir: profile.userDataDir },
    });
  }

  const { command, args } = buildManualLaunchCommand(executable, profile.userDataDir);
  const child = deps.spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid ?? null;
}
