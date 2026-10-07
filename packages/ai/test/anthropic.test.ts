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

  it('appends the schema instruction to system only when jsonSchema is set', async () => {
    process.env.ANTHROPIC_TEST_KEY = 'anthropic-test-key';
    const seenSystems: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { system: string };
        seenSystems.push(body.system);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const provider = () => new AnthropicProvider({ baseUrl, model: 'claude-test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' });
    const base = {
      purpose: 'resolve_target' as const,
      tier: 'fast' as const,
      messages: [{ role: 'user' as const, content: 'pick' }],
      maxOutputTokens: 100,
      temperature: 0,
      timeoutMs: 1000,
    };

    await provider().complete({ ...base, system: 'Choose an element.', jsonSchema: { type: 'object' } });
    await provider().complete({ ...base, system: 'Choose an element.' });

    expect(seenSystems[0]).toContain('Respond with a single JSON object matching this schema');
    expect(seenSystems[0]).toContain('{"type":"object"}');
    expect(seenSystems[0]).toContain('Choose an element.');
    // Without a schema the system prompt is passed through untouched.
    expect(seenSystems[1]).toBe('Choose an element.');

    server.closeAllConnections?.();
    delete process.env.ANTHROPIC_TEST_KEY;
  });

  it('retries a 529 overloaded error through the shared http helper', async () => {
    process.env.ANTHROPIC_TEST_KEY = 'anthropic-test-key';
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.setHeader('content-type', 'application/json');
      if (calls === 1) {
        response.statusCode = 529;
        response.end(JSON.stringify({ error: { type: 'overloaded_error' } }));
        return;
      }
      response.end(
        JSON.stringify({
          content: [{ type: 'text', text: '{"ref":"e1"}' }],
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
      );
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');

    const response = await new AnthropicProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: 'claude-test',
      apiKeyEnv: 'ANTHROPIC_TEST_KEY',
    }).complete({
      purpose: 'resolve_target',
      tier: 'fast',
      system: 'JSON',
      messages: [{ role: 'user', content: 'pick' }],
      maxOutputTokens: 100,
      temperature: 0,
      timeoutMs: 2000,
    });

    expect(calls).toBe(2);
    expect(response.json).toEqual({ ref: 'e1' });

    server.closeAllConnections?.();
    delete process.env.ANTHROPIC_TEST_KEY;
  });
});
