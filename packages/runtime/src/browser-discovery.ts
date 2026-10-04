import fs from 'node:fs/promises';
import path from 'node:path';
import { BosError, newId } from '@browser-os/protocol';

export interface BrowserInfo {
  path: string;
  vendor: 'chrome' | 'edge' | 'chromium' | 'unknown';
  version: string;
}

/**
 * Tries common environment variables and well-known install locations.
 * On Windows, checks ProgramFiles; on macOS, /Applications; on Linux, /usr/bin.
 */
export async function discoverBrowser(): Promise<BrowserInfo> {
  // 1. Explicit overrides
  if (process.env.CHROME_PATH) {
    return { path: process.env.CHROME_PATH, vendor: 'chrome', version: 'unknown' };
  }
  if (process.env.EDGE_PATH) {
    return { path: process.env.EDGE_PATH, vendor: 'edge', version: 'unknown' };
  }
  if (process.env.BROWSER_PATH) {
    return { path: process.env.BROWSER_PATH, vendor: 'unknown', version: 'unknown' };
  }

  // 2. Platform-specific defaults
  const candidates: Array<{ path: string; vendor: BrowserInfo['vendor'] }> = [];
  const platform = process.platform;

  if (platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      { path: path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'), vendor: 'chrome' },
      { path: path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'), vendor: 'chrome' },
      { path: path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'), vendor: 'edge' },
      { path: path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'), vendor: 'edge' },
    );
  } else if (platform === 'darwin') {
    candidates.push(
      { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', vendor: 'chrome' },
      { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', vendor: 'edge' },
    );
  } else {
    candidates.push(
      { path: '/usr/bin/google-chrome', vendor: 'chrome' },
      { path: '/usr/bin/chromium-browser', vendor: 'chromium' },
      { path: '/usr/bin/microsoft-edge', vendor: 'edge' },
    );
  }

  for (const c of candidates) {
    try {
      await fs.access(c.path);
      return { path: c.path, vendor: c.vendor, version: 'unknown' };
    } catch {
      // ignore
    }
  }

  throw new BosError('BROWSER_NOT_FOUND', `No browser found. Tried: ${candidates.map((c) => c.path).join(', ')}`);
}