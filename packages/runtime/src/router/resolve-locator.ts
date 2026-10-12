import { applyParamsToLocator, lexicalDecision, lexicalRank, matchLocator, verifyIdentity } from '@browser-os/dom';
import type {
  ActionType,
  ElementLocator,
  IndexEntry,
  Observation,
  ObservationIndex,
  Rect,
  SemanticElement,
  Tier,
} from '@browser-os/protocol';
import { BosError } from '../errors.js';
import type { DEFAULT_ROUTER_CONSTANTS } from './constants.js';
import type { ActionCachePort, ActionCacheQuery, Resolution } from './types.js';
import { buildResolution } from './types.js';

/** Output of a tier resolution: the `Resolution` plus the entry it came from. */
export interface LocatorResult {
  resolution: Resolution;
}

/**
 * Tier 1 — Cache tier (action-router §5.1).
 *
 * Given a `locator` (from a cached entry or a `{kind:'locator'}` action target),
 * tries a probe first (no full observation), then falls back to a fingerprint
 * match against a fresh observation.
 *
 * Returns `null` when the locator could not be resolved at the accept threshold.
 */
export async function tryResolveLocator(
  locator: ElementLocator,
  tierLabel: 'cache' | 'ref',
  attempts: TierAttemptInput[],
  input: ResolveLocatorInput,
): Promise<Resolution | null> {
  const { driver, observer, constants, actionType, cdp, worlds, mainCdpFrameId } = input;

  // Stage 1 — Probe (main frame only; §8.3)
  if (locator.framePath.length === 0) {
    const deadline = Date.now() + constants.probeTimeoutMs;
    while (Date.now() < deadline) {
      let candidates: ProbeCandidateLike[];
      try {
        candidates = await runProbe(cdp, worlds, mainCdpFrameId, locator);
      } catch {
        candidates = [];
      }
      if (candidates.length === 1 && candidates[0] !== undefined) {
        const candidate = candidates[0];
        const score = verifyIdentity(candidate, locator, actionType);
        if (score >= constants.matchAccept) {
          const entry: IndexEntry = {
            backendNodeId: candidate.backendNodeId,
            frameId: 'f0',
            cdpFrameId: mainCdpFrameId,
            locator,
          };
          return buildResolutionFromProbe(tierLabel, candidate, entry, locator);
        }
      }
      if (candidates.length > 1) break; // ambiguous → full match
      await sleep(constants.probeIntervalMs);
    }
  }

  // Stage 2 — Full observation + fingerprint scoring (§8.4)
  const { observation, index } = await observer.capture(input.sessionId, input.pageId);
  const scored = matchLocator(observation, index, locator, actionType);
  const best = scored[0];

  if (best) {
    const runnerUp = scored[1];
    const ok =
      best.score >= constants.matchAccept && (!runnerUp || best.score - runnerUp.score >= constants.matchMargin);
    if (ok) {
      return buildResolution(tierLabel, observation, best.ref, best.entry);
    }
  }

  const reason = scored.length > 0 ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND';
  attempts.push({ tier: tierLabel, ok: false, ms: 0, reason, score: best?.score });
  return null;
}

/**
 * Tier 2 — Deterministic tier (action-router §5 case `intent`, lexical path).
 *
 * Ranks the observation's elements against the intent string using the dom
 * `lexicalRank` / `lexicalDecision` helpers, and applies the `isCompatible`
 * filter. Returns `null` when the lexical decision is not acceptable.
 */
export async function resolveDeterministicTier(
  intent: string,
  actionType: ActionType,
  input: ResolveLocatorInput,
): Promise<Resolution | null> {
  const { observer, constants, sessionId, pageId } = input;
  const { observation, index } = await observer.capture(sessionId, pageId);

  const ranked = lexicalRank(observation.elements, intent, actionType);
  const decision = lexicalDecision(ranked, {
    accept: constants.lexicalAccept,
    margin: constants.lexicalMargin,
  });

  if ('reason' in decision) return null;

  const element = decision.element;
  const entry = index.entries.get(element.ref);
  if (!entry) return null;

  return buildResolution('deterministic', observation, element.ref, entry);
}

/**
 * Tier 3 — Learning tier (action-router §4 step H; memory §4.2).
 *
 * Applies param substitution to the resolved locator (replacing literal param
 * values with the dynamic `nameIsDynamic` marker), then writes the learned
 * locator to both the page-level and site-level cache slots.
 */
export function applyLearning(
  locator: ElementLocator,
  paramValues: Record<string, string>,
  cache: ActionCachePort,
  query: ActionCacheQuery,
): ElementLocator {
  const learned = applyParamsToLocator(locator, paramValues);
  cache.put(query, learned);
  return learned;
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface TierAttemptInput {
  tier: Tier;
  ok: boolean;
  ms: number;
  reason?: string;
  score?: number;
}

interface ProbeCandidateLike {
  backendNodeId: number;
  role: string;
  name: string;
  rect: Rect | null;
  disabled?: boolean;
  attrs?: Record<string, string>;
}

export interface ResolveLocatorInput {
  driver: unknown; // PageDriver — only probeLocator path uses cdp+worlds
  observer: {
    capture(
      sessionId: string,
      pageId: string,
      opts?: { includeText?: boolean },
    ): Promise<{ observation: Observation; index: ObservationIndex }>;
  };
  cache: ActionCachePort;
  constants: typeof DEFAULT_ROUTER_CONSTANTS;
  actionType: ActionType;
  sessionId: string;
  pageId: string;
  cdp: unknown;
  worlds: unknown;
  mainCdpFrameId: string;
}

async function runProbe(
  cdp: unknown,
  worlds: unknown,
  mainCdpFrameId: string,
  locator: ElementLocator,
): Promise<ProbeCandidateLike[]> {
  // probe() lives in @browser-os/dom; it takes (cdp, worlds, mainCdpFrameId, locator).
  // The runtime already has cdp/worlds/mainCdpFrameId from PageContext (P7-07 wiring).
  const { probe } = await import('@browser-os/dom');
  return (probe as (c: unknown, w: unknown, f: string, l: ElementLocator) => Promise<ProbeCandidateLike[]>)(
    cdp,
    worlds,
    mainCdpFrameId,
    locator,
  );
}

function buildResolutionFromProbe(
  tier: Tier,
  candidate: ProbeCandidateLike,
  entry: IndexEntry,
  locator: ElementLocator,
): Resolution {
  return {
    tier,
    entry,
    element: {
      ref: '',
      role: candidate.role,
      name: candidate.name,
      context: [],
    },
    url: '',
    origin: '',
    disabled: candidate.disabled === true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { SemanticElement };
export { applyParamsToLocator, BosError };
