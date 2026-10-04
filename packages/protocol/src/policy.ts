// Risk, policy and permissions (data-models §7).

import type { BrowserAction } from './actions.js';

export type RiskLevel = 'low' | 'medium' | 'high';
export type PermissionDecision = 'allow' | 'confirm' | 'deny';

export interface SitePolicy {
  originPattern: string; // exact origin or "*.example.com" wildcard
  access?: 'allow' | 'deny'; // deny = Browser-OS refuses to act on this origin
  risk?: Partial<Record<RiskLevel, PermissionDecision>>;
}

export interface Policy {
  risk: Record<RiskLevel, PermissionDecision>; // default { low: 'allow', medium: 'allow', high: 'confirm' }
  sites: SitePolicy[]; // first match wins; overrides `risk`
  tiers: { llm: boolean; vision: boolean; human: boolean };
  budgets: {
    maxLlmCallsPerAction: number; // default 2
    maxLlmCallsPerTask: number; // default 20
    maxRetriesPerAction: number; // default 2
    actionTimeoutMs: number; // default 15000
    humanTimeoutMs: number; // default 600000
  };
  uploads: { allowedDirs: string[] }; // default [] = uploads disabled
  downloads: { enabled: boolean; dir: string | null };
}

export interface PermissionRequest {
  id: string; // perm_...
  sessionId: string;
  taskId: string | null;
  action: BrowserAction; // masked
  risk: RiskLevel;
  reasons: string[]; // e.g. ["element name matches 'delete'", "site policy: high=confirm"]
  element?: { role: string; name: string };
  url: string;
  createdAt: number;
}

export interface PermissionDecisionRecord {
  requestId: string;
  decision: 'approve' | 'reject';
  decidedBy: 'human' | 'policy';
  decidedAt: number;
}

/** An override shape for mergePolicy: nested objects partial, arrays taken whole. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_POLICY: Policy = {
  risk: { low: 'allow', medium: 'allow', high: 'confirm' },
  sites: [],
  tiers: { llm: true, vision: false, human: true },
  budgets: {
    maxLlmCallsPerAction: 2,
    maxLlmCallsPerTask: 20,
    maxRetriesPerAction: 2,
    actionTimeoutMs: 15000,
    humanTimeoutMs: 600000,
  },
  uploads: { allowedDirs: [] },
  downloads: { enabled: false, dir: null },
};

/**
 * Pure deep merge with arrays REPLACED, never concatenated: a policy override that
 * lists three allowed upload directories means exactly those three.
 */
export function mergePolicy(base: Policy, override: DeepPartial<Policy> = {}): Policy {
  return {
    risk: { ...base.risk, ...override.risk },
    sites: override.sites ?? base.sites,
    tiers: { ...base.tiers, ...override.tiers },
    budgets: { ...base.budgets, ...override.budgets },
    uploads: { ...base.uploads, ...override.uploads },
    downloads: { ...base.downloads, ...override.downloads },
  };
}
