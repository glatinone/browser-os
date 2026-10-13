import { lexicalDecision, lexicalRank } from '@browser-os/dom';
import { normalizeIntent, pathTemplate as templatePath } from '@browser-os/memory';
import type { ActionType, Tier } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';
import { applyLearning, type ResolveLocatorInput, tryResolveLocator } from './resolve-locator.js';
import type { ActionCachePort, ActionCacheQuery, Resolution } from './types.js';
import { originOfUrl } from './types.js';

interface TierAttemptInput {
  tier: Tier;
  ok: boolean;
  ms: number;
  reason?: string;
  score?: number;
}

interface IntentDeps {
  driver: ResolveLocatorInput['driver'];
  observer: ResolveLocatorInput['observer'];
  cache: ActionCachePort;
  constants?: typeof DEFAULT_ROUTER_CONSTANTS;
  cdp?: unknown;
  worlds?: unknown;
  mainCdpFrameId?: string;
}

export interface ResolveIntentInput {
  intent: string;
  actionType: ActionType;
  url?: string;
  sessionId: string;
  pageId: string;
  params?: Record<string, string>;
  healIntent?: string | null;
  /**
   * §5.4 healing: the action cache is not consulted again, because the caller
   * already failed through a `{kind:'locator'}` target in this same action.
   */
  skipCache?: boolean;
}

/**
 * P7-03: Intent resolution tier ladder (action-router §5 case `intent`).
 * Order: cache → deterministic → (llm P7-04) → (human P7-04). Returns a
 * Resolution or throws BosError('TARGET_NOT_FOUND').
 */
export async function resolveIntentTarget(
  input: ResolveIntentInput,
  attempts: TierAttemptInput[],
  deps: IntentDeps,
): Promise<Resolution> {
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

  if (observation.challenge) {
    attempts.push({ tier: 'deterministic', ok: false, ms: Date.now() - t2, reason: 'challenge' });
    throw new BosError('VERIFICATION_FAILED', 'Security challenge blocks intent resolution');
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
  // so the cache is not consulted a second time in one action).
  if (input.healIntent) {
    return resolveIntentTarget(
      { ...input, intent: input.healIntent, healIntent: null, skipCache: true },
      attempts,
      deps,
    );
  }

  throw new BosError('TARGET_NOT_FOUND', `Could not resolve intent: ${input.intent}`);
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
