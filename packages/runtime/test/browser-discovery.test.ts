import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { discoverBrowser, type BrowserInfo } from '../src/browser-discovery.js';
import { BosError } from '@browser-os/protocol';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  Object.keys(process.env).forEach((k) => {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  });
  Object.assign(process.env, ORIGINAL_ENV);
}

describe('discoverBrowser', () => {
  beforeEach(() => {
    resetEnv();
    vi.resetModules();
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
  });

  it('returns Chrome info when CHROME_PATH is set', async () => {
    process.env.CHROME_PATH = '/fake/chrome';
    const info = await discoverBrowser();
    expect(info).toEqual({
      path: '/fake/chrome',
      vendor: 'chrome',
      version: 'unknown',
    });
  });

  it('returns Edge info when EDGE_PATH is set', async () => {
    process.env.EDGE_PATH = '/fake/edge';
    const info = await discoverBrowser();
    expect(info).toEqual({
      path: '/fake/edge',
      vendor: 'edge',
      version: 'unknown',
    });
  });

  it('falls back to BROWSER_PATH when no vendor-specific var is set', async () => {
    process.env.BROWSER_PATH = '/fake/browser';
    const info = await discoverBrowser();
    expect(info).toEqual({
      path: '/fake/browser',
      vendor: 'unknown',
      version: 'unknown',
    });
  });

  it('throws BROWSER_NOT_FOUND when nothing is configured', async () => {
    // Clear all browser-related env vars to ensure a clean state
    const originalChrome = process.env.CHROME_PATH;
    const originalEdge = process.env.EDGE_PATH;
    const originalBrowser = process.env.BROWSER_PATH;
    delete process.env.CHROME_PATH;
    delete process.env.EDGE_PATH;
    delete process.env.BROWSER_PATH;

    try {
      await expect(discoverBrowser()).rejects.toThrow(BosError);
      await expect(discoverBrowser()).rejects.toThrow('BROWSER_NOT_FOUND');
    } finally {
      // Restore original values
      if (originalChrome) process.env.CHROME_PATH = originalChrome;
      if (originalEdge) process.env.EDGE_PATH = originalEdge;
      if (originalBrowser) process.env.BROWSER_PATH = originalBrowser;
    }
  });

  it('includes tried locations in the error message', async () => {
    try {
      await discoverBrowser();
    } catch (e) {
      expect((e as Error).message).toMatch(/Chrome|Edge|Chromium/);
    }
  });
});