// P8-01 — WebSocket server + dispatcher, driven by a real `ws` client.
//
// Card tests (docs/tasks/phase-08-daemon-cli-sdk.md): valid call; each
// JSON-RPC error class; Origin → 403; oversized message rejected; logger
// canary. Everything runs over a real socket on an OS-assigned loopback port;
// the api is a fake (the card's "fake RuntimeApi" idea), so no runtime,
// browser, or network is involved.

import { request as httpRequest } from 'node:http';
import { BosError, JsonRpcErrorSchema, JsonRpcNotificationSchema } from '@browser-os/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { allowAllAuth, MAX_PAYLOAD_BYTES, type RunningServer, startServer } from '../src/index.js';
import { createRequestLogger } from '../src/log.js';

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];

async function shutdown(): Promise<void> {
  for (const ws of sockets.splice(0)) ws.terminate();
  while (servers.length > 0) await (servers.pop() as RunningServer).close();
}
afterEach(shutdown);
afterAll(shutdown);

// A fake api that answers just enough of protocol §4 to exercise every
// dispatcher branch without a runtime.
const fakeApi = {
  'system.hello': async (params: { client: string; protocolVersion: string }) => ({
    version: '0.0.0-test',
    protocolVersion: params.protocolVersion,
    pid: process.pid,
  }),
  'session.get': async () => {
    throw new BosError('SESSION_NOT_FOUND', 'no such session');
  },
  'profile.list': async () => [{ bogus: true }], // fails result validation on purpose
  act: async (params: { secretValues?: Record<string, string> }) => ({
    ok: true,
    action: { type: 'navigate', url: 'https://example.test' },
    tier: null,
    driver: null,
    attempts: [],
    url: 'https://example.test',
    pageChanged: false,
    ms: 1,
    llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
    risk: null,
    sawSecrets: params.secretValues !== undefined,
  }),
};

type ServeOptions = Parameters<typeof startServer>[0];
async function serve(extra: Partial<ServeOptions> = {}): Promise<RunningServer> {
  const server = await startServer({ api: fakeApi, auth: allowAllAuth, ...extra });
  servers.push(server);
  return server;
}

/** Open a socket, send one raw frame, resolve with the first reply text. */
function call(port: number, frame: string | Buffer, headers?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, headers === undefined ? undefined : { headers });
    sockets.push(ws);
    const timer = setTimeout(() => reject(new Error('no reply in time')), 4000);
    ws.on('open', () => ws.send(frame));
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`upgrade rejected with ${String(res.statusCode)}`));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Open a socket, send an oversized frame, resolve with the close code. */
function closedByOversize(port: number, payload: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    sockets.push(ws);
    ws.on('open', () => ws.send(payload));
    ws.on('close', (code) => resolve(code));
    // The client fails its own oversized send; the expected outcome is the
    // close event, so swallow the send-side error instead of leaking it.
    ws.on('error', () => {});
  });
}

/** Plain HTTP status of a GET — used for the non-/rpc 404 path. */
function getStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Assert a reply is a well-formed JSON-RPC error with the given code/id. */
function expectError(raw: string, code: number, id: string | number | null): Record<string, never> | object {
  const parsed = JsonRpcErrorSchema.parse(JSON.parse(raw));
  expect(parsed.error.code).toBe(code);
  expect(parsed.id).toBe(id);
  return parsed;
}

// ---------------------------------------------------------------------------
// Requirement 1 — server topology: /rpc only, Origin guard, auth hook,
// maxPayload, loopback.
// ---------------------------------------------------------------------------

describe('server topology', () => {
  it('answers a valid call over a real WebSocket (protocol §2)', async () => {
    const server = await serve();
    const raw = await call(
      server.port(),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'system.hello',
        params: { client: 'test', protocolVersion: '1' },
      }),
    );
    const reply = JSON.parse(raw);
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { version: '0.0.0-test', protocolVersion: '1', pid: process.pid },
    });
  });

  it('serves only /rpc — any other path is 404 and cannot upgrade', async () => {
    const server = await serve();
    expect(await getStatus(server.port(), '/health')).toBe(404);
    await expect(call(server.port(), '{}', undefined)).resolves.toBeTypeOf('string'); // sanity: /rpc works
    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}/other`);
    sockets.push(ws);
    const status = await new Promise<number>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', reject);
      ws.on('open', () => reject(new Error('upgrade on /other must not succeed')));
    });
    expect(status).toBe(404);
  });

  it('rejects an upgrade that carries an Origin header with 403 (S5)', async () => {
    const server = await serve();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}/rpc`, {
      headers: { Origin: 'https://evil.example' },
    });
    sockets.push(ws);
    const status = await new Promise<number>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', reject);
      ws.on('open', () => reject(new Error('Origin-bearing handshake must be refused')));
    });
    expect(status).toBe(403);
  });

  it('refuses the upgrade when auth.verify returns false or throws', async () => {
    const denied = await serve({ auth: { verify: () => false } });
    const ws = new WebSocket(`ws://127.0.0.1:${denied.port()}/rpc`);
    sockets.push(ws);
    const status = await new Promise<number>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', reject);
    });
    expect(status).toBe(401);

    const thrown = await serve({
      auth: {
        verify: () => {
          throw new Error('token store unreadable');
        },
      },
    });
    const ws2 = new WebSocket(`ws://127.0.0.1:${thrown.port()}/rpc`);
    sockets.push(ws2);
    const status2 = await new Promise<number>((resolve, reject) => {
      ws2.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws2.on('error', reject);
    });
    expect(status2).toBe(401);
  });

  it('passes the authorization header to auth.verify', async () => {
    let seen: string | undefined | null = null;
    const server = await serve({
      auth: {
        verify: (authorization) => {
          seen = authorization;
          return true;
        },
      },
    });
    const token = ['Bearer', 'tok'].join(' ');
    await call(
      server.port(),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'a',
        method: 'system.hello',
        params: { client: 'c', protocolVersion: '1' },
      }),
      {
        Authorization: token,
      },
    );
    expect(seen).toBe(token);
  });

  it('kills the connection on an oversized frame before dispatch (S7)', async () => {
    const server = await serve();
    expect(MAX_PAYLOAD_BYTES).toBe(8 * 1024 * 1024);
    const oversized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'system.hello',
      pad: 'x'.repeat(MAX_PAYLOAD_BYTES),
    });
    const code = await closedByOversize(server.port(), oversized);
    // ws closes 1009 (Message Too Big); the dispatcher never sees the frame.
    expect(code).toBe(1009);
  });

  it('refuses to bind anywhere but loopback', async () => {
    await expect(serve({ host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/);
  });
});

// ---------------------------------------------------------------------------
// Requirement 2 — each JSON-RPC error class, end to end over the socket.
// ---------------------------------------------------------------------------

describe('dispatcher error classes', () => {
  it('-32700 on unparseable JSON (id null)', async () => {
    const server = await serve();
    const raw = await call(server.port(), '{ not json');
    expectError(raw, -32700, null);
  });

  it('-32600 on an envelope that fails the request schema (id echoed only when trustworthy)', async () => {
    const server = await serve();
    expectError(
      await call(server.port(), JSON.stringify({ jsonrpc: '1.0', id: 7, method: 'system.hello' })),
      -32600,
      7,
    );
    // no id at all → null id in the reply
    expectError(await call(server.port(), JSON.stringify({ jsonrpc: '2.0', method: 'system.hello' })), -32600, null);
    // id of the wrong type → not echoed
    expectError(
      await call(server.port(), JSON.stringify({ jsonrpc: '2.0', id: { bad: 1 }, method: 'system.hello' })),
      -32600,
      null,
    );
  });

  it('-32601 on a method outside RPC_METHODS', async () => {
    const server = await serve();
    const parsed = expectError(
      await call(server.port(), JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'no.such' })),
      -32601,
      2,
    );
    expect((parsed as { error: { data?: { bosCode?: string } } }).error.data?.bosCode).toBe('INVALID_REQUEST');
  });

  it('-32601 on a known method this daemon does not serve', async () => {
    const server = await serve();
    expectError(
      await call(server.port(), JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'task.list', params: {} })),
      -32601,
      3,
    );
  });

  it('-32602 when params fail RPC_METHODS[method].params', async () => {
    const server = await serve();
    const parsed = expectError(
      await call(
        server.port(),
        JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'system.hello', params: { client: '', protocolVersion: '9' } }),
      ),
      -32602,
      4,
    );
    const data = (parsed as { error: { data?: { bosCode?: string; details?: { issues?: string[] } } } }).error.data;
    expect(data?.bosCode).toBe('INVALID_REQUEST');
    expect(data?.details?.issues?.length).toBeGreaterThan(0);
  });

  it('protocolVersion mismatch surfaces as -32602/INVALID_REQUEST (no bespoke gate)', async () => {
    const server = await serve();
    const parsed = expectError(
      await call(
        server.port(),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'system.hello',
          params: { client: 'c', protocolVersion: '2' },
        }),
      ),
      -32602,
      5,
    );
    expect((parsed as { error: { data?: { bosCode?: string } } }).error.data?.bosCode).toBe('INVALID_REQUEST');
  });

  it('handler BosError maps through toRpcError (-32000 + real bosCode)', async () => {
    const server = await serve();
    const parsed = expectError(
      await call(
        server.port(),
        JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'session.get', params: { sessionId: 's1' } }),
      ),
      -32000,
      6,
    );
    const data = (parsed as { error: { data?: { bosCode?: string; retryable?: boolean } } }).error.data;
    expect(data?.bosCode).toBe('SESSION_NOT_FOUND');
    expect(data?.retryable).toBe(false);
  });

  it('validates results in dev/test mode only', async () => {
    const strict = await serve({ validateResults: true });
    expectError(
      await call(strict.port(), JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'profile.list' })),
      -32000,
      8,
    );
    const lenient = await serve();
    const raw = await call(lenient.port(), JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'profile.list' }));
    expect(JSON.parse(raw).result).toEqual([{ bogus: true }]);
  });

  it('binary frames are refused with an -32600 frame, not a crash', async () => {
    const server = await serve();
    const raw = await call(server.port(), Buffer.from([0x00, 0x01, 0x02]));
    expectError(raw, -32600, null);
  });
});

// ---------------------------------------------------------------------------
// Requirement 3 — request logging: method/duration/ok only; secret canary.
// ---------------------------------------------------------------------------

describe('request logger', () => {
  it('logs method, status and duration — never params, even with secrets in them', async () => {
    const lines: string[] = [];
    const logger = createRequestLogger({ sink: (line) => lines.push(line), level: 'debug' });
    const server = await serve({ logger });
    const canary = `CANARY-${'s'.repeat(16)}`;
    await call(
      server.port(),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'act',
        params: {
          sessionId: 's1',
          action: { type: 'navigate', url: 'https://example.test' },
          secretValues: { password: canary },
        },
      }),
    );
    await call(server.port(), '{ nope');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('rpc act ok');
    expect(lines[1]).toContain('rpc - error code=-32700');
    for (const line of lines) {
      expect(line).not.toContain(canary);
      expect(line).not.toContain('secretValues');
      expect(line).not.toContain('password');
      expect(line).not.toContain('s1');
    }
  });

  it('silent level emits nothing at all', async () => {
    const lines: string[] = [];
    const logger = createRequestLogger({ sink: (line) => lines.push(line), level: 'silent' });
    const server = await serve({ logger });
    await call(
      server.port(),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.hello', params: { client: 'c', protocolVersion: '1' } }),
    );
    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 4 — send(event) fans a §3 notification out to live connections.
// ---------------------------------------------------------------------------

describe('event fan-out', () => {
  it('pushes a validated event notification to every live connection', async () => {
    const server = await serve();
    const event = {
      ts: Math.floor(Date.now() / 1000),
      type: 'session.status' as const,
      sessionId: 's1',
      data: { status: 'ready' as const },
    };
    const open = (port: number): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
        sockets.push(ws);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
      });
    const [a, b] = await Promise.all([open(server.port()), open(server.port())]);
    const [ma, mb] = await Promise.all([
      new Promise<string>((resolve) => a.once('message', (d) => resolve(d.toString()))),
      new Promise<string>((resolve) => b.once('message', (d) => resolve(d.toString()))),
      Promise.resolve().then(() => server.send(event)),
    ]);
    for (const raw of [ma, mb]) {
      const parsed = JsonRpcNotificationSchema.parse(JSON.parse(raw));
      expect(parsed.method).toBe('event');
      expect(parsed.params).toEqual(event);
    }
    expect(server.connectionCount()).toBe(2);
    // A malformed event is a daemon bug: it must never reach the wire.
    expect(() => server.send({ ts: 1, type: 'nope', data: {} } as never)).toThrow();
  });

  it('close() drops connections and frees the port', async () => {
    const server = await serve();
    const ws = await (async () => {
      const s = new WebSocket(`ws://127.0.0.1:${server.port()}/rpc`);
      sockets.push(s);
      await new Promise<void>((resolve) => s.on('open', () => resolve()));
      return s;
    })();
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await server.close();
    expect(await closed).toBe(1001);
    expect(server.connectionCount()).toBe(0);
  });
});
