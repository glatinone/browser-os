// Profile directories and Chrome's profile lock (browser-runtime §1, SECURITY §2 S1).
//
// A profile is a Browser-OS-owned Chrome user-data-dir at `<BOS_HOME>/profiles/<name>`.
// Browser-OS never points at the user's own Chrome/Edge profile (ADR-003), so every
// path a caller supplies is checked against `<BOS_HOME>/profiles` and rejected with
// `PERMISSION_DENIED` when it escapes — including through a symlinked parent (S1).

import fs from 'node:fs/promises';
import path from 'node:path';
import { BosError, PROFILE_NAME_RE } from '@browser-os/protocol';

/** POSIX: a symlink whose target is `<hostname>-<pid>` (browser-runtime §1). */
const SINGLETON_LOCK = 'SingletonLock';
/** Windows: a file Chrome holds with an exclusive share mode. */
const LOCKFILE = 'lockfile';
const PROFILES_DIR = 'profiles';

/** Throws `INVALID_REQUEST` unless `name` is a safe, lowercase profile slug. */
export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new BosError('INVALID_REQUEST', `Invalid profile name: ${JSON.stringify(name)}`, {});
  }
}

/**
 * `<bosHome>/profiles/<name>`, absolute and normalized. Pure path arithmetic: it
 * does **not** validate `name` (that is `validateProfileName`) and does **not**
 * touch the disk. Take the result through `assertInsideProfiles` before using it.
 */
export function profileDir(bosHome: string, name: string): string {
  return path.resolve(bosHome, PROFILES_DIR, name);
}

/**
 * S1: refuses any directory that is not strictly inside `<bosHome>/profiles`.
 * Both sides are realpath'd, so a symlinked parent cannot smuggle a path out, and
 * the check still holds for a directory that does not exist yet.
 */
export async function assertInsideProfiles(bosHome: string, dir: string): Promise<void> {
  const root = await realpathOrSelf(path.resolve(bosHome, PROFILES_DIR));
  const target = await realpathOrSelf(path.resolve(dir));
  const relative = path.relative(root, target);

  // '' means the profiles root itself — outside for our purposes, since a profile
  // directory must be a child of it, never the root.
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BosError('PERMISSION_DENIED', `Refusing to use a profile directory outside ${root}: ${target}`, {
      details: { root, dir: target },
    });
  }
}

/** Validates the name, creates `<bosHome>/profiles/<name>` recursively, returns it. */
export async function ensureProfileDir(bosHome: string, name: string): Promise<string> {
  validateProfileName(name);
  const dir = profileDir(bosHome, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * True when a **live** process owns the profile directory. A lock file left behind
 * by a crashed browser is not a lock: Chrome never deletes these files, and
 * Browser-OS does not either (SECURITY §2), so staleness is decided per platform
 * rather than by the file's existence.
 */
export async function isProfileLocked(dir: string): Promise<boolean> {
  return process.platform === 'win32' ? windowsLockHeld(dir) : posixLockHeld(dir);
}

async function posixLockHeld(dir: string): Promise<boolean> {
  let target: string;
  try {
    target = await fs.readlink(path.join(dir, SINGLETON_LOCK));
  } catch {
    return false; // no lock at all
  }

  const pid = singletonLockPid(target);
  if (pid === null) return false;
  return isProcessAlive(pid);
}

/**
 * Chrome's `SingletonLock` target is `<hostname>-<pid>`. The hostname may itself
 * contain '-', so only the last segment is the pid.
 */
function singletonLockPid(target: string): number | null {
  const separator = target.lastIndexOf('-');
  if (separator < 0) return null;
  const pid = Number(target.slice(separator + 1));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Chrome holds `lockfile` with an exclusive share mode, so an open for write fails
 * with `EBUSY` while Chrome is alive (measured against Chrome 154 on Windows 11).
 * Windows writes no pid into the file — it is empty — so this probe is the only
 * signal available. A stale file opens cleanly and reports false; `ENOENT` is not
 * a lock either.
 */
async function windowsLockHeld(dir: string): Promise<boolean> {
  try {
    const handle = await fs.open(path.join(dir, LOCKFILE), 'r+');
    await handle.close();
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EBUSY' || code === 'EPERM';
  }
}

/**
 * Like `fs.realpath`, but tolerates a missing path by resolving the closest
 * existing ancestor. A directory that is about to be created still gets its
 * symlinked parents followed, so the containment check cannot be talked around.
 */
async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await realpathOrSelf(parent), path.basename(target));
  }
}
