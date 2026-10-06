import type { ModelRequest } from '@browser-os/protocol';
import { describe, expect, it, vi } from 'vitest';
import { FakeModelProvider, truthResponder } from '../src/fake-provider.js';

const request: ModelRequest = {
  purpose: 'resolve_target',
  tier: 'fast',
  system: 'system',
  messages: [{ role: 'user', content: 'the submit button' }],
  maxOutputTokens: 100,
  temperature: 0,
  timeoutMs: 1000,
};

describe('FakeModelProvider', () => {
  it('records requests, parses JSON, and estimates usage', async () => {
    const provider = new FakeModelProvider({ responder: { ref: 'e1' } });
    const response = await provider.complete(request);
    expect(provider.calls).toBe(1);
    expect(provider.requests[0]).toEqual(request);
    expect(response.json).toEqual({ ref: 'e1' });
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
  });

  it('keeps plain text and reports malformed JSON without losing it', async () => {
    const provider = new FakeModelProvider({ responder: 'not-json' });
    const response = await provider.complete(request);
    expect(response.text).toBe('not-json');
    expect(response.json).toBeUndefined();
  });

  it('supports fake latency and propagates responder errors', async () => {
    vi.useFakeTimers();
    const provider = new FakeModelProvider({ latencyMs: 800, responder: { ok: true } });
    const pending = provider.complete(request);
    await vi.advanceTimersByTimeAsync(799);
    expect(await Promise.race([pending.then(() => 'done'), Promise.resolve('pending')])).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ json: { ok: true } });
    vi.useRealTimers();

    await expect(new FakeModelProvider({ responder: new Error('model failed') }).complete(request)).rejects.toThrow(
      'model failed',
    );
  });

  it('resolves intents from a truth map and can reset calls', async () => {
    const provider = new FakeModelProvider({ responder: truthResponder({ 'the submit button': 'e7', unknown: null }) });
    await expect(provider.complete(request)).resolves.toMatchObject({ json: { ref: 'e7' } });
    provider.reset();
    expect(provider.calls).toBe(0);
  });
});
