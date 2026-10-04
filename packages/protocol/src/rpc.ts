// The JSON-RPC method table, the wire envelopes and the config schema
// (specs/protocol.md §3–§6).
//
// Every method the daemon serves is declared here with a params schema and a
// result schema. `daemon` dispatches on this table and `sdk`/`cli` type their
// calls from it, so "every method in protocol §4 is present" is checked by the
// test suite rather than by reading the spec twice.

import { z } from 'zod';
import { BosError, isBosError } from './errors.js';
import { DEFAULT_POLICY } from './policy.js';
import {
  ActionCacheEntrySchema,
  ActionResultSchema,
  BosEventSchema,
  BrowserActionSchema,
  BrowserChannelSchema,
  BrowserProfileSchema,
  ErrorCodeSchema,
  HumanAnswerSchema,
  HumanRequestSchema,
  ObservationSchema,
  PageInfoSchema,
  PermissionDecisionRecordSchema,
  PermissionRequestSchema,
  PolicySchema,
  PROFILE_NAME_RE,
  SessionSchema,
  TASK_KEY_RE,
  TargetSchema,
  TaskSchema,
  TrajectorySchema,
} from './schemas.js';

export const PROTOCOL_VERSION = '1';

/** The single JSON-RPC error code the daemon uses; the specific reason is in `data.bosCode`. */
export const RPC_ERROR_CODE = -32000;

export const OkSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// config.json (protocol §6). Every field is optional in the file and resolved to
// a default here, so a missing or partial config is still valid.
// ---------------------------------------------------------------------------

export const ModelConfigSchema = z.object({
  provider: z.enum(['openai-compatible', 'anthropic', 'fake']),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  supportsJsonSchema: z.boolean().optional(),
  maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  // Test-only provider fields (integration §12).
  truthFile: z.string().optional(),
  latencyMs: z.number().nonnegative().optional(),
  jitterMs: z.number().nonnegative().optional(),
  dumpRequestsTo: z.string().optional(),
});

export const ConfigSchema = z.object({
  defaultProfile: z.string().regex(PROFILE_NAME_RE).default('default'),
  defaultChannel: BrowserChannelSchema.default('chrome'),
  daemon: z.object({ port: z.number().int().min(0).max(65535).default(0) }).default({ port: 0 }),
  sessionIdleMinutes: z.number().int().nonnegative().default(0),
  retentionDays: z.number().int().positive().default(30),
  models: z
    .object({
      fast: ModelConfigSchema.nullable().default(null),
      capable: ModelConfigSchema.nullable().default(null),
      vision: ModelConfigSchema.nullable().default(null),
    })
    .default({ fast: null, capable: null, vision: null }),
  policy: PolicySchema.default(DEFAULT_POLICY),
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Method table
// ---------------------------------------------------------------------------

export interface RpcMethodDef<P extends z.ZodType, R extends z.ZodType> {
  params: P;
  result: R;
}

function method<P extends z.ZodType, R extends z.ZodType>(params: P, result: R): RpcMethodDef<P, R> {
  return { params, result };
}

const SessionIdParams = z.object({ sessionId: z.string().min(1) });
const PageParams = z.object({ sessionId: z.string().min(1), pageId: z.string().optional() });
const NoParams = z.object({});

const StatsResultSchema = z.object({
  since: z.number().int().nullable(),
  actions: z.number().int().nonnegative(),
  tierDistribution: z.record(z.string(), z.number().int().nonnegative()),
  cacheHitRate: z.number().nullable(),
  cacheFalseHitRate: z.number().nullable(),
  deterministicPrecision: z.number().nullable(),
  llmCallsPerAction: z.number(),
  tokensPerAction: z.object({ input: z.number(), output: z.number() }),
  latencyByTier: z.record(z.string(), z.object({ p50: z.number(), p95: z.number() })),
  escalationRate: z.number().nullable(),
});

export const RPC_METHODS = {
  'system.hello': method(
    z.object({ client: z.string().min(1), protocolVersion: z.literal(PROTOCOL_VERSION) }),
    z.object({ version: z.string(), protocolVersion: z.literal(PROTOCOL_VERSION), pid: z.number().int().positive() }),
  ),
  'system.shutdown': method(NoParams, OkSchema),

  'profile.create': method(
    z.object({ name: z.string().regex(PROFILE_NAME_RE), channel: BrowserChannelSchema.optional() }),
    BrowserProfileSchema,
  ),
  'profile.list': method(NoParams, z.array(BrowserProfileSchema)),
  'profile.delete': method(z.object({ name: z.string().min(1), confirm: z.literal(true) }), OkSchema),
  'profile.openManual': method(z.object({ name: z.string().min(1) }), z.object({ pid: z.number().int().positive() })),

  'session.open': method(
    z.object({
      profile: z.string().regex(PROFILE_NAME_RE),
      provider: z.enum(['launch', 'cdp-endpoint']).optional(),
      headless: z.boolean().optional(),
      cdpEndpoint: z.string().optional(),
    }),
    SessionSchema,
  ),
  'session.list': method(z.object({ sessionId: z.string().optional() }), z.array(SessionSchema)),
  'session.get': method(SessionIdParams, SessionSchema),
  'session.close': method(SessionIdParams, OkSchema),
  'session.reconnect': method(SessionIdParams, SessionSchema),

  'page.list': method(PageParams, z.array(PageInfoSchema)),
  'page.new': method(z.object({ sessionId: z.string().min(1), url: z.string().optional() }), PageInfoSchema),
  'page.select': method(z.object({ sessionId: z.string().min(1), pageId: z.string().min(1) }), OkSchema),
  'page.close': method(z.object({ sessionId: z.string().min(1), pageId: z.string().min(1) }), OkSchema),

  observe: method(
    z.object({
      sessionId: z.string().min(1),
      pageId: z.string().optional(),
      includeText: z.boolean().optional(),
      viewportOnly: z.boolean().optional(),
      format: z.enum(['json', 'lines']).optional(),
    }),
    z.union([ObservationSchema, z.object({ observationId: z.string(), lines: z.string() })]),
  ),
  act: method(
    z.object({
      sessionId: z.string().min(1),
      pageId: z.string().optional(),
      action: BrowserActionSchema,
      taskId: z.string().optional(),
      secretValues: z.record(z.string(), z.string()).optional(),
    }),
    ActionResultSchema,
  ),
  upload: method(
    z.object({ sessionId: z.string().min(1), target: TargetSchema, paths: z.array(z.string()).min(1) }),
    ActionResultSchema,
  ),

  'task.start': method(
    z.object({
      sessionId: z.string().min(1),
      key: z.string().regex(TASK_KEY_RE),
      mode: z.enum(['record', 'replay', 'auto']).optional(),
      params: z.record(z.string(), z.string()).optional(),
      secretNames: z.array(z.string()).optional(),
    }),
    TaskSchema,
  ),
  'task.end': method(z.object({ taskId: z.string().min(1), success: z.boolean() }), TaskSchema),
  'task.run': method(
    z.object({
      sessionId: z.string().min(1),
      key: z.string().regex(TASK_KEY_RE),
      params: z.record(z.string(), z.string()).optional(),
      secretNames: z.array(z.string()).optional(),
      secretValues: z.record(z.string(), z.string()).optional(),
    }),
    TaskSchema,
  ),
  'task.get': method(z.object({ taskId: z.string().min(1) }), TaskSchema),
  'task.list': method(
    z.object({ key: z.string().optional(), limit: z.number().int().positive().optional() }),
    z.array(TaskSchema),
  ),

  'trajectory.list': method(z.object({ taskKey: z.string().optional() }), z.array(TrajectorySchema)),
  'trajectory.get': method(z.object({ key: z.string().regex(TASK_KEY_RE) }), TrajectorySchema),
  'trajectory.delete': method(z.object({ key: z.string().regex(TASK_KEY_RE) }), OkSchema),
  'trajectory.export': method(
    z.object({ key: z.string().regex(TASK_KEY_RE) }),
    z.object({ key: z.string(), json: z.string() }),
  ),
  'trajectory.import': method(z.object({ json: z.string() }), TrajectorySchema),

  'cache.list': method(z.object({ origin: z.string().optional() }), z.array(ActionCacheEntrySchema)),
  'cache.clear': method(
    z.object({ origin: z.string().optional() }),
    z.object({ deleted: z.number().int().nonnegative() }),
  ),

  'human.pending': method(z.object({ sessionId: z.string().optional() }), z.array(HumanRequestSchema)),
  'human.resume': method(z.object({ sessionId: z.string().min(1), answer: HumanAnswerSchema }), OkSchema),

  'permission.pending': method(z.object({ sessionId: z.string().optional() }), z.array(PermissionRequestSchema)),
  'permission.decide': method(
    z.object({ requestId: z.string().min(1), decision: z.enum(['approve', 'reject']) }),
    PermissionDecisionRecordSchema,
  ),

  'stats.get': method(
    z.object({ since: z.number().int().optional(), origin: z.string().optional(), taskKey: z.string().optional() }),
    StatsResultSchema,
  ),
  'events.subscribe': method(
    z.object({ sessionId: z.string().optional(), types: z.array(z.string()).optional() }),
    z.object({ subscriptionId: z.string().min(1) }),
  ),
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RPC_METHODS)[M]['result']>;

/** Every method name, for the daemon dispatcher and the tests. */
export const RPC_METHOD_NAMES = Object.keys(RPC_METHODS) as RpcMethod[];

// ---------------------------------------------------------------------------
// Wire envelopes (protocol §3)
// ---------------------------------------------------------------------------

const RpcIdSchema = z.union([z.string(), z.number()]);

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RpcIdSchema,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const JsonRpcSuccessSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RpcIdSchema,
  result: z.unknown(),
});

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z
    .object({
      bosCode: ErrorCodeSchema,
      retryable: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const JsonRpcErrorSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RpcIdSchema.nullable(),
  error: RpcErrorSchema,
});

/** Server push: one event per notification (protocol §3). */
export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('event'),
  params: BosEventSchema,
});

/** JSON-RPC 2.0 standard codes for malformed requests; parsed `data.bosCode` is INVALID_REQUEST. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;

/**
 * Maps any thrown value to a JSON-RPC error object. A BosError keeps its code,
 * retryable flag and details; anything else becomes INTERNAL, so an unexpected
 * exception can never masquerade as a typed failure.
 */
export function toRpcError(e: unknown): z.infer<typeof RpcErrorSchema> {
  if (isBosError(e)) {
    const data: { bosCode: z.infer<typeof ErrorCodeSchema>; retryable: boolean; details?: Record<string, unknown> } = {
      bosCode: e.code,
      retryable: e.retryable,
    };
    if (e.details !== undefined) data.details = e.details;
    return { code: RPC_ERROR_CODE, message: e.message, data };
  }
  const message = e instanceof BosError ? e.message : e instanceof Error ? e.message : String(e);
  return { code: RPC_ERROR_CODE, message, data: { bosCode: 'INTERNAL', retryable: false } };
}
