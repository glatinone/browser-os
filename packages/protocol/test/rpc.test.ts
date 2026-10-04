import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BosError,
  ConfigSchema,
  DEFAULT_POLICY,
  JSONRPC_INVALID_PARAMS,
  JsonRpcErrorSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
  PROTOCOL_VERSION,
  RPC_ERROR_CODE,
  RPC_METHOD_NAMES,
  RPC_METHODS,
  toRpcError,
} from '../src/index.js';

/** Every method in specs/protocol.md §4. This list IS the contract. */
const PROTOCOL_METHODS = [
  'system.hello',
  'system.shutdown',
  'profile.create',
  'profile.list',
  'profile.delete',
  'profile.openManual',
  'session.open',
  'session.list',
  'session.get',
  'session.close',
  'session.reconnect',
  'page.list',
  'page.new',
  'page.select',
  'page.close',
  'observe',
  'act',
  'upload',
  'task.start',
  'task.end',
  'task.run',
  'task.get',
  'task.list',
  'trajectory.list',
  'trajectory.get',
  'trajectory.delete',
  'trajectory.export',
  'trajectory.import',
  'cache.list',
  'cache.clear',
  'human.pending',
  'human.resume',
  'permission.pending',
  'permission.decide',
  'stats.get',
  'events.subscribe',
];

describe('RPC_METHODS', () => {
  it('contains exactly the 36 methods of protocol §4', () => {
    expect([...RPC_METHOD_NAMES].sort()).toEqual([...PROTOCOL_METHODS].sort());
  });

  it('gives every method a zod params schema and a zod result schema', () => {
    for (const name of RPC_METHOD_NAMES) {
      const def = RPC_METHODS[name];
      expect(def.params, `${name}.params`).toBeInstanceOf(z.ZodType);
      expect(def.result, `${name}.result`).toBeInstanceOf(z.ZodType);
      expect(typeof def.params.safeParse, `${name}.params.safeParse`).toBe('function');
      expect(typeof def.result.safeParse, `${name}.result.safeParse`).toBe('function');
    }
  });

  it('accepts an empty object for every params schema that documents no required field', () => {
    // Methods with no required params must tolerate `{}` — the daemon passes the
    // parsed object through, not the raw request.
    const empty = ['system.shutdown', 'profile.list', 'trajectory.list'] as const;
    for (const name of empty) expect(RPC_METHODS[name].params.safeParse({}).success, name).toBe(true);

    const needsInput = ['act', 'observe', 'session.open', 'task.run'] as const;
    for (const name of needsInput) expect(RPC_METHODS[name].params.safeParse({}).success, name).toBe(false);
  });
});

describe('PROTOCOL_VERSION', () => {
  it('is the string "1"', () => {
    expect(PROTOCOL_VERSION).toBe('1');
  });
});

describe('wire envelopes', () => {
  it('validates a request, a success, an error and an event notification', () => {
    expect(
      JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'observe', params: { sessionId: 's' } }).success,
    ).toBe(true);
    expect(JsonRpcSuccessSchema.safeParse({ jsonrpc: '2.0', id: 1, result: { ok: true } }).success).toBe(true);
    expect(
      JsonRpcErrorSchema.safeParse({ jsonrpc: '2.0', id: null, error: toRpcError(new BosError('TIMEOUT', 'x')) })
        .success,
    ).toBe(true);
    expect(
      JsonRpcNotificationSchema.safeParse({
        jsonrpc: '2.0',
        method: 'event',
        params: { ts: 1, type: 'session.status', data: { status: 'ready' } },
      }).success,
    ).toBe(true);
  });

  it('rejects a wrong jsonrpc version and a notification for another method', () => {
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: '1.0', id: 1, method: 'x' }).success).toBe(false);
    expect(JsonRpcNotificationSchema.safeParse({ jsonrpc: '2.0', method: 'shutdown', params: {} }).success).toBe(false);
  });
});

describe('toRpcError', () => {
  it('maps a BosError to the documented shape', () => {
    const error = new BosError('TARGET_AMBIGUOUS', 'two matches', { details: { candidates: ['e1', 'e2'] } });
    expect(toRpcError(error)).toEqual({
      code: RPC_ERROR_CODE,
      message: 'two matches',
      data: { bosCode: 'TARGET_AMBIGUOUS', retryable: false, details: { candidates: ['e1', 'e2'] } },
    });
  });

  it('carries the retryable flag from the code defaults', () => {
    expect(toRpcError(new BosError('TIMEOUT', 'slow')).data?.retryable).toBe(true);
    expect(toRpcError(new BosError('ACTION_FAILED', 'no')).data?.retryable).toBe(false);
  });

  it('omits details when the error has none', () => {
    expect(toRpcError(new BosError('INTERNAL', 'x')).data).toEqual({ bosCode: 'INTERNAL', retryable: false });
  });

  it('never leaks an unknown failure as a typed error', () => {
    for (const value of [new Error('socket hang up'), 'a string', null, undefined, 42, { nope: true }]) {
      const mapped = toRpcError(value);
      expect(mapped.code).toBe(RPC_ERROR_CODE);
      expect(mapped.data?.bosCode).toBe('INTERNAL');
      expect(mapped.data?.retryable).toBe(false);
    }
    expect(toRpcError(new Error('socket hang up')).message).toBe('socket hang up');
  });

  it('uses standard JSON-RPC codes for malformed requests', () => {
    expect(JSONRPC_INVALID_PARAMS).toBe(-32602);
  });
});

describe('ConfigSchema', () => {
  it('resolves an empty config to the documented defaults', () => {
    const config = ConfigSchema.parse({});
    expect(config.defaultProfile).toBe('default');
    expect(config.defaultChannel).toBe('chrome');
    expect(config.daemon.port).toBe(0);
    expect(config.sessionIdleMinutes).toBe(0);
    expect(config.retentionDays).toBe(30);
    expect(config.models).toEqual({ fast: null, capable: null, vision: null });
    expect(config.policy).toEqual(DEFAULT_POLICY);
  });

  it('accepts a full config, including the local-model and fake-provider forms', () => {
    const parsed = ConfigSchema.parse({
      defaultProfile: 'work',
      models: {
        fast: {
          provider: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen3',
          apiKeyEnv: 'OLLAMA_KEY',
          supportsJsonSchema: true,
        },
        vision: {
          provider: 'fake',
          truthFile: 'C:/tmp/truth.json',
          latencyMs: 800,
          dumpRequestsTo: 'C:/tmp/req.jsonl',
        },
      },
      policy: { downloads: { enabled: true, dir: 'C:/tmp/dl' } },
    });
    expect(parsed.models.fast?.maxTokensParam).toBeUndefined();
    expect(parsed.models.vision?.truthFile).toBe('C:/tmp/truth.json');
    expect(parsed.policy.downloads).toEqual({ enabled: true, dir: 'C:/tmp/dl' });
  });

  it('rejects an unknown provider and a non-numeric port', () => {
    expect(ConfigSchema.safeParse({ models: { fast: { provider: 'gemini' } } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ daemon: { port: 70000 } }).success).toBe(false);
  });
});
