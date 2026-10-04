import fs from 'node:fs/promises';
import path from 'node:path';
import { BosError } from '@browser-os/protocol';
import { resolveBosHome } from '@browser-os/protocol';

/**
 * Returns the absolute path for a profile directory.
 * Creates it if it doesn't exist.
 * Rejects unsafe paths (traversal or absolute).
 */
export async function resolveProfileDir(profileId: string): Promise<string> {
  if (!profileId || profileId.includes('..') || path.isAbsolute(profileId)) {
    throw new BosError('INVALID_PROFILE_ID', `Unsafe or invalid profile ID: ${profileId}`);
  }

  const base = await resolveBosHome();
  const profilePath = path.join(base, 'profiles', profileId);

  try {
    await fs.mkdir(profilePath, { recursive: true });
  } catch (e) {
    throw new BosError('PROFILE_DIR_CREATE_FAILED', `Could not create profile directory: ${profilePath}`, e as Error);
  }

  return profilePath;
}