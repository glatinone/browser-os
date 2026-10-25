// P8-02 — the subscription hub and the connection scope, in-process.
//
// Card tests: "subscription filtering" plus the bullet "it is removed on
// disconnect". Everything here is a fake handle collecting sent frames — no
// socket, no runtime.

import { BosError, type BosEvent } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import {
  type ConnectionHandle,
  createSubscriptionHub,
  currentConnection,
  matchesFilter,
  runWithConnection,
} from '../src/subscriptions.js';

function fakeHandle(id: string, opts: { throwOnSend?: boolean } = {}) {
  const frames: string[] = [];
  const handle: ConnectionHandle = {
    id,
    send(frame: string): void {
      if (opts.throwOnSend === true) throw new Error('socket is dying');
      frames.push(frame);
    },
  };
  return { handle, frames };
}

function event(type: string, sessionId?: string): BosEvent {
  return { ts: 1, type, ...(sessionId === undefined ? {} : { sessionId }), data: {} } as BosEvent;
}

describe('matchesFilter', () => {
  it('an empty filter matches everything', () => {
    expect(matchesFilter({}, event('cache.hit'))).toBe(true);
    expect(matchesFilter({}, event('action.completed', 'ses_a'))).toBe(true);
  });

  it('a sessionId filter matches only that session', () => {
    const f = { sessionId: 'ses_a' };
    expect(matchesFilter(f, event('action.completed', 'ses_a'))).toBe(true);
    expect(matchesFilter(f, event('action.completed', 'ses_b'))).toBe(false);
    // Events without a sessionId never match a session-scoped subscription.
    expect(matchesFilter(f, event('cache.hit'))).toBe(false);
  });

  it('a types filter matches only listed types; empty types means any type', () => {
    expect(matchesFilter({ types: ['task.started'] }, event('task.started', 'ses_a'))).toBe(true);
    expect(matchesFilter({ types: ['task.started'] }, event('task.completed', 'ses_a'))).toBe(false);
    expect(matchesFilter({ types: [] }, event('anything' as BosEvent['type'], 'ses_a'))).toBe(true);
  });

  it('sessionId and types combine with AND', () => {
    const f = { sessionId: 'ses_a', types: ['task.started'] };
    expect(matchesFilter(f, event('task.started', 'ses_a'))).toBe(true);
    expect(matchesFilter(f, event('task.started', 'ses_b'))).toBe(false);
    expect(matchesFilter(f, event('task.completed', 'ses_a'))).toBe(false);
  });
});

describe('subscription hub', () => {
  it('delivers only to connections with a matching subscription', () => {
    const hub = createSubscriptionHub();
    const a = fakeHandle('c1');
    const b = fakeHandle('c2');
    hub.attach(a.handle);
    hub.attach(b.handle);
    hub.subscribe('c1', { types: ['task.started'] });

    expect(hub.publish(event('task.started', 'ses_x'), 'F1')).toBe(1);
    expect(a.frames).toEqual(['F1']);
    expect(b.frames).toEqual([]);

    // c2 never subscribed: nothing, ever.
    expect(hub.publish(event('cache.hit'), 'F2')).toBe(0);
    expect(a.frames).toEqual(['F1']);
  });

  it('one connection with several matching subscriptions is charged once per event', () => {
    const hub = createSubscriptionHub();
    const a = fakeHandle('c1');
    hub.attach(a.handle);
    hub.subscribe('c1', { types: ['task.started'] });
    hub.subscribe('c1', {});

    expect(hub.publish(event('task.started', 'ses_x'), 'F')).toBe(1);
    expect(a.frames).toEqual(['F']);
  });

  it('detach removes the connection AND its subscriptions (the disconnect bullet)', () => {
    const hub = createSubscriptionHub();
    const a = fakeHandle('c1');
    hub.attach(a.handle);
    hub.subscribe('c1', {});
    hub.subscribe('c1', { sessionId: 'ses_x' });
    expect(hub.subscriptionCount()).toBe(2);

    hub.detach('c1');
    expect(hub.hasConnection('c1')).toBe(false);
    expect(hub.subscriptionCount()).toBe(0);
    expect(hub.activeSubscriptionsFor('c1')).toEqual([]);
    expect(hub.publish(event('cache.hit'), 'F')).toBe(0);
  });

  it('unsubscribe removes exactly one subscription', () => {
    const hub = createSubscriptionHub();
    const a = fakeHandle('c1');
    hub.attach(a.handle);
    const id1 = hub.subscribe('c1', {});
    const id2 = hub.subscribe('c1', { sessionId: 'ses_x' });
    expect(id1).toMatch(/^sub_[0-9a-f]{18}$/);
    expect(hub.unsubscribe(id2)).toBe(true);
    expect(hub.unsubscribe(id2)).toBe(false);
    expect(hub.activeSubscriptionsFor('c1')).toEqual([id1]);
  });

  it('subscribe on an unknown connection throws INTERNAL (no orphan subscriptions)', () => {
    const hub = createSubscriptionHub();
    expect(() => hub.subscribe('ghost', {})).toThrowError(BosError);
    try {
      hub.subscribe('ghost', {});
    } catch (error) {
      expect((error as BosError).code).toBe('INTERNAL');
    }
  });

  it('a throwing send is reported through onError and never kills fan-out', () => {
    const errors: string[] = [];
    const hub = createSubscriptionHub({ onError: (_e, id) => errors.push(id) });
    const bad = fakeHandle('bad', { throwOnSend: true });
    const good = fakeHandle('good');
    hub.attach(bad.handle);
    hub.attach(good.handle);
    hub.subscribe('bad', {});
    hub.subscribe('good', {});

    expect(hub.publish(event('cache.hit'), 'F')).toBe(1);
    expect(errors).toEqual(['bad']);
    expect(good.frames).toEqual(['F']);
  });

  it('re-attaching an id replaces the handle and clears stale subscriptions', () => {
    const hub = createSubscriptionHub();
    const first = fakeHandle('c1');
    hub.attach(first.handle);
    hub.subscribe('c1', {});
    const second = fakeHandle('c1');
    hub.attach(second.handle);
    expect(hub.subscriptionCount()).toBe(0);
    hub.subscribe('c1', {});
    expect(hub.publish(event('cache.hit'), 'F')).toBe(1);
    expect(first.frames).toEqual([]);
    expect(second.frames).toEqual(['F']);
  });
});

describe('connection scope (AsyncLocalStorage)', () => {
  it('currentConnection follows the sync scope and nests', () => {
    const a = fakeHandle('a').handle;
    const b = fakeHandle('b').handle;
    expect(currentConnection()).toBeUndefined();
    runWithConnection(a, () => {
      expect(currentConnection()?.id).toBe('a');
      runWithConnection(b, () => {
        expect(currentConnection()?.id).toBe('b');
      });
      expect(currentConnection()?.id).toBe('a');
    });
    expect(currentConnection()).toBeUndefined();
  });

  it("two concurrent async requests never see each other's connection", async () => {
    const a = fakeHandle('a').handle;
    const b = fakeHandle('b').handle;
    const nap = () => new Promise((r) => setTimeout(r, 10));
    const [seenA, seenB] = await Promise.all([
      runWithConnection(a, async () => {
        await nap();
        return currentConnection()?.id;
      }),
      runWithConnection(b, async () => {
        await nap();
        return currentConnection()?.id;
      }),
    ]);
    expect(seenA).toBe('a');
    expect(seenB).toBe('b');
  });
});
