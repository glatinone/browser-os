// P8-01 — the JSON-RPC dispatcher (protocol §2–§3).
//
// Transport-free: `handleMessage` takes a raw frame string and resolves to the
// raw response frame (null when nothing may be sent). `server.ts` owns the
// socket; everything the card lists as an error class is decided here, so the
// tests can drive it through a real `ws` client or in-process.
//
// Frame handling, exactly protocol §3:
//   * unparseable JSON                         → -32700, id null
//   * envelope fails JsonRpcRequestSchema      → -32600 (id only when trustworthy)
//   * method not in RPC_METHODS / not served   → -32601
//   * params fail RPC_METHODS[m].params        → -32602, data.bosCode INVALID_REQUEST
//   * handler throws                           → toRpcError(e) (-32000 + real bosCode)
//   * result fails RPC_METHODS[m].result (dev) → -32000, bosCode INTERNAL
//
// `protocolVersion` gating needs no code of its own: the params schemas carry
// `protocolVersion: z.literal('1')`, so an unknown version fails params and
// surfaces as -32602 with INVALID_REQUEST — the exact §3 outcome.
//
// A frame without `id` is not a valid §3 request (the schema demands one), so
// it lands in the -32600 class and no response id can be trusted from it.

import type { Clock } from '@browser-os/protocol';
import {
  isBosError,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  JsonRpcRequestSchema,
  RPC_ERROR_CODE,
  RPC_METHODS,
  type RpcMethod,
  systemClock,
  toRpcError,
} from '@browser-os/protocol';
import type { RequestLogger } from './log.js';

/**
 * The api surface the dispatcher calls. Handlers are declared with a `never`
 * parameter so any method-arity-compatible api (e.g. `RuntimeApi`) is
 * assignable without casts; params are validated before the call, so what the
 * handler receives is type-correct by the method table.
 */
export type RpcApi = Partial<Record<RpcMethod, (params: never) => Promise<unknown>>>;

export interface DispatcherOptions {
  api: RpcApi;
  /** Result validation (requirement 2) is a dev/test affordance: off by default. */
  validateResults?: boolean;
  logger?: RequestLogger;
  clock?: Clock;
}

export interface Dispatcher {
  /** Raw frame in, raw response frame out (null = send nothing back). */
  handleMessage(raw: string): Promise<string | null>;
}

/** Shape of `RpcErrorSchema`'s output, restated locally so the daemon needs no zod dependency. */
interface RpcErrorObject {
  code: number;
  message: string;
  data?: { bosCode: string; retryable: boolean; details?: Record<string, unknown> };
}

const INVALID_REQUEST_BOS = { bosCode: 'INVALID_REQUEST', retryable: false } as const;

function frame(id: string | number | null, error: RpcErrorObject): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

function stdError(code: number, message: string): RpcErrorObject {
  return { code, message, data: { ...INVALID_REQUEST_BOS } };
}

/** An id from an envelope we rejected is only echoed when it is certainly one. */
function trustworthyId(parsed: unknown): string | number | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const id = (parsed as { id?: unknown }).id;
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : null;
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const api = options.api;
  const validateResults = options.validateResults ?? false;
  const logger = options.logger;
  const clock = options.clock ?? systemClock;

  async function run(
    raw: string,
  ): Promise<{ response: string | null; ok: boolean; errorCode?: number; method: string }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        response: frame(null, stdError(JSONRPC_PARSE_ERROR, 'Parse error')),
        ok: false,
        errorCode: JSONRPC_PARSE_ERROR,
        method: '-',
      };
    }

    const envelope = JsonRpcRequestSchema.safeParse(parsed);
    if (!envelope.success) {
      const id = trustworthyId(parsed);
      return {
        response: frame(id, stdError(JSONRPC_INVALID_REQUEST, 'Invalid Request')),
        ok: false,
        errorCode: JSONRPC_INVALID_REQUEST,
        method: '-',
      };
    }
    const req = envelope.data;
    const method = req.method;

    if (!Object.hasOwn(RPC_METHODS, method)) {
      return {
        response: frame(req.id, {
          code: JSONRPC_METHOD_NOT_FOUND,
          message: `method not found: ${method}`,
          data: { ...INVALID_REQUEST_BOS },
        }),
        ok: false,
        errorCode: JSONRPC_METHOD_NOT_FOUND,
        method,
      };
    }
    const rpcMethod = method as RpcMethod;
    const handler = api[rpcMethod];
    if (handler === undefined) {
      return {
        response: frame(req.id, {
          code: JSONRPC_METHOD_NOT_FOUND,
          message: `method not served by this daemon: ${rpcMethod}`,
          data: { ...INVALID_REQUEST_BOS },
        }),
        ok: false,
        errorCode: JSONRPC_METHOD_NOT_FOUND,
        method,
      };
    }

    const def = RPC_METHODS[rpcMethod];
    const params = def.params.safeParse(req.params ?? {});
    if (!params.success) {
      return {
        response: frame(req.id, {
          code: JSONRPC_INVALID_PARAMS,
          message: `invalid params for ${rpcMethod}`,
          data: {
            ...INVALID_REQUEST_BOS,
            details: { issues: params.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
          },
        }),
        ok: false,
        errorCode: JSONRPC_INVALID_PARAMS,
        method,
      };
    }

    try {
      const result = await (handler as (p: unknown) => Promise<unknown>)(params.data);
      if (validateResults) {
        const checked = def.result.safeParse(result);
        if (!checked.success) {
          throw isBosError(result) ? result : new Error(`result validation failed for ${rpcMethod}`);
        }
      }
      return { response: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), ok: true, method };
    } catch (error) {
      const rpc = toRpcError(error);
      return { response: frame(req.id, rpc), ok: false, errorCode: rpc.code, method };
    }
  }

  return {
    async handleMessage(raw: string): Promise<string | null> {
      const started = clock.now();
      const outcome = await run(raw);
      if (logger !== undefined) {
        logger.logRequest({
          method: outcome.method,
          durationMs: Math.max(0, clock.now() - started),
          ok: outcome.ok,
          ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
        });
      }
      return outcome.response;
    },
  };
}

/** Re-exported so callers can build the standard envelope error without magic numbers. */
export const JSONRPC_INTERNAL_ERROR = RPC_ERROR_CODE;
