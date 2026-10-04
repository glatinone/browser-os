// Where Browser-OS keeps its data (specs/memory.md §2).
//
// Pure by construction: environment, platform and home directory are injected, so
// the result is testable for all three OSes on any host — and there is no way for
// a caller to accidentally read the real process environment through this module.
// The separator follows the *platform argument*, never the host, so a win32 answer
// is a win32 path even when the tests run on Linux.

export type BosPlatform = 'win32' | 'darwin' | 'linux';

const APP_DIR = 'browser-os';

function joinFor(platform: BosPlatform, ...parts: string[]): string {
  const separator = platform === 'win32' ? '\\' : '/';
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? stripTrailing(part) : stripSlashes(part)))
    .join(separator);
}

function stripTrailing(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

function stripSlashes(p: string): string {
  return p.replace(/^[\\/]+|[\\/]+$/g, '');
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * `<BOS_HOME>`: the explicit env var if set, otherwise the platform default
 * (Windows `%LOCALAPPDATA%`, macOS `~/Library/Application Support`,
 * Linux `${XDG_DATA_HOME:-~/.local/share}`).
 */
export function resolveBosHome(
  env: Record<string, string | undefined>,
  platform: BosPlatform,
  homedir: string,
): string {
  const explicit = nonEmpty(env.BOS_HOME);
  if (explicit !== undefined) return stripTrailing(explicit);

  if (platform === 'win32') {
    const localAppData = nonEmpty(env.LOCALAPPDATA) ?? joinFor('win32', homedir, 'AppData', 'Local');
    return joinFor('win32', localAppData, APP_DIR);
  }

  if (platform === 'darwin') {
    return joinFor('darwin', homedir, 'Library', 'Application Support', APP_DIR);
  }

  const xdg = nonEmpty(env.XDG_DATA_HOME) ?? joinFor('linux', homedir, '.local', 'share');
  return joinFor('linux', xdg, APP_DIR);
}
