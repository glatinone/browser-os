import type { ModelProvider } from '@browser-os/protocol';
import { BosError } from '@browser-os/protocol';
import { buildResolvePrompt, RESOLVE_OUTPUT_SCHEMA, type ResolvePromptInput } from './prompts/resolve-target.js';

export interface ResolveResult {
  ref: string | null;
  confidence: number;
  usage: { inputTokens: number; outputTokens: number };
  retried: boolean;
}

export async function resolveWithModel(provider: ModelProvider, input: ResolvePromptInput): Promise<ResolveResult> {
  const candidates = new Set(input.candidates.map((candidate) => candidate.ref));
  const prompt = buildResolvePrompt(input);
  let retried = false;
  for (;;) {
    const response = await provider.complete(prompt);
    const parsed = parseResolve(response.json);
    if (parsed) {
      return {
        ref: parsed.ref && candidates.has(parsed.ref) ? parsed.ref : null,
        confidence: parsed.ref && candidates.has(parsed.ref) ? parsed.confidence : 0,
        usage: response.usage,
        retried,
      };
    }
    if (retried) throw new BosError('LLM_INVALID_OUTPUT', 'Model returned invalid target resolution output');
    retried = true;
  }
}

function parseResolve(value: unknown): { ref: string | null; confidence: number } | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { ref?: unknown; confidence?: unknown };
  if (!(candidate.ref === null || (typeof candidate.ref === 'string' && /^e\d+$/.test(candidate.ref)))) return null;
  if (typeof candidate.confidence !== 'number' || candidate.confidence < 0 || candidate.confidence > 1) return null;
  return { ref: candidate.ref, confidence: candidate.confidence };
}

void RESOLVE_OUTPUT_SCHEMA;
