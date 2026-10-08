import type { Observation, ResolvedTarget, ExecutionContext, ElementLocator } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';
import { cache } from './cache.js';

function cacheKey(origin: string, pathTemplate: string, actionType: string, intent: string): string {
  return `intent:${origin}:${pathTemplate}:${actionType}:${normalizeIntent(intent)}`;
}

function normalizeIntent(intent: string): string {
  return intent.toLowerCase().trim().replace(/\s+/g, ' ');
}

function pathTemplate(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/[^/]+/g, (m) => m.match(/\d+/) ? '/:id' : m);
  } catch {
    return '/';
  }
}

async function lexicalRank(obs: any, intent: string, actionType: string): Promise<Array<{ element: any; score: number }>> {
  // dom-intelligence §7 - lexical ranking
  const candidates = obs.elements
    .filter((el: any) => isCompatible(el, 'fill')) // placeholder
    .map((el: any) => {
      let score = 0;
      
      // Name match (high weight)
      if (el.name && intent.includes(el.name.toLowerCase())) score += 0.4;
      if (el.name && el.name.toLowerCase().includes(intent)) score += 0.2;
      
      // Role match
      if (el.role && (intent.includes(el.role) || el.role.includes('box') || el.role.includes('button'))) score += 0.2;
      
      // Placeholder match
      if (el.placeholder && intent.includes(el.placeholder.toLowerCase())) score += 0.15;
      
      // Value match
      if (el.value && intent.includes(el.value.toLowerCase())) score += 0.1;
      
      // Context match
      if (el.context && el.context.some((c: string) => intent.includes(c.toLowerCase()))) score += 0.1;
      
      return { element: el, score };
    })
    .filter((c: any) => c.score > 0)
    .sort((a: any, b: any) => b.score - a.score);
  
  return candidates;
}

function isCompatible(element: any, actionType: string): boolean {
  switch (actionType) {
    case 'fill':
      return element.state?.editable || ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(element.role);
    case 'click':
    case 'hover':
      return !element.disabled && !['heading', 'paragraph', 'text'].includes(element.role);
    case 'press':
      return ['textbox', 'searchbox', 'combobox', 'spinbutton', 'button', 'link'].includes(element.role);
    case 'select':
      return ['select', 'combobox', 'listbox'].includes(element.role);
    default:
      return true;
  }
}

async function resolveIntentTarget(
  target: any,
  ctx: any,
  attempts: any[],
  healIntent: string | null,
  cache: any,
  driver: any,
  observer: any,
  model: any,
  risk: any,
  permissions: any,
  human: any,
  constants: typeof import('./constants.js').DEFAULT_ROUTER_CONSTANTS
): Promise<any> {
  const action = ctx.action;
  const origin = ctx.origin;
  const pathTmpl = pathTemplate(ctx.url);
  const key = cacheKey(origin, pathTemplate(ctx.url), ctx.action.type, target.text);
  
  // Tier 1: Action cache
  const cached = await cache.get(cacheKey(origin, pathTemplate(ctx.url), ctx.action.type, target.text));
  if (cached && cached.status === 'active') {
    const resolved = await tryResolveLocator(cached.locator, 'cache', [], ctx, driver, observer, DEFAULT_ROUTER_CONSTANTS);
    if (resolved) return resolved;
    await cache.recordMiss(key);
  }
  
  // Tier 2: Deterministic lexical match
  const obs = await driver.capture();
  const ranked = await lexicalRank(obs, target.text, action.type);
  
  if (ranked.length > 0) {
    const best = ranked[0];
    const secondBest = ranked[1]?.score ?? 0;
    
    if (best.score >= constants.lexicalAccept && 
        best.score - secondBest >= constants.lexicalMargin &&
        isCompatible(best.element, action.type)) {
      attempts.push({ tier: 'deterministic', ok: true, score: best.score });
      return buildResolution(best.element, 'deterministic');
    }
    attempts.push({ tier: 'deterministic', ok: false, reason: 'lexical score below threshold' });
  }
  
  // Tier 3: LLM (if enabled)
  if (ctx.policy.tiers.llm && model && ctx.budget.llmCallsAction < ctx.policy.budgets.maxLlmCallsPerAction) {
    // LLM resolution would go here
    // For now, return null to fall through
  }
  
  // Tier 4: Vision (post-MVP) - returns null
  
  // Tier 5: Human
  if (ctx.policy.tiers.human) {
    // Human resolution would go here
  }
  
  throw new BosError('TARGET_NOT_FOUND', `Could not resolve intent: ${target.text}`);
}

function pathTemplate(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/[^/]+/g, (m) => m.match(/\d+/) ? '/:id' : m);
  } catch {
    return '/';
  }
}

function normalizeIntent(intent: string): string {
  return intent.toLowerCase().trim().replace(/\s+/g, ' ');
}

function cacheKey(origin: string, pathTemplate: string, actionType: string, intent: string): string {
  return `intent:${origin}:${pathTemplate}:${actionType}:${normalizeIntent(intent)}`;
}

function buildResolution(element: any, tier: string) {
  return {
    tier,
    entry: {
      backendNodeId: element.backendNodeId,
      frameId: element.frame,
      cdpFrameId: element.cdpFrameId,
      locator: element.locator,
    },
    element: { ref: element.ref, role: element.role, name: element.name },
    disabled: element.disabled,
  };
}

async function tryResolveLocator(
  locator: any,
  tierLabel: string,
  attempts: any[],
  ctx: any,
  driver: any,
  observer: any,
  constants: any
): Promise<any | null> {
  // Stub
  return null;
}