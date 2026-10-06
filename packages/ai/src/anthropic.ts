import type { ModelContentPart, ModelProvider, ModelRequest, ModelResponse } from '@browser-os/protocol';
import { BosError } from '@browser-os/protocol';
import { postJson } from './http.js';

export interface AnthropicProviderOptions {
  baseUrl?: string;
  model: string;
  apiKeyEnv?: string;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly options: AnthropicProviderOptions;

  constructor(options: AnthropicProviderOptions) {
    this.options = options;
    this.id = `anthropic:${options.model}`;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const apiKeyEnv = this.options.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new BosError('LLM_UNAVAILABLE', `Missing API key environment variable ${apiKeyEnv}`);
    const system = request.jsonSchema
      ? `${request.system}\nRespond with a single JSON object matching this schema: ${JSON.stringify(request.jsonSchema)}`
      : request.system;
    const body = {
      model: this.options.model,
      system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: toAnthropicContent(message.content),
      })),
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
    };
    const started = Date.now();
    const result = await postJson<AnthropicResponse>(
      `${(this.options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`,
      {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body,
      },
      { timeoutMs: request.timeoutMs, retryStatuses: new Set([429, 500, 502, 503, 504, 529]), signal },
    );
    const text =
      result.data.content
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('') ?? '';
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      /* preserve text */
    }
    return {
      text,
      ...(json === undefined ? {} : { json }),
      usage: {
        inputTokens: result.data.usage?.input_tokens ?? Math.ceil(JSON.stringify(body.messages).length / 4),
        outputTokens: result.data.usage?.output_tokens ?? Math.ceil(text.length / 4),
      },
      model: this.options.model,
      latencyMs: Date.now() - started,
    };
  }
}

function toAnthropicContent(content: ModelRequest['messages'][number]['content']): unknown {
  if (typeof content === 'string') return content;
  return content.map((part: ModelContentPart) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.base64 } },
  );
}
