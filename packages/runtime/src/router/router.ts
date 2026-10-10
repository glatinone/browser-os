import type { PageDriver, ResolvedTarget } from '@browser-os/browser';
import type { EventBus, ValueSource } from '@browser-os/protocol';
import { ERROR_CODES, type ErrorCode } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';
import { resolveQuery } from './resolve-query.js';
import { resolveRef } from './resolve-ref.js';
import { pageChanged, settleAfter, toResolvedTarget, verifyAction } from './verify.js';

export class ActionRouter {
  private readonly driver: PageDriver;
  private readonly observer: any;
  private readonly cache: any;
  private readonly model: any;
  private readonly risk: any;
  private readonly permissions: any;
  private readonly human: any;
  private readonly events: EventBus;
  private readonly recorder: any;
  private readonly constants: typeof DEFAULT_ROUTER_CONSTANTS;
  private readonly disabledTiers: ReadonlyArray<'cache' | 'deterministic' | 'llm'>;

  constructor(deps: any) {
    this.driver = deps.driver;
    this.observer = deps.observer;
    this.cache = deps.cache;
    this.model = deps.model;
    this.risk = deps.risk;
    this.permissions = deps.permissions;
    this.human = deps.human;
    this.events = deps.events;
    this.recorder = deps.recorder;
    this.constants = { ...DEFAULT_ROUTER_CONSTANTS, ...deps.constants };
    this.disabledTiers = deps.disabledTiers ?? [];
  }

  async execute(action: any, ctx: any, opts: { healIntent?: string | null } = {}): Promise<any> {
    const actionId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const startedAt = Date.now();

    const maskAction = (a: any) => {
      if (!a.target || a.target.kind !== 'fill') return a;
      const v = a.target as any;
      if (v.value?.kind === 'secret') {
        return { ...a, target: { ...v, value: { kind: 'secret', name: v.value.name } } };
      }
      return a;
    };

    this.events.emit({ ts: startedAt, type: 'action.started', data: { actionId, action: maskAction(action) } });

    // A. Site access check
    if (await this.checkSiteAccess(ctx, action)) {
      return this.finish(actionId, startedAt, action, {
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'Site access denied by policy' },
      });
    }

    // B. Targetless actions
    if (!this.hasTarget(action)) {
      return this.executeTargetless(action, ctx, actionId, startedAt);
    }

    // C. Resolve target
    let resolved: any = null;
    const attempts: any[] = [];

    try {
      resolved = await this.resolveTarget(action, ctx, attempts, opts.healIntent ?? null);
    } catch (error) {
      if (error instanceof BosError && error.code === 'CANCELLED') throw error;
      return this.finish(actionId, startedAt, action, { ok: false, error: this.toResultError(error) });
    }

    // D. Security challenge check
    // This would be checked during resolution; stubbed for now

    // E. Risk + permission
    const riskResult = await this.risk.classify(action, resolved.element, resolved.url, ctx.policy);
    const decision = await this.permissions.decide(riskResult, ctx.policy, resolved.origin);

    if (decision === 'deny') {
      return this.finish(actionId, startedAt, action, {
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'Permission denied by policy' },
      });
    }
    if (decision === 'confirm') {
      const answer = await this.permissions.requestConfirmation({} as any);
      if (answer === 'reject') {
        return this.finish(actionId, startedAt, action, {
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
    const value = await this.resolveValue(action.value, ctx);
    const target: ResolvedTarget = toResolvedTarget(resolved);

    let driverUsed: 'cdp' | 'playwright' = 'cdp';
    let driverResult: any;

    try {
      driverResult = await this.driver.cdpPerform(action, target, value);
    } catch (e) {
      // Fallback to Playwright only when the failed action provably had no effect (S20).
      const effect = (e as { effect?: string }).effect;
      if (effect === 'none') {
        try {
          driverResult = await this.driver.playwrightPerform(action, target, value);
          driverUsed = 'playwright';
        } catch (fallbackError) {
          return this.finish(actionId, startedAt, action, {
            ok: false,
            error: this.toResultError(fallbackError),
          });
        }
      } else {
        // effect 'unknown' (or any other claim) is never retried blindly: report and stop.
        return this.finish(actionId, startedAt, action, { ok: false, error: this.toResultError(e) });
      }
    }

    // Requirement 4: an executed action invalidates the cached observation for this page.
    this.observer?.invalidate?.(ctx.pageId);

    // G. Verify + settle
    let changed = pageChanged(
      driverResult?.urlBefore ?? '',
      driverResult?.urlAfter ?? '',
      driverResult?.navigated === true,
    );
    try {
      await verifyAction({ action, driver: this.driver, target, value, changed });
      const actionTimeoutMs = ctx.policy?.budgets?.actionTimeoutMs ?? this.constants.settleMaxMs;
      await settleAfter(this.driver, this.constants, actionTimeoutMs, changed);
    } catch (e) {
      // `execute` never throws except CANCELLED: a failed verification is a failed ActionResult.
      if (e instanceof BosError && e.code === 'CANCELLED') throw e;
      return this.finish(actionId, startedAt, action, { ok: false, error: this.toResultError(e) });
    }

    // H. Learn / cache
    if (action.target.kind === 'intent' && ['deterministic', 'llm', 'vision', 'human'].includes(resolved.tier)) {
      // Cache learning would go here
    }
    if (resolved.tier === 'cache') {
      // Record cache hit
    }

    // Record trajectory if recording
    if (ctx.taskId && this.recorder && this.recorder.isRecording()) {
      await this.recorder.append({ action, resolved, value, risk: 'low' }, ctx);
    }

    return this.finish(actionId, startedAt, action, {
      ok: true,
      action,
      tier: resolved.tier,
      driver: driverUsed,
      attempts,
      element: resolved.element,
      locator: resolved.locator,
      url: resolved.url,
      pageChanged: changed,
      ms: Date.now() - startedAt,
      llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
      risk: null,
    });
  }

  private hasTarget(action: any): boolean {
    return 'target' in action && action.target !== undefined;
  }

  private async checkSiteAccess(ctx: any, action: any): Promise<boolean> {
    // Stub implementation
    return false;
  }

  private async executeTargetless(action: any, ctx: any, actionId: string, startedAt: number): Promise<any> {
    if (action.type === 'navigate') {
      await this.driver.navigate(action.url, action.timeoutMs ?? this.constants.settleMaxMs);
      await this.driver.settle(this.constants.settleQuietMs, this.constants.settleMaxMs);
      return this.finish(actionId, startedAt, action, {
        ok: true,
        action,
        tier: null,
        driver: 'cdp',
        attempts: [],
        url: action.url,
        pageChanged: true,
        ms: Date.now() - startedAt,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
        risk: null,
      });
    }
    if (action.type === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, action.timeoutMs ?? 1000));
      return this.finish(actionId, startedAt, action, {
        ok: true,
        action,
        tier: null,
        driver: null,
        attempts: [],
        url: '',
        pageChanged: false,
        ms: Date.now() - startedAt,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
        risk: null,
      });
    }
    return this.finish(actionId, startedAt, action, {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: `Unknown targetless action ${action.type}` },
    });
  }

  private async resolveTarget(action: any, ctx: any, attempts: any[], healIntent: string | null): Promise<any> {
    const target = action.target;

    switch (target.kind) {
      case 'ref':
        return this.resolveRefTarget(target, ctx, attempts);
      case 'locator':
        return this.resolveLocatorTarget(target, ctx, attempts);
      case 'query':
        return this.resolveQueryTarget(target, ctx, attempts);
      case 'intent':
        return this.resolveIntentTarget(target, ctx, attempts, healIntent);
      default:
        throw new Error(`Unknown target kind: ${(target as any).kind}`);
    }
  }

  private async resolveRefTarget(target: any, ctx: any, attempts: any[]): Promise<any> {
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

  private async resolveLocatorTarget(target: any, ctx: any, attempts: any[]): Promise<any> {
    // Locator tier arrives with P7-03 (intent/locator tiers are out of P7-02 scope).
    throw new BosError('TARGET_NOT_FOUND', 'Locator resolution not implemented');
  }

  private async resolveQueryTarget(target: any, ctx: any, attempts: any[]): Promise<any> {
    const { observation, index } = await this.observer.capture(ctx.sessionId, ctx.pageId);
    const resolution = resolveQuery(observation, index, target);
    attempts.push({ tier: 'deterministic', ok: true, ms: 0 });
    return resolution;
  }

  private async resolveIntentTarget(target: any, ctx: any, attempts: any[], healIntent: string | null): Promise<any> {
    throw new BosError('TARGET_NOT_FOUND', 'Intent resolution not implemented');
  }

  private async resolveValue(value: ValueSource | undefined, ctx: any): Promise<string | undefined> {
    if (value === undefined) return undefined; // click / hover / press carry no value
    if (value.kind === 'literal') return value.value;
    if (value.kind === 'param') return ctx.params[value.name] ?? '';
    if (value.kind === 'secret') return await ctx.secrets.resolve(value.name);
    throw new Error(`Unknown value source: ${(value as any).kind}`);
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

  private finish(actionId: string, startedAt: number, action: any, result: any): any {
    const built = {
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
      ms: Date.now() - startedAt,
      llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
      risk: result.risk ?? null,
      error: result.error,
    };
    this.events.emit({ ts: Date.now(), type: 'action.completed', data: { actionId, result: built } });
    return built;
  }
}
