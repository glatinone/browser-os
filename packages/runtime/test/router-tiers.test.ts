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
import { resolveLlmTier, selectCandidates } from '../src/router/resolve-llm.js';
import type { ActionCachePort, ActionCacheQuery } from '../src/router/types.js';
import { NullVisionResolver } from '../src/router/vision.js';
import type { HumanGate } from '../src/security/interfaces.js';
import { RejectingHumanGate } from '../src/security/stubs.js';

/**
 * P7-04 — LLM tier (§5.2), human tier (§5.3), vision hook, and the §4 step D security
 * challenge gate. Everything runs against fakes: no page, no CDP, no network, and the
 * only "model" is `FakeModelProvider`.
 *
 * These tests call the tier functions directly rather than through
 * `ActionRouter.execute`, because the intent ladder that sequences tiers 1→5 is still
 * un-wired (`router.ts:367` throws `TARGET_NOT_FOUND`; it belongs to P7-03). See the
 * OPEN entry in docs/tasks/CONFLICTS.md.
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
