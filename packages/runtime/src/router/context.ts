import type { Clock, ExecutionContext, Policy, SecretResolver } from '@browser-os/protocol';
import { BosError } from '@browser-os/protocol';

export interface ExecutionContextInput {
  sessionId: string;
  pageId: string;
  taskId?: string | null;
  policy: Policy;
  params?: Record<string, string>;
  secrets: SecretResolver;
  clock: Clock;
  signal: AbortSignal;
}

/**
 * Build the context every tier shares (data-models §8). The budget is seeded
 * from the policy: per-action counters start at zero on every `execute()`, and
 * the task counter has no ceiling outside a task.
 */
export function createExecutionContext(input: ExecutionContextInput): ExecutionContext {
  const taskId = input.taskId ?? null;
  return {
    sessionId: input.sessionId,
    pageId: input.pageId,
    taskId,
    policy: input.policy,
    params: input.params ?? {},
    secrets: input.secrets,
    budget: {
      llmCallsAction: 0,
      llmCallsActionMax: input.policy.budgets.maxLlmCallsPerAction,
      llmCallsTask: 0,
      llmCallsTaskMax: taskId === null ? Number.POSITIVE_INFINITY : input.policy.budgets.maxLlmCallsPerTask,
      deadline: input.clock.now() + input.policy.budgets.actionTimeoutMs,
    },
    signal: input.signal,
    clock: input.clock,
  };
}

export function budgetAvailable(ctx: ExecutionContext): boolean {
  return budgetBlocker(ctx) === null;
}

/**
 * Spend one LLM call against both counters. Throws `BUDGET_EXCEEDED` rather
 * than silently clamping, so a tier that keeps trying past its budget fails
 * the action instead of quietly burning the task's allowance.
 */
export function consumeLlmCall(ctx: ExecutionContext): void {
  const blocker = budgetBlocker(ctx);
  if (blocker !== null) throw new BosError('BUDGET_EXCEEDED', blocker);
  ctx.budget.llmCallsAction += 1;
  ctx.budget.llmCallsTask += 1;
}

/** Returns why the budget is spent, or null when a call may proceed. */
function budgetBlocker(ctx: ExecutionContext): string | null {
  const { budget, clock } = ctx;
  if (ctx.signal.aborted) return 'aborted before the LLM call';
  if (clock.now() >= budget.deadline) return 'action deadline passed';
  if (budget.llmCallsAction >= budget.llmCallsActionMax) {
    return `LLM budget for this action is spent (max ${budget.llmCallsActionMax})`;
  }
  if (budget.llmCallsTask >= budget.llmCallsTaskMax) {
    return `LLM budget for this task is spent (max ${budget.llmCallsTaskMax})`;
  }
  return null;
}
