import path from 'node:path';
import type { BosPlatform, BrowserChannel } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { defaultChannel, findExecutable } from '../src/executables.js';

// No filesystem access anywhere in this file (P2-01 acceptance): every case
// supplies its own `exists` probe, so the suite is identical on a machine with
// five browsers installed and on a bare CI runner.
function probe(installed: string[]) {
  const present = new Set(installed);
  const exists = vi.fn((candidate: string) => present.has(candidate));
  return {
    exists,
    /** The candidates `findExecutable` actually asked about, in call order. */
    probed: () => exists.mock.calls.map((call) => call[0]),
  };
}

const PROGRAM_FILES = 'C:\\Program Files';
const PROGRAM_FILES_X86 = 'C:\\Program Files (x86)';
const LOCAL_APP_DATA = 'C:\\Users\\test\\AppData\\Local';

const WINDOWS_ENV = {
  PROGRAMFILES: PROGRAM_FILES,
  'PROGRAMFILES(X86)': PROGRAM_FILES_X86,
  LOCALAPPDATA: LOCAL_APP_DATA,
};

function win(prefix: string, ...rest: string[]): string {
  return path.win32.join(prefix, ...rest);
}

const CHROME_WIN = [
  win(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  win(PROGRAM_FILES_X86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  win(LOCAL_APP_DATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

const EDGE_WIN = [
  win(PROGRAM_FILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  win(PROGRAM_FILES_X86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  win(LOCAL_APP_DATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EDGE_MAC = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const CHROME_LINUX = '/usr/bin/google-chrome';
const CHROME_LINUX_STABLE = '/usr/bin/google-chrome-stable';
const EDGE_LINUX = '/usr/bin/microsoft-edge';
const EDGE_LINUX_STABLE = '/usr/bin/microsoft-edge-stable';
const CHROMIUM_LINUX = '/usr/bin/chromium';
const CHROMIUM_BROWSER_LINUX = '/usr/bin/chromium-browser';

interface Case {
  platform: BosPlatform;
  channel: BrowserChannel;
  env: Record<string, string | undefined>;
  locations: string[];
}

const CASES: Case[] = [
  { platform: 'win32', channel: 'chrome', env: WINDOWS_ENV, locations: CHROME_WIN },
  { platform: 'win32', channel: 'msedge', env: WINDOWS_ENV, locations: EDGE_WIN },
  { platform: 'win32', channel: 'chromium', env: WINDOWS_ENV, locations: [] },
  { platform: 'darwin', channel: 'chrome', env: {}, locations: [CHROME_MAC] },
  { platform: 'darwin', channel: 'msedge', env: {}, locations: [EDGE_MAC] },
  { platform: 'darwin', channel: 'chromium', env: {}, locations: [] },
  {
    platform: 'linux',
    channel: 'chrome',
    env: {},
    locations: [CHROME_LINUX, CHROME_LINUX_STABLE],
  },
  {
    platform: 'linux',
    channel: 'msedge',
    env: {},
    locations: [EDGE_LINUX, EDGE_LINUX_STABLE],
  },
  {
    platform: 'linux',
    channel: 'chromium',
    env: {},
    locations: [CHROMIUM_LINUX, CHROMIUM_BROWSER_LINUX],
  },
];

describe.each(CASES)('findExecutable($platform, $channel)', ({ platform, channel, env, locations }) => {
  const first = locations[0];
  const last = locations[locations.length - 1];

  it('probes exactly the documented locations, in order', () => {
    const fs = probe([]);
    expect(findExecutable(channel, { platform, env, exists: fs.exists })).toBeNull();
    expect(fs.probed()).toEqual(locations);
  });

  if (last !== undefined) {
    it(`resolves ${last}`, () => {
      const fs = probe([last]);
      expect(findExecutable(channel, { platform, env, exists: fs.exists })).toBe(last);
    });

    if (first !== undefined && first !== last) {
      it(`prefers ${first} over later candidates`, () => {
        const fs = probe([...locations]);
        expect(findExecutable(channel, { platform, env, exists: fs.exists })).toBe(first);
      });
    }
  }
});

describe('env overrides', () => {
  it('tries BOS_CHROME_PATH before the known locations', () => {
    const override = '/opt/custom/chrome';
    const fs = probe([override, CHROME_LINUX]);
    expect(findExecutable('chrome', { platform: 'linux', env: { BOS_CHROME_PATH: override }, exists: fs.exists })).toBe(
      override,
    );
    expect(fs.probed()[0]).toBe(override);
  });

  it('applies BOS_CHROME_PATH to the chromium channel too', () => {
    const override = '/opt/custom/chromium';
    const fs = probe([override]);
    expect(
      findExecutable('chromium', { platform: 'linux', env: { BOS_CHROME_PATH: override }, exists: fs.exists }),
    ).toBe(override);
  });

  it('tries BOS_EDGE_PATH for msedge', () => {
    const override = '/opt/custom/edge';
    const fs = probe([override]);
    expect(findExecutable('msedge', { platform: 'linux', env: { BOS_EDGE_PATH: override }, exists: fs.exists })).toBe(
      override,
    );
  });

  it('ignores BOS_EDGE_PATH when the channel is chrome', () => {
    const fs = probe([CHROME_LINUX]);
    expect(
      findExecutable('chrome', {
        platform: 'linux',
        env: { BOS_EDGE_PATH: '/opt/custom/edge' },
        exists: fs.exists,
      }),
    ).toBe(CHROME_LINUX);
  });

  it('falls through to the known locations when the override is stale', () => {
    const fs = probe([CHROME_LINUX]);
    expect(
      findExecutable('chrome', {
        platform: 'linux',
        env: { BOS_CHROME_PATH: '/opt/gone/chrome' },
        exists: fs.exists,
      }),
    ).toBe(CHROME_LINUX);
  });

  it('treats an empty override as unset', () => {
    const fs = probe([]);
    findExecutable('chrome', { platform: 'linux', env: { BOS_CHROME_PATH: '' }, exists: fs.exists });
    expect(fs.probed()).toEqual([CHROME_LINUX, CHROME_LINUX_STABLE]);
  });
});

describe('win32 root defaults', () => {
  it('falls back to the standard Program Files paths when the root vars are unset', () => {
    const fs = probe([]);
    findExecutable('chrome', { platform: 'win32', env: {}, exists: fs.exists });
    expect(fs.probed()).toEqual([CHROME_WIN[0], CHROME_WIN[1]]);
  });
});

describe('defaultChannel', () => {
  it('prefers chrome', () => {
    expect(defaultChannel({ platform: 'linux', env: {}, exists: probe([CHROME_LINUX, EDGE_LINUX]).exists })).toBe(
      'chrome',
    );
  });

  it('falls back to msedge when chrome is missing', () => {
    expect(defaultChannel({ platform: 'linux', env: {}, exists: probe([EDGE_LINUX]).exists })).toBe('msedge');
  });

  it('falls back to chromium when neither is installed', () => {
    expect(defaultChannel({ platform: 'linux', env: {}, exists: probe([]).exists })).toBe('chromium');
  });

  it('stops probing once chrome is found', () => {
    const fs = probe([CHROME_LINUX, EDGE_LINUX]);
    defaultChannel({ platform: 'linux', env: {}, exists: fs.exists });
    expect(fs.probed()).toEqual([CHROME_LINUX]);
  });
});
