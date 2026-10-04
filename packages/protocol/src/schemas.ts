// Zod schemas mirroring the types in this package (data-models, all sections).
//
// Every type that crosses the daemon protocol or reaches a model has a schema
// here, so untrusted input (a client, a page, a model) is validated at the edge
// rather than trusted. `schemaTypeChecks()` at the bottom makes the schema and
// its interface a compile-time contract in both directions.

import { z } from 'zod';
import { ERROR_CODES } from './errors.js';
import type { BosEvent } from './events.js';
import type {
  ActionCacheEntry,
  ActionResult,
  BrowserAction,
  BrowserProfile,
  ElementLocator,
  FrameInfo,
  Observation,
  PageInfo,
  PermissionRequest,
  Policy,
  SemanticElement,
  Session,
  Target,
  Task,
  TextBlock,
  Trajectory,
  TrajectoryStep,
  ValueSource,
} from './index.js';

export const IdSchema = z.string().min(1);
export const TimestampSchema = z.number().int().nonnegative();

export const BrowserChannelSchema = z.enum(['chrome', 'msedge', 'chromium']);
export const SessionStatusSchema = z.enum(['starting', 'ready', 'busy', 'waiting_for_human', 'disconnected', 'closed']);
export const ChallengeKindSchema = z.enum(['login', 'captcha', 'mfa', 'passkey', 'consent', 'unknown']);
export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export const PermissionDecisionSchema = z.enum(['allow', 'confirm', 'deny']);
export const TierSchema = z.enum(['ref', 'cache', 'deterministic', 'llm', 'vision', 'human']);
export const DriverSchema = z.enum(['cdp', 'playwright']);
export const ActionTypeSchema = z.enum([
  'navigate',
  'click',
  'fill',
  'press',
  'select',
  'hover',
  'scroll',
  'wait',
  'waitFor',
  'extract',
  'upload',
]);
export const ModelTierSchema = z.enum(['fast', 'capable', 'vision']);
export const ModelPurposeSchema = z.enum(['resolve_target', 'extract', 'vision_locate']);
/** Derived from ERROR_CODES, so a new code is valid here the moment it exists. */
export const ErrorCodeSchema = z.enum(ERROR_CODES);
const BUDGET_DEFAULTS = {
  maxLlmCallsPerAction: 2,
  maxLlmCallsPerTask: 20,
  maxRetriesPerAction: 2,
  actionTimeoutMs: 15000,
  humanTimeoutMs: 600000,
} as const;

/** Profile names are directory names under <BOS_HOME>/profiles, so they are strictly constrained. */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Task keys are caller-chosen and become cache/trajectory keys. */
export const TASK_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const REF_RE = /^e\d+$/;
export const TEXT_BLOCK_REF_RE = /^t\d+$/;

export const BrowserProfileSchema = z.object({
  id: z.string().regex(/^prf_/),
  name: z.string().regex(PROFILE_NAME_RE),
  channel: BrowserChannelSchema,
  userDataDir: z.string().min(1),
  headless: z.boolean(),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
});

export const SessionSchema = z.object({
  id: z.string().regex(/^ses_/),
  profileId: z.string().min(1),
  status: SessionStatusSchema,
  ownership: z.enum(['launched', 'attached']),
  headless: z.boolean(),
  browserPid: z.number().int().positive().nullable(),
  cdpPort: z.number().int().nullable(),
  activePageId: z.string().nullable(),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema,
});

export const PageInfoSchema = z.object({
  id: z.string().regex(/^pg_/),
  sessionId: z.string().min(1),
  url: z.string(),
  title: z.string(),
  openerPageId: z.string().nullable(),
});

export const FrameInfoSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  url: z.string(),
  name: z.string().nullable(),
  outOfProcess: z.boolean(),
});

export const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const ElementStateSchema = z.object({
  disabled: z.literal(true).optional(),
  checked: z.union([z.boolean(), z.literal('mixed')]).optional(),
  expanded: z.boolean().optional(),
  selected: z.literal(true).optional(),
  focused: z.literal(true).optional(),
  required: z.literal(true).optional(),
  readonly: z.literal(true).optional(),
  editable: z.literal(true).optional(),
});

export const StableAttrSchema = z.enum([
  'id',
  'name',
  'type',
  'placeholder',
  'aria-label',
  'title',
  'alt',
  'href',
  'autocomplete',
  'data-testid',
  'data-test',
  'data-qa',
  'role',
]);

/** Partial<Record<StableAttr, string>> written out, so the inferred type matches the interface exactly. */
export const LocatorAttrsSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  placeholder: z.string().optional(),
  'aria-label': z.string().optional(),
  title: z.string().optional(),
  alt: z.string().optional(),
  href: z.string().optional(),
  autocomplete: z.string().optional(),
  'data-testid': z.string().optional(),
  'data-test': z.string().optional(),
  'data-qa': z.string().optional(),
  role: z.string().optional(),
});

export const ElementLocatorSchema = z.object({
  v: z.literal(1),
  role: z.string(),
  name: z.string().max(120),
  nameIsDynamic: z.boolean(),
  tag: z.string(),
  attrs: LocatorAttrsSchema,
  context: z.array(z.string()),
  cssPath: z.string(),
  framePath: z.array(z.string()),
  ordinal: z.number().int().nonnegative(),
});

export const SemanticElementSchema = z.object({
  ref: z.string().regex(REF_RE),
  role: z.string(),
  name: z.string().max(120),
  tag: z.string(),
  value: z.string().max(120).optional(),
  placeholder: z.string().optional(),
  description: z.string().max(120).optional(),
  href: z.string().optional(),
  inputType: z.string().optional(),
  state: ElementStateSchema,
  inViewport: z.boolean(),
  rect: RectSchema.nullable(),
  frame: z.string(),
  context: z.array(z.string()).max(2),
});

export const TextBlockSchema = z.object({
  ref: z.string().regex(TEXT_BLOCK_REF_RE),
  text: z.string().max(300),
  role: z.enum(['heading', 'paragraph', 'listitem', 'cell', 'status', 'alert', 'text']),
  level: z.number().int().optional(),
  frame: z.string(),
});

export const LARGE_PAGE_NODES = 15000;

export const ObservationSchema = z.object({
  id: z.string().regex(/^obs_/),
  sessionId: z.string(),
  pageId: z.string(),
  url: z.string(),
  title: z.string(),
  capturedAt: TimestampSchema,
  frames: z.array(FrameInfoSchema),
  elements: z.array(SemanticElementSchema),
  text: z.array(TextBlockSchema),
  dialogs: z.array(z.string()),
  challenge: ChallengeKindSchema.nullable(),
  warnings: z.array(z.string()),
  stats: z.object({
    domNodes: z.number().int().nonnegative(),
    axNodes: z.number().int().nonnegative(),
    elements: z.number().int().nonnegative(),
    captureMs: z.number().nonnegative(),
    buildMs: z.number().nonnegative(),
    estTokens: z.number().int().nonnegative(),
    large: z.boolean(),
  }),
});

export const ValueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('param'), name: z.string().min(1) }),
  z.object({ kind: z.literal('secret'), name: z.string().min(1) }),
]);

export const TargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ref'), ref: z.string().regex(REF_RE), observationId: z.string().min(1) }),
  z.object({ kind: z.literal('intent'), text: z.string().min(1) }),
  z.object({
    kind: z.literal('query'),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    css: z.string().optional(),
    nth: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('locator'), locator: ElementLocatorSchema }),
]);

export const BrowserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string().min(1) }),
  z.object({
    type: z.literal('click'),
    target: TargetSchema,
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
  z.object({
    type: z.literal('fill'),
    target: TargetSchema,
    value: ValueSourceSchema,
    submit: z.boolean().optional(),
  }),
  z.object({ type: z.literal('press'), key: z.string().min(1), target: TargetSchema.optional() }),
  z.object({ type: z.literal('select'), target: TargetSchema, value: ValueSourceSchema }),
  z.object({ type: z.literal('hover'), target: TargetSchema }),
  z.object({
    type: z.literal('scroll'),
    target: TargetSchema.optional(),
    direction: z.enum(['up', 'down']),
    amountPx: z.number().optional(),
  }),
  z.object({
    type: z.literal('wait'),
    until: z.enum(['load', 'domcontentloaded', 'settled']),
    timeoutMs: z.number().optional(),
  }),
  z.object({
    type: z.literal('waitFor'),
    target: TargetSchema,
    state: z.enum(['visible', 'hidden']).optional(),
    timeoutMs: z.number().optional(),
  }),
  z.object({ type: z.literal('extract'), target: TargetSchema.optional(), format: z.enum(['text', 'links', 'table']) }),
  z.object({ type: z.literal('upload'), target: TargetSchema, paths: z.array(z.string()).min(1) }),
]);

export const TierAttemptSchema = z.object({
  tier: TierSchema,
  ok: z.boolean(),
  ms: z.number().nonnegative(),
  reason: ErrorCodeSchema.optional(),
  candidates: z.number().int().nonnegative().optional(),
  score: z.number().optional(),
});

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  action: BrowserActionSchema,
  tier: TierSchema.nullable(),
  driver: DriverSchema.nullable(),
  attempts: z.array(TierAttemptSchema),
  element: z.object({ ref: z.string(), role: z.string(), name: z.string() }).optional(),
  locator: ElementLocatorSchema.optional(),
  url: z.string(),
  pageChanged: z.boolean(),
  extracted: z.unknown().optional(),
  ms: z.number().nonnegative(),
  llm: z.object({
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  }),
  risk: RiskLevelSchema.nullable(),
  error: z
    .object({ code: ErrorCodeSchema, message: z.string(), details: z.record(z.string(), z.unknown()).optional() })
    .optional(),
});

export const TaskStatsSchema = z.object({
  actions: z.number().int().nonnegative(),
  llmCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  visionCalls: z.number().int().nonnegative(),
  humanInterventions: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  healedSteps: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
});

export const TaskSchema = z.object({
  id: z.string().regex(/^tsk_/),
  key: z.string().regex(TASK_KEY_RE),
  sessionId: z.string(),
  mode: z.enum(['record', 'replay', 'auto']),
  resolvedMode: z.enum(['record', 'replay']).nullable(),
  params: z.record(z.string(), z.string()),
  secretNames: z.array(z.string()),
  status: z.enum(['running', 'waiting_for_human', 'completed', 'failed', 'cancelled']),
  trajectoryId: z.string().nullable(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  stats: TaskStatsSchema,
});

export const TrajectoryStepSchema = z.object({
  index: z.number().int().nonnegative(),
  action: BrowserActionSchema,
  intent: z.string().nullable(),
  pre: z.object({ urlPattern: z.string() }),
  post: z.object({ urlPattern: z.string().optional() }).optional(),
  risk: RiskLevelSchema,
});

export const TrajectorySchema = z.object({
  id: z.string().regex(/^trj_/),
  taskKey: z.string().regex(TASK_KEY_RE),
  origin: z.string(),
  startUrl: z.string(),
  version: z.number().int().positive(),
  params: z.array(z.string()),
  secretNames: z.array(z.string()),
  steps: z.array(TrajectoryStepSchema),
  status: z.enum(['active', 'suspect', 'invalid']),
  stats: z.object({
    runs: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    lastSuccessAt: TimestampSchema.nullable(),
  }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ActionCacheEntrySchema = z.object({
  key: z.string().min(1),
  origin: z.string(),
  pathTemplate: z.string(),
  actionType: ActionTypeSchema,
  intent: z.string(),
  locator: ElementLocatorSchema,
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  consecutiveMisses: z.number().int().nonnegative(),
  status: z.enum(['active', 'invalid']),
  createdAt: TimestampSchema,
  lastHitAt: TimestampSchema.nullable(),
});

export const SitePolicySchema = z.object({
  originPattern: z.string().min(1),
  access: z.enum(['allow', 'deny']).optional(),
  risk: z
    .object({
      low: PermissionDecisionSchema.optional(),
      medium: PermissionDecisionSchema.optional(),
      high: PermissionDecisionSchema.optional(),
    })
    .optional(),
});

/** Defaults mirror DEFAULT_POLICY exactly; a config file may omit any of them. */
export const PolicySchema = z.object({
  risk: z.record(RiskLevelSchema, PermissionDecisionSchema).default({ low: 'allow', medium: 'allow', high: 'confirm' }),
  sites: z.array(SitePolicySchema).default([]),
  tiers: z
    .object({ llm: z.boolean().default(true), vision: z.boolean().default(false), human: z.boolean().default(true) })
    .default({
      llm: true,
      vision: false,
      human: true,
    }),
  budgets: z
    .object({
      maxLlmCallsPerAction: z.number().int().default(BUDGET_DEFAULTS.maxLlmCallsPerAction),
      maxLlmCallsPerTask: z.number().int().default(BUDGET_DEFAULTS.maxLlmCallsPerTask),
      maxRetriesPerAction: z.number().int().default(BUDGET_DEFAULTS.maxRetriesPerAction),
      actionTimeoutMs: z.number().int().default(BUDGET_DEFAULTS.actionTimeoutMs),
      humanTimeoutMs: z.number().int().default(BUDGET_DEFAULTS.humanTimeoutMs),
    })
    .default(BUDGET_DEFAULTS),
  uploads: z.object({ allowedDirs: z.array(z.string()).default([]) }).default({ allowedDirs: [] }),
  downloads: z.object({ enabled: z.boolean().default(false), dir: z.string().nullable().default(null) }).default({
    enabled: false,
    dir: null,
  }),
});

export const PermissionRequestSchema = z.object({
  id: z.string().regex(/^perm_/),
  sessionId: z.string(),
  taskId: z.string().nullable(),
  action: BrowserActionSchema,
  risk: RiskLevelSchema,
  reasons: z.array(z.string()),
  element: z.object({ role: z.string(), name: z.string() }).optional(),
  url: z.string(),
  createdAt: TimestampSchema,
});

export const PermissionDecisionRecordSchema = z.object({
  requestId: z.string(),
  decision: z.enum(['approve', 'reject']),
  decidedBy: z.enum(['human', 'policy']),
  decidedAt: TimestampSchema,
});

export const HumanRequestSchema = z.object({
  id: z.string().regex(/^req_/),
  sessionId: z.string(),
  taskId: z.string().nullable(),
  reason: z.union([ChallengeKindSchema, z.literal('ambiguous'), z.literal('failed')]),
  message: z.string(),
  candidates: z.array(z.object({ ref: z.string(), role: z.string(), name: z.string() })).optional(),
  observationId: z.string().optional(),
  createdAt: TimestampSchema,
});

export const HumanAnswerSchema = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('ref'), ref: z.string().regex(REF_RE), observationId: z.string().min(1) }),
  z.object({ choice: z.literal('done') }),
  z.object({ choice: z.literal('abort') }),
]);

function envelope<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.object({
    ts: TimestampSchema,
    type: z.literal(type),
    sessionId: z.string().optional(),
    taskId: z.string().optional(),
    data,
  });
}

/**
 * An envelope whose `type` covers several literals. data-models §10 declares these
 * groups as a single member (`EventEnvelope<'a' | 'b', …>`), so the schema must be
 * one member too — splitting them would make the schema narrower than the type.
 */
function multiEnvelope<T extends string, D extends z.ZodType>(types: readonly [T, ...T[]], data: D) {
  return z.object({
    ts: TimestampSchema,
    type: z.enum(types),
    sessionId: z.string().optional(),
    taskId: z.string().optional(),
    data,
  });
}

export const BosEventSchema = z.discriminatedUnion('type', [
  envelope('session.status', z.object({ status: SessionStatusSchema, reason: z.string().optional() })),
  envelope(
    'observation.captured',
    z.object({
      observationId: z.string(),
      url: z.string(),
      elements: z.number().int(),
      domNodes: z.number().int(),
      captureMs: z.number(),
      buildMs: z.number(),
      estTokens: z.number().int(),
    }),
  ),
  envelope('action.started', z.object({ actionId: z.string(), action: BrowserActionSchema })),
  envelope('action.tier', z.object({ actionId: z.string(), attempt: TierAttemptSchema })),
  envelope('action.completed', z.object({ actionId: z.string(), result: ActionResultSchema })),
  envelope(
    'model.call',
    z.object({
      purpose: ModelPurposeSchema,
      model: z.string(),
      ms: z.number(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      ok: z.boolean(),
    }),
  ),
  multiEnvelope(
    ['cache.hit', 'cache.miss', 'cache.write', 'cache.invalidate'],
    z.object({ key: z.string(), reason: z.string().optional() }),
  ),
  multiEnvelope(['task.started', 'task.completed', 'task.failed'], z.object({ task: TaskSchema })),
  envelope(
    'trajectory.healed',
    z.object({ trajectoryId: z.string(), step: z.number().int(), newVersion: z.number().int() }),
  ),
  envelope(
    'human.required',
    z.object({
      reason: z.union([ChallengeKindSchema, z.literal('ambiguous'), z.literal('failed')]),
      message: z.string(),
    }),
  ),
  envelope('human.resolved', z.object({ outcome: z.enum(['resumed', 'aborted']) })),
  envelope('permission.requested', z.object({ request: PermissionRequestSchema })),
  envelope('permission.decided', z.object({ record: PermissionDecisionRecordSchema })),
  envelope('page.navigated', z.object({ pageId: z.string(), url: z.string() })),
  envelope('download.completed', z.object({ pageId: z.string(), path: z.string() })),
]);

/** `true` only when A and B are mutually assignable. */
export type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Compile-time proof that every schema and its interface agree in both directions.
 * Never called: it exists so `tsc` fails the build the moment a schema and its type
 * drift apart in either direction, which is the whole point of having both.
 */
export function schemaTypeChecks(): void {
  const expect = <A, B>(_proof: AssertEqual<A, B>): boolean => true;

  expect<z.infer<typeof BrowserProfileSchema>, BrowserProfile>(true);
  expect<z.infer<typeof SessionSchema>, Session>(true);
  expect<z.infer<typeof PageInfoSchema>, PageInfo>(true);
  expect<z.infer<typeof FrameInfoSchema>, FrameInfo>(true);
  expect<z.infer<typeof SemanticElementSchema>, SemanticElement>(true);
  expect<z.infer<typeof TextBlockSchema>, TextBlock>(true);
  expect<z.infer<typeof ObservationSchema>, Observation>(true);
  expect<z.infer<typeof ElementLocatorSchema>, ElementLocator>(true);
  expect<z.infer<typeof ValueSourceSchema>, ValueSource>(true);
  expect<z.infer<typeof TargetSchema>, Target>(true);
  expect<z.infer<typeof BrowserActionSchema>, BrowserAction>(true);
  expect<z.infer<typeof ActionResultSchema>, ActionResult>(true);
  expect<z.infer<typeof TaskSchema>, Task>(true);
  expect<z.infer<typeof TrajectorySchema>, Trajectory>(true);
  expect<z.infer<typeof TrajectoryStepSchema>, TrajectoryStep>(true);
  expect<z.infer<typeof ActionCacheEntrySchema>, ActionCacheEntry>(true);
  expect<z.infer<typeof PolicySchema>, Policy>(true);
  expect<z.infer<typeof PermissionRequestSchema>, PermissionRequest>(true);
  expect<z.infer<typeof BosEventSchema>, BosEvent>(true);
}
