import { describe, expect, it } from 'vitest';
import { resolveBosHome } from '../src/index.js';

const WIN_HOME = 'C:\\Users\\kiell';
const NIX_HOME = '/home/kiell';

describe('resolveBosHome', () => {
  it('prefers BOS_HOME over everything else on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(resolveBosHome({ BOS_HOME: '/tmp/bos' }, platform, NIX_HOME), platform).toBe('/tmp/bos');
    }
  });

  it('ignores an empty BOS_HOME (an unset env var is often exported as "")', () => {
    expect(resolveBosHome({ BOS_HOME: '' }, 'linux', NIX_HOME)).toBe('/home/kiell/.local/share/browser-os');
  });

  it('strips trailing separators from an explicit BOS_HOME', () => {
    expect(resolveBosHome({ BOS_HOME: '/tmp/bos/' }, 'linux', NIX_HOME)).toBe('/tmp/bos');
    expect(resolveBosHome({ BOS_HOME: 'C:\\bos\\' }, 'win32', WIN_HOME)).toBe('C:\\bos');
  });

  it('uses %LOCALAPPDATA% on Windows', () => {
    expect(resolveBosHome({ LOCALAPPDATA: 'C:\\Users\\kiell\\AppData\\Local' }, 'win32', WIN_HOME)).toBe(
      'C:\\Users\\kiell\\AppData\\Local\\browser-os',
    );
  });

  it('falls back to <home>/AppData/Local on Windows when LOCALAPPDATA is missing or empty', () => {
    expect(resolveBosHome({}, 'win32', WIN_HOME)).toBe('C:\\Users\\kiell\\AppData\\Local\\browser-os');
    expect(resolveBosHome({ LOCALAPPDATA: '' }, 'win32', WIN_HOME)).toBe(
      'C:\\Users\\kiell\\AppData\\Local\\browser-os',
    );
  });

  it('does not double a separator when LOCALAPPDATA ends with one', () => {
    expect(resolveBosHome({ LOCALAPPDATA: 'C:\\Users\\kiell\\AppData\\Local\\' }, 'win32', WIN_HOME)).toBe(
      'C:\\Users\\kiell\\AppData\\Local\\browser-os',
    );
  });

  it('uses ~/Library/Application Support on macOS', () => {
    expect(resolveBosHome({}, 'darwin', '/Users/kiell')).toBe('/Users/kiell/Library/Application Support/browser-os');
  });

  it('uses XDG_DATA_HOME on Linux when set', () => {
    expect(resolveBosHome({ XDG_DATA_HOME: '/mnt/data' }, 'linux', NIX_HOME)).toBe('/mnt/data/browser-os');
  });

  it('falls back to ~/.local/share on Linux when XDG_DATA_HOME is missing or empty', () => {
    expect(resolveBosHome({}, 'linux', NIX_HOME)).toBe('/home/kiell/.local/share/browser-os');
    expect(resolveBosHome({ XDG_DATA_HOME: '' }, 'linux', NIX_HOME)).toBe('/home/kiell/.local/share/browser-os');
  });

  it('separates by the PLATFORM argument, not the host, so a win32 answer is a win32 path everywhere', () => {
    const win = resolveBosHome({ LOCALAPPDATA: 'C:\\AppData\\Local' }, 'win32', WIN_HOME);
    expect(win.includes('\\')).toBe(true);
    expect(win.includes('/')).toBe(false);

    for (const platform of ['linux', 'darwin'] as const) {
      const posix = resolveBosHome({}, platform, NIX_HOME);
      expect(posix.includes('\\'), platform).toBe(false);
      expect(posix.startsWith('/')).toBe(true);
    }
  });

  it('is pure: the same inputs always give the same answer and the env object is untouched', () => {
    const env = { XDG_DATA_HOME: '/mnt/data' };
    const snapshot = structuredClone(env);
    expect(resolveBosHome(env, 'linux', NIX_HOME)).toBe(resolveBosHome(env, 'linux', NIX_HOME));
    expect(env).toEqual(snapshot);
  });
});
