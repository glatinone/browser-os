import { describe, expect, it, vi } from 'vitest';
import type { BosEvent } from '../src/index.js';
import { EventBus } from '../src/index.js';

const sessionEvent = (status: 'ready' | 'busy'): BosEvent => ({ ts: 1, type: 'session.status', data: { status } });
const cacheEvent: BosEvent = { ts: 1, type: 'cache.hit', data: { key: 'k' } };

describe('EventBus', () => {
  it('delivers a typed event to its typed subscribers only', () => {
    const bus = new EventBus();
    const onSession = vi.fn();
    const onCache = vi.fn();
    bus.on('session.status', onSession);
    bus.on('cache.hit', onCache);

    bus.emit(sessionEvent('ready'));

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(sessionEvent('ready'));
    expect(onCache).not.toHaveBeenCalled();
  });

  it('delivers every event to a wildcard subscriber', () => {
    const bus = new EventBus();
    const onAll = vi.fn();
    bus.on('*', onAll);

    bus.emit(sessionEvent('ready'));
    bus.emit(cacheEvent);

    expect(onAll).toHaveBeenCalledTimes(2);
  });

  it('delivers synchronously, before emit returns', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('*', () => order.push('handler'));
    order.push('before');
    bus.emit(cacheEvent);
    order.push('after');

    expect(order).toEqual(['before', 'handler', 'after']);
  });

  it('unsubscribes through the returned function, and only that handler', () => {
    const bus = new EventBus();
    const first = vi.fn();
    const second = vi.fn();
    const off = bus.on('*', first);
    bus.on('*', second);

    off();
    off(); // calling it twice is harmless
    bus.emit(cacheEvent);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('subscribes the same handler only once per type', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('cache.hit', handler);
    bus.on('cache.hit', handler);

    bus.emit(cacheEvent);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering when a handler throws, and reports the error', () => {
    const onError = vi.fn();
    const bus = new EventBus({ onError });
    const boom = new Error('handler blew up');
    const after = vi.fn();
    bus.on('*', () => {
      throw boom;
    });
    bus.on('*', after);

    expect(() => bus.emit(cacheEvent)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom, cacheEvent);
  });

  it('swallows a throwing handler when no onError was given (no console output in libraries)', () => {
    const bus = new EventBus();
    const after = vi.fn();
    bus.on('*', () => {
      throw new Error('ignored');
    });
    bus.on('*', after);

    expect(() => bus.emit(cacheEvent)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('survives a handler unsubscribing during delivery', () => {
    const bus = new EventBus();
    const calls: string[] = [];
    const off = bus.on('*', () => {
      calls.push('first');
      off();
    });
    bus.on('*', () => calls.push('second'));

    bus.emit(cacheEvent);
    bus.emit(cacheEvent);

    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('survives a handler subscribing during delivery without double-delivering', () => {
    const bus = new EventBus();
    const late = vi.fn();
    bus.on('*', () => {
      bus.on('*', late);
    });

    bus.emit(cacheEvent);

    expect(late).not.toHaveBeenCalled();
    bus.emit(cacheEvent);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('emitting with no subscribers is a no-op', () => {
    const bus = new EventBus();
    expect(() => bus.emit(sessionEvent('busy'))).not.toThrow();
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('EventBus.listenerCount', () => {
  it('counts per type, for the wildcard, and in total', () => {
    const bus = new EventBus();
    bus.on('session.status', vi.fn());
    bus.on('session.status', vi.fn());
    bus.on('cache.hit', vi.fn());
    bus.on('*', vi.fn());

    expect(bus.listenerCount('session.status')).toBe(2);
    expect(bus.listenerCount('cache.hit')).toBe(1);
    expect(bus.listenerCount('task.started')).toBe(0);
    expect(bus.listenerCount('*')).toBe(1);
    expect(bus.listenerCount()).toBe(4);
  });
});
