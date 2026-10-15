import type { PageDriver, ResolvedTarget } from '@browser-os/browser';
import type {
  ActionResult,
  ActionType,
  BrowserAction,
  EventBus,
  ExecutionContext,
  Target,
  Tier,
  TierAttempt,
  ValueSource,
} from '@browser-os/protocol';
import { ERROR_CODES, type ErrorCode, hasTarget } from '@browser-os/protocol';
import { BosError, isBosError } from '../errors.js';
import type { HumanGate, PermissionGate, RiskClassifier } from '../security/interfaces.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';
import { consumeLlmCall } from './context.js';
import {
  type Aftermath,
  attempt,
  crossedBoundary,
  dispatch,
  persistRun,
  settleAfterNavigate,
  verifyAndSettle,
} from './execute.js';
import { learnFromResolution, resolveIntentTarget } from './resolve-intent.js';
import { tryResolveLocator } from './resolve-locator.js';
import { resolveQuery } from './resolve-query.js';
import { resolveRef } from './resolve-ref.js';
import type {
  ActionCachePort,
  DisabledTier,
  ExecuteOptions,
  ModelsPort,
  ObserverPort,
  PagesPort,
  Resolution,
  RouterCoreDeps,
  RunPort,
  SessionsPort,
  TrajectoryRecorderPort,
} from './types.js';
import { toResolvedTarget } from './verify.js';

function newActionId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** §4-H tiers whose resolution is worth learning into the action cache. */
const LEARNABLE_TIERS = new Set<Tier>(['deterministic', 'llm', 'vision', 'human']);

/**
 * The copy of the action that goes on the wire (`action.started`). A `secret` value
 * source carries only its name, so the resolved secret can never ride along; this is
 * where any further literal-masking rule belongs (action-router §5).
 */
function maskAction(action: BrowserAction): BrowserAction {
  if (action.type !== 'fill' && action.type !== 'select') return action;
  if (action.value.kind !== 'secret') return action;
  return { ...action, value: { kind: 'secret', name: action.value.name } };
}

export class ActionRouter {
  private readonly driver: PageDriver;
  private readonly sessions: SessionsPort;
  private readonly observer: ObserverPort;
  private readonly runs: RunPort;
  private readonly cache: ActionCachePort;
  private readonly pages: PagesPort;
  private readonly risk: RiskClassifier;
  private readonly permissions: PermissionGate;
  private readonly human: HumanGate | null;
  private readonly models: ModelsPort | null;
  private readonly events: Pick<EventBus, 'emit'>;
  private readonly recorder: TrajectoryRecorderPort | null;
  private readonly constants: typeof DEFAULT_ROUTER_CONSTANTS;
  private readonly disabledTiers: readonly DisabledTier[];

  constructor(deps: RouterCoreDeps) {
    this.driver = deps.driver;
    this.sessions = deps.sessions;
    this.observer = deps.observer;
    this.runs = deps.runs;
    this.cache = deps.cache;
    this.pages = deps.pages;
    this.risk = deps.risk;
    this.permissions = deps.permissions;
    this.human = deps.human;
    this.models = deps.models ?? null;
    this.events = deps.events;
    this.recorder = deps.recorder ?? null;
    this.constants = { ...DEFAULT_ROUTER_CONSTANTS, ...deps.constants };
    this.disabledTiers = deps.disabledTiers ?? [];
  }

  /**
   * action-router §4. The body runs inside the session's per-page lock, so the capture,
   * the driver call and the settle window of one action can never interleave with another
   * action on the same page (requirement 4). Only CANCELLED leaves this method as an
   * exception; every other failure is an `ActionResult { ok: false }` (requirement 2).
   */
  async execute(action: BrowserAction, ctx: ExecutionContext, opts: ExecuteOptions = {}): Promise<ActionResult> {
    const actionId = newActionId();
    const startedAt = ctx.clock.now();

    try {
      return await this.sessions.withPageLock(
        ctx.sessionId,
        ctx.pageId,
        async () => await this.runAction(action, ctx, opts, actionId, startedAt),
      );
    } catch (error) {
      if (isBosError(error) && error.code === 'CANCELLED') throw error;
      if (process.env.BOS_TRACE === '1') {
        const trace = error as { constructor?: { name?: string }; code?: unknown; message?: unknown };
        console.error('execute catch:', trace?.constructor?.name, trace?.code, trace?.message);
      }
      // Either the lock could not be taken (unknown session or page) or something threw
      // that should not have: still an ActionResult, and still its action_runs row.
      return this.finish(actionId, startedAt, ctx, action, { ok: false, error: this.toResultError(error) });
    }
  }

  /** Steps A–H of action-router §4, called with the page lock already held. */
  private async runAction(
    action: BrowserAction,
    ctx: ExecutionContext,
    opts: ExecuteOptions,
    actionId: string,
    startedAt: number,
  ): Promise<ActionResult> {
    this.events.emit({ ts: startedAt, type: 'action.started', data: { actionId, action: maskAction(action) } });

    // A. Site access check
    if (await this.checkSiteAccess(ctx, action)) {
      return this.finish(actionId, startedAt, ctx, action, {
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'Site access denied by policy' },
      });
    }

    // B. Targetless actions
    if (!hasTarget(action)) return this.executeTargetless(action, ctx, actionId, startedAt);
    // hasTarget() above guarantees the union member carries a target.
    const target = ('target' in action ? action.target : undefined) as Target;

    // C. Resolve target
    let resolved: Resolution;
    const attempts: TierAttempt[] = [];
    try {
      resolved = await this.resolveTarget(action, target, ctx, attempts, opts.healIntent ?? null);
    } catch (error) {
      if (isBosError(error) && error.code === 'CANCELLED') throw error;
      return this.finish(actionId, startedAt, ctx, action, { ok: false, error: this.toResultError(error) });
    }

    // §5.3 done answer: the human performed the step; the router returns ok without
    // executing or learning. Step D (challenge) does not apply here (the human saw it).
    if (resolved.done) {
      this.events.emit({
        ts: startedAt,
        type: 'action.tier',
        data: { actionId, attempt: attempts[attempts.length - 1] ?? { tier: 'human', ok: true, ms: 0 } },
      });
      return this.finish(actionId, startedAt, ctx, action, {
        ok: true,
        action,
        tier: resolved.tier,
        driver: null,
        attempts,
        element: resolved.element,
        url: resolved.url,
        pageChanged: false,
        ms: ctx.clock.now() - startedAt,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
        risk: null,
      });
    }

    // D. Security challenge check — arrives with the vision tier (P7-04).

    // E. Risk + permission
    const riskResult = this.risk.classify(action, resolved.element, resolved.url, ctx.policy);
    const decision = this.permissions.decide(riskResult, ctx.policy, resolved.origin);

    if (decision === 'deny') {
      return this.finish(actionId, startedAt, ctx, action, {
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'Permission denied by policy' },
      });
    }
    if (decision === 'confirm') {
      const answer = await this.permissions.requestConfirmation({
        id: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
        action: maskAction(action),
        risk: riskResult.risk,
        reasons: riskResult.reasons,
        element: { role: resolved.element.role, name: resolved.element.name },
        url: resolved.url,
        createdAt: ctx.clock.now(),
      });
      if (answer === 'reject') {
        return this.finish(actionId, startedAt, ctx, action, {
          ok: false,
          error: { code: 'PERMISSION_DENIED', message: 'Confirmation rejected' },
        });
      }
    }

    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt) {
      this.events.emit({ ts: startedAt, type: 'action.tier', data: { actionId, attempt: lastAttempt } });
    }

    // F. Execute with driver fallback
    const value = await this.resolveValue('value' in action ? action.value : undefined, ctx);
    const resolvedTarget: ResolvedTarget = toResolvedTarget(resolved);
    const actionTimeoutMs = ctx.policy?.budgets?.actionTimeoutMs ?? this.constants.settleMaxMs;

    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await dispatch({ action, target: resolvedTarget, value, driver: this.driver });
    } catch (error) {
      // The driver ran (or tried to), so the cached observation for this page is stale.
      this.observer.invalidate(ctx.pageId);
      if (isBosError(error) && error.code === 'CANCELLED') throw error;
      this.invalidateFalseHit(resolved, error);
      return this.finish(actionId, startedAt, ctx, action, {
        ok: false,
        error: this.toResultError(error),
        url: resolved.url,
      });
    }
    this.observer.invalidate(ctx.pageId);

    // G. Verify + settle, then requirement 7: where the action left the page is where the
    // session sits next — applied on the failure path too, because the navigation that
    // happened while verification failed still happened.
    const changed = crossedBoundary(dispatched.result);
    let aftermath: Aftermath;
    try {
      aftermath = await verifyAndSettle({
        action,
        driver: this.driver,
        target: resolvedTarget,
        value,
        driverResult: dispatched.result,
        changed,
        constants: this.constants,
        actionTimeoutMs,
      });
    } catch (error) {
      if (isBosError(error) && error.code === 'CANCELLED') throw error;
      this.invalidateFalseHit(resolved, error);
      if (changed) this.markActivePage(ctx, dispatched.result.newPageId ?? ctx.pageId);
      return this.finish(actionId, startedAt, ctx, action, {
        ok: false,
        error: this.toResultError(error),
        url: aftermathUrl(dispatched.result, resolved),
        pageChanged: changed,
      });
    }
    if (changed) this.markActivePage(ctx, aftermath.newPageId ?? ctx.pageId);

    // H. Learn (action-router §4 step H; memory §4.2/§5). Both writes happen
    // only after G verified the action, so a cache tier that resolved but did
    // not verify never counts as a hit.
    this.learn(resolved, target.kind === 'intent', ctx.params);

    return this.finish(actionId, startedAt, ctx, action, {
      ok: true,
      action,
      tier: resolved.tier,
      driver: dispatched.via,
      attempts,
      element: resolved.element,
      locator: resolved.entry.locator,
      url: aftermath.url || aftermathUrl(dispatched.result, resolved),
      pageChanged: changed,
      ms: ctx.clock.now() - startedAt,
      llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
      risk: riskResult.risk,
    });
  }

  private async executeTargetless(
    action: BrowserAction,
    ctx: ExecutionContext,
    actionId: string,
    startedAt: number,
  ): Promise<ActionResult> {
    if (action.type === 'navigate') {
      const actionTimeoutMs = ctx.policy?.budgets?.actionTimeoutMs ?? this.constants.settleMaxMs;
      const nav = await attempt(() => this.driver.navigate(action.url, this.constants.settleMaxMs));
      if (!nav.ok) {
        // Navigation is dispatched, so it is never retried: report what the driver knows.
        return this.finish(actionId, startedAt, ctx, action, {
          ok: false,
          error: {
            code: nav.error?.code ?? 'NAVIGATION_FAILED',
            message: nav.error?.message ?? 'The driver could not navigate',
            ...(nav.effect !== 'none' ? { details: { effect: nav.effect } } : {}),
          },
          url: nav.urlAfter || action.url,
          pageChanged: crossedBoundary(nav),
        });
      }
      const changed = crossedBoundary(nav);
      await settleAfterNavigate(this.driver, this.constants, actionTimeoutMs);
      if (changed) this.markActivePage(ctx, nav.newPageId ?? ctx.pageId);
      return this.finish(actionId, startedAt, ctx, action, {
        ok: true,
        action,
        tier: null,
        driver: 'cdp',
        attempts: [],
        url: nav.urlAfter || action.url,
        pageChanged: changed,
        ms: ctx.clock.now() - startedAt,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
        risk: null,
      });
    }
    if (action.type === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, action.timeoutMs ?? 1000));
      return this.finish(actionId, startedAt, ctx, action, {
        ok: true,
        action,
        tier: null,
        driver: null,
        attempts: [],
        url: '',
        pageChanged: false,
        ms: ctx.clock.now() - startedAt,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
        risk: null,
      });
    }
    return this.finish(actionId, startedAt, ctx, action, {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: `Unknown targetless action ${action.type}` },
    });
  }

  /**
   * Action-router §4 step H, run only after step G verified the action.
   *
   * - cache tier + verified → `recordHit` on the key the tier consulted;
   * - deterministic/llm/vision/human on an intent target → learn the locator
   *   (param-substituted) into the action cache, both cache slots;
   * - ref/locator/query targets carry no learning data and never write.
   */
  private learn(resolved: Resolution, isIntentTarget: boolean, params: Record<string, string>): void {
    const learning = resolved.intentLearning;
    if (!learning) return;

    if (resolved.tier === 'cache') {
      if (learning.key !== null) this.cache.recordHit(learning.key);
      return;
    }

    if (isIntentTarget && LEARNABLE_TIERS.has(resolved.tier)) {
      learnFromResolution(resolved.entry.locator, learning.query, params, this.cache);
    }
  }

  /**
   * §5 false hit: the action cache resolved a locator that the action did not
   * verify against. Retiring the entry here keeps the entry from being served
   * again while the ladder relearns on the next call (memory §5).
   */
  private invalidateFalseHit(resolved: Resolution, error: unknown): void {
    const learning = resolved.intentLearning;
    if (!learning || learning.key === null || resolved.tier !== 'cache') return;
    if (isBosError(error) && error.code === 'VERIFICATION_FAILED') {
      this.cache.invalidate(learning.key, 'verification_failed');
    }
  }

  private async resolveTarget(
    action: BrowserAction,
    target: Target,
    ctx: ExecutionContext,
    attempts: TierAttempt[],
    healIntent: string | null,
  ): Promise<Resolution> {
    switch (target.kind) {
      case 'ref':
        return this.resolveRefTarget(target, ctx, attempts);
      case 'locator':
        return this.resolveLocatorTarget(target, ctx, attempts, healIntent, action.type);
      case 'query':
        return this.resolveQueryTarget(target, ctx, attempts);
      case 'intent':
        return this.resolveIntentTarget(action.type, target, ctx, attempts, healIntent);
      default:
        throw new BosError('INVALID_REQUEST', `Unknown target kind: ${String((target as Target).kind)}`);
    }
  }

  private async resolveRefTarget(
    target: Extract<Target, { kind: 'ref' }>,
    ctx: ExecutionContext,
    attempts: TierAttempt[],
  ): Promise<Resolution> {
    const { observation, index } = await this.observer.capture(ctx.sessionId, ctx.pageId);
    const staleIndex = this.observer.index(target.observationId) ?? null;
    const resolution = resolveRef({
      target,
      observation,
      index,
      staleIndex,
      accept: this.constants.matchAccept,
      margin: this.constants.matchMargin,
    });
    attempts.push({ tier: 'ref', ok: true, ms: 0 });
    return resolution;
  }

  private async resolveLocatorTarget(
    target: Extract<Target, { kind: 'locator' }>,
    ctx: ExecutionContext,
    attempts: TierAttempt[],
    healIntent: string | null,
    actionType: ActionType,
  ): Promise<Resolution> {
    // Trajectory replay target — action-router §5 case 'locator', tier 1.
    // The locator is trusted, so it goes straight through tryResolveLocator
    // (probe → fingerprint match). No cache read/write: a locator target is
    // itself the cache entry.
    const resolved = await tryResolveLocator(target.locator, 'cache', attempts, {
      driver: this.driver,
      observer: this.observer,
      cache: this.cache,
      constants: this.constants,
      actionType,
      sessionId: ctx.sessionId,
      pageId: ctx.pageId,
      cdp: null,
      worlds: null,
      mainCdpFrameId: '',
    });
    if (resolved) return resolved;
    if (!healIntent) throw new BosError('TARGET_NOT_FOUND', 'The locator no longer matches the page');
    // §5.4: the locator failed, so resolution continues as the healed intent
    // from tier 2 onward. The action cache is not consulted again, which the
    // ladder expresses as an intent that skips tier 1 entirely.
    return this.resolveIntentTarget(actionType, { kind: 'intent', text: healIntent }, ctx, attempts, null, true);
  }

  private async resolveQueryTarget(
    target: Extract<Target, { kind: 'query' }>,
    ctx: ExecutionContext,
    attempts: TierAttempt[],
  ): Promise<Resolution> {
    const { observation, index } = await this.observer.capture(ctx.sessionId, ctx.pageId);
    const resolution = resolveQuery(observation, index, target);
    attempts.push({ tier: 'deterministic', ok: true, ms: 0 });
    return resolution;
  }

  private async resolveIntentTarget(
    actionType: ActionType,
    target: Extract<Target, { kind: 'intent' }>,
    ctx: ExecutionContext,
    attempts: TierAttempt[],
    healIntent: string | null,
    skipCache = false,
  ): Promise<Resolution> {
    const pageContext = await this.pages.context(ctx.sessionId, ctx.pageId);

    return resolveIntentTarget(
      {
        intent: target.text,
        actionType,
        url: pageContext.url ?? undefined,
        sessionId: ctx.sessionId,
        pageId: ctx.pageId,
        params: ctx.params,
        healIntent,
        skipCache,
      },
      attempts,
      {
        driver: this.driver,
        observer: this.observer,
        cache: this.cache,
        constants: this.constants,
        cdp: pageContext.cdp,
        worlds: pageContext.worlds,
        mainCdpFrameId: pageContext.mainCdpFrameId,
        models: this.models,
        human: this.human,
        exec: {
          taskId: ctx.taskId,
          humanTimeoutMs: ctx.policy.budgets.humanTimeoutMs,
          consumeLlmCall: () => consumeLlmCall(ctx),
        },
      },
    );
  }

  private async resolveValue(value: ValueSource | undefined, ctx: ExecutionContext): Promise<string | undefined> {
    if (value === undefined) return undefined; // click / hover / press carry no value
    if (value.kind === 'literal') return value.value;
    if (value.kind === 'param') return ctx.params[value.name] ?? '';
    if (value.kind === 'secret') return await ctx.secrets.resolve(value.name);
    throw new Error(`Unknown value source: ${String((value as ValueSource).kind)}`);
  }

  /**
   * Requirement 2 / S20: every failure leaves `execute` as an
   * `ActionResult { ok: false }` (only CANCELLED propagates). `details.effect`
   * is preserved so the caller can see why nothing was retried, and an effect
   * that is not provably `'none'` is reported as ACTION_FAILED, never retried.
   */
  private toResultError(e: unknown): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    if (e instanceof BosError) {
      return e.details
        ? { code: e.code, message: e.message, details: e.details }
        : { code: e.code, message: e.message };
    }

    const raw = (e ?? {}) as { code?: unknown; message?: unknown; effect?: unknown; details?: unknown };
    const effect = typeof raw.effect === 'string' ? raw.effect : undefined;
    const message = typeof raw.message === 'string' ? raw.message : String(e);
    const known =
      typeof raw.code === 'string' && (ERROR_CODES as readonly string[]).includes(raw.code) ? raw.code : undefined;
    // S20: a failure whose effect is not 'none' is ACTION_FAILED with details.effect.
    const code: ErrorCode =
      effect !== undefined && effect !== 'none' ? 'ACTION_FAILED' : ((known ?? 'ACTION_FAILED') as ErrorCode);

    const details: Record<string, unknown> = {};
    if (effect !== undefined) details.effect = effect;
    if (raw.details && typeof raw.details === 'object') Object.assign(details, raw.details as Record<string, unknown>);

    return Object.keys(details).length > 0 ? { code, message, details } : { code, message };
  }

  /**
   * Builds the ActionResult, writes its `action_runs` row (requirement 1, §8) and emits
   * `action.completed`. Every exit of `execute` goes through here, success or not.
   */
  private finish(
    actionId: string,
    startedAt: number,
    ctx: ExecutionContext,
    action: BrowserAction,
    result: Partial<ActionResult> & { ok: boolean; error?: ActionResult['error'] },
  ): ActionResult {
    const built: ActionResult = {
      ok: result.ok,
      action,
      tier: result.tier ?? null,
      driver: result.driver ?? null,
      attempts: result.attempts ?? [],
      element: result.element,
      locator: result.locator,
      url: result.url ?? '',
      pageChanged: result.pageChanged ?? false,
      extracted: result.extracted,
      ms: ctx.clock.now() - startedAt,
      llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
      risk: result.risk ?? null,
      error: result.error,
    };

    persistRun(this.runs, ctx, built);

    // P7-05: a trajectory records what reached the risk gate; failures before it are not in it.
    if (ctx.taskId && this.recorder?.isRecording() && built.risk !== null) {
      this.recorder.append(built, ctx, null, built.risk);
    }

    this.events.emit({ ts: ctx.clock.now(), type: 'action.completed', data: { actionId, result: built } });
    return built;
  }

  private async checkSiteAccess(_ctx: ExecutionContext, _action: BrowserAction): Promise<boolean> {
    // Stub implementation (P7-01 hands over the site allow/deny list with the policy).
    return false;
  }

  /**
   * Requirement 7 (integration §5): an action that crossed a navigation boundary becomes
   * the session's active page, so the next capture and the next action land on the tab the
   * agent is actually looking at.
   */
  private markActivePage(ctx: ExecutionContext, pageId: string): void {
    try {
      this.sessions.setActivePage(ctx.sessionId, pageId);
    } catch {
      // A session that has already gone away must not turn a delivered action into a failure.
    }
  }
}

/** Post-action URL: what the driver saw, falling back to where it was acting. */
function aftermathUrl(result: { urlAfter?: string }, resolved: Resolution): string {
  return result.urlAfter || resolved.url;
}
