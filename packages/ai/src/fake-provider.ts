import type { ModelProvider, ModelRequest, ModelResponse } from '@browser-os/protocol';

export type FakeResponse = ModelResponse['json'] | string | Error;
export type FakeResponder = (request: ModelRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeModelProviderOptions {
  responder: FakeResponder | FakeResponse;
  latencyMs?: number;
  now?: () => number;
  model?: string;
}

export class FakeModelProvider implements ModelProvider {
  readonly id = 'fake';
  readonly requests: ModelRequest[] = [];
  private readonly responder: FakeResponder;
  private readonly latencyMs: number;
  private readonly now: () => number;
  private readonly model: string;

  constructor(options: FakeModelProviderOptions) {
    this.responder =
      typeof options.responder === 'function' ? (options.responder as FakeResponder) : () => options.responder;
    this.latencyMs = options.latencyMs ?? 0;
    this.now = options.now ?? Date.now;
    this.model = options.model ?? 'fake';
  }

  get calls(): number {
    return this.requests.length;
  }

  reset(): void {
    this.requests.length = 0;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const started = this.now();
    await delay(this.latencyMs, signal);
    const response = await this.responder(request);
    if (response instanceof Error) throw response;
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    const json = typeof response === 'string' ? parseJson(response) : response;
    return {
      text,
      ...(json === undefined ? {} : { json }),
      usage: {
        inputTokens: Math.ceil(
          request.messages.reduce((size, message) => size + contentLength(message.content), request.system.length) / 4,
        ),
        outputTokens: Math.ceil(text.length / 4),
      },
      model: this.model,
      latencyMs: Math.max(0, this.now() - started),
    };
  }
}

export function truthResponder(truth: Record<string, string | null>): FakeResponder {
  return (request) => {
    const intent = request.messages
      .filter((message) => message.role === 'user')
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(' '),
      )
      .join('\n')
      .trim();
    return { ref: truth[intent] ?? null };
  };
}

function contentLength(content: ModelRequest['messages'][number]['content']): number {
  return typeof content === 'string'
    ? content.length
    : content.reduce((size, part) => size + (part.type === 'text' ? part.text.length : part.base64.length), 0);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
