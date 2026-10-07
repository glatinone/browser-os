import type { Budget, ExecutionContext, Observation, ObservationIndex, Policy, ResolvedTarget, Tier } from '@browser-os/protocol';
import type { IndexEntry } from '@browser-os/protocol';
import type { PageDriver } from '@browser-os/browser';
import type { Observer } from '../observer/observer.js';
import type { ActionCacheStore } from '@browser-os/memory';
import type { ModelProvider } from '@browser-os/ai';
import type { RiskClassifier, PermissionGate, HumanGate, RiskResult } from '../security/interfaces.js';
import type { EventBus } from '@browser-os/protocol';
import type { TrajectoryRecorder } from '../tasks/recorder.js';
import { DEFAULT_ROUTER_CONSTANTS, type RouterConstants } from './constants.js';

export interface Resolution {
  tier: Tier;
  entry: IndexEntry;
  element: { ref: string | null; role: string; name: string };
  disabled: boolean;
}

export function toResolvedTarget(r: Resolution): ResolvedTarget {
  return {
    backendNodeId: r.entry.backendNodeId,
    cdpFrameId: r.entry.cdpFrameId,
    locator: r.entry.locator,
    role: r.element.role,
    name: r.element.name,
  };
}

export interface ActionCachePort {
  get(key: string): Promise<{ locator: import('@browser-os/protocol').ElementLocator; status: 'active' | 'invalid' } | null>;
  put(key: string, locator: import('@browser-os/protocol').ElementLocator): Promise<void>;
  recordHit(key: string): Promise<void>;
  recordMiss(key: string): Promise<void>;
}

export interface RunPort {
  recordRun(run: import('@browser-os/protocol').ActionRun): Promise<void>;
}

export interface RouterDeps {
  driver: PageDriver;
  observer: Observer;
  cache: ActionCachePort;
  model: ModelProvider | null;
  risk: RiskClassifier;
  permissions: PermissionGate;
  human: HumanGate;
  events: EventBus;
  recorder: TrajectoryRecorder | null;
  constants?: Partial<RouterConstants>;
  disabledTiers?: ReadonlyArray<'cache' | 'deterministic' | 'llm'>;
}