// Model provider vocabulary (data-models §9). Vendor details never appear here.

export type ModelTier = 'fast' | 'capable' | 'vision';
export type ModelPurpose = 'resolve_target' | 'extract' | 'vision_locate';

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string | ModelContentPart[];
}

export interface ModelRequest {
  purpose: ModelPurpose;
  tier: ModelTier;
  system: string;
  messages: ModelMessage[];
  jsonSchema?: Record<string, unknown>; // when set, provider must return JSON matching it
  maxOutputTokens: number;
  temperature: number; // 0 for resolution
  timeoutMs: number;
}

export interface ModelResponse {
  text: string;
  json?: unknown; // parsed when jsonSchema was set (still validated by caller with zod)
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  latencyMs: number;
}

export interface ModelProvider {
  readonly id: string; // e.g. "openai-compatible:gpt-x", "anthropic:claude-x", "fake"
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
