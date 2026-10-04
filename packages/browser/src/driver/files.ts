// Files in and out (browser-runtime §6).
//
// Upload paths are checked against `policy.uploads.allowedDirs` by the runtime, not here (P9-07):
// this module takes absolute paths and does what it is told. Downloads are the other way round —
// nothing is written anywhere until someone calls `enableDownloads`.

import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Download, Page } from 'playwright-core';
import { locatorFor } from './locator-for.js';
import { type DriverOutcome, playwrightFailure } from './op.js';
import type { ResolvedTarget } from './types.js';

/** The budget the spec gives an action, shared with the executor. */
const ACTION_TIMEOUT_MS = 2000;

export async function uploadFiles(page: Page, target: ResolvedTarget, paths: string[]): Promise<DriverOutcome> {
  try {
    const locator = await locatorFor(page, target.locator);
    await locator.setInputFiles(paths, { timeout: ACTION_TIMEOUT_MS });
    return { ok: true, effect: 'committed' };
  } catch (error) {
    return playwrightFailure(error, 'upload');
  }
}

export interface SavedDownload {
  path: string;
}

/**
 * Turns downloads on or off for a page. With a directory, each download is saved there under a
 * sanitized name; with `null`, downloads are cancelled. Returns the detach function.
 */
export function enableDownloads(
  page: Page,
  dir: string | null,
  onDownload?: (download: SavedDownload) => void,
): () => void {
  const listener = (download: Download): void => {
    if (dir === null) {
      // Cancelling is the safe default: a page must not be able to write to disk by itself.
      void download.cancel().catch(() => {
        // Already gone; nothing to cancel.
      });
      return;
    }
    void save(download, dir, onDownload);
  };

  page.on('download', listener);
  return () => page.off('download', listener);
}

async function save(download: Download, dir: string, onDownload?: (download: SavedDownload) => void): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = await freeName(dir, download.suggestedFilename());
  const path = join(dir, name);
  await download.saveAs(path);
  onDownload?.({ path });
}

/** Strips anything that would let a page choose where its file lands, or how it is named. */
export function sanitizeFileName(suggested: string): string {
  const cleaned = stripControlCharacters(
    // Both separators, whatever the platform: the name came from a web page.
    suggested.replaceAll(/[\\/]/g, '_'),
  )
    .trim()
    .replace(/^\.+/, '')
    .trim();

  return cleaned === '' ? 'download' : cleaned;
}

/**
 * Drops control characters, including the ones that truncate a path when a name is passed to a
 * shell. Written as a filter rather than a character-class regex: a control character in a regex
 * literal is exactly the kind of input this code is defending against.
 */
function stripControlCharacters(value: string): string {
  let kept = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) kept += character;
  }
  return kept;
}

/** `name.ext` → `name (1).ext`, then `name (2).ext`, for the first name not already taken. */
async function freeName(dir: string, suggested: string): Promise<string> {
  const base = sanitizeFileName(suggested);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : '';

  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? base : `${stem} (${attempt})${extension}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
