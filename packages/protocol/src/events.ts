// Every observability signal flows through one event type (data-models §10).
//
// Field names follow OpenTelemetry semantic style so an exporter can be added
// later without renaming (ADR-015).
//
// Invariant (tested): no event payload may contain a resolved secret value or the
// value of a sensitive field. Masking follows specs/integration.md §2 — one regex
// in mask.ts, used by maskAction() and every emitter.

import type { ActionResult, BrowserAction, TierAttempt } from './actions.js';
import type { SessionStatus } from './browser.js';
import type { ChallengeKind } from './dom.js';
import type { ModelPurpose } from './model.js';
import type { PermissionDecisionRecord, PermissionRequest } from './policy.js';
import type { Task } from './tasks.js';

export interface EventEnvelope<T extends string, D> {
  ts: number;
  type: T;
  sessionId?: string;
  taskId?: string;
  data: D;
}

export type BosEvent =
  | EventEnvelope<'session.status', { status: SessionStatus; reason?: string }>
  | EventEnvelope<
      'observation.captured',
      {
        observationId: string;
        url: string;
        elements: number;
        domNodes: number;
        captureMs: number;
        buildMs: number;
        estTokens: number;
      }
    >
  | EventEnvelope<'action.started', { actionId: string; action: BrowserAction }>
  | EventEnvelope<'action.tier', { actionId: string; attempt: TierAttempt }>
  | EventEnvelope<'action.completed', { actionId: string; result: ActionResult }>
  | EventEnvelope<
      'model.call',
      { purpose: ModelPurpose; model: string; ms: number; inputTokens: number; outputTokens: number; ok: boolean }
    >
  | EventEnvelope<'cache.hit' | 'cache.miss' | 'cache.write' | 'cache.invalidate', { key: string; reason?: string }>
  | EventEnvelope<'task.started' | 'task.completed' | 'task.failed', { task: Task }>
  | EventEnvelope<'trajectory.healed', { trajectoryId: string; step: number; newVersion: number }>
  | EventEnvelope<'human.required', { reason: ChallengeKind | 'ambiguous' | 'failed'; message: string }>
  | EventEnvelope<'human.resolved', { outcome: 'resumed' | 'aborted' }>
  | EventEnvelope<'permission.requested', { request: PermissionRequest }>
  | EventEnvelope<'permission.decided', { record: PermissionDecisionRecord }>
  | EventEnvelope<'page.navigated', { pageId: string; url: string }>
  | EventEnvelope<'download.completed', { pageId: string; path: string }>;

export type BosEventType = BosEvent['type'];
