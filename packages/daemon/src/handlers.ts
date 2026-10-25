// P8-02 — method handlers (protocol §4): the daemon's own methods plus the
// per-connection `events.subscribe`, assembled into the `RpcApi` shape the
// P8-01 dispatcher consumes.
//
// The runtime (P7-07 `createRuntimeApi`) answers every §4 method EXCEPT the
// daemon-only trio (`DAEMON_ONLY_METHODS`: system.hello, system.shutdown,
// events.subscribe) — P8 owns the socket, the process, and the subscriber
// fan-out. `createDaemonApi` fills exactly those three around a runtime api:
//
//   * `system.hello` — { version, protocolVersion, pid } (protocol §4). The
//     version is passed in (the daemon's package.json version), so the
//     handler never touches the filesystem.
//   * `events.subscribe` — registers a per-connection filter through the
//     SubscriptionHub and returns `{ subscriptionId }`. The dispatcher calls
//     the api with no connection identity, so `server.ts` wraps every
//     per-socket dispatch in `runWithConnection(ws, ...)`; the current socket
//     travels through AsyncLocalStorage, which — unlike a module variable —
//     survives the dispatcher's internal awaits. Two sockets processing
//     requests concurrently can never mix up their subscriptions.
//   * `system.shutdown` — graceful by contract ("closes sessions
//     gracefully"): await `closeSessions` (runtime.shutdown in the daemon; a
//     hook in tests), acknowledge `{ ok: true }`, THEN fire `onShutdown` from
//     a microtask so the reply reaches the client before the socket dies.
//
// Secret rule (SECURITY.md S12): handlers here never echo params; the only
// fields read are the declared `events.subscribe` filters.

import { BosError, PROTOCOL_VERSION, RPC_METHOD_NAMES, type RpcMethod } from '@browser-os/protocol';
import type { RpcApi } from './dispatch.js';
import { type ConnectionHandle, currentConnection, runWithConnection, type SubscriptionHub } from './subscriptions.js';

export interface DaemonHandlerOptions {
  /** Daemon version reported by `system.hello` (the daemon package.json version). */
  version: string;
  /**
   * Graceful-shutdown step run BEFORE `system.shutdown` is acknowledged —
   * `runtime.shutdown()` in the daemon (closes every live session).
   */
  closeSessions?: () => Promise<void>;
  /**
   * Called AFTER the `system.shutdown` reply is produced (next microtask):
   * P8-03 wires this to `server.close()` + process exit.
   */
  onShutdown?: () => void;
  /** Default `process.pid`; injectable so a test asserts the reported number. */
  pid?: number;
}

export interface DaemonApi {
  /** Wrapped api for `startServer({ api })`: every runtime method plus the trio. */
  api: RpcApi;
  /** Register a live socket with the subscription hub (the server does this on accept). */
  attachConnection(connection: ConnectionHandle): void;
  /** Drop a socket and its subscriptions (the server does this on close). */
  detachConnection(connectionId: string): void;
  /** Run `fn` (e.g. `dispatcher.handleMessage`) with `connection` as the current socket. */
  withConnection<T>(connection: ConnectionHandle, fn: () => T): T;
  /** §4 method names `api` answers — the parity test pins this to RPC_METHOD_NAMES. */
  servedMethods(): string[];
}

/**
 * Merge a (runtime) api with the three daemon-only handlers. The result is a
 * complete §4 surface: `servedMethods()` must equal `RPC_METHOD_NAMES` once
 * the runtime api covers the other methods (the card's parity requirement).
 */
export function createDaemonApi(runtimeApi: RpcApi, hub: SubscriptionHub, options: DaemonHandlerOptions): DaemonApi {
  const pid = options.pid ?? process.pid;

  const systemHandlers: RpcApi = {
    'system.hello': async () => ({
      version: options.version,
      protocolVersion: PROTOCOL_VERSION,
      pid,
    }),

    'events.subscribe': async (params: unknown) => {
      // Params arrive pre-validated by the dispatcher ({ sessionId?, types? });
      // the requesting socket comes from the async scope set by the server.
      const connection = currentConnection();
      if (connection === undefined) {
        // Only reachable if the server dispatched without runWithConnection();
        // a subscription with no owner would leak forever, so refuse loudly.
        throw new BosError('INTERNAL', 'events.subscribe requires an attached connection');
      }
      const parsed = params as { sessionId?: string; types?: string[] };
      const subscriptionId = hub.subscribe(connection.id, {
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        ...(parsed.types === undefined ? {} : { types: parsed.types }),
      });
      return { subscriptionId };
    },

    'system.shutdown': async () => {
      if (options.closeSessions !== undefined) await options.closeSessions();
      // Acknowledge first; tear down one event-loop turn later (setImmediate
      // runs after this promise chain and the socket write are queued, so
      // the { ok: true } frame is on its way before the socket dies).
      setImmediate(() => options.onShutdown?.());
      return { ok: true };
    },
  };

  const api = { ...runtimeApi, ...systemHandlers } as RpcApi;

  return {
    api,
    attachConnection(connection: ConnectionHandle): void {
      hub.attach(connection);
    },
    detachConnection(connectionId: string): void {
      hub.detach(connectionId);
    },
    withConnection<T>(connection: ConnectionHandle, fn: () => T): T {
      return runWithConnection(connection, fn);
    },
    servedMethods(): string[] {
      return RPC_METHOD_NAMES.filter((m) => typeof api[m as RpcMethod] === 'function');
    },
  };
}
