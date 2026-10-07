import type { SecretResolver } from '@browser-os/protocol';
import { BosError, isBosError } from '@browser-os/protocol';

/** Per-call `secretValues` from `act` / `task.run` (SECURITY.md §10, SDK path). */
export class MapSecretResolver implements SecretResolver {
  constructor(private readonly values: Readonly<Record<string, string>>) {}

  async resolve(name: string): Promise<string> {
    const value = this.values[name];
    if (value === undefined) throw missing(name);
    return value;
  }
}

/**
 * Daemon environment fallback: `BOS_SECRET_<NAME>`, with the name used exactly
 * as the caller spelled it, matching what `bos --secret NAME` reads on the CLI.
 */
export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

  async resolve(name: string): Promise<string> {
    const value = this.env[`BOS_SECRET_${name}`];
    if (value === undefined) throw missing(name);
    return value;
  }
}

/**
 * Try `first`, fall back to `second` only when the secret is *missing*.
 * Any other failure from `first` propagates: a broken resolver must not be
 * silently papered over by the next one in the chain.
 */
export function chain(first: SecretResolver, second: SecretResolver): SecretResolver {
  return {
    async resolve(name: string): Promise<string> {
      try {
        return await first.resolve(name);
      } catch (error) {
        if (isBosError(error) && error.code === 'PERMISSION_DENIED') return second.resolve(name);
        throw error;
      }
    },
  };
}

/**
 * The name only, never the value: `message` is what reaches logs, events and
 * the model, so a missing secret must not become a place a value could leak.
 */
function missing(name: string): BosError {
  return new BosError('PERMISSION_DENIED', `secret "${name}" is not available`);
}
