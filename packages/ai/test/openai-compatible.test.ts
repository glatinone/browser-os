import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/openai-compatible.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function localServer(
  handler: (body: unknown, headers: Record<string, string | string[] | undefined>) => unknown,
): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const result = handler(body, request.headers);
    const normalized =
      result && typeof result === 'object' && 'body' in result
        ? (result as { status?: number; body: unknown })
        : { body: result };
    response.statusCode = normalized.status ?? 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(normalized.body));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}/v1`;
}

const request = {
  purpose: 'resolve_target' as const,
  tier: 'fast' as const,
  system: 'Return JSON',
  messages: [{ role: 'user' as const, content: 'choose e1' }],
  jsonSchema: { type: 'object' },
  maxOutputTokens: 100,
  temperature: 0,
  timeoutMs: 1000,
};

describe('OpenAI-compatible provider', () => {
  it('sends the contract and parses JSON without exposing the key in the body', async () => {
    process.env.BROWSER_OS_TEST_KEY = 'test-secret';
    let seenBody: unknown;
    const url = await localServer((body, headers) => {
      seenBody = body;
      expect(headers.authorization).toBe('Bearer test-secret');
      return { choices: [{ message: { content: '{"ref":"e1"}' } }], usage: { prompt_tokens: 4, completion_tokens: 3 } };
    });
    const response = await new OpenAiCompatibleProvider({
      baseUrl: url,
      model: 'local-model',
      apiKeyEnv: 'BROWSER_OS_TEST_KEY',
      supportsJsonSchema: true,
    }).complete(request);
    expect(response.json).toEqual({ ref: 'e1' });
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 3 });
    expect(JSON.stringify(seenBody)).not.toContain('test-secret');
    delete process.env.BROWSER_OS_TEST_KEY;
  });

  it('uses json_object fallback and preserves malformed response text', async () => {
    process.env.BROWSER_OS_TEST_KEY = 'test-secret';
    const url = await localServer((body) => {
      expect(JSON.stringify(body)).toContain('Respond with JSON only.');
      return { choices: [{ message: { content: 'not json' } }] };
    });
    const response = await new OpenAiCompatibleProvider({
      baseUrl: url,
      model: 'local-model',
      apiKeyEnv: 'BROWSER_OS_TEST_KEY',
    }).complete(request);
    expect(response.text).toBe('not json');
    expect(response.json).toBeUndefined();
    delete process.env.BROWSER_OS_TEST_KEY;
  });

  it('fails without a key and retries transient server errors', async () => {
    delete process.env.BROWSER_OS_TEST_KEY;
    const url = await localServer(() => ({ error: 'should not be called' }));
    await expect(
      new OpenAiCompatibleProvider({ baseUrl: url, model: 'local' }).complete(request),
    ).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });

    process.env.BROWSER_OS_TEST_KEY = 'test-secret';
    let calls = 0;
    const retryUrl = await localServer(() => {
      calls += 1;
      return calls < 3
        ? { status: 503, body: { error: 'busy' } }
        : { body: { choices: [{ message: { content: '{}' } }] } };
    });
    await new OpenAiCompatibleProvider({
      baseUrl: retryUrl,
      model: 'local',
      apiKeyEnv: 'BROWSER_OS_TEST_KEY',
    }).complete(request);
    expect(calls).toBe(3);
    delete process.env.BROWSER_OS_TEST_KEY;
  });
});
