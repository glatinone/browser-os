import type { Budget, ExecutionContext, Observation, ObservationIndex, Policy, Tier, TierAttempt, ValueSource, BrowserAction, BrowserActionType, IndexEntry, ErrorCode, ElementLocator, ActionResult, ActionType, Driver } from '@browser-os/protocol';
import type { PageDriver, ResolvedTarget } from '@browser-os/browser';
import { BosError } from '../errors.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';
import { EventBus } from '@browser-os/protocol';
import type { ActionCachePort, RouterConstants, RouterDeps, Resolution, toResolvedTarget } from './types.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';
import { ActionResult, ActionType, Tier, TierAttempt, Driver } from '@browser-os/protocol';
import { EventBus } from '@browser-os/protocol';
import type { ModelProvider } from '@browser-os/ai';
import type { RiskClassifier, PermissionGate, HumanGate, RiskResult } from '../security/interfaces.js';
import { BosError } from '../errors.js';

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

    this.events.emit('action.started', { actionId, action: maskAction(action) });

    // A. Site access check
    if (await this.checkSiteAccess(ctx, action)) {
      return this.finish(actionId, startedAt, action, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Site access denied by policy' } });
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
      if (error instanceof BosError) {
        return this.finish(actionId, startedAt, action, { ok: false, error: { code: error.code, message: error.message } });
      }
      throw error;
    }

    // D. Security challenge check
    // This would be checked during resolution; stubbed for now

    // E. Risk + permission
    const riskResult = await this.risk.classify(action, resolved.element, resolved.url, ctx.policy);
    const decision = await this.permissions.decide(riskResult, ctx.policy, resolved.origin);

    if (decision === 'deny') {
      return this.finish(actionId, startedAt, action, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Permission denied by policy' } });
    }
    if (decision === 'confirm') {
      const answer = await this.permissions.requestConfirmation({} as any);
      if (answer === 'reject') {
        return this.finish(actionId, startedAt, action, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Confirmation rejected' } });
      }
    }

    // F. Execute with driver fallback
    const value = await this.resolveValue(action.value, ctx);
    
    let driverUsed: 'cdp' | 'playwright' = 'cdp';
    let driverResult: any;

    try {
      driverResult = await this.driver.cdp.perform(action, resolved, value);
      driverUsed = 'cdp';
    } catch (e) {
      // Fallback to Playwright only on effect === 'none'
      if ((e as any).effect === 'none') {
        driverResult = await this.driver.playwright.perform(action, resolved.locator, value);
        driverUsed = 'playwright';
      } else {
        throw e;
      }
    }

    // G. Verify + settle
    await verifyAction(this.driver, action, resolved, value);
    await settle(this.driver, ctx);

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
      attempts: [],
      element: resolved.element,
      locator: resolved.locator,
      url: resolved.url,
      pageChanged: false,
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
      await this.driver.cdp.navigate(action.url);
      await this.driver.settle();
      return this.finish(actionId, startedAt, action, { ok: true, action, tier: null, driver: 'cdp', attempts: [], url: action.url, pageChanged: true, ms: Date.now() - startedAt, llm: { calls: 0, inputTokens: 0, outputTokens: 0 }, risk: null });
    }
    if (action.type === 'wait') {
      await new Promise(resolve => setTimeout(resolve, action.timeoutMs ?? 1000));
      return this.finish(actionId, startedAt, action, { ok: true, action, tier: null, driver: null, attempts: [], url: '', pageChanged: false, ms: Date.now() - startedAt, llm: { calls: 0, inputTokens: 0, outputTokens: 0 }, risk: null });
    }
    return this.finish(actionId, startedAt, action, { ok: false, error: { code: 'INVALID_REQUEST', message: `Unknown targetless action ${action.type}` } });
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
    // Stub - would use observer.index
    throw new BosError('TARGET_NOT_FOUND', 'Ref resolution not implemented');
  }

  private async resolveLocatorTarget(target: any, ctx: any, attempts: any[]): Promise<any> {
    // Use existing resolveLocator
    throw new BosError('TARGET_NOT_FOUND', 'Locator resolution not implemented');
  }

  private async resolveQueryTarget(target: any, ctx: any, attempts: any[]): Promise<any> {
    throw new BosError('TARGET_NOT_FOUND', 'Query resolution not implemented');
  }

  private async resolveIntentTarget(target: any, ctx: any, attempts: any[], healIntent: string | null): Promise<any> {
    throw new BosError('TARGET_NOT_FOUND', 'Intent resolution not implemented');
  }

  private async resolveValue(value: ValueSource, ctx: any): Promise<string> {
    if (value.kind === 'literal') return value.value;
    if (value.kind === 'param') return ctx.params[value.name] ?? '';
    if (value.kind === 'secret') return await ctx.secrets.resolve(value.name);
    throw new Error(`Unknown value source: ${(value as any).kind}`);
  }

  private finish(actionId: string, startedAt: number, action: any, result: any): any {
    return {
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
  }
}

// Need to export the BosError class
import { BosError } from '@browser-os/protocol';