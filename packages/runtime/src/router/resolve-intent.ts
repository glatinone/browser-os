import { lexicalDecision, lexicalRank } from '@browser-os/dom';
import { normalizeIntent, pathTemplate as templatePath } from '@browser-os/memory';
import type { ActionType, BrowserAction, ExecutionContext, IndexEntry, ObservationIndex } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import type { HumanGate } from '../security/interfaces.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';
import { pauseForChallenge, resolveHumanTier } from './resolve-human.js';
import { resolveLlmTier } from './resolve-llm.js';
import { applyLearning, type ResolveLocatorInput, tryResolveLocator } from './resolve-locator.js';
import {
  type ActionCachePort,
  type ActionCacheQuery,
  buildResolution,
  type HumanDone,
  type LadderAttempt,
  type ModelsPort,
  originOfUrl,
  type Resolution,
  type VisionResolver,
} from './types.js';

export interface ResolveIntentInput {
  intent: string;
  actionType: ActionType;
  url?: string;
  sessionId: string;
  pageId: string;
  params?: Record<string, string>;
  /**
   * §5.4: after a locator target fails, the intent recorded in the cache is
   * resolved *as if the caller had passed it* — from tier 2 onward. One level.
   */
  healIntent?: string | null;
  /**
   * Set on the §5.4 continuation so tier 1 is not consulted twice in one
   * action (the cache-backed locator has already failed).
   */
  skipCache?: boolean;
  /**
   * P7-04: the executing action and its shared context — the contract for
   * tiers 3–5 (model budget, policy tier switches, human gate). Direct unit
   * calls of the ladder (P7-03's cache/deterministic tests) pass neither and
   * stop after tier 2 exactly as before.
   */
  action?: BrowserAction;
  ctx?: ExecutionContext;
  /**
   * §4 step D: the human cleared a challenge on this action. The ladder
   * restarts once — a second challenge is a `SECURITY_CHALLENGE` failure,
   * never a loop.
   */
  challengeRetried?: boolean;
}

interface IntentDeps {
  driver: ResolveLocatorInput['driver'];
  observer: ResolveLocatorInput['observer'];
  cache: ActionCachePort;
  constants?: typeof DEFAULT_ROUTER_CONSTANTS;
  cdp?: unknown;
  worlds?: unknown;
  mainCdpFrameId?: string;
  /** P7-04: model registry the LLM tier reads `fast` from (§5.2). */
  models?: ModelsPort | null;
  /** P7-04: vision tier hook — MVP ships `NullVisionResolver`. */
  vision?: VisionResolver | null;
  /** P7-04: human tier (§5.3) and the §4 step D challenge pause. */
  humanGate?: HumanGate | null;
}

/**
 * P7-03: Intent resolution tier ladder (action-router §5 case `intent`).
 * Order: cache → deterministic → llm (P7-04) → vision (P7-04) → human (P7-04).
 * Returns a `Resolution`, or `HumanDone` when the human reports the step as
 * already done (§5.3.2), or throws `BosError('TARGET_NOT_FOUND')`.
 */
export async function resolveIntentTarget(
  input: ResolveIntentInput,
  attempts: LadderAttempt[],
  deps: IntentDeps,
): Promise<Resolution | HumanDone> {
  const constants = deps.constants ?? DEFAULT_ROUTER_CONSTANTS;
  const origin = originOfUrl(input.url ?? '');
  const normalized = normalizeIntent(input.intent, input.params ?? {});
  const query: ActionCacheQuery = {
    origin,
    pathTemplate: templatePath(input.url ?? '/'),
    actionType: input.actionType,
    intent: normalized,
  };

  const resolveLocatorInput: ResolveLocatorInput = {
    driver: deps.driver,
    observer: deps.observer,
    cache: deps.cache,
    constants,
    actionType: input.actionType,
    sessionId: input.sessionId,
    pageId: input.pageId,
    cdp: deps.cdp ?? null,
    worlds: deps.worlds ?? null,
    mainCdpFrameId: deps.mainCdpFrameId ?? '',
  };

  // Tier 1 — cache (action-router §5.1). ActionCacheStore.get already tries
  // the page-level cacheKey first, then the site-wide siteKey. Skipped on the
  // §5.4 heal path, which already failed a cache-backed locator this action.
  const cached = input.skipCache ? null : deps.cache.get(query);
  if (cached) {
    const t0 = Date.now();
    const resolved = await tryResolveLocator(cached.locator, 'cache', attempts, resolveLocatorInput);
    if (resolved) {
      // recordHit is deferred to router step H — §4-H logs it here only after
      // the action verified, and invalidates on a false hit instead.
      attempts.push({ tier: 'cache', ok: true, ms: Date.now() - t0 });
      return { ...resolved, intentLearning: { query, key: cached.key } };
    }
    attempts.push({ tier: 'cache', ok: false, ms: Date.now() - t0, reason: 'locator_not_found' });
    // recordMiss bumps consecutive_misses and invalidates past the limit
    // (memory §5), retiring the entry so the ladder does not retry it.
    deps.cache.recordMiss(cached.key);
  }

  // Tier 2 — deterministic lexical match (dom-intelligence §7).
  const t2 = Date.now();
  const { observation, index } = await deps.observer.capture(input.sessionId, input.pageId);

  // §4 step D (P7-04): a wall on this page — login, CAPTCHA, MFA, passkey or
  // consent — is handed to a human, never defeated by the agent
  // (CODING_AGENT.md §5.5). With no gate wired (or a gate that aborts) the
  // action fails as SECURITY_CHALLENGE, which is requirement 5's contract.
  if (observation.challenge) {
    attempts.push({ tier: 'deterministic', ok: false, ms: Date.now() - t2, reason: 'challenge' });
    if (!input.ctx || !deps.humanGate || input.challengeRetried) {
      throw new BosError('SECURITY_CHALLENGE', `Security challenge (${observation.challenge}) requires a human`);
    }
    await pauseForChallenge({
      challenge: observation.challenge,
      observationId: observation.id,
      ctx: input.ctx,
      humanGate: deps.humanGate,
    });
    // 'resume': the human cleared it — restart the ladder once from step C.
    // Tier 1 is skipped: this action has already missed the cache for this intent.
    return resolveIntentTarget({ ...input, challengeRetried: true, skipCache: true }, attempts, deps);
  }

  const ranked = lexicalRank(observation.elements, input.intent, input.actionType);
  const decision = lexicalDecision(ranked, {
    accept: constants.lexicalAccept,
    margin: constants.lexicalMargin,
  });

  if ('element' in decision) {
    const entry = index.entries.get(decision.element.ref);
    if (entry) {
      attempts.push({ tier: 'deterministic', ok: true, ms: Date.now() - t2, score: ranked[0]?.score });
      return {
        tier: 'deterministic',
        entry,
        element: decision.element,
        url: observation.url,
        origin: originOfUrl(observation.url),
        disabled: decision.element.state.disabled === true,
        // No tier-1 key: this resolution is learned into the cache in step H.
        intentLearning: { query, key: null },
      };
    }
  }

  attempts.push({
    tier: 'deterministic',
    ok: false,
    ms: Date.now() - t2,
    reason: 'reason' in decision ? decision.reason : 'TARGET_NOT_FOUND',
    score: ranked[0]?.score,
  });

  // §5.4 healIntent: continue the ladder exactly as if the healed intent had
  // been the caller's own, from tier 2 onward (the tier-1 entry just failed,
  // so the cache is not consulted a second time in one action). The recorded
  // intent wins over guessing, so it runs before tiers 3–5.
  if (input.healIntent) {
    return resolveIntentTarget(
      { ...input, intent: input.healIntent, healIntent: null, skipCache: true },
      attempts,
      deps,
    );
  }

  // Tier 3 — LLM (action-router §5.2, P7-04). Skipped entirely when no model
  // registry is wired: that router has no LLM tier at all. With a registry,
  // resolveLlmTier itself reports LLM_DISABLED / BUDGET_EXCEEDED as attempts
  // and falls through, and its answer is a ref only (never a selector — §5.2).
  if (input.ctx && deps.models) {
    const outcome = await resolveLlmTier(
      {
        actionType: input.actionType,
        intent: input.intent,
        observation,
        index,
        model: deps.models.get('fast') ?? null,
        enabled: input.ctx.policy?.tiers?.llm ?? true,
        budget: input.ctx.budget,
        constants: { llmCandidates: constants.llmCandidates, llmMinConfidence: constants.llmMinConfidence },
      },
      attempts,
    );
    if (outcome.outcome === 'resolved') {
      // Budget was consumed by the call itself (§5.2); the locator is learned
      // in step H only after step G verified the action.
      return { ...outcome.resolution, intentLearning: { query, key: null } };
    }
  }

  // Tier 4 — vision (P7-04 requirement 3). NullVisionResolver answers null
  // without an attempt, so the MVP falls straight through to tier 5. A vision
  // answer is only ever this observation's entry: like the LLM tier, it can
  // select among refs, never mint a selector.
  if (input.ctx && input.action && deps.vision && (input.ctx.policy?.tiers?.vision ?? false)) {
    const entry = await deps.vision.resolve({
      observation,
      action: input.action,
      text: input.intent,
      ctx: input.ctx,
    });
    const ref = entry ? refOfEntry(index, entry) : null;
    if (entry && ref) {
      attempts.push({ tier: 'vision', ok: true, ms: 0 });
      return { ...buildResolution('vision', observation, ref, entry), intentLearning: { query, key: null } };
    }
  }

  // Tier 5 — human (action-router §5.3, P7-04). The last resort when every
  // automatic tier declined: the human either points at an element (ref), says
  // the step is already done (HumanDone → the router reports ok:true without
  // dispatching, §5.3.2), or aborts (HUMAN_REQUIRED). A ref answer is learned
  // immediately (§5.3.2 "the human taught us") and again by step H after G
  // verifies — same locator, same key.
  if (input.ctx && input.action && deps.humanGate && (input.ctx.policy?.tiers?.human ?? true)) {
    const outcome = await resolveHumanTier(
      {
        action: input.action,
        intent: input.intent,
        observation,
        index,
        ctx: input.ctx,
        humanGate: deps.humanGate,
        reason: 'ambiguous',
        cache: { port: deps.cache, query },
      },
      attempts,
    );
    if ('done' in outcome) return outcome;
    return { ...outcome, intentLearning: { query, key: null } };
  }

  throw new BosError('TARGET_NOT_FOUND', `Could not resolve intent: ${input.intent}`);
}

/**
 * The ref an `IndexEntry` answers for: identity first, then the unique
 * backendNodeId. An answer that is not in this observation never becomes a
 * selector — the same §5.2 output contract the LLM tier enforces.
 */
function refOfEntry(index: ObservationIndex, entry: IndexEntry): string | null {
  for (const [ref, candidate] of index.entries) {
    if (candidate === entry || candidate.backendNodeId === entry.backendNodeId) return ref;
  }
  return null;
}

/**
 * Learning step (action-router §4 step H; memory §4.2): apply param
 * substitution to the locator the tier just proved, then write it to both
 * the page-level and site-level cache slots.
 */
export function learnFromResolution(
  locator: Resolution['entry']['locator'],
  query: ActionCacheQuery,
  params: Record<string, string>,
  cache: ActionCachePort,
): void {
  applyLearning(locator, params, cache, query);
}

export type { ActionCacheQuery };
