import type { ActionResult, BrowserAction, ElementLocator } from '@browser-os/protocol';
import { MASKED_VALUE } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ActionRouter } from '../src/router/router.js';
import { compactSteps, TrajectoryRecorder, templatizeUrl } from '../src/tasks/recorder.js';

/**
 * P7-05 trajectory recorder, unit tier (card: docs/tasks/phase-07-router-and-tasks.md).
 * Covers every row of the memory §6.1 table, the compaction rules, the
 * `finalize(success)` contract, and the S13 sensitive-literal guard at the
 * router boundary (fake driver must see ZERO calls).
 */

function locator(attrs: Record<string, string> = {}, name = 'Field'): ElementLocator {
  return {
    v: 1,
    role: 'textbox',
    name,
    nameIsDynamic: false,
    tag: 'input',
    attrs,
    context: [],
    cssPath: '#field',
    framePath: [],
    ordinal: 0,
  };
}

function resultOf(action: BrowserAction, overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    ok: true,
    action,
    tier: 'ref',
    driver: 'cdp',
    attempts: [],
    url: 'https://shop.test/',
    pageChanged: false,
    ms: 1,
    llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
    risk: 'low',
    ...overrides,
  };
}

const ctx = { taskId: 't1', params: {} } as never;

function makeRecorder(opts: { params?: Record<string, string>; secretNames?: string[] } = {}) {
  const store = { createRecorded: vi.fn(() => ({ id: 'trj_1' })) };
  const rec = new TrajectoryRecorder({
    store,
    taskKey: 'shop.checkout',
    params: opts.params ?? {},
    secretNames: opts.secretNames ?? [],
  });
  rec.start('https://shop.test/');
  return { rec, store };
}

describe('templatizeUrl (memory §6.1 navigate.url)', () => {
  it('replaces param values in the URL with {{name}} placeholders', () => {
    expect(templatizeUrl('https://shop.test/buy/widget-42', { product: 'widget-42' })).toBe(
      'https://shop.test/buy/{{product}}',
    );
  });

  it('leaves URLs without param values untouched', () => {
    expect(templatizeUrl('https://shop.test/cart', { product: 'widget-42' })).toBe('https://shop.test/cart');
  });
});

describe('TrajectoryRecorder — memory §6.1 table rows', () => {
  it('records navigate with the templated URL and the pre url pattern', () => {
    const { rec } = makeRecorder({ params: { product: 'widget-42' } });
    rec.append(
      resultOf(
        { type: 'navigate', url: 'https://shop.test/buy/widget-42' },
        {
          url: 'https://shop.test/buy/widget-42',
          pageChanged: true,
        },
      ),
      ctx,
      null,
      'low',
    );
    const steps = rec.finalize(true);
    expect(steps).not.toBeNull();
    expect(steps).toHaveLength(1);
    expect(steps![0]!.action).toEqual({ type: 'navigate', url: 'https://shop.test/buy/{{product}}' });
    expect(steps![0]!.pre.urlPattern).toBe('/');
    expect(steps![0]!.post?.urlPattern).toBe('/buy/*');
  });

  it('keeps param and secret value references as-is', () => {
    const { rec } = makeRecorder();
    const action: BrowserAction = {
      type: 'fill',
      target: { kind: 'locator', locator: locator() },
      value: { kind: 'param', name: 'email' },
    };
    rec.append(resultOf(action, { locator: locator() }), ctx, null, 'low');
    const steps = rec.finalize(true)!;
    expect(steps[0]!.action).toEqual(action);
  });

  it('promotes a literal equal to a param value into a param reference', () => {
    const { rec } = makeRecorder({ params: { query: 'hello world' } });
    rec.append(
      resultOf(
        {
          type: 'fill',
          target: { kind: 'locator', locator: locator() },
          value: { kind: 'literal', value: 'hello world' },
        },
        { locator: locator() },
      ),
      ctx,
      null,
      'low',
    );
    const steps = rec.finalize(true)!;
    expect((steps[0]!.action as { value: unknown }).value).toEqual({ kind: 'param', name: 'query' });
  });

  it('keeps a plain literal on a non-sensitive target', () => {
    const { rec } = makeRecorder();
    rec.append(
      resultOf(
        { type: 'fill', target: { kind: 'locator', locator: locator() }, value: { kind: 'literal', value: 'sale' } },
        { locator: locator() },
      ),
      ctx,
      null,
      'low',
    );
    const steps = rec.finalize(true)!;
    expect((steps[0]!.action as { value: unknown }).value).toEqual({ kind: 'literal', value: 'sale' });
  });

  it('masks a literal that reaches a sensitive target (defense in depth)', () => {
    const { rec } = makeRecorder();
    const pw = locator({ type: 'password', name: 'password' }, 'Password');
    rec.append(
      resultOf(
        { type: 'fill', target: { kind: 'locator', locator: pw }, value: { kind: 'literal', value: 'hunter2!' } },
        { locator: pw },
      ),
      ctx,
      null,
      'low',
    );
    const steps = rec.finalize(true)!;
    const value = (steps[0]!.action as { value: { value: string } }).value;
    expect(value.value).toBe(MASKED_VALUE);
    expect(JSON.stringify(steps)).not.toContain('hunter2!');
  });

  it('captures the intent for a locator step and the role/name form for ref targets', () => {
    const { rec } = makeRecorder();
    // Intent handed by the router (the caller used { kind: 'intent' } or a heal intent).
    rec.append(
      resultOf(
        { type: 'click', target: { kind: 'locator', locator: locator() } },
        {
          locator: locator(),
          element: { ref: 'e1', role: 'button', name: 'Save' },
        },
      ),
      ctx,
      'the save button',
      'low',
    );
    // No intent handed and the target was a ref: describe the resolved element.
    rec.append(
      resultOf(
        { type: 'click', target: { kind: 'ref', ref: 'e1', observationId: 'o1' } },
        {
          locator: locator(),
          element: { ref: 'e1', role: 'button', name: 'Save' },
        },
      ),
      ctx,
      null,
      'low',
    );
    const steps = rec.finalize(true)!;
    expect(steps[0]!.intent).toBe('the save button');
    expect(steps[1]!.intent).toBe('button "Save"');
  });

  it('a human-manual step keeps {kind:"intent"} as the recorded target (router §5.3)', () => {
    const { rec } = makeRecorder();
    rec.append(
      resultOf(
        { type: 'click', target: { kind: 'intent', text: 'the captcha' } },
        {
          tier: 'human',
          locator: locator(),
        },
      ),
      ctx,
      'the captcha',
      'low',
    );
    const steps = rec.finalize(true)!;
    expect((steps[0]!.action as { target: unknown }).target).toEqual({ kind: 'intent', text: 'the captcha' });
  });

  it('carries the router-computed risk onto the step and post.urlPattern only on page change', () => {
    const { rec } = makeRecorder();
    rec.append(resultOf({ type: 'click', target: { kind: 'ref', ref: 'e1', observationId: 'o1' } }), ctx, null, 'high');
    rec.append(
      resultOf(
        { type: 'click', target: { kind: 'ref', ref: 'e2', observationId: 'o1' } },
        {
          url: 'https://shop.test/checkout',
          pageChanged: true,
        },
      ),
      ctx,
      null,
      'medium',
    );
    const steps = rec.finalize(true)!;
    expect(steps[0]!.risk).toBe('high');
    expect(steps[0]!.post).toBeUndefined();
    expect(steps[1]!.risk).toBe('medium');
    expect(steps[1]!.post?.urlPattern).toBe('/checkout');
    expect(steps[1]!.pre.urlPattern).toBe('/');
  });
});

describe('TrajectoryRecorder — finalize and compaction (memory §6.1)', () => {
  it('finalize(false) discards the buffer and writes nothing', () => {
    const { rec, store } = makeRecorder();
    rec.append(
      resultOf({ type: 'navigate', url: 'https://shop.test/a' }, { url: 'https://shop.test/a', pageChanged: true }),
      ctx,
      null,
      'low',
    );
    expect(rec.finalize(false)).toBeNull();
    expect(store.createRecorded).not.toHaveBeenCalled();
    expect(rec.isRecording()).toBe(false);
  });

  it('finalize(true) persists version-1 input with origin, params and secret names', () => {
    const { rec, store } = makeRecorder({ params: { product: 'p' }, secretNames: ['checkout.password'] });
    rec.append(resultOf({ type: 'click', target: { kind: 'ref', ref: 'e1', observationId: 'o1' } }), ctx, null, 'low');
    const steps = rec.finalize(true)!;
    expect(store.createRecorded).toHaveBeenCalledTimes(1);
    const input = store.createRecorded.mock.calls[0]![0];
    expect(input).toMatchObject({
      taskKey: 'shop.checkout',
      origin: 'https://shop.test',
      startUrl: 'https://shop.test/',
      params: ['product'],
      secretNames: ['checkout.password'],
    });
    expect(input.steps).toEqual(steps);
  });

  it('compactSteps: consecutive fills on the same locator collapse to the last', () => {
    const loc = locator();
    const fill = (v: string) =>
      resultOf(
        {
          type: 'fill',
          target: { kind: 'locator', locator: loc },
          value: { kind: 'literal', value: v },
        } as BrowserAction,
        { locator: loc },
      );
    const steps = compactSteps([
      { index: 0, action: (fill('a') as ActionResult).action, intent: null, pre: { urlPattern: '/' }, risk: 'low' },
      { index: 1, action: (fill('b') as ActionResult).action, intent: null, pre: { urlPattern: '/' }, risk: 'low' },
      { index: 2, action: (fill('c') as ActionResult).action, intent: null, pre: { urlPattern: '/' }, risk: 'low' },
    ]);
    expect(steps).toHaveLength(1);
    expect((steps[0]!.action as { value: unknown }).value).toEqual({ kind: 'literal', value: 'c' });
    expect(steps[0]!.index).toBe(0);
  });

  it('compactSteps: a wait immediately followed by waitFor is dropped, indices stay dense', () => {
    const wait = {
      index: 0,
      action: { type: 'wait', until: 'load' } as BrowserAction,
      intent: null,
      pre: { urlPattern: '/' },
      risk: 'low' as const,
    };
    const waitFor = {
      index: 1,
      action: { type: 'waitFor', target: { kind: 'ref', ref: 'e1', observationId: 'o1' } } as BrowserAction,
      intent: null,
      pre: { urlPattern: '/' },
      risk: 'low' as const,
    };
    const click = {
      index: 2,
      action: { type: 'click', target: { kind: 'ref', ref: 'e2', observationId: 'o1' } } as BrowserAction,
      intent: null,
      pre: { urlPattern: '/' },
      risk: 'low' as const,
    };
    const steps = compactSteps([click, wait, waitFor, click].map((s, i) => ({ ...s, index: i })));
    expect(steps.map((s) => s.action.type)).toEqual(['click', 'waitFor', 'click']);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('failed steps are never appended by the recorder itself', () => {
    const { rec } = makeRecorder();
    rec.append(
      resultOf({ type: 'click', target: { kind: 'ref', ref: 'e1', observationId: 'o1' } }, { ok: false }),
      ctx,
      null,
      'low',
    );
    expect(rec.finalize(true)).toBeNull();
  });
});

describe('S13 — sensitive literal guard at the router (memory §6.1, SECURITY.md S13)', () => {
  // Minimal router harness mirroring router-core.test.ts fakes. The point of
  // the test: the rejection happens BEFORE execution, so every fake driver
  // method must show zero calls.
  function pwEntry(): import('@browser-os/protocol').IndexEntry {
    return {
      backendNodeId: 1,
      frameId: 'f0',
      cdpFrameId: '1',
      locator: {
        v: 1,
        role: 'textbox',
        name: 'Password',
        nameIsDynamic: false,
        tag: 'input',
        attrs: { type: 'password', name: 'password' },
        context: [],
        cssPath: '#pw',
        framePath: [],
        ordinal: 0,
      },
    };
  }

  function routerWithRecording() {
    const el = {
      ref: 'e1',
      role: 'textbox',
      name: 'Password',
      tag: 'input',
      state: {},
      inViewport: true,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      frame: 'f0',
      context: [],
    } as never;
    const entry = pwEntry();
    const observation = {
      id: 'obs1',
      sessionId: 's1',
      pageId: 'p1',
      url: 'https://shop.test/',
      title: 'Shop',
      capturedAt: 1,
      frames: [],
      elements: [el],
      text: [],
      dialogs: [],
      challenge: null,
      warnings: [],
      stats: { domNodes: 1, axNodes: 1, elements: 1, captureMs: 1, buildMs: 1, estTokens: 1 },
    } as never;
    const index = { observationId: 'obs1', pageId: 'p1', entries: new Map([['e1', entry]]) };
    const stayed = {
      ok: true,
      effect: 'committed',
      urlBefore: 'https://shop.test/',
      urlAfter: 'https://shop.test/',
      navigated: false,
    };
    const driver: any = {
      navigate: vi.fn(async () => stayed),
      settle: vi.fn(async () => {}),
      cdpPerform: vi.fn(async () => stayed),
      playwrightPerform: vi.fn(async () => stayed),
      readValue: vi.fn(async () => 'sekret'), // must match ctx.secrets.resolve for the fill verify to pass
    };
    const recorder = { isRecording: () => true, append: vi.fn(), finalize: vi.fn() };
    const router = new ActionRouter({
      driver,
      observer: {
        capture: vi.fn(async () => ({ observation, index })),
        index: vi.fn(() => index),
        invalidate: vi.fn(),
      },
      sessions: {
        withPageLock: vi.fn(async (_s: string, _p: string, fn: () => Promise<any>) => fn()),
        setActivePage: vi.fn(),
        reconnect: vi.fn(),
      } as any,
      runs: { insert: vi.fn(() => 1) },
      cache: { get: vi.fn(() => null), put: vi.fn(), recordHit: vi.fn(), recordMiss: vi.fn(), invalidate: vi.fn() },
      risk: { classify: vi.fn(() => ({ risk: 'low' as const, reasons: [] as string[] })) },
      permissions: {
        decide: vi.fn(() => 'allow' as const),
        requestConfirmation: vi.fn(async () => 'approve' as const),
      },
      human: null,
      events: { emit: vi.fn() },
      recorder,
      constants: {},
      disabledTiers: [],
    } as any);
    return { router, driver, recorder };
  }

  const execCtx = {
    sessionId: 's1',
    pageId: 'p1',
    taskId: 'task-1',
    policy: { budgets: { actionTimeoutMs: 2000, maxLlmCallsPerAction: 3, maxLlmCallsPerTask: 10 } },
    params: {},
    secrets: { resolve: async () => 'sekret' },
    budget: {},
    signal: new AbortController().signal,
    clock: { now: () => Date.now() },
  } as never;

  it('rejects a fill literal into a password field before the driver runs and never records it', async () => {
    const { router, driver, recorder } = routerWithRecording();
    const result = await router.execute(
      {
        type: 'fill',
        target: { kind: 'ref', observationId: 'obs1', ref: 'e1' },
        value: { kind: 'literal', value: 'hunter2!' },
      },
      execCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_REQUEST');
    expect(result.error?.message).toContain('secret reference');
    expect(driver.cdpPerform).not.toHaveBeenCalled();
    expect(driver.playwrightPerform).not.toHaveBeenCalled();
    expect(driver.readValue).not.toHaveBeenCalled();
    expect(recorder.append).not.toHaveBeenCalled();
  });

  it('lets a secret-reference fill through to execution while recording', async () => {
    const { router, driver, recorder } = routerWithRecording();
    const result = await router.execute(
      {
        type: 'fill',
        target: { kind: 'ref', observationId: 'obs1', ref: 'e1' },
        value: { kind: 'secret', name: 'shop.password' },
      },
      execCtx,
    );
    expect(result.ok).toBe(true);
    expect(driver.cdpPerform).toHaveBeenCalled();
    expect(recorder.append).toHaveBeenCalledTimes(1);
  });
});
