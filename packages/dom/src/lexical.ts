import type { SemanticElement } from '@browser-os/protocol';
import { dice, normalizeName, parseIntent, tokenize } from './normalize.js';

export interface RankedElement {
  element: SemanticElement;
  score: number;
}

export interface LexicalDecision {
  element: SemanticElement;
}

export interface LexicalFailure {
  reason: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS';
}

export function lexicalRank(elements: SemanticElement[], intent: string, _actionType?: string): RankedElement[] {
  const parsed = parseIntent(intent);
  const intentTokens = parsed.tokens;
  return elements
    .map((element, index) => ({ element, score: scoreElement(element, parsed, intentTokens), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ element, score }) => ({ element, score }));
}

export function lexicalDecision(
  ranked: RankedElement[],
  thresholds: { accept?: number; margin?: number } = {},
): LexicalDecision | LexicalFailure {
  const accept = thresholds.accept ?? 0.75;
  const margin = thresholds.margin ?? 0.15;
  const best = ranked[0];
  if (!best || best.score < accept) return { reason: 'TARGET_NOT_FOUND' };
  const next = ranked[1]?.score ?? 0;
  if (best.score - next < margin) return { reason: 'TARGET_AMBIGUOUS' };
  return { element: best.element };
}

function scoreElement(
  element: SemanticElement,
  parsed: ReturnType<typeof parseIntent>,
  intentTokens: string[],
): number {
  const nameN = normalizeName(element.name);
  const exactScore = parsed.exact !== null && nameN === normalizeName(parsed.exact) ? 1 : 0;
  const nameScore =
    exactScore || (intentTokens.length && intentTokens.join(' ') === nameN ? 1 : dice(intentTokens, tokenize(nameN)));
  const auxScore = Math.max(
    dice(intentTokens, tokenize(element.placeholder ?? '')),
    dice(intentTokens, tokenize(element.description ?? '')),
  );
  const roleScore = parsed.roleHints.length === 0 ? 0.5 : parsed.roleHints.includes(element.role) ? 1 : 0;
  const contextScore = Math.max(...element.context.map((context) => dice(intentTokens, tokenize(context))), 0);
  const viewScore = element.inViewport ? 1 : 0;
  let score = 0.55 * nameScore + 0.15 * auxScore + 0.2 * roleScore + 0.05 * contextScore + 0.05 * viewScore;
  if (parsed.exact !== null && nameN !== normalizeName(parsed.exact)) score = Math.min(score, 0.5);
  if (
    parsed.searchBonus &&
    (nameN.includes('search') ||
      (element.placeholder ?? '').toLowerCase().includes('search') ||
      element.role === 'searchbox')
  )
    score = Math.min(1, score + 0.1);
  return score;
}
