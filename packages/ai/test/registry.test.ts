import { describe, expect, it } from 'vitest';
import { ModelRegistry } from '../src/registry.js';

describe('ModelRegistry', () => {
  it('creates configured providers and leaves missing tiers disabled', () => {
    const registry = ModelRegistry.fromConfig({
      fast: { provider: 'fake', model: 'fixture', latencyMs: 2 },
      capable: { provider: 'openai-compatible', model: 'local', baseUrl: 'http://127.0.0.1:1/v1' },
      vision: null,
    });
    expect(registry.get('fast')?.id).toBe('fake');
    expect(registry.get('capable')?.id).toBe('openai-compatible:local');
    expect(registry.get('vision')).toBeNull();
  });

  it('rejects malformed provider configuration at the edge', () => {
    expect(() => ModelRegistry.fromConfig({ fast: { provider: 'unknown' } })).toThrow();
  });
});
