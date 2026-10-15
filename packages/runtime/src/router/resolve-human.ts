// Tier 5, human (action-router §5.3). The ladder's last stop: pause through the
// HumanGate and turn the answer into a resolution, a hand-off, or a failure.

import type { IndexEntry, Observation, ObservationIndex, TierAttempt } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import type { HumanGate } from '../security/interfaces.js';
import type { ActionCacheQuery, Resolution } from './types.js';
import { buildResolution } from './types.js';

export interface ResolveHumanInput {
  actionType: string;
  intent: string;
  sessionId: string;
  taskId: string | null;
  observation: Observation;
  index: ObservationIndex;
  /** Top candidates offered to the human (§5.3 step 1: top 5). */
  ranked: Array<{ element: { ref: string; role: string; name: string }; score: number }>;
  human: HumanGate | null;
  /** policy.budgets.humanTimeoutMs (§5.3 step 3). */
  humanTimeoutMs: number;
  attempts: TierAttempt[];
  /** Written when the human answers with a ref: the human taught us the target. */
  query: ActionCacheQuery;
  cache: { put(query: ActionCacheQuery, locator: IndexEntry['locator']): void };
}

export type HumanOutcome = { kind: 'ref'; resolution: Resolution } | { kind: 'done' } | { kind: 'abort' };

/**
 * §5.3 humanResolve. Returns the outcome of the pause:
 *   - `ref`: resolved with tier `human`, cache written (the human taught us);
 *   - `done`: the human performed the step, the router returns ok without executing;
 *   - null on timeout/no gate, after a HUMAN_REQUIRED attempt row.
 * Throws only what the ladder must not swallow (never, in practice).
 */
export async function resolveWithHuman(input: ResolveHumanInput): Promise<HumanOutcome> {
  const { human, attempts } = input;

  if (!human) {
    attempts.push({ tier: 'human', ok: false, ms: 0, reason: 'HUMAN_REQUIRED' });
    throw new BosError('HUMAN_REQUIRED', 'No human gate is wired and the ladder is exhausted');
  }

  const candidates = input.ranked.slice(0, 5).map((entry) => ({
    ref: entry.element.ref,
    role: entry.element.role,
    name: entry.element.name,
  }));

  const t0 = Date.now();
  let answer: Awaited<ReturnType<HumanGate['pause']>>;
  try {
    answer = await withTimeout(
      human.pause({
        sessionId: input.sessionId,
        taskId: input.taskId,
        reason: 'ambiguous',
        message: `Cannot confidently find '${input.intent}' for ${input.actionType}.`,
        candidates,
      }),
      input.humanTimeoutMs,
    );
  } catch {
    attempts.push({ tier: 'human', ok: false, ms: Date.now() - t0, reason: 'HUMAN_REQUIRED' });
    throw new BosError('HUMAN_REQUIRED', 'The human pause timed out');
  }

  if (answer.choice === 'abort') {
    attempts.push({ tier: 'human', ok: false, ms: Date.now() - t0, reason: 'HUMAN_REQUIRED' });
    throw new BosError('HUMAN_REQUIRED', 'The human aborted the action');
  }
  attempts.push({ tier: 'human', ok: true, ms: Date.now() - t0 });
  if (answer.choice === 'done') return { kind: 'done' };

  // §5.3: a ref answer resolves with tier `human` and teaches the cache.
  const entry = input.index.entries.get(answer.ref);
  if (!entry) {
    attempts.push({ tier: 'human', ok: false, ms: Date.now() - t0, reason: 'HUMAN_REQUIRED' });
    throw new BosError('HUMAN_REQUIRED', `The human picked ${answer.ref}, which is not in the observation`);
  }
  input.cache.put(input.query, entry.locator);
  return { kind: 'ref', resolution: buildResolution('human', input.observation, answer.ref, entry) };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BosError('HUMAN_REQUIRED', 'The human pause timed out')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
