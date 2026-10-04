import { readdir } from 'node:fs/promises';
import { fakeClock, withFixtureServer, withTempBosHome } from '@browser-os/tests/helpers';
import { describe, expect, it } from 'vitest';

describe('test helpers', () => {
  it('withFixtureServer serves pages and always closes the server', async () => {
    let baseUrl = '';
    await withFixtureServer(async (server) => {
      baseUrl = server.baseUrl;
      const res = await fetch(`${server.baseUrl}/basic/`);
      expect(res.status).toBe(200);
    });
    // The server is closed after the callback: the port must no longer answer.
    await expect(fetch(`${baseUrl}/basic/`)).rejects.toThrow();
  });

  it('withTempBosHome points BOS_HOME at an empty temp dir and restores it', async () => {
    const before = process.env.BOS_HOME;
    let seen = '';
    await withTempBosHome(async (bosHome) => {
      seen = bosHome;
      expect(process.env.BOS_HOME).toBe(bosHome);
      expect(await readdir(bosHome)).toEqual([]);
    });
    expect(process.env.BOS_HOME).toBe(before);
    await expect(readdir(seen)).rejects.toThrow(); // cleaned up afterwards
  });

  it('fakeClock only moves when advanced', () => {
    const clock = fakeClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(250);
    expect(clock.now()).toBe(1250);
  });
});
