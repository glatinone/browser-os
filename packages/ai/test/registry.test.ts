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

  it('creates an anthropic provider for the anthropic kind', () => {
    const registry = ModelRegistry.fromConfig({
      fast: { provider: 'anthropic', model: 'claude-test', baseUrl: 'https://anthropic.test/v1' },
    });
    expect(registry.get('fast')?.id).toBe('anthropic:claude-test');
  });

  it('reports a tier that is absent from the config as null', () => {
    const registry = ModelRegistry.fromConfig({ fast: { provider: 'fake', model: 'x' } });
    expect(registry.get('fast')).not.toBeNull();
    expect(registry.get('capable')).toBeNull();
    expect(registry.get('vision')).toBeNull();
  });

  it('rejects malformed provider configuration with INVALID_REQUEST and a readable message', () => {
    let thrown: unknown;
    try {
      ModelRegistry.fromConfig({ fast: { provider: 'unknown' } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { name?: string }).name).toBe('BosError');
    expect((thrown as { code?: string }).code).toBe('INVALID_REQUEST');
    // The message has to name the offending path, not just say "invalid".
    expect((thrown as { message?: string }).message).toContain('fast');
    expect((thrown as { message?: string }).message).toContain('invalid models config');
  });

  it('carries the structured zod issues for callers that want them', () => {
    try {
      ModelRegistry.fromConfig({ fast: { provider: 'nope', model: 7 } });
      throw new Error('expected fromConfig to throw');
    } catch (error) {
      const issues: unknown = (error as { details?: { issues?: unknown } }).details?.issues ?? null;
      expect(Array.isArray(issues)).toBe(true);
      if (Array.isArray(issues)) expect(issues.length).toBeGreaterThan(0);
    }
  });
});
