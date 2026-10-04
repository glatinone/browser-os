// Actions and their results (data-models §5).
//
// The calling agent always names the action TYPE explicitly. Only the TARGET may
// be natural language. That is what keeps the deterministic tiers deterministic
// (ADR-010).

import type { ElementLocator } from './dom.js';
import type { ErrorCode } from './errors.js';
import type { RiskLevel } from './policy.js';

export type ValueSource =
  | { kind: 'literal'; value: string } // stored in trajectories only if not sensitive
  | { kind: 'param'; name: string } // value from task params; stored as the reference only
  | { kind: 'secret'; name: string }; // resolved at execution from SecretResolver; never stored, logged or sent to a model

export type Target =
  | { kind: 'ref'; ref: string; observationId: string } // from a fresh observation (tier 'ref')
  | { kind: 'intent'; text: string } // natural language: "the search box"
  | { kind: 'query'; role?: string; name?: string; text?: string; css?: string; nth?: number } // structured, deterministic
  | { kind: 'locator'; locator: ElementLocator }; // from cache / trajectory

export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: Target; button?: 'left' | 'right' | 'middle'; clickCount?: 1 | 2 }
  | { type: 'fill'; target: Target; value: ValueSource; submit?: boolean } // submit = press Enter after
  | { type: 'press'; key: string; target?: Target } // Playwright key syntax: "Enter", "Control+A"
  | { type: 'select'; target: Target; value: ValueSource } // matches option value, then label
  | { type: 'hover'; target: Target }
  | { type: 'scroll'; target?: Target; direction: 'up' | 'down'; amountPx?: number }
  | { type: 'wait'; until: 'load' | 'domcontentloaded' | 'settled'; timeoutMs?: number }
  | { type: 'waitFor'; target: Target; state?: 'visible' | 'hidden'; timeoutMs?: number }
  | { type: 'extract'; target?: Target; format: 'text' | 'links' | 'table' }
  | { type: 'upload'; target: Target; paths: string[] }; // absolute paths; checked against policy.uploads.allowedDirs

export type ActionType = BrowserAction['type'];

/**
 * Action types that never need a target resolved. `press`, `scroll` and `extract`
 * may carry an optional target, so they are not listed here — use `hasTarget`
 * to decide whether resolution is required for a concrete action.
 */
export const TARGETLESS: ReadonlySet<ActionType> = new Set<ActionType>(['navigate', 'wait']);

/** True when this concrete action carries a target and therefore needs resolution. */
export function hasTarget(action: BrowserAction): boolean {
  return 'target' in action && action.target !== undefined;
}

export type Tier = 'ref' | 'cache' | 'deterministic' | 'llm' | 'vision' | 'human';
export type Driver = 'cdp' | 'playwright';

export interface TierAttempt {
  tier: Tier;
  ok: boolean;
  ms: number;
  reason?: ErrorCode;
  candidates?: number; // number of candidates considered
  score?: number; // best match score (0..1) where applicable
}

export interface ActionResult {
  ok: boolean;
  action: BrowserAction; // as requested, with literal values of sensitive fields masked
  tier: Tier | null; // tier that resolved the target; null for targetless actions
  driver: Driver | null;
  attempts: TierAttempt[];
  element?: { ref: string; role: string; name: string };
  locator?: ElementLocator; // what was resolved (used by recorder and cache)
  url: string; // url after the action
  pageChanged: boolean; // navigation or url change happened
  extracted?: unknown; // for 'extract'
  ms: number;
  llm: { calls: number; inputTokens: number; outputTokens: number };
  risk: RiskLevel | null; // computed risk (null for actions that never reached classification)
  // e.g. { effect: 'unknown' }, { reason: 'mfa' }, { candidates: [..] }; never secrets
  error?: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}
