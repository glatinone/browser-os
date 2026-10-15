// Router contracts (integration §5, action-router §3, §3.1).
//
// Names in this file are final: P7-03..P7-07 code against them, so a rename here
// breaks other tasks. Every port is a structural interface instead of a class
// reference so router tests can substitute in-memory fakes for SessionManager,
// ActionCacheStore, RunStore and the P7-01 security stubs.

import type { PageDriver } from '@browser-os/browser';
import type {
  ActionResult,
  BrowserAction,
  CdpTransport,
  Clock,
  ElementLocator,
  EventBus,
  ExecutionContext,
  HelperWorlds,
  IndexEntry,
  ModelProvider,
  ModelTier,
  Observation,
  ObservationIndex,
  RiskLevel,
  Session,
  Tier,
} from '@browser-os/protocol';
import type { HumanGate, PermissionGate, RiskClassifier } from '../security/interfaces.js';

/** What the router needs from a live page (integration §5). Built by SessionManager. */
export interface PageContext {
  sessionId: string;
  pageId: string;
  driver: PageDriver;
  cdp: CdpTransport;
  worlds: HelperWorlds;
  mainCdpFrameId: string;
  headless: boolean;
  /**
   * The page's current URL, when the builder knows it. The intent cache query
   * (action-router §5) is keyed on origin + path template, and reading it here is
   * what lets tier 1 answer without paying for an observation; absent → `''`,
   * which turns every cache lookup into a miss rather than a wrong hit.
   */
  url?: string;
}

/**
 * Structural subset of the P4-11 `Observer` (action-router §3.1).
 *
 * `latest()` from §3.1 is deliberately absent: `capture()` already reuses the
 * cache when nothing changed, which is the only way this router reads an
 * observation. `index()` accepts `null | undefined` because P4-11 returns
 * `undefined` for an evicted observation.
 */
export interface ObserverPort {
  capture(
    sessionId: string,
    pageId: string,
    opts?: { includeText?: boolean },
  ): Promise<{ observation: Observation; index: ObservationIndex }>;
  index(observationId: string): ObservationIndex | null | undefined;
  invalidate(pageId: string): void;
}

export interface PagesPort {
  context(sessionId: string, pageId: string): Promise<PageContext>;
}

export interface SessionsPort {
  /** Per-page lock (action-router §4): the router body runs inside it. */
  withPageLock<T>(sessionId: string, pageId: string, fn: () => Promise<T>): Promise<T>;
  reconnect(sessionId: string): Promise<Session>;
  /**
   * integration §5 declares this `void`; SessionManager's own method is the
   * async `selectPage`, so P7-07 adapts it at wiring time.
   */
  setActivePage(sessionId: string, pageId: string): void;
}

/** Query shape shared with `ActionCacheStore` (same field names, structurally). */
export interface ActionCacheQuery {
  origin: string;
  pathTemplate: string;
  actionType: string;
  intent: string;
}

export interface ActionCachePort {
  get(query: ActionCacheQuery): { key: string; locator: ElementLocator } | null;
  put(query: ActionCacheQuery, locator: ElementLocator): void;
  recordHit(key: string): void;
  recordMiss(key: string): number;
  invalidate(key: string, reason: string): void;
}

export interface RunPort {
  insert(ctx: { sessionId: string; taskId?: string | null; origin: string; ts?: number }, result: ActionResult): number;
}

export interface ModelsPort {
  get(tier: ModelTier): ModelProvider | null;
}

/**
 * Vision tier hook. P7-04 owns the real shape and ships `NullVisionResolver`,
 * which returns `null` in the MVP; the router only awaits the call.
 */
export interface VisionResolver {
  resolve(input: {
    observation: Observation;
    action: BrowserAction;
    text: string;
    ctx: ExecutionContext;
  }): Promise<IndexEntry | null>;
}

/** P7-05 `TrajectoryRecorder` interface (action-router §3.1). */
export interface TrajectoryRecorderPort {
  isRecording(): boolean;
  append(result: ActionResult, ctx: ExecutionContext, intent: string | null, risk: RiskLevel): void;
  finalize(success: boolean): unknown[] | null;
}

/** What a single tier returns (action-router §3.1; integration §5 on `element`/`disabled`). */
export interface Resolution {
  tier: Tier;
  entry: IndexEntry;
  element: { ref: string; role: string; name: string; context: string[] };
  /** URL of the observation this target was resolved from (verify/settle compare against it). */
  url: string;
  /** Origin of `url` — the shape `decide()` and `classify()` ask for (integration §5). */
  origin: string;
  /** Resolved element is known but disabled — the driver must not be called for click/fill/select/upload. */
  disabled: boolean;
  /**
   * Set only by the intent ladder (§5) and never by ref/locator/query targets,
   * which do not write to the action cache. Step H needs it after the action
   * verified: `query` to learn a fresh resolution into (memory §4.2), `key` of
   * the tier-1 entry that answered — hit → `recordHit`, false hit → `invalidate`.
   */
  intentLearning?: { query: ActionCacheQuery; key: string | null };
  /**
   * §5.3: the human answered `done` and performed the step manually. The router
   * returns ok with tier `human` without executing; the cache is not written.
   */
  done?: boolean;
}

/** A resolution plus the observation it was derived from (needed for verify and settle). */
export interface ResolutionOutcome {
  resolution: Resolution;
  observation: Observation;
  index: ObservationIndex;
}

/**
 * Builds a `Resolution` from a fresh observation entry. The element block
 * prefers the semantic element (live role/name/context) and falls back to the
 * index locator when the element only exists in the locator index.
 */
export function buildResolution(tier: Tier, observation: Observation, ref: string, entry: IndexEntry): Resolution {
  const element = observation.elements.find((e) => e.ref === ref);
  return {
    tier,
    entry,
    element: {
      ref,
      role: element?.role ?? entry.locator.role,
      name: element?.name ?? entry.locator.name,
      context: element?.context ?? entry.locator.context,
    },
    url: observation.url,
    origin: originOfUrl(observation.url),
    disabled: element?.state.disabled === true,
  };
}

/** `''` when `url` is not absolute (a relative observation URL has no origin to classify against). */
export function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export type DisabledTier = 'cache' | 'deterministic' | 'llm';

export interface RouterConstants {
  lexicalAccept: number;
  lexicalMargin: number;
  matchAccept: number;
  matchMargin: number;
  llmCandidates: number;
  llmMinConfidence: number;
  probeTimeoutMs: number;
  probeIntervalMs: number;
  settleQuietMs: number;
  settleMaxMs: number;
  cacheMaxConsecutiveMisses: number;
}

/** Options of `execute()` (action-router §3). */
export interface ExecuteOptions {
  /** P7-03 learning: intent recorded in the cache before this call. */
  healIntent?: string | null;
  /** Risk carried in by a replayed trajectory; live risk and this are maxed in step E. */
  recordedRisk?: RiskLevel | null;
}

/** Router dependencies (integration §5). */
export interface RouterDeps {
  pages: PagesPort;
  sessions: SessionsPort;
  observer: ObserverPort;
  risk: RiskClassifier;
  permissions: PermissionGate;
  human: HumanGate;
  models: ModelsPort;
  vision: VisionResolver;
  runs: RunPort;
  cache: ActionCachePort;
  clock: Clock;
  events?: EventBus;
  /** P7-05; absent in P7-02 and in most tests. */
  recorder?: TrajectoryRecorderPort | null;
  /** Benchmark ablation only (P10-02): tiers skipped by the ladder. */
  disabledTiers?: readonly DisabledTier[];
  /** Per-construction override of `DEFAULT_ROUTER_CONSTANTS`. */
  constants?: Partial<RouterConstants>;
}

/**
 * What the P7-02 router consumes today: a structural subset of `RouterDeps` that leaves
 * out the ports the later tiers own. `pages` provides `PageContext` for probe access,
 * `driver` is used for action execution, `models`/`vision` arrive with P7-03/P7-04,
 * `clock` is read off the `ExecutionContext` per action, and `human` may still be `null`
 * while the human tier is unwired. Every name shared with `RouterDeps` is the *same* type,
 * so P7-07 widens this contract instead of rewriting the router against it.
 */
export interface RouterCoreDeps {
  driver: PageDriver;
  pages: PagesPort;
  sessions: SessionsPort;
  observer: ObserverPort;
  risk: RiskClassifier;
  permissions: PermissionGate;
  human: HumanGate | null;
  /** P7-04 tier 3: null/absent → the LLM tier is disabled. */
  models?: ModelsPort | null;
  runs: RunPort;
  cache: ActionCachePort;
  /** The router only emits; a full `EventBus` satisfies it. */
  events: Pick<EventBus, 'emit'>;
  /** P7-05; absent in P7-02 and in most tests. */
  recorder?: TrajectoryRecorderPort | null;
  /** Benchmark ablation only (P10-02): tiers skipped by the ladder. */
  disabledTiers?: readonly DisabledTier[];
  /** Per-construction override of `DEFAULT_ROUTER_CONSTANTS`. */
  constants?: Partial<RouterConstants>;
}
