import { DEFAULT_POLICY, type ExecutionContext, type Policy } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import { budgetAvailable, consumeLlmCall, createExecutionContext } from '../src/router/context.js';

function expectBudgetError(fn: () => void, matcher: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { name?: string })?.name).toBe('BosError');
  expect((thrown as { code?: string })?.code).toBe('BUDGET_EXCEEDED');
  expect((thrown as { message?: string })?.message).toMatch(matcher);
}

function policy(overrides: Partial<Policy['budgets']> = {}, taskId: string | null = 'tsk_1'): ExecutionContext {
  const controller = new AbortController();
  return createExecutionContext({
    sessionId: 'ses_1',
    pageId: 'page_1',
    taskId,
    policy: { ...DEFAULT_POLICY, budgets: { ...DEFAULT_POLICY.budgets, ...overrides } },
    secrets: { resolve: async () => 'x' },
    clock: { now: () => 0 },
    signal: controller.signal,
  });
}

describe('execution budget', () => {
  it('seeds from policy and starts every counter at zero', () => {
    const ctx = policy({ maxLlmCallsPerAction: 3, maxLlmCallsPerTask: 7 });
    expect(ctx.budget).toEqual({
      llmCallsAction: 0,
      llmCallsActionMax: 3,
      llmCallsTask: 0,
      llmCallsTaskMax: 7,
      deadline: DEFAULT_POLICY.budgets.actionTimeoutMs,
    });
    expect(ctx.params).toEqual({});
    expect(budgetAvailable(ctx)).toBe(true);
  });

  it('has no task ceiling when there is no task', () => {
    const ctx = policy({ maxLlmCallsPerAction: 10, maxLlmCallsPerTask: 7 }, null);
    expect(ctx.taskId).toBeNull();
    expect(ctx.budget.llmCallsTaskMax).toBe(Number.POSITIVE_INFINITY);
    // Spend past the per-task limit: only the per-action cap can stop it.
    for (let i = 0; i < 5; i += 1) consumeLlmCall(ctx);
    expect(ctx.budget.llmCallsTask).toBe(5);
    expect(budgetAvailable(ctx)).toBe(true);
  });

  it('spends both counters together and stops at the per-action cap', () => {
    const ctx = policy({ maxLlmCallsPerAction: 2, maxLlmCallsPerTask: 20 });
    consumeLlmCall(ctx);
    consumeLlmCall(ctx);
    expect(ctx.budget).toMatchObject({ llmCallsAction: 2, llmCallsTask: 2 });

    expect(budgetAvailable(ctx)).toBe(false);
    expectBudgetError(() => consumeLlmCall(ctx), /budget for this action/);
    // The failed attempt must not silently spend more of the task's allowance.
    expect(ctx.budget.llmCallsTask).toBe(2);
  });

  it('stops at the per-task cap even when the per-action cap is higher', () => {
    const ctx = policy({ maxLlmCallsPerAction: 50, maxLlmCallsPerTask: 2 });
    consumeLlmCall(ctx);
    consumeLlmCall(ctx);
    expect(budgetAvailable(ctx)).toBe(false);
    expectBudgetError(() => consumeLlmCall(ctx), /budget for this task is spent \(max 2\)/);
  });

  it('refuses once the deadline has passed', () => {
    let now = 0;
    const controller = new AbortController();
    const ctx = createExecutionContext({
      sessionId: 'ses_1',
      pageId: 'page_1',
      taskId: 'tsk_1',
      policy: DEFAULT_POLICY,
      secrets: { resolve: async () => 'x' },
      clock: { now: () => now },
      signal: controller.signal,
    });

    now = DEFAULT_POLICY.budgets.actionTimeoutMs;
    expect(budgetAvailable(ctx)).toBe(false);
    expectBudgetError(() => consumeLlmCall(ctx), /deadline passed/);

    now = 0;
    expect(budgetAvailable(ctx)).toBe(true);
  });

  it('refuses when the run was aborted', () => {
    const controller = new AbortController();
    const ctx = createExecutionContext({
      sessionId: 'ses_1',
      pageId: 'page_1',
      policy: DEFAULT_POLICY,
      secrets: { resolve: async () => 'x' },
      clock: { now: () => 0 },
      signal: controller.signal,
    });
    controller.abort();
    expect(budgetAvailable(ctx)).toBe(false);
    expectBudgetError(() => consumeLlmCall(ctx), /aborted/);
  });
});
