// P8-01 — WebSocket server (protocol §2; SECURITY.md S5, S7).
//
// Topology the card fixes: a `node:http` server on 127.0.0.1 hosting a `ws`
// `WebSocketServer({ noServer: true })`, mounted only on `/rpc` (every other
// path is 404). The upgrade request is the only place a browser could pretend
// to be the SDK, so it is also where the two guards live:
//
//   * `Origin` header present → 403. Browsers always send one on a WebSocket
//     handshake; the CLI/SDK never does. This kills cross-site WebSocket
//     hijacking without an origin allowlist (protocol §2).
//   * `auth.verify(authorization)` must resolve true → otherwise 401. P8-04
//     implements the token comparison; until then `allowAllAuth` is the stub,
//     reachable in production code only if a caller passes it explicitly.
//
// `maxPayload: 8 MiB` (S7) is set on the WebSocketServer, so an oversized
// frame kills the connection before the dispatcher ever sees a string.
//
// `send(event)` pushes a JSON-RPC `event` notification to every live
// connection; per-connection subscription filters are P8-02's job.

import { createServer, type Server } from 'node:http';
import { BosError, type BosEvent, JsonRpcNotificationSchema, PROTOCOL_VERSION } from '@browser-os/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import { createDispatcher, type RpcApi } from './dispatch.js';
import type { RequestLogger } from './log.js';
import { type ConnectionHandle, runWithConnection, type SubscriptionHub } from './subscriptions.js';

/** Max frame size accepted from a client (SECURITY.md S7 = 8 MB). */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export interface ServerAuth {
  /**
   * Called with the raw `authorization` upgrade header (undefined when the
   * client sent none). Reject by returning false or throwing.
   */
  verify(authorization: string | undefined): Promise<boolean> | boolean;
}

/** The P8-04 placeholder: accepts everything. Only pass it deliberately. */
export const allowAllAuth: ServerAuth = { verify: () => true };

export interface StartServerOptions {
  api: RpcApi;
  auth: ServerAuth;
  /** 0 = OS-assigned; the real port lands on `server.port`. */
  port?: number;
  /** Fixed at 127.0.0.1 by the card; the option exists so tests can see it is honoured. */
  host?: string;
  logger?: RequestLogger;
  validateResults?: boolean;
  /**
   * P8-02 — install a per-connection subscription hub. With it present:
   *   * `send(event)` delivers only to connections whose `events.subscribe`
   *     filters match (subscribe-only; an unsubscribed socket gets nothing).
   *   * every dispatch runs inside `runWithConnection(handle, ...)`, so the
   *     `events.subscribe` handler (from `createDaemonApi`) can see which
   *     socket asked.
   * Left undefined, the P8-01 contract holds: `send` fans out to everyone.
   */
  subscriptions?: SubscriptionHub;
}

export interface RunningServer {
  /** The bound port ( meaningful when `port: 0` was requested). */
  port(): number;
  /** Live connections, for tests and shutdown (P8-03). */
  connectionCount(): number;
  /** Push one event notification to every live connection (protocol §3). */
  send(event: BosEvent): void;
  close(): Promise<void>;
  /** The underlying http server, for P8-03 lifecycle hooks. */
  readonly httpServer: Server;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    // protocol §2: the daemon listens on loopback only. This is a policy
    // assertion, not a style choice — do not relax it without an ADR.
    throw new BosError('INVALID_REQUEST', `daemon host must be 127.0.0.1, got ${host}`);
  }

  const dispatcher = createDispatcher({
    api: options.api,
    validateResults: options.validateResults,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  // P8-02: when a hub is installed, `send` routes through subscription
  // filters; without one the P8-01 unconditional fan-out is preserved.
  const hub = options.subscriptions;

  const httpServer = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const connections = new Set<WebSocket>();
  let nextConnectionId = 0;

  httpServer.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head);
  });

  async function handleUpgrade(
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): Promise<void> {
    const respond = (status: number, body: string): void => {
      socket.write(`HTTP/1.1 ${status} ${body}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      socket.destroy();
    };

    let path = '';
    try {
      path = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname;
    } catch {
      respond(400, 'Bad Request');
      return;
    }
    if (path !== '/rpc') {
      respond(404, 'Not Found');
      return;
    }
    // Browser handshakes always carry Origin; the SDK/CLI never does (§2).
    if (req.headers.origin !== undefined) {
      respond(403, 'Forbidden');
      return;
    }
    let ok = false;
    try {
      ok = await options.auth.verify(req.headers.authorization);
    } catch {
      ok = false;
    }
    if (!ok) {
      respond(401, 'Unauthorized');
      return;
    }
    if (req.socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // P8-02: every live socket is a hub connection with a stable id, so
      // `events.subscribe` (current socket) and `send` (filtered fan-out)
      // agree on who is who.
      const connectionId = `conn_${nextConnectionId}`;
      nextConnectionId += 1;
      const handle: ConnectionHandle = {
        id: connectionId,
        send: (frame: string) => reply(ws, frame),
      };
      hub?.attach(handle);
      connections.add(ws);
      ws.on('close', () => {
        connections.delete(ws);
        hub?.detach(handle.id); // subscriptions die with the connection (card bullet)
      });
      // A receiver error (oversized frame per S7, malformed stream) must kill
      // this connection only — never the daemon. `ws` closes it after the
      // error; the listener exists so the event has somewhere to go.
      ws.on('error', () => connections.delete(ws));
      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          reply(ws, errorFrame(null, 'frames must be JSON text'));
          return;
        }
        // The whole dispatch runs with this socket as the current
        // connection, so events.subscribe registers against the right one
        // even while other sockets are mid-request (AsyncLocalStorage).
        const promise = runWithConnection(handle, () =>
          dispatcher.handleMessage(typeof data === 'string' ? data : data.toString('utf8')),
        );
        void promise
          .then((response) => {
            if (response !== null) reply(ws, response);
          })
          .catch(() => {
            // The dispatcher maps every failure to a frame; arriving here is
            // a bug in the dispatcher. Close loudly rather than pretend.
            ws.close(1011, 'internal error');
          });
      });
    });
  }

  function reply(ws: WebSocket, frame: string): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }

  function errorFrame(id: string | number | null, message: string): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message, data: { bosCode: 'INVALID_REQUEST', retryable: false } },
    });
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  return {
    port(): number {
      const address = httpServer.address();
      if (address === null || typeof address === 'string') throw new BosError('INTERNAL', 'server is not listening');
      return address.port;
    },
    connectionCount(): number {
      return connections.size;
    },
    send(event: BosEvent): void {
      // Validate before fan-out: a malformed event is a daemon bug, and the
      // wire must never carry one (protocol §3 pins the notification shape).
      const notification = JsonRpcNotificationSchema.parse({ jsonrpc: '2.0', method: 'event', params: event });
      const frame = JSON.stringify(notification);
      if (hub !== undefined) {
        // P8-02 mode: only subscribers with a matching filter receive it.
        hub.publish(event, frame);
        return;
      }
      for (const ws of connections) reply(ws, frame);
    },
    async close(): Promise<void> {
      for (const ws of connections) ws.close(1001, 'daemon shutting down');
      connections.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
    httpServer,
  };
}

/** Protocol version the running server speaks — used by `system.hello` (P8-02). */
export const SERVER_PROTOCOL_VERSION = PROTOCOL_VERSION;
