// Tasks, trajectories and the action cache (data-models §6).

import type { ActionType, BrowserAction } from './actions.js';
import type { ElementLocator } from './dom.js';
import type { RiskLevel } from './policy.js';

export type TaskStatus = 'running' | 'waiting_for_human' | 'completed' | 'failed' | 'cancelled';
export type TaskMode = 'record' | 'replay' | 'auto'; // auto = replay if an active trajectory exists, else record

export interface TaskStats {
  actions: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  visionCalls: number;
  humanInterventions: number;
  cacheHits: number;
  healedSteps: number;
  ms: number;
}

export interface Task {
  id: string; // tsk_...
  key: string; // /^[a-z0-9][a-z0-9._-]{0,63}$/, e.g. "linkedin.search-people"; chosen by the caller
  sessionId: string;
  mode: TaskMode;
  resolvedMode: 'record' | 'replay' | null; // decided at start (integration §10)
  params: Record<string, string>; // non-secret params; persisted
  secretNames: string[]; // names only
  status: TaskStatus;
  trajectoryId: string | null;
  startedAt: number;
  endedAt: number | null;
  stats: TaskStats;
}

export interface TrajectoryStep {
  index: number;
  // targets are { kind: 'locator' }, EXCEPT { kind: 'intent' } when a human performed
  // the step manually (action-router §5.3); values ALWAYS param/secret refs or
  // non-sensitive literals
  action: BrowserAction;
  intent: string | null; // original natural-language target, used for healing
  pre: { urlPattern: string }; // path template the page must match before this step (specs/memory.md §4)
  post?: { urlPattern?: string };
  risk: RiskLevel;
}

export interface Trajectory {
  id: string; // trj_...
  taskKey: string;
  origin: string; // origin of the first step's page, e.g. "https://www.linkedin.com"
  startUrl: string; // URL before the first step, param values replaced by {{name}}
  version: number; // increments when healing rewrites a step
  params: string[];
  secretNames: string[];
  steps: TrajectoryStep[];
  status: 'active' | 'suspect' | 'invalid';
  stats: {
    runs: number;
    successes: number;
    failures: number;
    consecutiveFailures: number;
    lastSuccessAt: number | null;
  };
  createdAt: number;
  updatedAt: number;
}

export interface ActionCacheEntry {
  key: string; // sha256(origin | pathTemplate | actionType | normalizedIntent), hex
  origin: string;
  pathTemplate: string;
  actionType: ActionType;
  intent: string; // normalized intent text
  locator: ElementLocator;
  hits: number;
  misses: number;
  consecutiveMisses: number;
  status: 'active' | 'invalid';
  createdAt: number;
  lastHitAt: number | null;
}
