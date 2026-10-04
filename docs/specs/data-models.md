# Spec: Data Models (`packages/protocol`)

**Status:** Authoritative for MVP · **Owner package:** `@browser-os/protocol`
**Related:** ADR-009 (DOM representation), ADR-010 (router), ADR-011 (trajectory memory), ADR-014 (security)

These types are the shared vocabulary of every package. They live in `packages/protocol/src/` and are the **only** types that cross package boundaries. Changing them requires an ADR (CODING_AGENT rule 11).

Rules:
- Keep them plain data (JSON-serializable). No classes, no functions, except the explicitly listed interfaces (`ModelProvider`, `CdpTransport`, `Clock`, `SecretResolver`).
- All timestamps are `number` (Unix epoch milliseconds).
- All IDs are strings created by `newId(prefix)` (§1).
- Every type that crosses the daemon protocol has a matching zod schema in `packages/protocol/src/schemas.ts` (task P1-03).

File layout:

```
packages/protocol/src/
├── ids.ts          §1
├── errors.ts       §2
├── browser.ts      §3  BrowserProfile, Session, PageInfo, FrameInfo
├── dom.ts          §4  SemanticElement, Observation, ElementLocator, ObservationIndex
├── actions.ts      §5  Target, ValueSource, BrowserAction, ActionResult
├── tasks.ts        §6  Task, Trajectory, TrajectoryStep, ActionCacheEntry
├── policy.ts       §7  RiskLevel, Policy, Permission*
├── context.ts      §8  ExecutionContext and injected interfaces
├── model.ts        §9  ModelRequest, ModelResponse, ModelProvider
├── events.ts       §10 BosEvent
├── rpc.ts          see specs/protocol.md
├── schemas.ts      zod schemas mirroring the above
├── mask.ts         SENSITIVE_NAME_RE, isSensitiveName(), isSensitiveField(), maskAction()   (integration §2)
├── event-bus.ts    tiny typed EventBus (on/off/emit), no dependencies
├── target-syntax.ts parseTargetString() shared by CLI and SDK (specs/protocol.md §5)
├── paths.ts        resolveBosHome(env, platform, homedir) (specs/memory.md §2)
└── index.ts        re-exports everything
```

---

## 1. IDs (`ids.ts`)

```ts
export type IdPrefix = 'prf' | 'ses' | 'pg' | 'obs' | 'tsk' | 'trj' | 'run' | 'perm' | 'req';

/** Returns `${prefix}_${26 chars}`: 10 chars base32 time + 16 chars base32 random. Sortable by creation time. */
export function newId(prefix: IdPrefix): string;
```

Implementation: `Date.now()` encoded in Crockford base32 (10 chars) followed by 16 random Crockford base32 chars from `crypto.getRandomValues`. No dependency.

---

## 2. Errors (`errors.ts`)

```ts
export type ErrorCode =
  // browser / session
  | 'BROWSER_NOT_FOUND'        // channel executable not installed
  | 'BROWSER_LAUNCH_FAILED'
  | 'BROWSER_DISCONNECTED'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_LOCKED'           // another process owns the user-data-dir
  | 'SESSION_NOT_FOUND'
  | 'PAGE_NOT_FOUND'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  // target resolution / execution
  | 'STALE_REF'                // ref belongs to an older observation
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_NOT_INTERACTABLE'  // hidden, disabled, zero-size
  | 'TARGET_OBSCURED'          // hit-test landed on another element
  | 'ACTION_FAILED'
  | 'VERIFICATION_FAILED'
  // AI
  | 'LLM_DISABLED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_INVALID_OUTPUT'
  | 'BUDGET_EXCEEDED'
  // security / human
  | 'PERMISSION_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'HUMAN_REQUIRED'
  | 'SECURITY_CHALLENGE'       // login wall, CAPTCHA, MFA detected
  // memory
  | 'TRAJECTORY_NOT_FOUND'
  | 'TRAJECTORY_STEP_FAILED'
  // protocol
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'CANCELLED'
  | 'INTERNAL';

export class BosError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;   // MUST NOT contain secrets
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, opts?: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown });
  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown>; retryable: boolean };
}

export function isBosError(e: unknown): e is BosError;
```

Default `retryable`: `true` for `STALE_REF`, `TARGET_OBSCURED`, `TIMEOUT`, `BROWSER_DISCONNECTED`, `LLM_UNAVAILABLE`; otherwise `false`.

---

## 3. Browser (`browser.ts`)

```ts
export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

export interface BrowserProfile {
  id: string;                 // prf_...
  name: string;               // unique, /^[a-z0-9][a-z0-9-]{0,31}$/
  channel: BrowserChannel;
  userDataDir: string;        // absolute; ALWAYS <dataDir>/profiles/<name> (ADR-003)
  headless: boolean;          // default false (real sites + human takeover need a visible window)
  createdAt: number;
  lastUsedAt: number | null;
}

export type SessionStatus =
  | 'starting'
  | 'ready'
  | 'busy'                    // an action is executing
  | 'waiting_for_human'
  | 'disconnected'            // browser gone or CDP dropped; reconnect possible
  | 'closed';

export interface Session {
  id: string;                 // ses_...
  profileId: string;
  status: SessionStatus;
  ownership: 'launched' | 'attached';   // launched = Browser-OS started the process
  headless: boolean;
  browserPid: number | null;  // may be null with persistent contexts (integration §13)
  cdpPort: number | null;     // internal; always null in protocol responses
  activePageId: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface PageInfo {
  id: string;                 // pg_... (Browser-OS id; maps internally to a CDP targetId)
  sessionId: string;
  url: string;
  title: string;
  openerPageId: string | null;
}

export interface FrameInfo {
  id: string;                 // "f0" main frame, "f1".. in document order, stable per observation
  parentId: string | null;
  url: string;
  name: string | null;
  outOfProcess: boolean;      // OOPIF → needs its own CDP session
}
```

---

## 4. DOM (`dom.ts`)

Full pipeline in `specs/dom-intelligence.md`.

```ts
export interface Rect { x: number; y: number; w: number; h: number }  // CSS px, top-level viewport coordinates

export interface ElementState {
  disabled?: true;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  selected?: true;
  focused?: true;
  required?: true;
  readonly?: true;
  editable?: true;            // input, textarea, contenteditable
}

/** What the model and the calling agent see. Compact by design. */
export interface SemanticElement {
  ref: string;                // "e1".."eN"; valid ONLY within the Observation that produced it
  role: string;               // computed ARIA role (button, link, textbox, combobox, checkbox, ...)
  name: string;               // accessible name, whitespace-collapsed, max 120 chars
  tag: string;                // lowercase tag name
  value?: string;             // current value, max 120 chars; "••••" for password or secret fields
  placeholder?: string;
  description?: string;       // aria-description / title, max 120 chars
  href?: string;              // links: same-origin → path only; cross-origin → full URL
  inputType?: string;         // <input type>
  state: ElementState;
  inViewport: boolean;
  rect: Rect | null;
  frame: string;              // FrameInfo.id ("f0" = main)
  context: string[];          // ≤ 2 nearest container labels, e.g. ["navigation:Primary", "dialog:Sign in"]
}

export interface TextBlock {
  ref: string;                // "t1".."tN"
  text: string;               // max 300 chars
  role: 'heading' | 'paragraph' | 'listitem' | 'cell' | 'status' | 'alert' | 'text';
  level?: number;             // heading level
  frame: string;
}

export interface Observation {
  id: string;                 // obs_...
  sessionId: string;
  pageId: string;
  url: string;
  title: string;
  capturedAt: number;
  frames: FrameInfo[];
  elements: SemanticElement[];     // interactive elements only
  text: TextBlock[];               // non-interactive visible text, only when requested (includeText)
  dialogs: string[];               // names of open modal dialogs (topmost first)
  challenge: ChallengeKind | null; // detected security challenge (specs/dom-intelligence.md §9)
  warnings: string[];              // e.g. "frame f3 omitted: AX timeout"
  stats: {
    domNodes: number;
    axNodes: number;
    elements: number;
    captureMs: number;             // CDP round trips
    buildMs: number;               // our processing
    estTokens: number;             // ceil(serializedLength / 4)
    large: boolean;                // domNodes > LARGE_PAGE_NODES (15000)
  };
}

export type ChallengeKind = 'login' | 'captcha' | 'mfa' | 'passkey' | 'consent' | 'unknown';

/**
 * Durable description of an element, stored in the action cache and trajectories.
 * Resolved against a fresh observation by the fingerprint matcher (specs/dom-intelligence.md §8).
 * Never contains user-typed values.
 */
export interface ElementLocator {
  v: 1;
  role: string;
  name: string;               // "" when nameIsDynamic
  nameIsDynamic: boolean;     // true if the name contained a param value at record time
  tag: string;
  attrs: Partial<Record<StableAttr, string>>;
  context: string[];
  cssPath: string;            // see dom-intelligence §8.2; shadow boundaries joined with " >>> "
  framePath: string[];        // iframe selectors from top; [] = main frame
  ordinal: number;            // 0-based index among elements with same role+name in that observation
}

export type StableAttr =
  | 'id' | 'name' | 'type' | 'placeholder' | 'aria-label' | 'title' | 'alt'
  | 'href' | 'autocomplete' | 'data-testid' | 'data-test' | 'data-qa' | 'role';

/** Value type of ObservationIndex.entries. */
export interface IndexEntry {
  backendNodeId: number;
  frameId: string;            // FrameInfo.id
  cdpFrameId: string;         // real CDP frame id
  locator: ElementLocator;
}

/** Internal (daemon-side only) index from refs to live nodes. Never sent to models or clients. */
export interface ObservationIndex {
  observationId: string;
  pageId: string;
  entries: Map<string, IndexEntry>;   // key = ref ("e12")
}
```

---

## 5. Actions (`actions.ts`)

The calling agent always names the **action type** explicitly. Only the **target** may be natural language. This keeps the deterministic tiers deterministic (ADR-010).

```ts
export type ValueSource =
  | { kind: 'literal'; value: string }   // stored in trajectories only if not sensitive
  | { kind: 'param'; name: string }      // value from task params; stored as the reference only
  | { kind: 'secret'; name: string };    // resolved at execution from SecretResolver; never stored, logged or sent to a model

export type Target =
  | { kind: 'ref'; ref: string; observationId: string }      // from a fresh observation (tier 'ref')
  | { kind: 'intent'; text: string }                          // natural language: "the search box"
  | { kind: 'query'; role?: string; name?: string; text?: string; css?: string; nth?: number } // structured, deterministic
  | { kind: 'locator'; locator: ElementLocator };             // from cache / trajectory

export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: Target; button?: 'left' | 'right' | 'middle'; clickCount?: 1 | 2 }
  | { type: 'fill'; target: Target; value: ValueSource; submit?: boolean }   // submit = press Enter after
  | { type: 'press'; key: string; target?: Target }                          // Playwright key syntax: "Enter", "Control+A"
  | { type: 'select'; target: Target; value: ValueSource }                   // matches option value, then label
  | { type: 'hover'; target: Target }
  | { type: 'scroll'; target?: Target; direction: 'up' | 'down'; amountPx?: number }
  | { type: 'wait'; until: 'load' | 'domcontentloaded' | 'settled'; timeoutMs?: number }
  | { type: 'waitFor'; target: Target; state?: 'visible' | 'hidden'; timeoutMs?: number }
  | { type: 'extract'; target?: Target; format: 'text' | 'links' | 'table' }
  | { type: 'upload'; target: Target; paths: string[] };   // absolute paths; checked against policy.uploads.allowedDirs

export type ActionType = BrowserAction['type'];

/** Actions with no target need no resolution. */
export const TARGETLESS: ReadonlySet<ActionType>; // navigate, wait, (press|scroll|extract when target undefined)

export type Tier = 'ref' | 'cache' | 'deterministic' | 'llm' | 'vision' | 'human';
export type Driver = 'cdp' | 'playwright';

export interface TierAttempt {
  tier: Tier;
  ok: boolean;
  ms: number;
  reason?: ErrorCode;
  candidates?: number;        // number of candidates considered
  score?: number;             // best match score (0..1) where applicable
}

export interface ActionResult {
  ok: boolean;
  action: BrowserAction;      // as requested, with literal values of sensitive fields masked
  tier: Tier | null;          // tier that resolved the target; null for targetless actions
  driver: Driver | null;
  attempts: TierAttempt[];
  element?: { ref: string; role: string; name: string };
  locator?: ElementLocator;   // what was resolved (used by recorder and cache)
  url: string;                // url after the action
  pageChanged: boolean;       // navigation or url change happened
  extracted?: unknown;        // for 'extract'
  ms: number;
  llm: { calls: number; inputTokens: number; outputTokens: number };
  risk: RiskLevel | null;     // computed risk (null for actions that never reached classification)
  error?: { code: ErrorCode; message: string; details?: Record<string, unknown> };  // e.g. { effect:'unknown' }, { reason:'mfa' }, { candidates:[…] }; never secrets
}
```

---

## 6. Tasks, trajectories, cache (`tasks.ts`)

```ts
export type TaskStatus = 'running' | 'waiting_for_human' | 'completed' | 'failed' | 'cancelled';
export type TaskMode = 'record' | 'replay' | 'auto';   // auto = replay if an active trajectory exists, else record

export interface TaskStats {
  actions: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  visionCalls: number;
  humanInterventions: number;
  cacheHits: number;
  healedSteps: number;
  ms: number;
}

export interface Task {
  id: string;                 // tsk_...
  key: string;                // /^[a-z0-9][a-z0-9._-]{0,63}$/, e.g. "linkedin.search-people"; chosen by the caller
  sessionId: string;
  mode: TaskMode;
  resolvedMode: 'record' | 'replay' | null;   // decided at start (integration §10)
  params: Record<string, string>;   // non-secret params; persisted
  secretNames: string[];            // names only
  status: TaskStatus;
  trajectoryId: string | null;
  startedAt: number;
  endedAt: number | null;
  stats: TaskStats;
}

export interface TrajectoryStep {
  index: number;
  action: BrowserAction;      // targets are { kind: 'locator' }, EXCEPT { kind: 'intent' } when a human performed the step manually
                              // (action-router §5.3); values ALWAYS param/secret refs or non-sensitive literals
  intent: string | null;      // original natural-language target, used for healing
  pre: { urlPattern: string };     // path template the page must match before this step (specs/memory.md §4)
  post?: { urlPattern?: string };
  risk: RiskLevel;
}

export interface Trajectory {
  id: string;                 // trj_...
  taskKey: string;
  origin: string;             // origin of the first step's page, e.g. "https://www.linkedin.com"
  startUrl: string;           // URL before the first step, param values replaced by {{name}}
  version: number;            // increments when healing rewrites a step
  params: string[];
  secretNames: string[];
  steps: TrajectoryStep[];
  status: 'active' | 'suspect' | 'invalid';
  stats: { runs: number; successes: number; failures: number; consecutiveFailures: number; lastSuccessAt: number | null };
  createdAt: number;
  updatedAt: number;
}

export interface ActionCacheEntry {
  key: string;                // sha256(origin | pathTemplate | actionType | normalizedIntent), hex
  origin: string;
  pathTemplate: string;
  actionType: ActionType;
  intent: string;             // normalized intent text
  locator: ElementLocator;
  hits: number;
  misses: number;
  consecutiveMisses: number;
  status: 'active' | 'invalid';
  createdAt: number;
  lastHitAt: number | null;
}
```

---

## 7. Policy & permissions (`policy.ts`)

```ts
export type RiskLevel = 'low' | 'medium' | 'high';
export type PermissionDecision = 'allow' | 'confirm' | 'deny';

export interface SitePolicy {
  originPattern: string;      // exact origin or "*.example.com" wildcard
  access?: 'allow' | 'deny';  // deny = Browser-OS refuses to act on this origin
  risk?: Partial<Record<RiskLevel, PermissionDecision>>;
}

export interface Policy {
  risk: Record<RiskLevel, PermissionDecision>;  // default { low: 'allow', medium: 'allow', high: 'confirm' }
  sites: SitePolicy[];                          // first match wins; overrides `risk`
  tiers: { llm: boolean; vision: boolean; human: boolean };
  budgets: {
    maxLlmCallsPerAction: number;               // default 2
    maxLlmCallsPerTask: number;                 // default 20
    maxRetriesPerAction: number;                // default 2
    actionTimeoutMs: number;                    // default 15000
    humanTimeoutMs: number;                     // default 600000
  };
  uploads: { allowedDirs: string[] };           // default [] = uploads disabled
  downloads: { enabled: boolean; dir: string | null };
}

export interface PermissionRequest {
  id: string;                 // perm_...
  sessionId: string;
  taskId: string | null;
  action: BrowserAction;      // masked
  risk: RiskLevel;
  reasons: string[];          // e.g. ["element name matches 'delete'", "site policy: high=confirm"]
  element?: { role: string; name: string };
  url: string;
  createdAt: number;
}

export interface PermissionDecisionRecord {
  requestId: string;
  decision: 'approve' | 'reject';
  decidedBy: 'human' | 'policy';
  decidedAt: number;
}
```

---

## 8. Execution context (`context.ts`)

```ts
export interface Clock { now(): number }

export interface SecretResolver {
  /** Returns the secret value or throws BosError('PERMISSION_DENIED'). Never logs the value. */
  resolve(name: string): Promise<string>;
}

/** Minimal CDP interface so `dom` does not depend on Playwright (implemented in `browser`). */
export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (params: unknown) => void): () => void;  // returns unsubscribe
}

export interface Budget {
  llmCallsAction: number;     // reset at the start of every execute()
  llmCallsActionMax: number;  // policy.budgets.maxLlmCallsPerAction
  llmCallsTask: number;       // shared across a task's actions (owned by TaskManager)
  llmCallsTaskMax: number;    // policy.budgets.maxLlmCallsPerTask; Infinity outside a task
  deadline: number;           // epoch ms
}

/** Implemented by @browser-os/browser (IsolatedWorlds); lets dom run helpers without importing browser. */
export interface HelperWorlds {
  registerHelper(name: string, source: string): void;
  evaluate<T>(cdpFrameId: string, fnSource: string, args?: unknown[]): Promise<T>;
  /** fnSource returns Element[]; resolves to their backendNodeIds (max 5). */
  evaluateElements(cdpFrameId: string, fnSource: string, args?: unknown[]): Promise<number[]>;
}

export interface HumanRequest {
  id: string;                 // req_...
  sessionId: string;
  taskId: string | null;
  reason: ChallengeKind | 'ambiguous' | 'failed';
  message: string;
  candidates?: { ref: string; role: string; name: string }[];
  observationId?: string;
  createdAt: number;
}

export type HumanAnswer =
  | { choice: 'ref'; ref: string; observationId: string }
  | { choice: 'done' }
  | { choice: 'abort' };

export interface ExecutionContext {
  sessionId: string;
  pageId: string;
  taskId: string | null;
  policy: Policy;
  params: Record<string, string>;
  secrets: SecretResolver;
  budget: Budget;
  signal: AbortSignal;
  clock: Clock;
}
```

---

## 9. Models (`model.ts`)

```ts
export type ModelTier = 'fast' | 'capable' | 'vision';
export type ModelPurpose = 'resolve_target' | 'extract' | 'vision_locate';

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string };

export interface ModelMessage { role: 'user' | 'assistant'; content: string | ModelContentPart[] }

export interface ModelRequest {
  purpose: ModelPurpose;
  tier: ModelTier;
  system: string;
  messages: ModelMessage[];
  jsonSchema?: Record<string, unknown>;   // when set, provider must return JSON matching it
  maxOutputTokens: number;
  temperature: number;                    // 0 for resolution
  timeoutMs: number;
}

export interface ModelResponse {
  text: string;
  json?: unknown;             // parsed when jsonSchema was set (still validated by caller with zod)
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  latencyMs: number;
}

export interface ModelProvider {
  readonly id: string;        // e.g. "openai-compatible:gpt-x", "anthropic:claude-x", "fake"
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
```

---

## 10. Events (`events.ts`)

All observability flows through one event type. Field names follow OpenTelemetry semantic style so an OTel exporter can be added later without renaming (ADR-015).

```ts
export interface EventEnvelope<T extends string, D> {
  ts: number;
  type: T;
  sessionId?: string;
  taskId?: string;
  data: D;
}

export type BosEvent =
  | EventEnvelope<'session.status', { status: SessionStatus; reason?: string }>
  | EventEnvelope<'observation.captured', { observationId: string; url: string; elements: number; domNodes: number; captureMs: number; buildMs: number; estTokens: number }>
  | EventEnvelope<'action.started', { actionId: string; action: BrowserAction }>
  | EventEnvelope<'action.tier', { actionId: string; attempt: TierAttempt }>
  | EventEnvelope<'action.completed', { actionId: string; result: ActionResult }>
  | EventEnvelope<'model.call', { purpose: ModelPurpose; model: string; ms: number; inputTokens: number; outputTokens: number; ok: boolean }>
  | EventEnvelope<'cache.hit' | 'cache.miss' | 'cache.write' | 'cache.invalidate', { key: string; reason?: string }>
  | EventEnvelope<'task.started' | 'task.completed' | 'task.failed', { task: Task }>
  | EventEnvelope<'trajectory.healed', { trajectoryId: string; step: number; newVersion: number }>
  | EventEnvelope<'human.required', { reason: ChallengeKind | 'ambiguous' | 'failed'; message: string }>
  | EventEnvelope<'human.resolved', { outcome: 'resumed' | 'aborted' }>
  | EventEnvelope<'permission.requested', { request: PermissionRequest }>
  | EventEnvelope<'permission.decided', { record: PermissionDecisionRecord }>
  | EventEnvelope<'page.navigated', { pageId: string; url: string }>
  | EventEnvelope<'download.completed', { pageId: string; path: string }>;
```

Invariant (tested): no event payload may contain a resolved secret value or the value of a sensitive field. Masking follows `specs/integration.md` §2 exactly: one regex (`SENSITIVE_NAME_RE`), `isSensitiveField()` and `maskAction()` all live in `packages/protocol/src/mask.ts`. `action.started` masks every literal; later events mask literals of sensitive targets.
