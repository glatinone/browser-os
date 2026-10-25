// P8-02 — per-connection event subscriptions (protocol §4 `events.subscribe`).
//
// The hub is the daemon's event router: `server.ts` attaches one handle per
// live WebSocket, `events.subscribe` registers a filter against that handle,
// and every disconnect removes the handle together with its filters (the
// card's "it is removed on disconnect" bullet).
//
// Semantics, deliberately split by wiring mode:
//   * Hub installed (the daemon, and every test here): **subscribe-only**.
//     A connection with no subscription receives no event notifications —
//     protocol §4 introduces `events.subscribe` precisely as the gate for
//     `event` notifications, and the daemon must not push runtime traffic
//     (urls, task payloads) to a socket that never asked for it.
//   * No hub (P8-01's `startServer` contract): `RunningServer.send` keeps its
//     unconditional fan-out, unchanged.
//
// Filter shape (protocol §4): `{ sessionId?, types? }`.
//   * `sessionId` set → only events carrying that exact `sessionId` match.
//     Events without a sessionId (cache.*, stats-like) never match a
//     session-scoped subscription.
//   * `types` non-empty → only those event types match. An absent or empty
//     `types` list means "any type" (empty = no opinion, the friendlier and
//     the only useful reading of `types: []`).
// Multiple subscriptions on one connection form a UNION: an event is
// delivered once per connection no matter how many of its subscriptions
// matched (deduped per publish, never duplicated on the wire).

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { BosError, type BosEvent } from '@browser-os/protocol';

/** The send seam a connection must offer the hub. `id` must be stable. */
export interface ConnectionHandle {
  readonly id: string;
  send(frame: string): void;
}

// --- current-connection scope -------------------------------------------------
// The dispatcher calls the api with no connection identity, so `server.ts`
// wraps every per-socket dispatch in runWithConnection(). AsyncLocalStorage —
// unlike a module variable — survives the dispatcher's internal awaits, so
// two sockets processing requests concurrently can never mix up whose
// `events.subscribe` is executing.

const connectionScope = new AsyncLocalStorage<ConnectionHandle>();

/** Run `fn` with `connection` installed as the current socket (sync + async). */
export function runWithConnection<T>(connection: ConnectionHandle, fn: () => T): T {
  return connectionScope.run(connection, fn);
}

/** The socket whose request is executing right now, or undefined. */
export function currentConnection(): ConnectionHandle | undefined {
  return connectionScope.getStore();
}

/** Opaque subscription id for `{ subscriptionId }` (protocol §4 result). */
export function newSubscriptionId(): string {
  return `sub_${randomBytes(9).toString('hex')}`;
}

export interface SubscriptionFilter {
  sessionId?: string;
  types?: readonly string[];
}

export interface SubscriptionHubOptions {
  /** Called when a connection's `send` throws (a dying socket). Never let one kill fan-out. */
  onError?: (error: unknown, connectionId: string) => void;
}

export interface SubscriptionHub {
  /** Register a live connection. Re-attaching the same id replaces the handle. */
  attach(connection: ConnectionHandle): void;
  /** Drop a connection and every subscription registered through it. */
  detach(connectionId: string): void;
  /**
   * Register `filter` for an attached connection; returns the subscription id
   * (the `{ subscriptionId }` result of `events.subscribe`).
   * Throws `INTERNAL` when the connection is not attached.
   */
  subscribe(connectionId: string, filter: SubscriptionFilter): string;
  /** Remove one subscription. True when it existed. */
  unsubscribe(subscriptionId: string): boolean;
  hasConnection(connectionId: string): boolean;
  /** Live subscription total — the leak check after disconnects. */
  subscriptionCount(): number;
  /** Subscription ids currently registered for one connection. */
  activeSubscriptionsFor(connectionId: string): string[];
  /**
   * Deliver one event: matches every connection's filters, sends the
   * pre-validated `frame` at most once per connection. Returns how many
   * connections received it.
   */
  publish(event: BosEvent, frame: string): number;
}

/** One subscription row: the filter plus the connection id that owns it. */
interface Subscription {
  connectionId: string;
  filter: SubscriptionFilter;
}

/** Pure match predicate, exported so the unit tests pin every edge. */
export function matchesFilter(filter: SubscriptionFilter, event: BosEvent): boolean {
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.types !== undefined && filter.types.length > 0 && !filter.types.includes(event.type)) return false;
  return true;
}

export function createSubscriptionHub(options: SubscriptionHubOptions = {}): SubscriptionHub {
  // Insertion order is the delivery order; deterministic delivery keeps tests honest.
  const connections = new Map<string, ConnectionHandle>();
  const subscriptions = new Map<string, Subscription>();

  function detach(connectionId: string): void {
    connections.delete(connectionId);
    for (const [id, sub] of subscriptions) {
      if (sub.connectionId === connectionId) subscriptions.delete(id);
    }
  }

  return {
    attach(connection: ConnectionHandle): void {
      if (connections.has(connection.id)) detach(connection.id);
      connections.set(connection.id, connection);
    },

    detach,

    subscribe(connectionId: string, filter: SubscriptionFilter): string {
      if (!connections.has(connectionId)) {
        throw new BosError('INTERNAL', `connection is not attached: ${connectionId}`, {
          details: { connectionId },
        });
      }
      const id = newSubscriptionId();
      const stored: SubscriptionFilter = {
        ...(filter.sessionId === undefined ? {} : { sessionId: filter.sessionId }),
        ...(filter.types === undefined ? {} : { types: [...filter.types] }),
      };
      subscriptions.set(id, { connectionId, filter: stored });
      return id;
    },

    unsubscribe(subscriptionId: string): boolean {
      return subscriptions.delete(subscriptionId);
    },

    hasConnection(connectionId: string): boolean {
      return connections.has(connectionId);
    },

    subscriptionCount(): number {
      return subscriptions.size;
    },

    activeSubscriptionsFor(connectionId: string): string[] {
      const ids: string[] = [];
      for (const [id, sub] of subscriptions) {
        if (sub.connectionId === connectionId) ids.push(id);
      }
      return ids;
    },

    publish(event: BosEvent, frame: string): number {
      let delivered = 0;
      // Snapshot first: a send callback that (un)subscribes must not mutate
      // the map mid-delivery.
      const rows = [...subscriptions.values()];
      for (const connection of connections.values()) {
        const matched = rows.some((sub) => sub.connectionId === connection.id && matchesFilter(sub.filter, event));
        if (!matched) continue;
        try {
          connection.send(frame);
          delivered += 1;
        } catch (error) {
          options.onError?.(error, connection.id);
        }
      }
      return delivered;
    },
  };
}
