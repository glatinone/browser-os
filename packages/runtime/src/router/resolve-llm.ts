import { type ResolvePromptInput, resolveWithModel } from '@browser-os/ai';
import { lexicalRank } from '@browser-os/dom';
import type { ModelProvider, Observation, ObservationIndex, SemanticElement, TierAttempt } from '@browser-os/protocol';
import { buildResolution, type Resolution } from './types.js';

export interface ResolveLlmInput {
  actionType: string;
  intent: string;
  observation: Observation;
  index: ObservationIndex;
  /** `null` when the registry has no `fast` model — treated as `LLM_DISABLED`. */
  model: ModelProvider | null;
  /** `policy.tiers.llm`. */
  enabled: boolean;
  /**
   * Both counters are consumed per §5.2: `llmCallsAction` resets every `execute()`,
   * `llmCallsTask` is shared across a task (action-router §4 step B / memory §4).
   */
  budget: {
    llmCallsAction: number;
    llmCallsActionMax: number;
    llmCallsTask: number;
    llmCallsTaskMax: number;
  };
  constants: { llmCandidates: number; llmMinConfidence: number };
  /** Memoised prompt input, so tests and the caller can assert on what was sent. */
  onPrompt?: (prompt: ResolvePromptInput) => void;
}

export type LlmTierOutcome =
  | { outcome: 'resolved'; resolution: Resolution }
  | { outcome: 'skipped'; reason: 'LLM_DISABLED' | 'BUDGET_EXCEEDED' }
  | { outcome: 'no-decision' };

/**
 * Tier 3 — LLM tier (action-router §5.2).
 *
 * Selects the candidate set (`topK` by lexical score with viewport fill), builds the §5.2.1
 * prompt, calls the model once, validates the answer against the candidates that were sent,
 * and returns a `Resolution` at tier `llm` only when the model is confident.
 *
 * Never runs when the tier is disabled, when no `fast` model is registered, or when either
 * budget is spent — those paths push a `LLM_DISABLED` / `BUDGET_EXCEEDED` attempt and return
 * `skipped`, so the caller falls through to tier 4 (vision, MVP: null) and tier 5 (human).
 *
 * Model output never becomes a selector: `resolveWithModel` already rejects any `ref` that
 * was not in the candidate list (SECURITY.md §9 "Output contract").
 */
export async function resolveLlmTier(input: ResolveLlmInput, attempts: TierAttempt[]): Promise<LlmTierOutcome> {
  const { actionType, intent, observation, index, model, enabled, budget, constants } = input;

  if (!enabled || !model) {
    attempts.push({ tier: 'llm', ok: false, ms: 0, reason: 'LLM_DISABLED' });
    return { outcome: 'skipped', reason: 'LLM_DISABLED' };
  }
  if (budget.llmCallsAction >= budget.llmCallsActionMax || budget.llmCallsTask >= budget.llmCallsTaskMax) {
    attempts.push({ tier: 'llm', ok: false, ms: 0, reason: 'BUDGET_EXCEEDED' });
    return { outcome: 'skipped', reason: 'BUDGET_EXCEEDED' };
  }

  const candidates = selectCandidates(observation, intent, actionType, constants.llmCandidates);

  const promptInput: ResolvePromptInput = {
    actionType,
    intent,
    url: observation.url,
    title: observation.title,
    dialogs: observation.dialogs,
    candidates,
  };
  input.onPrompt?.(promptInput);

  const startedAt = Date.now();
  const result = await resolveWithModel(model, promptInput);
  const ms = Date.now() - startedAt;

  // Budget is consumed by the call itself, successful decision or not (§5.2).
  budget.llmCallsAction += 1;
  budget.llmCallsTask += 1;

  attempts.push({
    tier: 'llm',
    ok: result.ref !== null && result.confidence >= constants.llmMinConfidence,
    ms,
    candidates: candidates.length,
    score: result.confidence,
  });

  if (result.ref === null || result.confidence < constants.llmMinConfidence) {
    return { outcome: 'no-decision' };
  }

  const entry = index.entries.get(result.ref);
  if (!entry) return { outcome: 'no-decision' }; // not in the observation → never a selector

  return { outcome: 'resolved', resolution: buildResolution('llm', observation, result.ref, entry) };
}

/**
 * §5.2 candidate selection: rank lexically, keep the top-K that scored above zero, and if
 * fewer than K scored, fill with `inViewport` elements in document order. The fill matters
 * when the lexical ranker scores everything zero (a page whose labels do not match the
 * intent) — the model still needs something to choose from, and viewport elements are the
 * ones a human would point at.
 */
export function selectCandidates(
  observation: Observation,
  intent: string,
  actionType: string,
  k: number,
): SemanticElement[] {
  const ranked = lexicalRank(observation.elements, intent, actionType);

  const chosen: SemanticElement[] = [];
  const seen = new Set<string>();
  for (const { element, score } of ranked) {
    if (chosen.length >= k) break;
    if (score <= 0) break; // ranked desc; everything after is zero
    chosen.push(element);
    seen.add(element.ref);
  }

  if (chosen.length < k) {
    for (const element of observation.elements) {
      if (chosen.length >= k) break;
      if (element.inViewport && !seen.has(element.ref)) {
        chosen.push(element);
        seen.add(element.ref);
      }
    }
  }
  return chosen;
}
