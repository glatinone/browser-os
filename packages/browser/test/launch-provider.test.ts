import type { BrowserProfile } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { LaunchProvider, type LaunchProviderDeps } from '../src/providers/launch-provider.js';

function profile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    id: 'prf_test',
    name: 'test',
    channel: 'chrome',
    userDataDir: '/bos/profiles/test',
    headless: true,
    createdAt: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

function deps(overrides: Partial<LaunchProviderDeps> = {}): LaunchProviderDeps {
  return {
    findExecutable: () => '/usr/bin/google-chrome',
    isProfileLocked: async () => false,
    ...overrides,
  };
}

describe('LaunchProvider', () => {
  it('reports the launch kind and full capabilities', () => {
    const provider = new LaunchProvider(deps());
    expect(provider.kind).toBe('launch');
    expect(provider.capabilities).toEqual({
      persistentProfile: true,
      screenshots: true,
      oopif: true,
      headful: true,
      uploads: true,
      downloads: true,
    });
  });
});

// These two checks run before Playwright is touched, so the provider can be tested
// without a browser. That they are *raised* is the contract; whether the lock is
// really held is P2-02's job.
describe('LaunchProvider.open pre-flight', () => {
  it('raises BROWSER_NOT_FOUND when the profile channel is not installed', async () => {
    const provider = new LaunchProvider(deps({ findExecutable: () => null }));

    await expect(provider.open({ profile: profile({ channel: 'msedge' }) })).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
    });
  });

  it('raises PROFILE_LOCKED when another process owns the profile', async () => {
    const provider = new LaunchProvider(deps({ isProfileLocked: async () => true }));

    await expect(provider.open({ profile: profile() })).rejects.toMatchObject({
      code: 'PROFILE_LOCKED',
    });
  });

  it('checks the lock with the profile own user-data-dir', async () => {
    const isProfileLocked = vi.fn(async () => true);
    const provider = new LaunchProvider(deps({ isProfileLocked }));

    await provider.open({ profile: profile({ userDataDir: '/bos/profiles/work' }) }).catch(() => {});

    expect(isProfileLocked).toHaveBeenCalledWith('/bos/profiles/work');
  });

  it('never looks up an executable for the chromium channel', async () => {
    const findExecutable = vi.fn(() => null);
    // chromium is the one channel allowed to use Playwright's bundled build, so the
    // lookup is skipped and the next check (the lock) is what fires.
    const provider = new LaunchProvider(deps({ findExecutable, isProfileLocked: async () => true }));

    await expect(provider.open({ profile: profile({ channel: 'chromium' }) })).rejects.toMatchObject({
      code: 'PROFILE_LOCKED',
    });
    expect(findExecutable).not.toHaveBeenCalled();
  });

  it('does not report BROWSER_NOT_FOUND for chromium when no system build exists', async () => {
    const provider = new LaunchProvider(deps({ findExecutable: () => null, isProfileLocked: async () => true }));

    const error = await provider.open({ profile: profile({ channel: 'chromium' }) }).catch((e) => e);

    expect(error.code).not.toBe('BROWSER_NOT_FOUND');
  });
});
