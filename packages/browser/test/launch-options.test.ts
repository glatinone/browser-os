import type { BrowserProfile } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import { buildLaunchOptions } from '../src/providers/launch-provider.js';

function profile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    id: 'prf_test',
    name: 'test',
    channel: 'chrome',
    userDataDir: '/bos/profiles/test',
    headless: false,
    createdAt: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

/** SECURITY §2 S4 ran against every channel, so a new channel cannot slip through. */
const CHANNELS = ['chrome', 'msedge', 'chromium'] as const;

describe('buildLaunchOptions', () => {
  it.each(CHANNELS)('uses exactly the profile channel (%s)', (channel) => {
    expect(buildLaunchOptions(profile({ channel })).channel).toBe(channel);
  });

  it('defaults the viewport to null, which means the window size', () => {
    expect(buildLaunchOptions(profile()).viewport).toBeNull();
  });

  it('passes an explicit viewport through', () => {
    const viewport = { width: 1280, height: 720 };
    expect(buildLaunchOptions(profile(), { viewport }).viewport).toEqual(viewport);
  });

  it('accepts downloads', () => {
    expect(buildLaunchOptions(profile()).acceptDownloads).toBe(true);
  });

  it('follows the profile headless flag', () => {
    expect(buildLaunchOptions(profile({ headless: true })).headless).toBe(true);
    expect(buildLaunchOptions(profile({ headless: false })).headless).toBe(false);
  });

  it('lets the caller override headless', () => {
    expect(buildLaunchOptions(profile({ headless: false }), { headless: true }).headless).toBe(true);
  });
});

describe('buildLaunchOptions — S4 (nothing hides automation)', () => {
  it.each(CHANNELS)('never overrides args, user agent or automation flags (%s)', (channel) => {
    const options = buildLaunchOptions(profile({ channel })) as Record<string, unknown>;

    expect(options).not.toHaveProperty('ignoreDefaultArgs');
    expect(options).not.toHaveProperty('userAgent');
    expect(options).not.toHaveProperty('args');
  });

  it.each(CHANNELS)('carries no stealth or debugging flag anywhere (%s)', (channel) => {
    const serialized = JSON.stringify(buildLaunchOptions(profile({ channel })));

    for (const forbidden of [
      '--enable-automation',
      'AutomationControlled',
      '--remote-debugging-port',
      '--remote-debugging-pipe',
      'userAgent',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
