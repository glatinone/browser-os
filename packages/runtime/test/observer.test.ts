import type { PageHandle } from '@browser-os/browser';
import { EventBus } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { Observer } from '../src/observer/observer.js';

function page(mutations: number) {
  const on = vi.fn(() => () => {});
  const handle = {
    id: 'page_1',
    url: () => 'https://example.test/',
    title: async () => 'Example',
    opener: () => null,
    cdp: async () => ({ send: vi.fn(), on }),
    driver: () => ({ mutationCounter: async () => mutations }),
    bringToFront: async () => {},
    close: async () => {},
    onClose: () => () => {},
  } as unknown as PageHandle;
  return { handle, on };
}

function capture() {
  return {
    snapshot: {},
    layoutMetrics: {},
    frameTree: null,
    capturedAt: 1,
    documents: [],
    axTrees: [],
    viewport: { width: 1, height: 1, pageX: 0, pageY: 0 },
    frames: [],
    warnings: [],
  } as never;
}

describe('Observer', () => {
  it('reuses unchanged observations and emits only for fresh captures', async () => {
    const p = page(0);
    const events = new EventBus();
    const emitted = vi.fn();
    events.on('observation.captured', emitted);
    const build = vi.fn(() => ({
      observation: {
        id: `obs_${emitted.mock.calls.length + 1}`,
        sessionId: 's',
        pageId: 'page_1',
        url: 'https://example.test/',
        title: 'Example',
        capturedAt: 1,
        frames: [],
        elements: [],
        text: [],
        dialogs: [],
        challenge: null,
        warnings: [],
        stats: { domNodes: 0, axNodes: 0, elements: 0, captureMs: 0, buildMs: 0, estTokens: 0, large: false },
      },
      index: { observationId: `obs_${emitted.mock.calls.length + 1}`, pageId: 'page_1', entries: new Map() },
    }));
    const observer = new Observer({
      events,
      getPage: () => p.handle,
      captureRaw: async () => capture(),
      buildObservation: build as never,
    });

    const first = await observer.capture('s', 'page_1');
    const second = await observer.capture('s', 'page_1');
    expect(second.observation).toBe(first.observation);
    expect(build).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('recaptures after invalidation and retains the latest three indices', async () => {
    const p = page(0);
    let serial = 0;
    const build = vi.fn(() => {
      serial += 1;
      return {
        observation: { id: `obs_${serial}` },
        index: { observationId: `obs_${serial}`, pageId: 'page_1', entries: new Map() },
      };
    });
    const observer = new Observer({
      getPage: () => p.handle,
      captureRaw: async () => capture(),
      buildObservation: build as never,
    });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      observer.invalidate('page_1');
      ids.push((await observer.capture('s', 'page_1')).observation.id);
    }
    expect(observer.index(ids[0])).toBeUndefined();
    expect(observer.index(ids[1])).toBeDefined();
    expect(build).toHaveBeenCalledTimes(4);
  });
});
