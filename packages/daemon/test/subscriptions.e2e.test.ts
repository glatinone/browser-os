// P8-02 — subscriptions over the REAL socket: the card's bullets proven
// end-to-end through server.ts.
//
//   * events.subscribe registers a filter PER CONNECTION (two sockets, two
//     filters, different deliveries — including concurrent subscribes).
//   * a subscription is removed on disconnect (no frames, no hub leaks).
//   * with a hub installed, send() is subscribe-only; without one the P8-01
//     fan-out still holds (regression guard on the same file).
//   * system.shutdown over the wire: reply arrives BEFORE the teardown hook.

import { type BosEvent, PROTOCOL_VERSION } from '@browser-os/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { allowAllAuth, createDaemonApi, type RunningServer, startServer } from '../src/index.js';
import { createSubscriptionHub } from '../src/subscriptions.js';

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];

async function shutdownAll(): Promise<void> {
  for (const ws of sockets.splice(0)) ws.terminate();
  while (servers.length > 0) await (servers.pop() as RunningServer).close();
}
afterEach(shutdownAll);
afterAll(shutdownAll);

const echoApi = {
  'profile.list': async () => [],
};

interface Harness {
  server: RunningServer;
  hub: ReturnType<typeof createSubscriptionHub>;
  /** Wire a live client socket to the server. */
  connect(): Promise<Client>;
}

interface Client {
  ws: WebSocket;
  port: number;
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  /** Resolve with the next `event` notification frame (params object). */
  nextEvent(): Promise<BosEvent>;
  /** Resolve with every event notification frame until quiet for 150 ms. */
  eventsUntilQuiet(): Promise<BosEvent[]>;
  closed: Promise<number>;
}

async function harness(options: { hub?: boolean } = {}): Promise<Harness> {
  const hub = options.hub === false ? undefined : createSubscriptionHub();
  const daemon = hub ? createDaemonApi(echoApi as never, hub, { version: 'p8-02-test', pid: 1 }) : null;
  const server = await startServer({
    api: (daemon?.api ?? echoApi) as never,
    auth: allowAllAuth,
    ...(hub === undefined ? {} : { subscriptions: hub }),
  });
  servers.push(server);

  // The server attaches sockets itself; mirror the dispatch scope by routing
  // through its hub exactly as server.ts does internally. (server.ts owns
  // runWithConnection; nothing to do here.)
  async function connect(): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}/rpc`);
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    let nextId = 1;
    const waiters: ((msg: Record<string, unknown>) => void)[] = [];
    const events: BosEvent[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.method === 'event') {
        events.push(msg.params as BosEvent);
        return;
      }
      waiters.shift()?.(msg);
    });
    return {
      ws,
      port: server.port(),
      request: (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = nextId;
          nextId += 1;
          const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 3000);
          waiters.push((msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        }),
      nextEvent: () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no event in time')), 3000);
          const poll = setInterval(() => {
            if (events.length > 0) {
              clearInterval(poll);
              clearTimeout(timer);
              resolve(events.shift() as BosEvent);
            }
          }, 5);
        }),
      eventsUntilQuiet: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return events.splice(0);
      },
      closed,
    };
  }
  return { server, hub: hub ?? createSubscriptionHub(), connect };
}

const minimalTask = {
  id: 'tsk_test',
  key: 'test.task',
  sessionId: 'ses_x',
  mode: 'auto',
  resolvedMode: 'record',
  params: {},
  secretNames: [],
  status: 'running',
  trajectoryId: null,
  startedAt: 1,
  endedAt: null,
  stats: {
    actions: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    visionCalls: 0,
    humanInterventions: 0,
    cacheHits: 0,
    healedSteps: 0,
    ms: 0,
  },
} as const;

const ev = (type: string, sessionId?: string): BosEvent =>
  ({
    ts: 1,
    type,
    ...(sessionId === undefined ? {} : { sessionId }),
    data: type.startsWith('task.') ? { task: minimalTask } : { key: 'k' },
  }) as BosEvent;

describe('events.subscribe over the wire', () => {
  it('filters per connection: types, sessionId, and the unsubscribed socket', async () => {
    const h = await harness();
    const a = await h.connect(); // wants task.* only
    const b = await h.connect(); // wants ses_a only
    const c = await h.connect(); // subscribes to nothing

    await a.request('events.subscribe', { types: ['task.started', 'task.completed'] });
    await b.request('events.subscribe', { sessionId: 'ses_a' });

    h.server.send(ev('task.started', 'ses_b'));
    h.server.send(ev('cache.hit'));
    h.server.send(ev('task.completed', 'ses_a'));

    const gotA = await a.eventsUntilQuiet();
    const gotB = await b.eventsUntilQuiet();
    const gotC = await c.eventsUntilQuiet();

    expect(gotA.map((e) => e.type)).toEqual(['task.started', 'task.completed']);
    expect(gotB.map((e) => e.type)).toEqual(['task.completed']);
    expect(gotC).toEqual([]);
  });

  it('concurrent subscribes from two sockets land on their OWN connections', async () => {
    const h = await harness();
    const a = await h.connect();
    const b = await h.connect();
    const [ra, rb] = await Promise.all([
      a.request('events.subscribe', { types: ['cache.hit'] }),
      b.request('events.subscribe', { types: ['download.completed'] }),
    ]);
    expect(ra.error).toBeUndefined();
    expect(rb.error).toBeUndefined();
    expect(h.hub.subscriptionCount()).toBe(2);

    h.server.send(ev('cache.hit'));
    expect((await a.eventsUntilQuiet()).map((e) => e.type)).toEqual(['cache.hit']);
    expect(await b.eventsUntilQuiet()).toEqual([]);
  });

  it('a disconnect removes the subscription: no more frames, no hub leak', async () => {
    const h = await harness();
    const a = await h.connect();
    await a.request('events.subscribe', {});
    expect(h.hub.subscriptionCount()).toBe(1);

    a.ws.close();
    await a.closed;
    // Give the server's close handler a turn, then check the books.
    await new Promise((r) => setTimeout(r, 100));
    expect(h.hub.subscriptionCount()).toBe(0);

    // Publishing after the disconnect must not blow up and must find no
    // eligible connection.
    expect(h.hub.publish(ev('cache.hit'), 'x')).toBe(0);
  });

  it('subscribe-only with a hub; P8-01 fan-out without one', async () => {
    const bare = await harness({ hub: false });
    const x = await bare.connect();
    bare.server.send(ev('cache.hit'));
    expect((await x.eventsUntilQuiet()).map((e) => e.type)).toEqual(['cache.hit']); // P8-01 contract intact
  });

  it('malformed filters fail params validation, the socket stays alive', async () => {
    const h = await harness();
    const a = await h.connect();
    const reply = await a.request('events.subscribe', { types: 'cache.hit' });
    expect((reply.error as { code: number }).code).toBe(-32602);
    const ok = await a.request('system.hello', { client: 't', protocolVersion: PROTOCOL_VERSION });
    expect(ok.result).toMatchObject({ version: 'p8-02-test' });
  });
});

describe('system.shutdown over the wire', () => {
  it('answers { ok: true } and runs teardown right after (socket side)', async () => {
    let torn = 0;
    const hub = createSubscriptionHub();
    const daemon = createDaemonApi(echoApi as never, hub, {
      version: 'p8-02-test',
      onShutdown: () => {
        torn += 1;
      },
    });
    const server = await startServer({ api: daemon.api as never, auth: allowAllAuth, subscriptions: hub });
    servers.push(server);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}/rpc`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.shutdown', params: {} }));
    });
    // The socket's ordering contract: the reply is a normal frame that
    // arrives and is delivered without the socket dying first. The
    // handler-side ordering (closeSessions before ack, onShutdown after the
    // ack is produced) is pinned deterministically in handlers.test.ts —
    // over the wire the host's microtask races frame delivery.
    expect(reply.result).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(torn).toBe(1);
  });
});

// server.ts owns runWithConnection; the hub and the handle contract are
// re-exported from the package index for P8-03's composition root.
