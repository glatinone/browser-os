import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BrowserProfile, newId } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildManualLaunchCommand,
  type ManualLaunchDeps,
  type ManualSpawnOptions,
  openManual,
  type SpawnedProcess,
} from '../src/manual-launch.js';

/** A profile to point manual mode at; nothing here touches the filesystem. */
function manualProfile(name = 'manual'): BrowserProfile {
  return {
    id: newId('prf'),
    name,
    channel: 'chrome',
    userDataDir: path.join(tmpdir(), `bos-unused-${name}`),
    headless: false,
    createdAt: Date.now(),
    lastUsedAt: null,
  };
}

/**
 * Flags that would turn a window a human is setting up into one we could drive, or would
 * otherwise defeat the point of manual mode (browser-runtime §1.1, SECURITY §7).
 */
const FORBIDDEN_FLAGS = ['--remote-debugging-port', '--remote-debugging-pipe', '--enable-automation', '--headless'];

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: ManualSpawnOptions;
}

function fakeDeps(overrides: Partial<ManualLaunchDeps> = {}) {
  const calls: SpawnCall[] = [];
  let unrefs = 0;
  const deps: ManualLaunchDeps = {
    findExecutable: () => '/opt/chrome/chrome',
    isProfileLocked: async () => false,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        pid: 4242,
        unref: () => {
          unrefs += 1;
        },
      };
    },
    ...overrides,
  };
  return { deps, calls, unrefs: () => unrefs };
}

describe('buildManualLaunchCommand', () => {
  it('opens the profile directory and carries no debugging flag', () => {
    const { command, args } = buildManualLaunchCommand('/opt/chrome/chrome', '/home/k/.hermes/profiles/default');

    expect(command).toBe('/opt/chrome/chrome');
    expect(args).toEqual([
      '--user-data-dir=/home/k/.hermes/profiles/default',
      '--no-first-run',
      '--no-default-browser-check',
    ]);

    for (const flag of FORBIDDEN_FLAGS) {
      expect(args.filter((arg) => arg.startsWith(flag))).toEqual([]);
    }
  });
});

describe('openManual', () => {
  it('spawns the window detached and hands back its pid', async () => {
    const { deps, calls, unrefs } = fakeDeps();
    const profile = manualProfile();

    const pid = await openManual(profile, deps);

    expect(pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/opt/chrome/chrome');
    expect(calls[0]?.args).toEqual([
      `--user-data-dir=${profile.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]);
    // Detached plus unref: the window outlives the daemon that opened it.
    expect(calls[0]?.options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(unrefs()).toBe(1);
  });

  it('refuses a channel that is not installed, without spawning anything', async () => {
    const { deps, calls } = fakeDeps({ findExecutable: () => null });

    await expect(openManual(manualProfile(), deps)).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a profile another process already holds, without spawning anything', async () => {
    const { deps, calls } = fakeDeps({ isProfileLocked: async () => true });

    await expect(openManual(manualProfile(), deps)).rejects.toMatchObject({
      code: 'PROFILE_LOCKED',
    });
    expect(calls).toEqual([]);
  });

  it('reports a null pid when the platform has not assigned one yet', async () => {
    const { deps } = fakeDeps({
      spawn: (): SpawnedProcess => ({ pid: undefined, unref: () => {} }),
    });

    expect(await openManual(manualProfile(), deps)).toBeNull();
  });
});
