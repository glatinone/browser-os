import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CdpEndpointProvider } from '../src/providers/cdp-endpoint-provider.js';
import { dummyProfile } from './support/dummy-profile.js';

interface SpawnedChrome {
  /** What a power user would copy out of their own Chrome: `http://127.0.0.1:<port>`. */
  readonly endpoint: string;
  readonly port: string;
  stop(): Promise<void>;
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(file, 'utf8');
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Asks the browser directly, rather than through Playwright, whether it is still up. */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve(body));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error(`timed out asking ${url}`)));
  });
}

/**
 * Starts a Chromium the way a power user would — `--remote-debugging-port=0` over its own
 * user-data-dir — and reads the chosen port back out of `DevToolsActivePort`.
 */
async function spawnChromeWithDebugPort(): Promise<SpawnedChrome> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'bos-cdp-'));
  const child: ChildProcess = spawn(
    chromium.executablePath(),
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--headless',
      '--no-first-run',
      '--no-default-browser-check',
      // Playwright always launches Chromium with the sandbox off (`chromiumSandbox` defaults
      // to false); a raw spawn does not, and the sandboxed browser is the one that refuses to
      // start on a CI runner. The shared-memory flag is the other container staple.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Keep what the browser says. A silent spawn leaves us guessing, and this only ever fails
  // on a machine we are not sitting at.
  let log = '';
  let exited: string | null = null;
  child.stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.on('exit', (code) => {
    exited = `the browser exited with code ${code}`;
  });

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  try {
    await waitForFile(portFile, 30000);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}${exited === null ? '' : `; ${exited}`}\n${log}`);
  }

  const port = (await readFile(portFile, 'utf8')).split('\n')[0]?.trim();
  if (port === undefined || port === '') throw new Error('DevToolsActivePort carried no port');

  return {
    endpoint: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      child.kill();
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    },
  };
}

describe('CdpEndpointProvider (browser)', () => {
  let chrome: SpawnedChrome;

  beforeEach(async () => {
    chrome = await spawnChromeWithDebugPort();
  }, 60000);

  afterEach(async () => {
    await chrome.stop();
  });

  it('attaches to a browser it did not start and lists its pages', async () => {
    const provider = new CdpEndpointProvider();

    const handle = await provider.open({ profile: dummyProfile(), cdpEndpoint: chrome.endpoint });

    expect(handle.pages().length).toBeGreaterThanOrEqual(1);
    expect(handle.pid).toBeNull();
    await handle.close();
  });

  it('opens pages in the attached browser', async () => {
    const provider = new CdpEndpointProvider();
    const handle = await provider.open({ profile: dummyProfile(), cdpEndpoint: chrome.endpoint });
    const before = handle.pages().length;

    const page = await handle.newPage();

    expect(page.id).toMatch(/^pg_/);
    expect(handle.pages().length).toBe(before + 1);
    await handle.close();
  });

  it('disconnects without stopping the browser', async () => {
    const provider = new CdpEndpointProvider();
    const handle = await provider.open({ profile: dummyProfile(), cdpEndpoint: chrome.endpoint });

    await handle.close();

    // The browser answers for itself: if close() had stopped the process, nothing would be
    // listening on the port any more (`ownership: 'attached'`, browser-runtime §2).
    const version = JSON.parse(await httpGet(`http://127.0.0.1:${chrome.port}/json/version`)) as { Browser?: string };
    expect(version.Browser).toContain('Chrome');
  });
});
