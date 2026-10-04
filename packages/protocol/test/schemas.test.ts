import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ActionCacheEntrySchema,
  ActionResultSchema,
  BosEventSchema,
  BrowserActionSchema,
  BrowserProfileSchema,
  DEFAULT_POLICY,
  ElementLocatorSchema,
  FrameInfoSchema,
  HumanAnswerSchema,
  HumanRequestSchema,
  ObservationSchema,
  PageInfoSchema,
  PermissionDecisionRecordSchema,
  PermissionRequestSchema,
  PolicySchema,
  SemanticElementSchema,
  SessionSchema,
  TargetSchema,
  TaskSchema,
  TextBlockSchema,
  TrajectorySchema,
  TrajectoryStepSchema,
  ValueSourceSchema,
} from '../src/index.js';

const UUID = '0190f3a1-1111-7222-8333-444455556666';

const LOCATOR = {
  v: 1,
  role: 'button',
  name: 'Sign in',
  nameIsDynamic: false,
  tag: 'button',
  attrs: { id: 'submit' },
  context: ['main'],
  cssPath: '#submit',
  framePath: [],
  ordinal: 0,
};

const ELEMENT = {
  ref: 'e1',
  role: 'button',
  name: 'Sign in',
  tag: 'button',
  state: {},
  inViewport: true,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  frame: 'f0',
  context: [],
};

const PROFILE = {
  id: 'prf_01M42A92RQSBV852WQDCT86TAJ',
  name: 'work',
  channel: 'chrome',
  userDataDir: 'C:/bos/profiles/work',
  headless: false,
  createdAt: 1,
  lastUsedAt: null,
};

const SESSION = {
  id: 'ses_01M42A92RQSBV852WQDCT86TAJ',
  profileId: 'prf_1',
  status: 'ready',
  ownership: 'launched',
  headless: false,
  browserPid: null,
  cdpPort: null,
  activePageId: 'pg_1',
  createdAt: 1,
  lastUsedAt: 2,
};

const TASK = {
  id: 'tsk_01M42A92RQSBV852WQDCT86TAJ',
  key: 'spa.search-and-open',
  sessionId: 'ses_1',
  mode: 'auto',
  resolvedMode: null,
  params: { query: 'Ada Lovelace' },
  secretNames: [],
  status: 'running',
  trajectoryId: null,
  startedAt: 1,
  endedAt: null,
  stats: {
    actions: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    visionCalls: 0,
    humanInterventions: 0,
    cacheHits: 0,
    healedSteps: 0,
    ms: 0,
  },
};

interface Row {
  schema: z.ZodType;
  valid: unknown;
  invalid: [unknown, unknown];
}

const ROWS: Record<string, Row> = {
  BrowserProfileSchema: {
    schema: BrowserProfileSchema,
    valid: PROFILE,
    invalid: [
      { ...PROFILE, name: 'Work Profile' },
      { ...PROFILE, channel: 'firefox' },
    ],
  },
  SessionSchema: {
    schema: SessionSchema,
    valid: SESSION,
    invalid: [
      { ...SESSION, status: 'idle' },
      { ...SESSION, ownership: 'borrowed' },
    ],
  },
  PageInfoSchema: {
    schema: PageInfoSchema,
    valid: { id: 'pg_1', sessionId: 'ses_1', url: 'https://x/', title: 'x', openerPageId: null },
    invalid: [
      { id: 'e1', sessionId: 's', url: 'x', title: 'x', openerPageId: null },
      { id: 'pg_1', sessionId: 'ses_1', url: 'x' },
    ],
  },
  FrameInfoSchema: {
    schema: FrameInfoSchema,
    valid: { id: 'f0', parentId: null, url: 'https://x/', name: null, outOfProcess: false },
    invalid: [
      { id: 'f0', parentId: null, url: 'x', name: null, outOfProcess: 'no' },
      { id: 'f0', parentId: null, url: 'x', name: null },
    ],
  },
  SemanticElementSchema: {
    schema: SemanticElementSchema,
    valid: ELEMENT,
    invalid: [
      { ...ELEMENT, ref: 'x1' },
      { ...ELEMENT, context: ['a', 'b', 'c'] },
    ],
  },
  TextBlockSchema: {
    schema: TextBlockSchema,
    valid: { ref: 't1', text: 'Hello', role: 'heading', level: 1, frame: 'f0' },
    invalid: [
      { ref: 'e1', text: 'x', role: 'heading', frame: 'f0' },
      { ref: 't1', text: 'x', role: 'banner', frame: 'f0' },
    ],
  },
  ObservationSchema: {
    schema: ObservationSchema,
    valid: {
      id: 'obs_1',
      sessionId: 'ses_1',
      pageId: 'pg_1',
      url: 'https://x/',
      title: 'x',
      capturedAt: 1,
      frames: [],
      elements: [ELEMENT],
      text: [],
      dialogs: [],
      challenge: null,
      warnings: [],
      stats: { domNodes: 1, axNodes: 1, elements: 1, captureMs: 1, buildMs: 1, estTokens: 1, large: false },
    },
    invalid: [
      {
        id: 'obs_1',
        sessionId: 's',
        pageId: 'p',
        url: 'u',
        title: 't',
        capturedAt: 1,
        frames: [],
        elements: [],
        text: [],
        dialogs: [],
        challenge: 'robot',
        warnings: [],
        stats: { domNodes: 0, axNodes: 0, elements: 0, captureMs: 0, buildMs: 0, estTokens: 0, large: false },
      },
      {
        id: 'obs_1',
        sessionId: 's',
        pageId: 'p',
        url: 'u',
        title: 't',
        capturedAt: 1,
        frames: [],
        elements: [],
        text: [],
        dialogs: [],
        challenge: null,
        warnings: [],
      },
    ],
  },
  ElementLocatorSchema: {
    schema: ElementLocatorSchema,
    valid: LOCATOR,
    invalid: [
      { ...LOCATOR, v: 2 },
      { ...LOCATOR, ordinal: -1 },
    ],
  },
  ValueSourceSchema: {
    schema: ValueSourceSchema,
    valid: { kind: 'param', name: 'query' },
    invalid: [{ kind: 'other', value: 'x' }, { kind: 'secret' }],
  },
  TargetSchema: {
    schema: TargetSchema,
    valid: { kind: 'intent', text: 'the search box' },
    invalid: [
      { kind: 'nope', text: 'x' },
      { kind: 'ref', ref: 'e1' },
    ],
  },
  BrowserActionSchema: {
    schema: BrowserActionSchema,
    valid: { type: 'click', target: { kind: 'intent', text: 'Sign in' } },
    invalid: [{ type: 'bogus' }, { type: 'navigate' }],
  },
  ActionResultSchema: {
    schema: ActionResultSchema,
    valid: {
      ok: true,
      action: { type: 'navigate', url: 'https://x/' },
      tier: null,
      driver: null,
      attempts: [],
      url: 'https://x/',
      pageChanged: false,
      ms: 1,
      llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
      risk: null,
    },
    invalid: [
      {
        ok: true,
        action: { type: 'navigate', url: 'x' },
        tier: 'nope',
        driver: null,
        attempts: [],
        url: 'x',
        pageChanged: false,
        ms: 1,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
        risk: null,
      },
      {
        ok: false,
        action: { type: 'navigate', url: 'x' },
        tier: null,
        driver: 'cdp',
        attempts: [],
        url: 'x',
        pageChanged: false,
        ms: 1,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
        risk: null,
        error: { code: 'NOT_A_CODE', message: 'x' },
      },
    ],
  },
  TaskSchema: {
    schema: TaskSchema,
    valid: TASK,
    invalid: [
      { ...TASK, key: 'Bad Key' },
      { ...TASK, status: 'paused' },
    ],
  },
  TrajectorySchema: {
    schema: TrajectorySchema,
    valid: {
      id: 'trj_1',
      taskKey: 'spa.search-and-open',
      origin: 'https://x',
      startUrl: 'https://x/?q={{query}}',
      version: 1,
      params: ['query'],
      secretNames: [],
      steps: [],
      status: 'active',
      stats: { runs: 0, successes: 0, failures: 0, consecutiveFailures: 0, lastSuccessAt: null },
      createdAt: 1,
      updatedAt: 1,
    },
    invalid: [
      {
        id: 'trj_1',
        taskKey: 'k',
        origin: 'o',
        startUrl: 'u',
        version: 0,
        params: [],
        secretNames: [],
        steps: [],
        status: 'active',
        stats: { runs: 0, successes: 0, failures: 0, consecutiveFailures: 0, lastSuccessAt: null },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'trj_1',
        taskKey: 'k',
        origin: 'o',
        startUrl: 'u',
        version: 1,
        params: [],
        secretNames: [],
        steps: [],
        status: 'stale',
        stats: { runs: 0, successes: 0, failures: 0, consecutiveFailures: 0, lastSuccessAt: null },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
  TrajectoryStepSchema: {
    schema: TrajectoryStepSchema,
    valid: {
      index: 0,
      action: { type: 'navigate', url: 'https://x/' },
      intent: null,
      pre: { urlPattern: '/' },
      risk: 'low',
    },
    invalid: [
      { index: -1, action: { type: 'navigate', url: 'x' }, intent: null, pre: { urlPattern: '/' }, risk: 'low' },
      { index: 0, action: { type: 'navigate', url: 'x' }, intent: null, risk: 'low' },
    ],
  },
  ActionCacheEntrySchema: {
    schema: ActionCacheEntrySchema,
    valid: {
      key: 'a'.repeat(64),
      origin: 'https://x',
      pathTemplate: '/search',
      actionType: 'click',
      intent: 'the first result',
      locator: LOCATOR,
      hits: 0,
      misses: 0,
      consecutiveMisses: 0,
      status: 'active',
      createdAt: 1,
      lastHitAt: null,
    },
    invalid: [
      {
        key: 'k',
        origin: 'o',
        pathTemplate: 'p',
        actionType: 'bogus',
        intent: 'i',
        locator: LOCATOR,
        hits: 0,
        misses: 0,
        consecutiveMisses: 0,
        status: 'active',
        createdAt: 1,
        lastHitAt: null,
      },
      {
        key: 'k',
        origin: 'o',
        pathTemplate: 'p',
        actionType: 'click',
        intent: 'i',
        locator: LOCATOR,
        hits: 0,
        misses: 0,
        consecutiveMisses: 0,
        status: 'expired',
        createdAt: 1,
        lastHitAt: null,
      },
    ],
  },
  PolicySchema: {
    schema: PolicySchema,
    valid: {},
    invalid: [{ risk: { high: 'maybe' } }, { tiers: { llm: 'yes' } }],
  },
  PermissionRequestSchema: {
    schema: PermissionRequestSchema,
    valid: {
      id: 'perm_1',
      sessionId: 'ses_1',
      taskId: null,
      action: { type: 'click', target: { kind: 'intent', text: 'Delete account' } },
      risk: 'high',
      reasons: ['site policy: high=confirm'],
      url: 'https://x/',
      createdAt: 1,
    },
    invalid: [
      {
        id: 'x',
        sessionId: 's',
        taskId: null,
        action: { type: 'navigate', url: 'x' },
        risk: 'high',
        reasons: [],
        url: 'u',
        createdAt: 1,
      },
      {
        id: 'perm_1',
        sessionId: 's',
        taskId: null,
        action: { type: 'navigate', url: 'x' },
        risk: 'extreme',
        reasons: [],
        url: 'u',
        createdAt: 1,
      },
    ],
  },
  PermissionDecisionRecordSchema: {
    schema: PermissionDecisionRecordSchema,
    valid: { requestId: 'perm_1', decision: 'approve', decidedBy: 'human', decidedAt: 1 },
    invalid: [
      { requestId: 'perm_1', decision: 'maybe', decidedBy: 'human', decidedAt: 1 },
      { requestId: 'perm_1', decision: 'approve', decidedBy: 'robot', decidedAt: 1 },
    ],
  },
  HumanRequestSchema: {
    schema: HumanRequestSchema,
    valid: { id: 'req_1', sessionId: 'ses_1', taskId: null, reason: 'mfa', message: 'Enter the code', createdAt: 1 },
    invalid: [
      { id: 'perm_1', sessionId: 's', taskId: null, reason: 'mfa', message: 'x', createdAt: 1 },
      { id: 'req_1', sessionId: 's', taskId: null, reason: 'robot', message: 'x', createdAt: 1 },
    ],
  },
  HumanAnswerSchema: {
    schema: HumanAnswerSchema,
    valid: { choice: 'ref', ref: 'e12', observationId: 'obs_1' },
    invalid: [{ choice: 'nope' }, { choice: 'ref', ref: 'e12' }],
  },
  BosEventSchema: {
    schema: BosEventSchema,
    valid: { ts: 1, type: 'session.status', data: { status: 'ready' } },
    invalid: [
      { ts: 1, type: 'bogus', data: {} },
      { ts: 1, type: 'session.status', data: { status: 'idle' } },
    ],
  },
};

describe('schemas', () => {
  it('covers every protocol-crossing type the card lists', () => {
    expect(Object.keys(ROWS)).toHaveLength(22);
  });

  it.each(Object.entries(ROWS))('%s accepts its valid sample', (_name, row) => {
    const result = row.schema.safeParse(row.valid);
    if (!result.success) throw new Error(`${_name} rejected its valid sample: ${JSON.stringify(result.error.issues)}`);
    expect(result.success).toBe(true);
  });

  it.each(Object.entries(ROWS))('%s rejects two invalid samples', (_name, row) => {
    for (const sample of row.invalid) {
      expect(row.schema.safeParse(sample).success, `${_name} accepted ${JSON.stringify(sample)}`).toBe(false);
    }
  });
});

describe('PolicySchema defaults', () => {
  it('resolves an empty object to exactly DEFAULT_POLICY', () => {
    expect(PolicySchema.parse({})).toEqual(DEFAULT_POLICY);
  });

  it('requires all three risk keys when the file provides `risk` (the type is a full Record)', () => {
    // A config file spells the whole map, as protocol §6 shows. Partial overrides
    // are mergePolicy()'s job (DeepPartial), not the schema's.
    const parsed = PolicySchema.parse({
      risk: { low: 'allow', medium: 'allow', high: 'deny' },
      budgets: { maxLlmCallsPerTask: 5 },
    });
    expect(parsed.risk).toEqual({ low: 'allow', medium: 'allow', high: 'deny' });
    expect(parsed.budgets.maxLlmCallsPerTask).toBe(5);
    expect(parsed.budgets.maxLlmCallsPerAction).toBe(2);
    expect(parsed.downloads).toEqual({ enabled: false, dir: null });
    expect(PolicySchema.safeParse({ risk: { high: 'deny' } }).success).toBe(false);
  });
});

describe('regex constraints', () => {
  it('accepts the documented profile name and task key shapes', () => {
    expect(BrowserProfileSchema.safeParse({ ...PROFILE, name: 'a'.repeat(32) }).success).toBe(true);
    expect(BrowserProfileSchema.safeParse({ ...PROFILE, name: `a${UUID}` }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...TASK, key: 'a.b_c-d' }).success).toBe(true);
    expect(TaskSchema.safeParse({ ...TASK, key: '-leading' }).success).toBe(false);
  });
});
