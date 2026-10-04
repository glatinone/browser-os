import { describe, expect, it } from 'vitest';
import { CountingCdpTransport } from '../src/cdp/counting-transport.js';
import type { CdpTransport } from '../src/cdp/transport.js';

interface StubTransport extends CdpTransport {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }>;
  emit(event: string, payload: unknown): void;
}

function stubTransport(): StubTransport {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    sent,
    async send(method, params) {
      sent.push(params === undefined ? { method } : { method, params });
      return { echoed: method };
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<(payload: unknown) => void>();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

describe('CountingCdpTransport', () => {
  it('passes the call through and returns the inner result', async () => {
    const inner = stubTransport();
    const counting = new CountingCdpTransport(inner);

    const result = await counting.send('DOM.getDocument', { depth: -1 });

    expect(result).toEqual({ echoed: 'DOM.getDocument' });
    expect(inner.sent).toEqual([{ method: 'DOM.getDocument', params: { depth: -1 } }]);
  });

  it('counts calls per method and in total', async () => {
    const counting = new CountingCdpTransport(stubTransport());

    await counting.send('DOM.getDocument');
    await counting.send('DOM.getDocument');
    await counting.send('Page.getFrameTree');

    expect(counting.counts()).toEqual({ 'DOM.getDocument': 2, 'Page.getFrameTree': 1 });
    expect(counting.total()).toBe(3);
  });

  it('counts nothing for an event subscription, and still delivers events', () => {
    const inner = stubTransport();
    const counting = new CountingCdpTransport(inner);
    const seen: unknown[] = [];

    const unsubscribe = counting.on('Page.frameNavigated', (payload) => {
      seen.push(payload);
    });
    inner.emit('Page.frameNavigated', { frame: { id: 'F1' } });

    expect(seen).toEqual([{ frame: { id: 'F1' } }]);
    expect(counting.total()).toBe(0);

    unsubscribe();
    inner.emit('Page.frameNavigated', { frame: { id: 'F2' } });
    expect(seen).toEqual([{ frame: { id: 'F1' } }]);
  });

  it('starts again from zero after reset', async () => {
    const counting = new CountingCdpTransport(stubTransport());
    await counting.send('DOM.getDocument');

    counting.reset();

    expect(counting.counts()).toEqual({});
    expect(counting.total()).toBe(0);
  });
});
