// What one driver operation is: the context it runs in, and what it reports (action-router §4.1).
//
// `effect` is the only thing the router retries on, so every operation answers in these terms:
//   none    — nothing was dispatched, the failure is safe to retry or fall back from
//   committed — the input was dispatched and the operation finished
//   unknown — input may have gone out and the call failed afterwards, so never retry blind

import type { ErrorCode } from '@browser-os/protocol';
import type { CdpTransport } from '../cdp/transport.js';
import type { ResolvedTarget } from './types.js';

export interface DriverOutcome {
  ok: boolean;
  effect: 'none' | 'committed' | 'unknown';
  error?: { code: ErrorCode; message: string };
}

export interface CdpContext {
  transport: CdpTransport;
  /** Runs `source` in the `bos` world, bound to a node when one is given. */
  call<T>(source: string, args: readonly unknown[], target: ResolvedTarget | null): Promise<T>;
}

export function refuse(code: ErrorCode, message: string): DriverOutcome {
  return { ok: false, effect: 'none', error: { code, message } };
}

/** Input may already have gone out, so whether it landed is anyone's guess (§4.1). */
export function unsure(error: unknown): DriverOutcome {
  return {
    ok: false,
    effect: 'unknown',
    error: { code: 'ACTION_FAILED', message: describe(error) },
  };
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
