import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BosError } from '@browser-os/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertInsideProfiles,
  ensureProfileDir,
  isProfileLocked,
  profileDir,
  validateProfileName,
} from '../src/profiles.js';

const isWindows = process.platform === 'win32';
const isPosix = !isWindows;

let bosHome: string;

beforeEach(async () => {
  bosHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bos-profiles-'));
});

afterEach(async () => {
  // Retries: a lock file may be released a moment after its holder is killed.
  await fs.rm(bosHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The `code` of the BosError `fn` throws, or `undefined` when it does not throw. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as BosError).code;
  }
}

/** Spawns a Node process that stays alive, and returns a killer that waits for it. */
function holdProcessAlive(): { pid: number; release: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return {
    pid: child.pid as number,
    release: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      }),
  };
}

async function until(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

describe('validateProfileName', () => {
  it.each(['default', 'a', 'a1', '0', 'work', 'work-profile', 'a'.repeat(32), 'trail-'])('accepts %j', (name) => {
    // 'trail-' is accepted on purpose: PROFILE_NAME_RE (data-models §1) allows a
    // trailing hyphen, and tightening it here would be a protocol change.
    expect(() => validateProfileName(name)).not.toThrow();
  });

  it.each([
    '',
    'A',
    'Work',
    '-lead',
    'has space',
    'under_score',
    'a.b',
    'a/b',
    '..',
    '../escape',
    '.',
    'a'.repeat(33),
    'ünïcode',
  ])('rejects %j', (name) => {
    expect(() => validateProfileName(name)).toThrow(BosError);
  });

  it('reports INVALID_REQUEST', async () => {
    expect(await codeOf(async () => validateProfileName('Bad Name'))).toBe('INVALID_REQUEST');
  });
});

describe('profileDir', () => {
  it('returns an absolute path under <bosHome>/profiles', () => {
    const dir = profileDir(bosHome, 'work');
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.basename(dir)).toBe('work');
    expect(path.basename(path.dirname(dir))).toBe('profiles');
  });

  it('normalizes the bosHome argument', () => {
    const messy = path.join(bosHome, 'a', '..', '.');
    expect(profileDir(messy, 'work')).toBe(profileDir(bosHome, 'work'));
  });
});

describe('assertInsideProfiles', () => {
  it('accepts a profile directory that exists', async () => {
    const dir = await ensureProfileDir(bosHome, 'work');
    await expect(assertInsideProfiles(bosHome, dir)).resolves.toBeUndefined();
  });

  it('accepts a profile directory that does not exist yet', async () => {
    await expect(assertInsideProfiles(bosHome, profileDir(bosHome, 'later'))).resolves.toBeUndefined();
  });

  it('rejects the profiles root itself', async () => {
    const root = path.join(bosHome, 'profiles');
    expect(await codeOf(() => assertInsideProfiles(bosHome, root))).toBe('PERMISSION_DENIED');
  });

  it('rejects a traversal out of profiles', async () => {
    const traversal = path.join(bosHome, 'profiles', '..', '..', 'elsewhere');
    expect(await codeOf(() => assertInsideProfiles(bosHome, traversal))).toBe('PERMISSION_DENIED');
  });

  it('rejects a sibling directory of profiles', async () => {
    const sibling = path.join(bosHome, 'downloads', 'run');
    expect(await codeOf(() => assertInsideProfiles(bosHome, sibling))).toBe('PERMISSION_DENIED');
  });

  it('rejects an unrelated absolute directory', async () => {
    const elsewhere = path.resolve(bosHome, '..');
    expect(await codeOf(() => assertInsideProfiles(bosHome, elsewhere))).toBe('PERMISSION_DENIED');
  });
});

describe.skipIf(isWindows)('assertInsideProfiles symlink escape (S1)', () => {
  it('rejects a symlinked profile directory that points outside profiles', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bos-outside-'));
    try {
      const profilesRoot = path.join(bosHome, 'profiles');
      await fs.mkdir(profilesRoot, { recursive: true });
      const link = path.join(profilesRoot, 'escape');
      await fs.symlink(outside, link, 'dir');

      expect(await codeOf(() => assertInsideProfiles(bosHome, link))).toBe('PERMISSION_DENIED');
    } finally {
      await fs.rm(outside, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it('rejects a path whose symlinked parent points outside profiles', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bos-outside-'));
    try {
      const profilesRoot = path.join(bosHome, 'profiles');
      await fs.mkdir(profilesRoot, { recursive: true });
      await fs.symlink(outside, path.join(profilesRoot, 'linked'), 'dir');

      const notCreatedYet = path.join(profilesRoot, 'linked', 'child');
      expect(await codeOf(() => assertInsideProfiles(bosHome, notCreatedYet))).toBe('PERMISSION_DENIED');
    } finally {
      await fs.rm(outside, { recursive: true, force: true, maxRetries: 10 });
    }
  });
});

describe('ensureProfileDir', () => {
  it('creates the directory recursively and returns it', async () => {
    const dir = await ensureProfileDir(bosHome, 'work');
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    expect(dir).toBe(profileDir(bosHome, 'work'));
  });

  it('is idempotent', async () => {
    const first = await ensureProfileDir(bosHome, 'work');
    expect(await ensureProfileDir(bosHome, 'work')).toBe(first);
  });

  it('rejects an invalid name without touching the disk', async () => {
    expect(await codeOf(() => ensureProfileDir(bosHome, '../escape'))).toBe('INVALID_REQUEST');
    expect(await fs.readdir(bosHome)).toEqual([]);
  });
});

describe('isProfileLocked', () => {
  it('is false when no lock file exists', async () => {
    const dir = await ensureProfileDir(bosHome, 'work');
    expect(await isProfileLocked(dir)).toBe(false);
  });
});

describe.skipIf(isWindows)('isProfileLocked — POSIX SingletonLock', () => {
  it('is true while the recorded pid is alive', async () => {
    const dir = await ensureProfileDir(bosHome, 'work');
    const holder = holdProcessAlive();
    try {
      await fs.symlink(`${os.hostname()}-${holder.pid}`, path.join(dir, 'SingletonLock'));
      expect(await isProfileLocked(dir)).toBe(true);
    } finally {
      await holder.release();
    }
  });

  it('is false for a stale lock whose process is gone', async () => {
    const dir = await ensureProfileDir(bosHome, 'work');
    const holder = holdProcessAlive();
    const pid = holder.pid;
    await holder.release();

    await fs.symlink(`${os.hostname()}-${pid}`, path.join(dir, 'SingletonLock'));
    expect(await isProfileLocked(dir)).toBe(false);
  });

  it('is false when the lock name carries no pid', async () => {
    const dir = await ensureProfileDir(bosHome, 'work');
    await fs.symlink('hostname-only', path.join(dir, 'SingletonLock'));
    expect(await isProfileLocked(dir)).toBe(false);
  });
});

describe.skipIf(isPosix)('isProfileLocked — Windows lockfile', () => {
  it('is false for a stale lock file nobody holds', async () => {
    const dir = await ensureProfileDir(bosHome, 'work');
    await fs.writeFile(path.join(dir, 'lockfile'), '');
    expect(await isProfileLocked(dir)).toBe(false);
  });

  it('is true while another process holds the file exclusively', async () => {
    const dir = await ensureProfileDir(bosHome, 'work');
    const lockfile = path.join(dir, 'lockfile');
    await fs.writeFile(lockfile, '');

    // Node opens files with FILE_SHARE_READ|WRITE|DELETE, so a Node holder is not
    // exclusive and the probe succeeds. Chrome asks for FileShare.None; PowerShell
    // is the only thing on a stock runner that can reproduce that, and it does make
    // the probe fail with EBUSY (measured).
    const holder = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$f=[IO.File]::Open('${lockfile}','Open','ReadWrite','None'); Start-Sleep -Seconds 60`,
      ],
      { stdio: 'ignore' },
    );

    try {
      expect(await until(async () => isProfileLocked(dir), 20000)).toBe(true);
    } finally {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.once('exit', resolve));
    }
  });
});
