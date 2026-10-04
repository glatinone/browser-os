// Execution context and the interfaces a package may depend on without pulling in
// another package (data-models §8).

import type { ChallengeKind } from './dom.js';
import type { Policy } from './policy.js';

export interface Clock {
  now(): number;
}

export interface SecretResolver {
  /** Returns the secret value or throws BosError('PERMISSION_DENIED'). Never logs the value. */
  resolve(name: string): Promise<string>;
}

/** Minimal CDP interface so `dom` does not depend on Playwright (implemented in `browser`). */
export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (params: unknown) => void): () => void; // returns unsubscribe
}

export interface Budget {
  llmCallsAction: number; // reset at the start of every execute()
  llmCallsActionMax: number; // policy.budgets.maxLlmCallsPerAction
  llmCallsTask: number; // shared across a task's actions (owned by TaskManager)
  llmCallsTaskMax: number; // policy.budgets.maxLlmCallsPerTask; Infinity outside a task
  deadline: number; // epoch ms
}

/** Implemented by @browser-os/browser (IsolatedWorlds); lets dom run helpers without importing browser. */
export interface HelperWorlds {
  registerHelper(name: string, source: string): void;
  evaluate<T>(cdpFrameId: string, fnSource: string, args?: unknown[]): Promise<T>;
  /** fnSource returns Element[]; resolves to their backendNodeIds (max 5). */
  evaluateElements(cdpFrameId: string, fnSource: string, args?: unknown[]): Promise<number[]>;
}

export interface HumanRequest {
  id: string; // req_...
  sessionId: string;
  taskId: string | null;
  reason: ChallengeKind | 'ambiguous' | 'failed';
  message: string;
  candidates?: { ref: string; role: string; name: string }[];
  observationId?: string;
  createdAt: number;
}

export type HumanAnswer =
  | { choice: 'ref'; ref: string; observationId: string }
  | { choice: 'done' }
  | { choice: 'abort' };

export interface ExecutionContext {
  sessionId: string;
  pageId: string;
  taskId: string | null;
  policy: Policy;
  params: Record<string, string>;
  secrets: SecretResolver;
  budget: Budget;
  signal: AbortSignal;
  clock: Clock;
}
