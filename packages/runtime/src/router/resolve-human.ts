import { lexicalRank } from '@browser-os/dom';
import type {
  BrowserAction,
  ChallengeKind,
  ExecutionContext,
  HumanRequest,
  Observation,
  ObservationIndex,
  TierAttempt,
} from '@browser-os/protocol';
import { BosError } from '../errors.js';
import type { HumanGate } from '../security/interfaces.js';
import { type ActionCachePort, type ActionCacheQuery, buildResolution, type Resolution } from './types.js';

export interface ResolveHumanInput {
  action: BrowserAction;
  intent: string;
  observation: Observation;
  index: ObservationIndex;
  ctx: ExecutionContext;
  humanGate: HumanGate;
  reason: HumanRequest['reason'];
  /**
   * Where a `ref` answer is learned (§5.3.2 "the human taught us" / §4 step H).
   * Both must be given together; without them the resolution still succeeds but nothing
   * is cached, which is what the non-intent callers want.
   */
  cache?: { port: ActionCachePort; query: ActionCacheQuery } | null;
}

/**
 * Tier 5 — Human tier (action-router §5.3).
 *
 * Pauses through `HumanGate.pause` with `reason`, the human-readable message and the
 * top-5 candidates (§5.3.1). Answers:
 *   - `{ choice: 'ref', ref, observationId }` → a `Resolution` at tier `human`. The caller
 *     writes the cache (§4 step H / §5.3.2 "the human taught us").
 *   - `{ choice: 'done' }`  → `{ tier:'human', done:true }`: the router reports `ok:true`
 *     without executing and must NOT write the cache.
 *   - `{ choice: 'abort' }` → throws `HUMAN_REQUIRED` (§5.3.2).
 *
 * Timeout (`policy.budgets.humanTimeoutMs`) is enforced by the HumanGate itself: it
 * answers `abort`, which lands on the same `HUMAN_REQUIRED` path (§5.3.3).
 *
 * The `ref` answer must reference the observation the candidates were rendered from,
 * otherwise it is a stale pick and is rejected as `HUMAN_REQUIRED`.
 */
export async function resolveHumanTier(
  input: ResolveHumanInput,
  attempts: TierAttempt[],
): Promise<Resolution | { tier: 'human'; done: true }> {
  const { action, intent, observation, index, ctx, humanGate, reason } = input;

  const candidates = topCandidates(input).map((element) => ({
    ref: element.ref,
    role: element.role,
    name: element.name,
  }));

  const start = ctx.clock.now();
  const answer = await humanGate.pause({
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    reason,
    message: `Cannot confidently find '${intent}' for ${action.type}.`,
    candidates,
    observationId: observation.id,
  });
  const ms = Math.max(0, ctx.clock.now() - start);

  if (answer.choice === 'ref') {
    const entry = index.entries.get(answer.ref);
    if (entry && answer.observationId === observation.id) {
      // §5.3.2: a `ref` answer is learned — write the locator back to the action cache so
      // the next run of the same intent skips the human. The `done` and `abort` answers
      // deliberately do not reach here.
      input.cache?.port.put(input.cache.query, entry.locator);
      attempts.push({ tier: 'human', ok: true, ms, candidates: candidates.length });
      return buildResolution('human', observation, answer.ref, entry);
    }
    attempts.push({ tier: 'human', ok: false, ms, candidates: candidates.length, reason: 'HUMAN_REQUIRED' });
    throw new BosError('HUMAN_REQUIRED', 'Human answer references an unknown ref or a stale observation');
  }

  if (answer.choice === 'done') {
    // The human performed the step manually: ok:true, nothing dispatched, no cache write.
    attempts.push({ tier: 'human', ok: true, ms, candidates: candidates.length });
    return { tier: 'human', done: true };
  }

  attempts.push({ tier: 'human', ok: false, ms, candidates: candidates.length, reason: 'HUMAN_REQUIRED' });
  throw new BosError('HUMAN_REQUIRED', 'Human resolution was aborted');
}

/**
 * Top 5 by lexical score (§5.3.1) — the same ranking the deterministic tier consults.
 * Static import: the human tier must return candidates synchronously from the
 * observation, and a dynamic import added await-shaped latency to every pause.
 */
function topCandidates(input: ResolveHumanInput): Observation['elements'] {
  return lexicalRank(input.observation.elements, input.intent, input.action.type)
    .slice(0, 5)
    .map((ranked) => ranked.element);
}

/**
 * §4 step D — security challenge gate, run *before* resolution continues.
 *
 * `observation.challenge` is set during resolution (`detectChallenge`, dom-intelligence §9).
 * The router asks the human to deal with the challenge — a login wall, a CAPTCHA, MFA, a
 * passkey prompt or a consent dialog are exactly the cases Browser-OS must never try to
 * defeat itself (CODING_AGENT.md §5.5).
 *
 * Returns `'resume'` when the human cleared it and resolution may restart, or throws
 * `BosError('SECURITY_CHALLENGE')` when the gate aborts (the `RejectingHumanGate` stub
 * always aborts, which is how the MVP reports "there is a wall, nobody is watching").
 */
export async function pauseForChallenge(input: ResolveChallengeInput): Promise<'resume'> {
  const { challenge, ctx, humanGate, message } = input;
  const answer = await humanGate.pause({
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    reason: challenge,
    message: message ?? `A security challenge (${challenge}) was detected on this page.`,
    observationId: input.observationId,
  });

  if (answer.choice === 'abort') {
    throw new BosError('SECURITY_CHALLENGE', `Security challenge (${challenge}) requires a human`, {
      details: { challenge },
    });
  }
  // 'ref' / 'done': the human resolved the wall by hand — restart from §4 step C once.
  return 'resume';
}

export interface ResolveChallengeInput {
  challenge: ChallengeKind;
  observationId?: string;
  ctx: ExecutionContext;
  humanGate: HumanGate;
  message?: string;
}
