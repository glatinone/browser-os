import type { SecretResolver } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import { chain, EnvSecretResolver, MapSecretResolver } from '../src/secrets.js';

const RAW = 'hunter2-super-secret';

async function expectDenied(resolver: SecretResolver, name: string, valueNeverShown: string): Promise<void> {
  let thrown: unknown;
  try {
    await resolver.resolve(name);
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { name?: string })?.name).toBe('BosError');
  expect((thrown as { code?: string })?.code).toBe('PERMISSION_DENIED');

  // The name is what an operator needs to fix the config; the value must not
  // appear anywhere a log, event or prompt could pick it up.
  const serialized = JSON.stringify({
    message: (thrown as { message?: string }).message,
    stack: (thrown as { stack?: string }).stack,
    details: (thrown as { details?: unknown }).details,
  });
  expect(serialized).toContain(name);
  expect(serialized).not.toContain(valueNeverShown);
}

describe('secret resolvers', () => {
  it('returns a value present in the per-call map', async () => {
    const resolver = new MapSecretResolver({ password: RAW });
    await expect(resolver.resolve('password')).resolves.toBe(RAW);
  });

  it('denies a missing map secret, naming it and never the value', async () => {
    await expectDenied(new MapSecretResolver({ password: RAW }), 'missing', RAW);
  });

  it('reads BOS_SECRET_<NAME> from the environment', async () => {
    const resolver = new EnvSecretResolver({ BOS_SECRET_API_TOKEN: RAW });
    await expect(resolver.resolve('API_TOKEN')).resolves.toBe(RAW);
    await expectDenied(resolver, 'MISSING_TOKEN', RAW);
  });

  it('chains with fallback only when the secret is missing', async () => {
    const chained = chain(new MapSecretResolver({}), new EnvSecretResolver({ BOS_SECRET_FALLBACK: RAW }));
    await expect(chained.resolve('FALLBACK')).resolves.toBe(RAW);
    await expectDenied(chained, 'NOPE', RAW);
  });

  it('does not let a later resolver mask a genuine failure in the first', async () => {
    const broken: SecretResolver = {
      resolve: () => Promise.reject(new Error('resolver exploded')),
    };
    const chained = chain(broken, new MapSecretResolver({ password: RAW }));
    await expect(chained.resolve('password')).rejects.toThrow('resolver exploded');
  });

  it('never puts a resolved value into a failure path', async () => {
    // The secret exists in one resolver but not the other, so the failing side
    // has to report the miss without echoing anything it does know about.
    const chained = chain(new MapSecretResolver({}), new EnvSecretResolver({}));
    let thrown: unknown;
    try {
      await chained.resolve('password');
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify(thrown)).not.toContain(RAW);
    expect((thrown as { message?: string }).message).toContain('password');
  });
});
