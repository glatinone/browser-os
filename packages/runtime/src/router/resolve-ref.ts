import { matchLocator } from '@browser-os/dom';
import type { Observation, ObservationIndex, Target } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import { buildResolution, type Resolution } from './types.js';

export type RefTarget = Extract<Target, { kind: 'ref' }>;

export interface ResolveRefInput {
  target: RefTarget;
  /** Fresh capture (step A) the reference is being resolved against. */
  observation: Observation;
  index: ObservationIndex;
  /** Index behind `target.observationId`, from `Observer.index()`; `undefined` when evicted. */
  staleIndex: ObservationIndex | null | undefined;
  accept: number;
  margin: number;
}

/**
 * action-router §5 case `ref`.
 *
 * Same observation → direct hit. Different observation → stale-ref healing:
 * re-match the old locator against the fresh observation. The probe executor
 * (§5.1) is deliberately not used here; healing without it is what P7-02 ships
 * and it is covered by its own test.
 */
export function resolveRef(input: ResolveRefInput): Resolution {
  const { target, observation, index, staleIndex, accept, margin } = input;

  if (target.observationId === index.observationId) {
    const entry = index.entries.get(target.ref);
    if (!entry) {
      throw new BosError('TARGET_NOT_FOUND', 'The reference is not in the current observation', {
        details: { ref: target.ref, observationId: target.observationId },
      });
    }
    return buildResolution('ref', observation, target.ref, entry);
  }

  const staleEntry = staleIndex?.entries.get(target.ref);
  if (!staleEntry) {
    throw new BosError('STALE_REF', 'The reference belongs to an observation that is no longer cached', {
      details: { ref: target.ref, observationId: target.observationId },
    });
  }

  const ranked = matchLocator(observation, index, staleEntry.locator).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const runnerUp = ranked[1];

  if (!best || best.score < accept) {
    throw new BosError('TARGET_NOT_FOUND', 'The element behind this reference is no longer present', {
      details: {
        ref: target.ref,
        score: best ? best.score : 0,
        accept,
        candidates: ranked.slice(0, 5).map((m) => ({ ref: m.ref, score: m.score })),
      },
    });
  }

  if (runnerUp && runnerUp.score >= accept && best.score - runnerUp.score < margin) {
    throw new BosError('TARGET_AMBIGUOUS', 'Stale-ref healing produced more than one plausible element', {
      details: {
        ref: target.ref,
        candidates: ranked.slice(0, 5).map((m) => ({ ref: m.ref, score: m.score })),
      },
    });
  }

  return buildResolution('ref', observation, best.ref, best.entry);
}
