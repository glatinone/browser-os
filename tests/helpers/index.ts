import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type FixtureServer, startFixtureServer } from '@browser-os/fixtures/server';
import type { Clock } from '@browser-os/protocol';

/** Starts the fixture server, runs `fn`, and always closes it. */
export async function withFixtureServer<T>(fn: (server: FixtureServer) => Promise<T>): Promise<T> {
  const server = await startFixtureServer();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

/** Runs `fn` with BOS_HOME pointed at a fresh temp dir (TESTING.md §8: never share profiles). */
export async function withTempBosHome<T>(fn: (bosHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bos-home-'));
  const previous = process.env.BOS_HOME;
  process.env.BOS_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.BOS_HOME;
    else process.env.BOS_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deterministic Clock for tests. Advance it explicitly; it never runs on its own. */
export function fakeClock(startMs = 0): Clock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
