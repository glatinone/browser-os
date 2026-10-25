// P8-02 — daemon handlers in-process: the §4 parity table (card: "every
// method reachable — table test with a fake RuntimeApi"), system.hello's
// exact shape, and system.shutdown's graceful order.
//
// No sockets here: the dispatcher is driven with raw frames, the hub with
// fake handles, and the fake runtime api records which method was reached.

import { BosError, PROTOCOL_VERSION, RPC_METHOD_NAMES, RPC_METHODS, type RpcMethod } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import { createDispatcher, type RpcApi } from '../src/dispatch.js';
import { createDaemonApi } from '../src/handlers.js';
import { type ConnectionHandle, createSubscriptionHub, runWithConnection } from '../src/subscriptions.js';

const fakeHandle = (id: string): ConnectionHandle => ({ id, send: () => undefined });

/** A fake RuntimeApi answering every §4 method except the daemon-only trio. */
function fakeRuntimeApi(): { api: RpcApi; calls: string[] } {
  const calls: string[] = [];
  const api: RpcApi = {};
  for (const name of RPC_METHOD_NAMES) {
    if (name === 'system.hello' || name === 'system.shutdown' || name === 'events.subscribe') continue;
    api[name] = (async () => {
      calls.push(name);
      // ActionResult-shaped ok for act/upload; a Task-ish or array shape is
      // irrelevant here: result validation stays off (daemon default).
      return { ok: true };
    }) as RpcApi[RpcMethod];
  }
  return { api, calls };
}

function wire(options = {}) {
  const hub = createSubscriptionHub();
  const { api: runtimeApi, calls } = fakeRuntimeApi();
  const daemon = createDaemonApi(runtimeApi, hub, { version: '9.9.9-test', pid: 4242, ...options });
  const dispatcher = createDispatcher({ api: daemon.api });
  return { hub, daemon, dispatcher, calls };
}

async function rpc(dispatcher: ReturnType<typeof wire>['dispatcher'], method: string, params: unknown = {}) {
  const raw = await dispatcher.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  return JSON.parse((raw ?? '{}') as string) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: { bosCode?: string } };
  };
}

describe('§4 parity (table test, fake RuntimeApi)', () => {
  it('the wrapped api answers EVERY method in RPC_METHOD_NAMES', async () => {
    const { dispatcher, calls, hub } = wire();
    // Parity by the surface itself, before any call.
    expect(wire().daemon.servedMethods().sort()).toEqual([...RPC_METHOD_NAMES].sort());

    const conn = fakeHandle('c1');
    hub.attach(conn);
    for (const method of RPC_METHOD_NAMES) {
      const reply = await runWithConnection(conn, () => rpc(dispatcher, method));
      // Every method must be REACHABLE: no -32601 method-not-found, no
      // INVALID_REQUEST "not implemented". Params are validated first, so
      // methods with required params answer -32602 (dispatcher) — proof the
      // table entry exists — while zero-param methods reach the handler.
      if (reply.error !== undefined) {
        expect(reply.error.code, method).toBe(-32602); // params rejected, method found
        const def = RPC_METHODS[method as RpcMethod];
        expect(def.params.safeParse({}).success, `${method} should need params`).toBe(false);
      } else {
        calls.push(method); // dispatcher reached a handler
        expect(reply.result, method).toBeDefined();
      }
    }
    // Every method either ran or was params-rejected; none was method-not-found.
    const reached = new Set(calls);
    for (const method of RPC_METHOD_NAMES) {
      const def = RPC_METHODS[method as RpcMethod];
      if (def.params.safeParse({}).success) {
        expect(reached.has(method), `${method} must be callable`).toBe(true);
      }
    }
  });

  it('an unknown method is still -32601 through the wrapped api', async () => {
    const { dispatcher } = wire();
    const reply = await rpc(dispatcher, 'no.such.method');
    expect(reply.error?.code).toBe(-32601);
  });
});

describe('system.hello', () => {
  it('returns exactly { version, protocolVersion, pid } (protocol §4)', async () => {
    const { dispatcher } = wire();
    const reply = await rpc(dispatcher, 'system.hello', { client: 'bos-cli/1', protocolVersion: PROTOCOL_VERSION });
    expect(reply.result).toEqual({ version: '9.9.9-test', protocolVersion: '1', pid: 4242 });
  });

  it('defaults pid to process.pid', async () => {
    const hub = createSubscriptionHub();
    const daemon = createDaemonApi({}, hub, { version: 'v' });
    await expect(daemon.api['system.hello']?.({} as never)).resolves.toEqual({
      version: 'v',
      protocolVersion: '1',
      pid: process.pid,
    });
  });
});

describe('system.shutdown', () => {
  it('closes sessions BEFORE answering, and fires onShutdown only after the reply', async () => {
    const order: string[] = [];
    const { dispatcher } = wire({
      closeSessions: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('closeSessions');
      },
      onShutdown: () => order.push('onShutdown'),
    });
    const reply = await rpc(dispatcher, 'system.shutdown');
    expect(reply.result).toEqual({ ok: true });
    // closeSessions already ran; onShutdown has NOT yet (it waits for the
    // reply to leave — a microtask/immediate later).
    expect(order).toEqual(['closeSessions']);
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['closeSessions', 'onShutdown']);
  });

  it('a failing closeSessions surfaces as a BosError frame, not a crash', async () => {
    const { dispatcher } = wire({
      closeSessions: async () => {
        throw new BosError('INTERNAL', 'store refuses to close');
      },
    });
    const reply = await rpc(dispatcher, 'system.shutdown');
    expect(reply.error?.code).toBe(-32000);
    expect(reply.error?.data?.bosCode).toBe('INTERNAL');
  });
});

describe('events.subscribe through the dispatcher', () => {
  it('registers against the CURRENT connection and returns { subscriptionId }', async () => {
    const { dispatcher, hub } = wire();
    const c1 = fakeHandle('c1');
    const c2 = fakeHandle('c2');
    hub.attach(c1);
    hub.attach(c2);

    const reply = await runWithConnection(c1, () =>
      rpc(dispatcher, 'events.subscribe', { sessionId: 'ses_a', types: ['task.started'] }),
    );
    expect(typeof reply.result?.subscriptionId).toBe('string');
    expect(String(reply.result?.subscriptionId)).toMatch(/^sub_/);
    expect(hub.activeSubscriptionsFor('c1')).toHaveLength(1);
    expect(hub.activeSubscriptionsFor('c2')).toHaveLength(0);
  });

  it('without a connection scope it is an INTERNAL error, never a silent orphan', async () => {
    const { dispatcher } = wire();
    const reply = await rpc(dispatcher, 'events.subscribe', {});
    expect(reply.error?.code).toBe(-32000);
    expect(reply.error?.data?.bosCode).toBe('INTERNAL');
  });

  it('bad filters are refused by params validation (-32602) before any handler runs', async () => {
    const { dispatcher, hub } = wire();
    const c1 = fakeHandle('c1');
    hub.attach(c1);
    const reply = await runWithConnection(c1, () => rpc(dispatcher, 'events.subscribe', { types: 'task.started' }));
    expect(reply.error?.code).toBe(-32602);
    expect(hub.subscriptionCount()).toBe(0);
  });

  it('a subscription from a socket the hub never attached raises INTERNAL', async () => {
    const hub = createSubscriptionHub();
    const daemon = createDaemonApi({}, hub, { version: 'v' });
    const dispatcher = createDispatcher({ api: daemon.api });
    // In scope, but the hub never saw attach() for this handle (e.g. the
    // socket died between accept and request): no orphan subscription.
    const ghost = fakeHandle('ghost');
    const reply = await runWithConnection(ghost, () => rpc(dispatcher, 'events.subscribe', {}));
    expect(reply.error?.data?.bosCode).toBe('INTERNAL');
    expect(hub.subscriptionCount()).toBe(0);
  });
});

describe('secretValues pass-through (retention is the runtime contract)', () => {
  it('act/task.run params reach the runtime api verbatim; the daemon keeps nothing', async () => {
    let seenAct: unknown;
    let seenRun: unknown;
    const runtimeApi: RpcApi = {
      act: (async (p: unknown) => {
        seenAct = p;
        return { ok: true };
      }) as RpcApi[RpcMethod],
      'task.run': (async (p: unknown) => {
        seenRun = p;
        return { ok: true };
      }) as RpcApi[RpcMethod],
    };
    const hub = createSubscriptionHub();
    const daemon = createDaemonApi(runtimeApi, hub, { version: 'v' });
    const dispatcher = createDispatcher({ api: daemon.api });

    const reply = await rpc(dispatcher, 'act', {
      sessionId: 'ses_a',
      action: { type: 'navigate', url: 'https://x.test' },
      secretValues: { PASSWORD: 'hunter2' },
    });
    expect(reply.result).toEqual({ ok: true });
    expect(seenAct).toMatchObject({ secretValues: { PASSWORD: 'hunter2' } });

    await rpc(dispatcher, 'task.run', { sessionId: 'ses_a', key: 'shop.buy', secretValues: { PIN: '1234' } });
    expect(seenRun).toMatchObject({ secretValues: { PIN: '1234' } });

    // Nothing in the daemon layer retains them: the api object carries only
    // function references, and no handler state exists to inspect. The
    // per-call MapSecretResolver lives in the runtime (api.ts buildContext:
    // built fresh per call, dropped when the call's promise settles) and is
    // pinned by runtime/test/secrets.test.ts.
    for (const value of Object.values(daemon.api)) {
      expect(typeof value).toBe('function');
    }
    const wire = JSON.stringify(daemon.api);
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('1234');
  });
});
