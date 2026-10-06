import type { ModelContentPart, ModelProvider, ModelRequest, ModelResponse } from '@browser-os/protocol';
import { BosError } from '@browser-os/protocol';
import { postJson } from './http.js';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  supportsJsonSchema?: boolean;
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  fetch?: typeof globalThis.fetch;
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly options: OpenAiCompatibleOptions;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
    this.id = `openai-compatible:${options.model}`;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const apiKeyEnv = this.options.apiKeyEnv ?? 'OPENAI_API_KEY';
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey)
      throw new BosError('LLM_UNAVAILABLE', `Missing API key environment variable ${apiKeyEnv}`, { retryable: false });
    const system =
      this.options.supportsJsonSchema || !request.jsonSchema
        ? request.system
        : `${request.system}\nRespond with JSON only.`;
    const messages = [
      { role: 'system', content: system },
      ...request.messages.map((message) => ({ role: message.role, content: toOpenAiContent(message.content) })),
    ];
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      temperature: request.temperature,
      [this.options.maxTokensParam ?? 'max_tokens']: request.maxOutputTokens,
    };
    if (request.jsonSchema) {
      body.response_format = this.options.supportsJsonSchema
        ? { type: 'json_schema', json_schema: { name: request.purpose, schema: request.jsonSchema, strict: true } }
        : { type: 'json_object' };
    }
    const started = Date.now();
    const result = await postJson<OpenAiResponse>(
      `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
      },
      { timeoutMs: request.timeoutMs, signal },
    );
    const text = result.data.choices?.[0]?.message?.content ?? '';
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      /* preserve text for caller validation */
    }
    return {
      text,
      ...(json === undefined ? {} : { json }),
      usage: {
        inputTokens: result.data.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(messages).length / 4),
        outputTokens: result.data.usage?.completion_tokens ?? Math.ceil(text.length / 4),
      },
      model: this.options.model,
      latencyMs: Date.now() - started,
    };
  }
}

function toOpenAiContent(content: ModelRequest['messages'][number]['content']): unknown {
  if (typeof content === 'string') return content;
  return content.map((part: ModelContentPart) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.base64}` } },
  );
}
