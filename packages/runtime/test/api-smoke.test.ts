// P7-07 — API smoke over a fixture with a fake model.
//
// Card tests: "API smoke over a fixture with a fake model"
// (docs/tasks/phase-07-router-and-tasks.md P7-07). Drives `createRuntime` +
// `createRuntimeApi` in-process — no daemon, no real browser — through the
// protocol §4 surface the runtime owns: profiles, sessions (a fake provider
// stands in for Chromium), the task lifecycle, trajectory management
// (get/export/delete/import) and stats. The model layer is `ModelRegistry`
// built from a `fake` provider config, so nothing here touches the network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRegistry } from '@browser-os/ai';
import type {
  BrowserHandle,
  BrowserProvider,
  CdpTransport,
  OpenOptions,
  PageDriver,
  PageHandle,
  ProviderCapabilities,
} from '@browser-os/browser';
import {
  BosError,
  BrowserProfileSchema,
  OkSchema,
  RPC_METHOD_NAMES,
  RPC_METHODS,
  SessionSchema,
  TaskSchema,
  type Trajectory,
  TrajectorySchema,
} from '@browser-os/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { createRuntimeApi, DAEMON_ONLY_METHODS } from '../src/api.js';
import type { Runtime } from '../src/runtime.js';
import { createRuntime } from '../src/runtime.js';

const homes: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bos-api-'));
  homes.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

function fakeRuntime() {
  const runtime = createRuntime(
    { models: { fast: { provider: 'fake', latencyMs: 1 }, capable: null, vision: null } },
    {
      bosHome: tempHome(),
      env: {},
      providers: { launch: new FakeProvider() },
      models: ModelRegistry.fromConfig({ fast: { provider: 'fake', latencyMs: 1 } }),
    },
  );
  return { runtime, api: createRuntimeApi(runtime, { env: {} }) };
}

/** A persisted recording is exactly what `task.end` of a real run would leave
 * behind; the fixture writes one so the trajectory.* methods have a row. */
function createRecordedFixture(runtime: Runtime): Trajectory {
  const store = runtime.trajectories;
  if (store === null) throw new Error('fixture runtime must persist');
  return store.createRecorded({
    taskKey: 'shop.smoke',
    origin: 'https://shop.test',
    startUrl: 'https://shop.test/',
    params: ['product'],
    secretNames: [],
    steps: [
      {
        index: 0,
        action: { type: 'navigate', url: 'https://shop.test/buy/{{product}}' },
        intent: null,
        pre: { urlPattern: '/' },
        risk: 'low',
      },
    ],
  });
}

describe('RuntimeApi smoke over a fixture with a fake model (P7-07)', () => {
  it('profile + session + task lifecycle + trajectory management round-trip through protocol types', async () => {
    const { runtime, api } = fakeRuntime();
    try {
      // profiles: create then list sees it (BrowserProfileSchema per §4).
      const profile = await api['profile.create']({ name: 'smoke' });
      BrowserProfileSchema.parse(profile);
      expect((await api['profile.list']({})).map((p) => p.name)).toContain('smoke');

      // sessions open against the fake provider; the fixture seeds a page.
      const session = await api['session.open']({ profile: 'smoke', headless: true });
      SessionSchema.parse(session);
      expect(session.status).toBe('ready');

      // task lifecycle over the in-process api.
      const task = await api['task.start']({ sessionId: session.id, key: 'shop.smoke', mode: 'record' });
      TaskSchema.parse(task);
      expect(task).toMatchObject({ mode: 'record', resolvedMode: 'record', status: 'running' });
      await expect(api['task.get']({ taskId: task.id })).resolves.toMatchObject({ id: task.id });

      // a second start on the same session is the §7 refusal, surfaced as a BosError.
      await expect(api['task.start']({ sessionId: session.id, key: 'shop.other' })).rejects.toBeInstanceOf(BosError);

      // S13: a failed recording leaves no trajectory behind.
      const failed = await api['task.end']({ taskId: task.id, success: false });
      expect(failed.status).toBe('failed');
      await expect(api['trajectory.get']({ key: 'shop.smoke' })).rejects.toMatchObject({
        code: 'TRAJECTORY_NOT_FOUND',
      });

      // the fixture stands in for a successful recording end.
      const seeded = createRecordedFixture(runtime);
      expect((await api['task.list']({ key: 'shop.smoke' })).map((t) => t.id)).toContain(task.id);

      // trajectory management: get / export (no secrets by construction) / import.
      const got = await api['trajectory.get']({ key: 'shop.smoke' });
      TrajectorySchema.parse(got);
      expect(got.id).toBe(seeded.id);

      const { json } = await api['trajectory.export']({ key: 'shop.smoke' });
      expect(JSON.parse(json)).toMatchObject({ taskKey: 'shop.smoke', version: 1 });

      OkSchema.parse(await api['trajectory.delete']({ key: 'shop.smoke' }));
      await expect(api['trajectory.get']({ key: 'shop.smoke' })).rejects.toMatchObject({
        code: 'TRAJECTORY_NOT_FOUND',
      });
      const reimported = await api['trajectory.import']({ json });
      TrajectorySchema.parse(reimported);
      expect((await api['trajectory.list']({ taskKey: 'shop.smoke' })).map((t) => t.id)).toContain(reimported.id);

      // stats answers through the same surface (runs table is empty but shaped);
      // the schema is taken from RPC_METHODS itself — the AC pin, not a copy.
      const stats = await api['stats.get']({});
      expect(RPC_METHODS['stats.get'].result.safeParse(stats).success).toBe(true);

      // cache + human + permission query methods answer with protocol shapes.
      expect(await api['cache.list']({})).toEqual([]);
      expect(await api['cache.clear']({})).toEqual({ deleted: 0 });
      expect(await api['human.pending']({})).toEqual([]);
      expect(await api['permission.pending']({})).toEqual([]);

      OkSchema.parse(await api['session.close']({ sessionId: session.id }));
    } finally {
      await runtime.shutdown();
    }
  });

  it('every protocol §4 method except the daemon trio exists on RuntimeApi (AC: names match RPC_METHODS)', async () => {
    const api = fakeRuntime().api;
    const expected = RPC_METHOD_NAMES.filter((m) => !(DAEMON_ONLY_METHODS as readonly string[]).includes(m));
    expect(expected.length).toBe(33); // 36 RPC methods minus the daemon trio
    for (const name of expected) expect(typeof (api as unknown as Record<string, unknown>)[name]).toBe('function');
  });

  it('store refusals are BosErrors with routed codes (unknown task, key, session)', async () => {
    const { runtime, api } = fakeRuntime();
    try {
      await expect(api['task.get']({ taskId: 'tsk_missing' })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      await expect(api['trajectory.get']({ key: 'shop.none' })).rejects.toMatchObject({
        code: 'TRAJECTORY_NOT_FOUND',
      });
      await expect(api['session.get']({ sessionId: 'ses_missing' })).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    } finally {
      await runtime.shutdown();
    }
  });
});

// --- fixture doubles (same shape as session-manager.test.ts, trimmed) ------

const CAPABILITIES: ProviderCapabilities = {
  persistentProfile: true,
  screenshots: true,
  oopif: true,
  headful: true,
  uploads: true,
  downloads: true,
};

class FakePage implements PageHandle {
  readonly id = `pg_${Math.random().toString(36).slice(2, 10)}`;
  #url = 'https://shop.test/';
  readonly #closed = new Set<() => void>();
  readonly #navigated = new Set<(payload: unknown) => void>();
  #transport: CdpTransport | null = null;

  url(): string {
    return this.#url;
  }
  async title(): Promise<string> {
    return 'fixture';
  }
  opener(): PageHandle | null {
    return null;
  }
  async cdp(): Promise<CdpTransport> {
    const page = this;
    this.#transport ??= {
      async send(method: string, params?: Record<string, unknown>) {
        if (method === 'Page.navigate') {
          page.#url = String(params?.url);
          for (const listener of [...page.#navigated]) listener({ frame: { id: 'F1' } });
        }
        return {};
      },
      on(event: string, listener: (payload: unknown) => void) {
        if (event !== 'Page.frameNavigated') return () => {};
        page.#navigated.add(listener);
        return () => {
          page.#navigated.delete(listener);
        };
      },
    };
    return this.#transport;
  }
  driver(): PageDriver {
    throw new BosError('INTERNAL', 'no driver in the api smoke fixture', {});
  }
  async bringToFront(): Promise<void> {}
  async close(): Promise<void> {
    for (const cb of [...this.#closed]) cb();
  }
  onClose(cb: () => void): () => void {
    this.#closed.add(cb);
    return () => {
      this.#closed.delete(cb);
    };
  }
}

class FakeHandle implements BrowserHandle {
  readonly pid: number | null = null;
  readonly pagesById: FakePage[];
  constructor(pages: FakePage[]) {
    this.pagesById = pages;
  }
  pages(): PageHandle[] {
    return [...this.pagesById];
  }
  async newPage(): Promise<PageHandle> {
    const page = new FakePage();
    this.pagesById.push(page);
    return page;
  }
  onPage(): () => void {
    return () => {};
  }
  onDisconnected(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

class FakeProvider implements BrowserProvider {
  readonly kind = 'launch' as const;
  readonly capabilities = CAPABILITIES;
  async open(_opts: OpenOptions): Promise<BrowserHandle> {
    return new FakeHandle([new FakePage()]);
  }
}
