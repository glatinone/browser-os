// Tier 3, LLM (action-router §5.2). A fast model picks one ref from compressed
// candidates; its output is validated against the candidate list before it may
// become a resolution. Lives beside the intent ladder, not in the router: the
// P7-02 router core carries no ModelsPort. The ladder calls this after the
// deterministic tier fails.

import { resolveWithModel } from '@browser-os/ai';
import type { IndexEntry, Observation, SemanticElement, TierAttempt } from '@browser-os/protocol';
import type { ModelsPort } from './types.js';

export interface ResolveLlmInput {
  actionType: string;
  intent: string;
  observation: Observation;
  /** The observation index the candidates came from; the resolved ref is looked up here. */
  index: { entries: Map<string, IndexEntry> };
  /** Lexical-ranked elements (from the deterministic tier). Top-K comes from here. */
  ranked: Array<{ element: SemanticElement; score: number }>;
  models: ModelsPort | null;
  /** From DEFAULT_ROUTER_CONSTANTS with per-construction override. */
  constants: { llmCandidates: number; llmMinConfidence: number };
  attempts: TierAttempt[];
  /** Increments action+task LLM counters; throws BosError('BUDGET_EXCEEDED'). */
  consumeLlmCall: () => void;
}

/**
 * §5.2 llmResolve. Returns the matched IndexEntry, or null so the ladder
 * continues to the human tier. Never throws for "the model was unsure":
 * only the budget counter throws, and that happens before the call.
 */
export async function resolveWithLlm(input: ResolveLlmInput): Promise<IndexEntry | null> {
  const { actionType, intent, observation, index, ranked, models, constants, attempts, consumeLlmCall } = input;

  // A ModelsPort exposes get(tier); anything else (e.g. a bare provider handed
  // in by an older test harness) disables the tier rather than crashing it.
  let provider: ReturnType<NonNullable<ModelsPort['get']>> | null = null;
  try {
    provider = typeof models?.get === 'function' ? (models.get('fast') ?? null) : null;
  } catch {
    provider = null;
  }
  if (!provider) {
    attempts.push({ tier: 'llm', ok: false, ms: 0, reason: 'LLM_DISABLED' });
    return null;
  }

  const candidates = topKWithViewportFill(observation.elements, ranked, constants.llmCandidates);
  if (candidates.length === 0) {
    attempts.push({ tier: 'llm', ok: false, ms: 0, reason: 'ACTION_FAILED' });
    return null;
  }

  // Budget is consumed only for the call that is actually made (§5.2). A
  // BUDGET_EXCEEDED throw here is the ladder's signal to move on to human.
  consumeLlmCall();

  const t0 = Date.now();
  // §5.2: an unparsable answer after one retry is LLM_INVALID_OUTPUT; the
  // ladder treats any model failure the same way: tier failed, continue to
  // human (§4.1 keeps execute() non-throwing).
  let result: Awaited<ReturnType<typeof resolveWithModel>>;
  try {
    result = await resolveWithModel(provider, {
      actionType,
      intent,
      url: observation.url,
      title: observation.title,
      dialogs: observation.dialogs,
      candidates: candidates.map((c) => c.element),
    });
  } catch {
    attempts.push({ tier: 'llm', ok: false, ms: Date.now() - t0, reason: 'ACTION_FAILED' });
    return null;
  }

  // §5.2: `ref == null` or a ref outside the candidate list is no match, and
  // the model output never becomes a selector on its own.
  if (result.ref === null || !candidates.some((c) => c.element.ref === result.ref)) {
    attempts.push({
      tier: 'llm',
      ok: false,
      ms: Date.now() - t0,
      reason: result.ref === null ? 'ACTION_FAILED' : 'ACTION_FAILED',
    });
    return null;
  }
  if (result.confidence < constants.llmMinConfidence) {
    attempts.push({ tier: 'llm', ok: false, ms: Date.now() - t0, reason: 'ACTION_FAILED' });
    return null;
  }

  const entry = index.entries.get(result.ref);
  if (!entry) {
    attempts.push({ tier: 'llm', ok: false, ms: Date.now() - t0, reason: 'ACTION_FAILED' });
    return null;
  }

  attempts.push({ tier: 'llm', ok: true, ms: Date.now() - t0 });
  return entry;
}

/** §5.2 candidate selection: top-K by lexical score, viewport fill for zero-score slots. */
export function topKWithViewportFill(
  elements: SemanticElement[],
  ranked: Array<{ element: SemanticElement; score: number }>,
  k: number,
): Array<{ element: SemanticElement; score: number }> {
  const positive = ranked.filter((entry) => entry.score > 0).slice(0, k);
  if (positive.length >= k) return positive;
  const chosen = new Set(positive.map((entry) => entry.element.ref));
  for (const element of elements) {
    if (positive.length >= k) break;
    if (chosen.has(element.ref) || !element.inViewport) continue;
    positive.push({ element, score: 0 });
    chosen.add(element.ref);
  }
  return positive;
}
