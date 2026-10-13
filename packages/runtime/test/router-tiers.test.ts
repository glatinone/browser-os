import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeResponder } from '@browser-os/ai';
import { buildResolvePrompt, FakeModelProvider, truthResponder } from '@browser-os/ai';
import { buildObservation } from '@browser-os/dom';
import type {
  BrowserAction,
  ElementLocator,
  ExecutionContext,
  IndexEntry,
  ModelRequest,
  Observation,
  ObservationIndex,
  SemanticElement,
  TierAttempt,
} from '@browser-os/protocol';
import { MASKED_VALUE } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import { pauseForChallenge, resolveHumanTier } from '../src/router/resolve-human.js';
import { resolveIntentTarget } from '../src/router/resolve-intent.js';
import { resolveLlmTier, selectCandidates } from '../src/router/resolve-llm.js';
import type { ActionCachePort, ActionCacheQuery, VisionResolver } from '../src/router/types.js';
import { NullVisionResolver } from '../src/router/vision.js';
import type { HumanGate } from '../src/security/interfaces.js';
import { RejectingHumanGate } from '../src/security/stubs.js';

/**
 * P7-04 — LLM tier (§5.2), human tier (§5.3), vision hook, and the §4 step D security
 * challenge gate. Everything runs against fakes: no page, no CDP, no network, and the
 * only "model" is `FakeModelProvider`.
 *
 * The tier functions are covered here at module level, and the wired ladder
 * (`resolveIntentTarget`, tiers 2→5 in order) at the bottom of this file — P7-04
 * wired tiers 3–5 and the challenge gate into the ladder that P7-03 sequenced.
 */

const RAW_SECRET = 'hunter2-CANARY-e3f1';

// ── fixtures ─────────────────────────────────────────────────────────────────

function element(ref: string, role: string, name: string, overrides: Partial<SemanticElement> = {}): SemanticElement {
  return {
    ref,
    role,
    name,
    tag: 'button',
    state: {},
    inViewport: true,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    frame: 'f0',
    context: [],
    ...overrides,
  } as SemanticElement;
}

function locatorFor(el: SemanticElement): ElementLocator {
  return {
    v: 1,
    role: el.role,
    name: el.name,
    nameIsDynamic: false,
    tag: el.tag,
    attrs: {},
    context: [],
    cssPath: `#${el.ref}`,
    framePath: [],
    ordinal: 0,
  };
}

function observation(
  elements: SemanticElement[],
  overrides: Partial<Observation> = {},
): { observation: Observation; index: ObservationIndex } {
  const entries = new Map<string, IndexEntry>();
  for (const el of elements) {
    entries.set(el.ref, {
      backendNodeId: Number(el.ref.replace(/\D/g, '')) || 1,
      frameId: 'f0',
      cdpFrameId: '1',
      locator: locatorFor(el),
    });
  }
  const obs = {
    id: 'obs_1',
    sessionId: 's1',
    pageId: 'p1',
    url: 'https://example.test/settings',
    title: 'Settings',
    capturedAt: 1_700_000_000_000,
    frames: [],
    elements,
    text: [],
    dialogs: [],
    challenge: null,
    warnings: [],
    stats: { domNodes: 1, axNodes: 1, elements: elements.length, captureMs: 1, buildMs: 1, estTokens: 10 },
    ...overrides,
  } as unknown as Observation;
  return { observation: obs, index: { observationId: obs.id, pageId: 'p1', entries } };
}

function budget(
  overrides: Partial<{
    llmCallsAction: number;
    llmCallsActionMax: number;
    llmCallsTask: number;
    llmCallsTaskMax: number;
  }> = {},
) {
  return { llmCallsAction: 0, llmCallsActionMax: 2, llmCallsTask: 0, llmCallsTaskMax: 20, ...overrides };
}

function ctx(clockNow = () => 0): ExecutionContext {
  return {
    sessionId: 's1',
    pageId: 'p1',
    taskId: null,
    policy: {} as ExecutionContext['policy'],
    params: {},
    secrets: { resolve: async () => RAW_SECRET },
    budget: {
      llmCallsAction: 0,
      llmCallsActionMax: 2,
      llmCallsTask: 0,
      llmCallsTaskMax: Number.POSITIVE_INFINITY,
      deadline: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    clock: { now: clockNow },
  } as ExecutionContext;
}

function fillAction(): BrowserAction {
  return { id: 'req_1', type: 'fill', value: { kind: 'literal', value: 'irrelevant' } } as unknown as BrowserAction;
}

/**
 * Click is compatible with every non-disabled element (action-router §5.1
 * `isCompatible`), which is what the human-tier fixtures (buttons and links)
 * are. A `fill` action would rank zero of them and the pause would carry an
 * empty candidate list — the human could not point at anything.
 */
function clickAction(): BrowserAction {
  return { id: 'req_1', type: 'click' } as unknown as BrowserAction;
}

function promptText(request: ModelRequest): string {
  return request.messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(' '),
    )
    .join('\n')
    .trim();
}

/** `truthResponder` answers without a `confidence`; the schema needs one, so add it. */
function confident(base: FakeResponder, confidence = 0.93): FakeResponder {
  return (request) => {
    const answer = base(request) as { ref: string | null };
    return { ref: answer.ref ?? null, confidence: answer.ref ? confidence : 0 };
  };
}

function fakeCache() {
  const puts: Array<{ query: ActionCacheQuery; locator: ElementLocator }> = [];
  const port: ActionCachePort = {
    get: () => null,
    put: (query, locator) => {
      puts.push({ query, locator });
    },
    recordHit: () => {},
    recordMiss: () => 0,
    invalidate: () => {},
  };
  return { port, puts };
}

function gate(
  answer: { choice: 'ref'; ref: string; observationId: string } | { choice: 'done' } | { choice: 'abort' },
): {
  gate: HumanGate;
  requests: Array<Parameters<HumanGate['pause']>[0]>;
} {
  const requests: Array<Parameters<HumanGate['pause']>[0]> = [];
  return {
    gate: {
      async pause(request) {
        requests.push(request);
        return answer;
      },
    },
    requests,
  };
}

// ── §5.2 LLM tier ────────────────────────────────────────────────────────────

describe('resolveLlmTier (action-router §5.2)', () => {
  const intent = 'the save button';
  const elements = [
    element('e3', 'link', 'Cancel'),
    element('e7', 'button', 'Save'),
    element('e12', 'button', 'Save draft'),
    element('e20', 'paragraph', 'Changes are saved automatically.'),
  ];

  it('resolves an ambiguous intent when the model picks a ref', async () => {
    const { observation: obs, index } = observation(elements);
    const attempts: TierAttempt[] = [];
    const candidates = selectCandidates(obs, intent, 'click', 5);

    // Build the exact key `truthResponder` keys on, so the fake answers from the same
    // prompt the tier actually sends.
    const key = promptText(
      buildResolvePrompt({
        actionType: 'click',
        intent,
        url: obs.url,
        title: obs.title,
        dialogs: obs.dialogs,
        candidates,
      }),
    );
    const model = new FakeModelProvider({ responder: confident(truthResponder({ [key]: 'e12' })) });

    const result = await resolveLlmTier(
      {
        actionType: 'click',
        intent,
        observation: obs,
        index,
        model,
        enabled: true,
        budget: budget(),
        constants: { llmCandidates: 5, llmMinConfidence: 0.72 },
      },
      attempts,
    );

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.resolution.tier).toBe('llm');
    expect(result.resolution.element.ref).toBe('e12');
    expect(result.resolution.entry.locator.name).toBe('Save draft');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ tier: 'llm', ok: true, candidates: candidates.length });
  });

  it('consumes one call from both the action and task budgets', async () => {
    const { observation: obs, index } = observation(elements);
    const model = new FakeModelProvider({ responder: { ref: 'e7', confidence: 0.99 } });
    const b = budget();

    await resolveLlmTier(
      {
        actionType: 'click',
        intent,
        observation: obs,
        index,
        model,
        enabled: true,
        budget: b,
        constants: { llmCandidates: 5, llmMinConfidence: 0.72 },
      },
      [],
    );

    expect(b.llmCallsAction).toBe(1);
    expect(b.llmCallsTask).toBe(1);
  });

  it('treats a model ref outside the candidate list as no decision, never a selector', async () => {
    const { observation: obs, index } = observation(elements);
    const attempts: TierAttempt[] = [];
    // e99 is in the observation index but is NOT among the candidates sent.
    const model = new FakeModelProvider({ responder: { ref: 'e99', confidence: 0.99 } });

    const result = await resolveLlmTier(
      {
        actionType: 'click',
        intent,
        observation: obs,
        index,
        model,
        enabled: true,
        budget: budget(),
        constants: { llmCandidates: 2, llmMinConfidence: 0.72 },
      },
      attempts,
    );

    expect(result.outcome).toBe('no-decision');
    expect(model.calls).toBe(1); // one retry-less call: the shape was valid, the ref was not
    expect(attempts[0]).toMatchObject({ tier: 'llm', ok: false });
  });

  it('returns no decision when confidence is below llmMinConfidence', async () => {
    const { observation: obs, index } = observation(elements);
    const model = new FakeModelProvider({ responder: { ref: 'e7', confidence: 0.4 } });
    const attempts: TierAttempt[] = [];

    const result = await resolveLlmTier(
      {
        actionType: 'click',
        intent,
        observation: obs,
        index,
        model,
        enabled: true,
        budget: budget(),
        constants: { llmCandidates: 5, llmMinConfidence: 0.72 },
      },
      attempts,
    );

    expect(result.outcome).toBe('no-decision');
    expect(attempts[0]?.ok).toBe(false);
  });

  it('never calls the model when the action budget is exhausted', async () => {
    const { observation: obs, index } = observation(elements);
    const model = new FakeModelProvider({ responder: { ref: 'e7', confidence: 0.99 } });
    const attempts: TierAttempt[] = [];

    const result = await resolveLlmTier(
      {
        actionType: 'click',
        intent,
        observation: obs,
        index,
        model,
        enabled: true,
        budget: budget({ llmCallsAction: 2, llmCallsActionMax: 2 }),
        constants: { llmCandidates: 5, llmMinConfidence: 0.72 },
      },
      attempts,
    );

    expect(result).toEqual({ outcome: 'skipped', reason: 'BUDGET_EXCEEDED' });
    expect(model.calls).toBe(0);
    expect(attempts[0]).toMatchObject({ tier: 'llm', ok: false, reason: 'BUDGET_EXCEEDED' });
  });

  it('never calls the model when the task budget is exhausted', async () => {
    const { observation: obs, index } = observation(elements);
    const model = new FakeModelProvider({ responder: { ref: 'e7', confidence: 0.99 } });
    const attempts: TierAttempt[] = [];

    const result = await resolveLlmTier(
      {
        actionType: 'click',
        intent,
        observation: obs,
        index,
        model,
        enabled: true,
        budget: budget({ llmCallsTask: 20, llmCallsTaskMax: 20 }),
        constants: { llmCandidates: 5, llmMinConfidence: 0.72 },
      },
      attempts,
    );

    expect(result).toEqual({ outcome: 'skipped', reason: 'BUDGET_EXCEEDED' });
    expect(model.calls).toBe(0);
  });

  it('never calls the model when policy.tiers.llm is false (LLM_DISABLED)', async () => {
    const { observation: obs, index } = observation(elements);
    const model = new FakeModelProvider({ responder: { ref: 'e7', confidence: 0.99 } });
    const attempts: TierAttempt[] = [];

    const result = await resolveLlmTier(
      {
        actionType: 'click',
        intent,
        observation: obs,
        index,
        model,
        enabled: false,
        budget: budget(),
        constants: { llmCandidates: 5, llmMinConfidence: 0.72 },
      },
      attempts,
    );

    expect(result).toEqual({ outcome: 'skipped', reason: 'LLM_DISABLED' });
    expect(model.calls).toBe(0);
  });

  it('never calls the model when no fast model is registered (LLM_DISABLED)', async () => {
    const { observation: obs, index } = observation(elements);
    const attempts: TierAttempt[] = [];

    const result = await resolveLlmTier(
      {
        actionType: 'click',
        intent,
        observation: obs,
        index,
        model: null,
        enabled: true,
        budget: budget(),
        constants: { llmCandidates: 5, llmMinConfidence: 0.72 },
      },
      attempts,
    );

    expect(result).toEqual({ outcome: 'skipped', reason: 'LLM_DISABLED' });
    expect(attempts[0]).toMatchObject({ reason: 'LLM_DISABLED' });
  });

  it('fills candidates from in-viewport elements when fewer than K score above zero', () => {
    // Nothing here matches the intent lexically, so the ranker scores everything 0 —
    // the model would otherwise receive an empty list.
    const quiet = [
      element('e1', 'link', 'Home'),
      element('e2', 'link', 'About'),
      element('e3', 'link', 'Contact'),
      element('e4', 'paragraph', 'Footer', { inViewport: false }),
    ];
    const { observation: obs } = observation(quiet);
    const chosen = selectCandidates(obs, 'the login portal', 'click', 3);
    expect(chosen).toHaveLength(3);
    expect(chosen.map((c) => c.ref)).toEqual(['e1', 'e2', 'e3']);
  });

  it('caps the candidate list at K', () => {
    const many = Array.from({ length: 12 }, (_, i) => element(`e${i + 1}`, 'button', `Save ${i + 1}`));
    const { observation: obs } = observation(many);
    expect(selectCandidates(obs, 'save', 'click', 5)).toHaveLength(5);
  });
});

// ── AC: no secret reaches a prompt ───────────────────────────────────────────

describe('P7-04 acceptance: no prompt carries a secret', () => {
  it('sends the mask, never the raw password, and never the action value', async () => {
    const password = element('e9', 'textbox', 'Password', {
      tag: 'input',
      value: MASKED_VALUE,
      state: { editable: true },
    });
    const { observation: obs, index } = observation([
      element('e3', 'textbox', 'Email', { tag: 'input', state: { editable: true } }),
      password,
    ]);

    const model = new FakeModelProvider({ responder: { ref: 'e3', confidence: 0.99 } });
    const seen: ModelRequest[] = [];
    const b = budget();

    await resolveLlmTier(
      {
        actionType: 'fill',
        intent: 'the password field',
        observation: obs,
        index,
        model,
        enabled: true,
        budget: b,
        constants: { llmCandidates: 5, llmMinConfidence: 0.72 },
        onPrompt: (prompt) => seen.push(prompt),
      },
      [],
    );

    expect(model.calls).toBe(1);
    expect(seen).toHaveLength(1);
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).toContain(MASKED_VALUE); // the mask passes through untouched
    expect(serialized).not.toContain(RAW_SECRET);
    expect(serialized).not.toContain('irrelevant'); // the fill value is not in the prompt
  });
});

// ── §5.3 human tier ──────────────────────────────────────────────────────────

describe('resolveHumanTier (action-router §5.3)', () => {
  const elements = [
    element('e3', 'button', 'Save'),
    element('e7', 'button', 'Save draft'),
    element('e12', 'link', 'Cancel'),
    element('e20', 'link', 'Back'),
  ];
  const intent = 'the tricky button';

  it('resolves on a ref answer and writes the cache (the human taught us)', async () => {
    const { observation: obs, index } = observation(elements);
    const attempts: TierAttempt[] = [];
    const { port, puts } = fakeCache();
    const { gate: humanGate, requests } = gate({ choice: 'ref', ref: 'e7', observationId: 'obs_1' });

    const result = await resolveHumanTier(
      {
        action: clickAction(),
        intent,
        observation: obs,
        index,
        ctx: ctx(),
        humanGate,
        reason: 'ambiguous',
        cache: {
          port,
          query: { origin: 'https://example.test', pathTemplate: '/settings', actionType: 'click', intent },
        },
      },
      attempts,
    );

    expect(result).toMatchObject({ tier: 'human' });
    if (!('entry' in result)) throw new Error('expected a Resolution');
    expect(result.element.ref).toBe('e7');
    expect(result.entry.locator.name).toBe('Save draft');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sessionId: 's1',
      taskId: null,
      reason: 'ambiguous',
      observationId: 'obs_1',
      message: `Cannot confidently find '${intent}' for click.`,
    });
    expect(requests[0]?.candidates?.length).toBeLessThanOrEqual(5);
    expect(requests[0]?.candidates?.map((c) => c.ref)).toContain('e7');

    expect(puts).toHaveLength(1);
    expect(puts[0]?.query).toMatchObject({ actionType: 'click', intent });
    expect(puts[0]?.locator.name).toBe('Save draft');
    expect(attempts[0]).toMatchObject({ tier: 'human', ok: true });
  });

  it('a done answer means the step already happened: ok, no execution, no cache write', async () => {
    const { observation: obs, index } = observation(elements);
    const { port, puts } = fakeCache();
    const { gate: humanGate, requests } = gate({ choice: 'done' });

    const result = await resolveHumanTier(
      {
        action: clickAction(),
        intent,
        observation: obs,
        index,
        ctx: ctx(),
        humanGate,
        reason: 'ambiguous',
        cache: {
          port,
          query: { origin: 'https://example.test', pathTemplate: '/settings', actionType: 'click', intent },
        },
      },
      [],
    );

    expect(result).toEqual({ tier: 'human', done: true });
    expect(puts).toHaveLength(0); // §5.3.2: the cache is NOT written on 'done'
    expect(requests).toHaveLength(1);
  });

  it('an abort answer fails HUMAN_REQUIRED', async () => {
    const { observation: obs, index } = observation(elements);
    const { port, puts } = fakeCache();
    const attempts: TierAttempt[] = [];

    await expect(
      resolveHumanTier(
        {
          action: clickAction(),
          intent,
          observation: obs,
          index,
          ctx: ctx(),
          humanGate: gate({ choice: 'abort' }).gate,
          reason: 'ambiguous',
          cache: { port, query: { origin: 'https://example.test', pathTemplate: '/s', actionType: 'click', intent } },
        },
        attempts,
      ),
    ).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });

    expect(puts).toHaveLength(0);
    expect(attempts[0]).toMatchObject({ tier: 'human', ok: false, reason: 'HUMAN_REQUIRED' });
  });

  it('rejects a ref answer that points at a stale observation', async () => {
    const { observation: obs, index } = observation(elements);
    const { port, puts } = fakeCache();

    await expect(
      resolveHumanTier(
        {
          action: clickAction(),
          intent,
          observation: obs,
          index,
          ctx: ctx(),
          humanGate: gate({ choice: 'ref', ref: 'e7', observationId: 'obs_STALE' }).gate,
          reason: 'ambiguous',
          cache: { port, query: { origin: 'https://example.test', pathTemplate: '/s', actionType: 'click', intent } },
        },
        [],
      ),
    ).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });

    expect(puts).toHaveLength(0); // a stale pick is never learned
  });

  it('rejects a ref answer naming a ref that is not in the index', async () => {
    const { observation: obs, index } = observation(elements);

    await expect(
      resolveHumanTier(
        {
          action: clickAction(),
          intent,
          observation: obs,
          index,
          ctx: ctx(),
          humanGate: gate({ choice: 'ref', ref: 'e999', observationId: 'obs_1' }).gate,
          reason: 'ambiguous',
        },
        [],
      ),
    ).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });
  });
});

// ── §4 step D: security challenge ────────────────────────────────────────────

describe('pauseForChallenge (action-router §4 step D, P7-04 requirement 5)', () => {
  async function loginFixture(): Promise<Observation> {
    const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dom/test/fixtures');
    const raw = JSON.parse(await readFile(path.join(fixtures, 'login.raw.json'), 'utf8')) as Parameters<
      typeof buildObservation
    >[0];
    return buildObservation(raw, { url: 'http://127.0.0.1/login/', title: 'Sign in', includeText: true }).observation;
  }

  it('the login fixture carries a detected challenge', async () => {
    expect((await loginFixture()).challenge).toBe('login');
  });

  it('pauses with the challenge as the reason and fails SECURITY_CHALLENGE when the gate aborts', async () => {
    const obs = await loginFixture();
    const { gate: humanGate, requests } = gate({ choice: 'abort' });

    await expect(
      pauseForChallenge({ challenge: obs.challenge ?? 'unknown', observationId: obs.id, ctx: ctx(), humanGate }),
    ).rejects.toMatchObject({ code: 'SECURITY_CHALLENGE' });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reason: 'login', observationId: obs.id });
    expect(requests[0]?.message).toContain('login');
  });

  it('the shipped RejectingHumanGate aborts, so an unattended run stops at the wall', async () => {
    const obs = await loginFixture();

    await expect(
      pauseForChallenge({ challenge: obs.challenge ?? 'unknown', ctx: ctx(), humanGate: new RejectingHumanGate() }),
    ).rejects.toMatchObject({ code: 'SECURITY_CHALLENGE' });
  });

  it('resumes resolution when a human clears the wall by hand', async () => {
    const obs = await loginFixture();
    const { gate: humanGate } = gate({ choice: 'done' });

    await expect(pauseForChallenge({ challenge: obs.challenge ?? 'unknown', ctx: ctx(), humanGate })).resolves.toBe(
      'resume',
    );
  });

  it('carries every ChallengeKind the detector can raise', async () => {
    for (const challenge of ['login', 'captcha', 'mfa', 'passkey', 'consent', 'unknown'] as const) {
      const { gate: humanGate } = gate({ choice: 'abort' });
      await expect(pauseForChallenge({ challenge, ctx: ctx(), humanGate })).rejects.toMatchObject({
        code: 'SECURITY_CHALLENGE',
      });
    }
  });
});

// ── §5 tier 4: vision ────────────────────────────────────────────────────────

describe('NullVisionResolver (P7-04 requirement 3)', () => {
  it('returns null without recording an attempt or touching the page', async () => {
    const { observation: obs } = observation([element('e1', 'button', 'Save')]);
    const result = await new NullVisionResolver().resolve({
      observation: obs,
      action: fillAction(),
      text: 'save',
      ctx: ctx(),
    });
    expect(result).toBeNull();
  });
});

// ── the wired ladder: tiers 2 → 5 in order ──────────────────────────────────

describe('resolveIntentTarget wiring (P7-04)', () => {
  const intent = 'the export button'; // nothing on the page matches: tier 2 scores < accept (0.75) and declines,
  // so the ladder falls to tiers 3–5 (the same fixture the §5.2 module tests assume).
  const elements = [
    element('e3', 'link', 'Cancel'),
    element('e7', 'button', 'Save'),
    element('e12', 'button', 'Save draft'),
    element('e20', 'paragraph', 'Changes are saved automatically.'),
  ];

  /** Captures in order, so a test can hand the ladder a challenged page first. */
  function captureDeps(pages: Array<{ observation: Observation; index: ObservationIndex }>) {
    let i = 0;
    return {
      capture: async () => pages[Math.min(i++, pages.length - 1)],
      index: () => pages[0]!.index,
      invalidate: () => {},
    };
  }

  function ladderInput(obs: Observation, c: ExecutionContext): Parameters<typeof resolveIntentTarget>[0] {
    return {
      intent,
      actionType: 'click',
      url: obs.url,
      sessionId: 's1',
      pageId: 'p1',
      skipCache: true,
      action: clickAction(),
      ctx: c,
    };
  }

  function ladderDeps(
    pages: Array<{ observation: Observation; index: ObservationIndex }>,
    extra: Record<string, unknown> = {},
  ): Parameters<typeof resolveIntentTarget>[2] {
    return {
      driver: {} as never,
      observer: captureDeps(pages),
      cache: fakeCache().port,
      ...extra,
    } as Parameters<typeof resolveIntentTarget>[2];
  }

  function policyCtx(
    tiers: Partial<{ llm: boolean; vision: boolean; human: boolean }>,
    budgetOverrides: Partial<{ llmCallsAction: number }> = {},
  ): ExecutionContext {
    const c = ctx();
    (c.policy as unknown as { tiers: { llm: boolean; vision: boolean; human: boolean } }).tiers = {
      llm: tiers.llm ?? true,
      vision: tiers.vision ?? false,
      human: tiers.human ?? true,
    };
    Object.assign(c.budget, budgetOverrides);
    return c;
  }

  /** Model that always declines — nothing on the page matches (§5.2 `return null`). */
  function decliningModel(): FakeModelProvider {
    return new FakeModelProvider({ responder: () => ({ ref: null, confidence: 0 }) });
  }

  /** Model that picks `ref` for the exact prompt the ladder sends (truthResponder keys on prompt text). */
  function pickingModel(obs: Observation, ref: string): FakeModelProvider {
    const key = promptText(
      buildResolvePrompt({
        actionType: 'click',
        intent,
        url: obs.url,
        title: obs.title,
        dialogs: obs.dialogs,
        candidates: selectCandidates(obs, intent, 'click', 5),
      }),
    );
    return new FakeModelProvider({ responder: confident(truthResponder({ [key]: ref })) });
  }

  it('tier 3: the ladder falls through to the model, consumes the budget, and resolves at tier llm', async () => {
    const { observation: obs, index } = observation(elements);
    const model = pickingModel(obs, 'e12');
    const c = policyCtx({});
    const attempts: TierAttempt[] = [];

    const result = await resolveIntentTarget(
      ladderInput(obs, c),
      attempts,
      ladderDeps([{ observation: obs, index }], { models: { get: () => model } }),
    );

    expect(result).toMatchObject({ tier: 'llm', entry: { backendNodeId: 12 } });
    expect(result).toHaveProperty('intentLearning');
    expect(model.calls).toBe(1);
    expect(c.budget.llmCallsAction).toBe(1); // §5.2: spent by the call itself
    expect(attempts).toEqual([
      expect.objectContaining({ tier: 'deterministic', ok: false }),
      expect.objectContaining({ tier: 'llm', ok: true, candidates: 4 }), // 4 click-compatible elements in the fixture
    ]);
  });

  it('tier 3 skipped when policy.tiers.llm is false — LLM_DISABLED recorded, model untouched', async () => {
    const { observation: obs, index } = observation(elements);
    const model = decliningModel();
    const c = policyCtx({ llm: false });
    const attempts: TierAttempt[] = [];

    await expect(
      resolveIntentTarget(
        ladderInput(obs, c),
        attempts,
        ladderDeps([{ observation: obs, index }], { models: { get: () => model } }),
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });

    expect(model.calls).toBe(0);
    expect(attempts).toContainEqual(expect.objectContaining({ tier: 'llm', ok: false, reason: 'LLM_DISABLED' }));
  });

  it('tier 3 skipped when the action budget is spent — BUDGET_EXCEEDED recorded, model untouched', async () => {
    const { observation: obs, index } = observation(elements);
    const model = decliningModel();
    const c = policyCtx({}, { llmCallsAction: 2 }); // llmCallsActionMax is 2
    const attempts: TierAttempt[] = [];

    await expect(
      resolveIntentTarget(
        ladderInput(obs, c),
        attempts,
        ladderDeps([{ observation: obs, index }], { models: { get: () => model } }),
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });

    expect(model.calls).toBe(0);
    expect(attempts).toContainEqual(expect.objectContaining({ tier: 'llm', ok: false, reason: 'BUDGET_EXCEEDED' }));
  });

  it('tier 5: every automatic tier declined, the human points at a ref and it is learned', async () => {
    const { observation: obs, index } = observation(elements);
    const cache = fakeCache();
    const { gate: humanGate, requests } = gate({ choice: 'ref', ref: 'e7', observationId: obs.id });
    const attempts: TierAttempt[] = [];

    const result = await resolveIntentTarget(
      ladderInput(obs, policyCtx({})),
      attempts,
      ladderDeps([{ observation: obs, index }], {
        models: { get: () => decliningModel() },
        humanGate,
        cache: cache.port,
      }),
    );

    expect(result).toMatchObject({ tier: 'human', entry: { backendNodeId: 7 } });
    expect(requests[0]).toMatchObject({ reason: 'ambiguous' });
    expect(requests[0]?.candidates?.length).toBeGreaterThan(0);
    expect(cache.puts).toHaveLength(1); // §5.3.2: the human taught us — learned immediately
    expect(attempts).toEqual([
      expect.objectContaining({ tier: 'deterministic', ok: false }),
      expect.objectContaining({ tier: 'llm', ok: false }),
      expect.objectContaining({ tier: 'human', ok: true }),
    ]);
  });

  it('tier 5 done: HumanDone reaches the caller verbatim and nothing is cached', async () => {
    const { observation: obs, index } = observation(elements);
    const cache = fakeCache();
    const { gate: humanGate } = gate({ choice: 'done' });
    const attempts: TierAttempt[] = [];

    const result = await resolveIntentTarget(
      ladderInput(obs, policyCtx({})),
      attempts,
      ladderDeps([{ observation: obs, index }], { humanGate, cache: cache.port }),
    );

    expect(result).toEqual({ tier: 'human', done: true });
    expect(cache.puts).toHaveLength(0); // no resolution — nothing to learn
    expect(attempts.at(-1)).toMatchObject({ tier: 'human', ok: true });
  });

  it('tier 5 abort: HUMAN_REQUIRED with the attempt recorded', async () => {
    const { observation: obs, index } = observation(elements);
    const { gate: humanGate } = gate({ choice: 'abort' });
    const attempts: TierAttempt[] = [];

    await expect(
      resolveIntentTarget(
        ladderInput(obs, policyCtx({})),
        attempts,
        ladderDeps([{ observation: obs, index }], { humanGate }),
      ),
    ).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });

    expect(attempts.at(-1)).toMatchObject({ tier: 'human', ok: false, reason: 'HUMAN_REQUIRED' });
  });

  it('tier 4: the vision resolver may claim the target when policy.tiers.vision is on', async () => {
    const { observation: obs, index } = observation(elements);
    const vision: VisionResolver = { resolve: async () => index.entries.get('e12') ?? null };
    const attempts: TierAttempt[] = [];

    const result = await resolveIntentTarget(
      ladderInput(obs, policyCtx({ vision: true })),
      attempts,
      ladderDeps([{ observation: obs, index }], { vision }),
    );

    expect(result).toMatchObject({ tier: 'vision', entry: { backendNodeId: 12 } });
    expect(result).toHaveProperty('intentLearning');
  });

  it('tier 4: NullVisionResolver falls through silently — no vision attempt', async () => {
    const { observation: obs, index } = observation(elements);
    const attempts: TierAttempt[] = [];

    await expect(
      resolveIntentTarget(
        ladderInput(obs, policyCtx({ vision: true })),
        attempts,
        ladderDeps([{ observation: obs, index }], { vision: new NullVisionResolver() }),
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });

    expect(attempts.map((a) => a.tier)).toEqual(['deterministic']);
  });

  it('§4 step D: a challenge pauses the human gate before resolution continues', async () => {
    const { observation: challenged, index } = observation(elements, { challenge: 'login' });
    const { gate: humanGate, requests } = gate({ choice: 'abort' });
    const attempts: TierAttempt[] = [];

    await expect(
      resolveIntentTarget(
        ladderInput(challenged, ctx()),
        attempts,
        ladderDeps([{ observation: challenged, index }], { humanGate }),
      ),
    ).rejects.toMatchObject({ code: 'SECURITY_CHALLENGE' });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reason: 'login' });
    expect(attempts).toContainEqual(expect.objectContaining({ tier: 'deterministic', ok: false, reason: 'challenge' }));
  });

  it('§4 step D: with no gate wired a challenge is still SECURITY_CHALLENGE, never a defeat attempt', async () => {
    const { observation: challenged, index } = observation(elements, { challenge: 'captcha' });

    await expect(
      resolveIntentTarget(ladderInput(challenged, ctx()), [], ladderDeps([{ observation: challenged, index }])),
    ).rejects.toMatchObject({ code: 'SECURITY_CHALLENGE' });
  });

  it('§4 step D: a human who cleared the wall lets resolution restart once and it resolves', async () => {
    const { observation: challenged, index } = observation(elements, { challenge: 'login' });
    const { observation: cleared } = observation(elements); // same page, wall gone
    const model = pickingModel(cleared, 'e12');
    const { gate: humanGate, requests } = gate({ choice: 'done' });
    const attempts: TierAttempt[] = [];

    const result = await resolveIntentTarget(
      ladderInput(challenged, policyCtx({})),
      attempts,
      ladderDeps(
        [
          { observation: challenged, index },
          { observation: cleared, index },
        ],
        {
          models: { get: () => model },
          humanGate,
        },
      ),
    );

    expect(requests).toHaveLength(1); // exactly one pause
    expect(result).toMatchObject({ tier: 'llm', entry: { backendNodeId: 12 } });
    expect(attempts).toContainEqual(expect.objectContaining({ reason: 'challenge', ok: false }));
  });

  it('§4 step D: a wall that survives the resume fails SECURITY_CHALLENGE — never a loop', async () => {
    const { observation: challenged, index } = observation(elements, { challenge: 'mfa' });
    const { gate: humanGate, requests } = gate({ choice: 'done' }); // "resume"
    const attempts: TierAttempt[] = [];

    await expect(
      resolveIntentTarget(
        ladderInput(challenged, ctx()),
        attempts,
        ladderDeps([{ observation: challenged, index }], { humanGate }),
      ),
    ).rejects.toMatchObject({ code: 'SECURITY_CHALLENGE' });

    expect(requests).toHaveLength(1);
  });
});
