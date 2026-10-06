import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serverFor(body: unknown): Promise<string> {
  const server = createServer((request, response) => {
    expect(request.headers['x-api-key']).toBe('anthropic-test-key');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('AnthropicProvider', () => {
  it('sends Anthropic headers and parses the first text blocks', async () => {
    process.env.ANTHROPIC_TEST_KEY = 'anthropic-test-key';
    const baseUrl = await serverFor({
      content: [{ type: 'text', text: '{"ref":"e2"}' }],
      usage: { input_tokens: 8, output_tokens: 2 },
    });
    const response = await new AnthropicProvider({
      baseUrl,
      model: 'claude-test',
      apiKeyEnv: 'ANTHROPIC_TEST_KEY',
    }).complete({
      purpose: 'resolve_target',
      tier: 'fast',
      system: 'JSON',
      messages: [{ role: 'user', content: 'pick' }],
      jsonSchema: { type: 'object' },
      maxOutputTokens: 100,
      temperature: 0,
      timeoutMs: 1000,
    });
    expect(response.json).toEqual({ ref: 'e2' });
    expect(response.usage).toEqual({ inputTokens: 8, outputTokens: 2 });
    delete process.env.ANTHROPIC_TEST_KEY;
  });

  it('does not call the endpoint without the configured key', async () => {
    delete process.env.ANTHROPIC_TEST_KEY;
    await expect(
      new AnthropicProvider({
        baseUrl: 'http://127.0.0.1:1',
        model: 'claude-test',
        apiKeyEnv: 'ANTHROPIC_TEST_KEY',
      }).complete({
        purpose: 'extract',
        tier: 'capable',
        system: '',
        messages: [],
        maxOutputTokens: 10,
        temperature: 0,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });
});
