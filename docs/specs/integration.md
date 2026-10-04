# Spec: Integration Contracts (reconciliation layer)

**Status:** Authoritative · **Written:** 2026-10-02, after an independent consistency review.
**Precedence:** where this file conflicts with any other spec, task card or cross-cutting doc, **this file wins**. It defines the contracts that several tasks must agree on. When you implement a task, also check this file for the interfaces you touch.

---

## 1. Verification commands

Packages export `./dist/index.js`, so **build before typecheck/test**:

```bash
pnpm build && pnpm -r typecheck && pnpm lint && pnpm test
```

P0-01 also adds a `"source"` export condition (`"source": "./src/index.ts"`) to every package and configures Vitest with `resolve.conditions: ['source']`, so tests always run against the sources and never a stale `dist`.

---

## 2. Masking and sensitivity (single source of truth)

`packages/protocol/src/mask.ts` exports the **only** sensitivity regex. Every other document that lists a regex refers to this one.

```ts
export const SENSITIVE_NAME_RE =
  /pass|secret|token|otp|one.?time|2fa|mfa|cvv|cvc|card.?number|cc.?number|\bpin\b|security.?code|verification.?code/i;

export function isSensitiveName(s: string | undefined | null): boolean;

/** Field-level check used by dom and runtime. */
export function isSensitiveField(f: { inputType?: string; name?: string; id?: string; autocomplete?: string; ariaLabel?: string }): boolean;
// true if inputType === 'password' or autocomplete in {'one-time-code','cc-number','cc-csc','current-password','new-password'}
// or any of name/id/ariaLabel/autocomplete matches SENSITIVE_NAME_RE

export function maskAction(action: BrowserAction, opts?: { sensitiveTarget?: boolean }): BrowserAction;
```

`isSensitiveField` lives in `protocol` (not `dom`). P4-01 imports it from protocol.

Masking rules:
- **Before target resolution** (event `action.started`, any log line written before resolution): mask **every** `literal` value (`sensitiveTarget` is unknown, so treat it as `true`).
- **After resolution** (`action.completed`, `action_runs`, audit, traces): `sensitiveTarget = isSensitiveField(fieldsOf(entry.locator))`, where `fieldsOf` maps `locator.attrs` (`type`→inputType, `name`, `id`, `autocomplete`, `aria-label`→ariaLabel).
- `secret` refs are always shown as references (`{ kind:'secret', name }`), never resolved.

---

## 3. Protocol type additions (already applied in data-models.md)

- `Session.headless: boolean`
- `ActionResult.error.details?: Record<string, unknown>` (e.g. `{ effect: 'unknown' }`, `{ candidates: [...] }`, `{ reason: 'mfa' }`) and `ActionResult.risk: RiskLevel | null`
- `BrowserAction` gains `{ type: 'upload'; target: Target; paths: string[] }` (risk R8; paths checked by policy)
- `Task.resolvedMode: 'record' | 'replay' | null`
- `Trajectory.startUrl: string` (URL before the first recorded step, with `{{param}}` placeholders)
- `Budget` has per-action and per-task counters (§7)
- `HelperWorlds`, `HumanRequest`, `HumanAnswer` interfaces/types (§4, §9)
- Events: `page.navigated { pageId, url }`, `download.completed { path }`

---

## 4. Helper worlds (so `dom` never imports `browser`)

```ts
// packages/protocol/src/context.ts
export interface HelperWorlds {
  /** Register a helper script installed in every 'bos' isolated world (idempotent). */
  registerHelper(name: string, source: string): void;
  /** Evaluate a function in the 'bos' world of a frame; returnByValue. */
  evaluate<T>(cdpFrameId: string, fnSource: string, args?: unknown[]): Promise<T>;
  /** Evaluate a function returning Element[] in the 'bos' world; resolves to their backendNodeIds (max 5). */
  evaluateElements(cdpFrameId: string, fnSource: string, args?: unknown[]): Promise<number[]>;
}
```

`packages/browser` implements it (`IsolatedWorlds implements HelperWorlds`, P2-03). `dom.probe(cdp, worlds: HelperWorlds, locator)` uses it. The **main frame's** `cdpFrameId` comes from `Page.getFrameTree`.

---

## 5. Router dependencies and page context (supersedes action-router §3 `RouterDeps`)

```ts
// packages/runtime/src/router/types.ts
export interface PageContext {
  sessionId: string;
  pageId: string;
  driver: PageDriver;                  // from @browser-os/browser
  cdp: CdpTransport;
  worlds: HelperWorlds;
  mainCdpFrameId: string;
  headless: boolean;
}

export interface RouterDeps {
  pages: { context(sessionId: string, pageId: string): Promise<PageContext> };   // implemented by SessionManager
  sessions: {
    withPageLock<T>(sessionId: string, pageId: string, fn: () => Promise<T>): Promise<T>;
    reconnect(sessionId: string): Promise<Session>;
    setActivePage(sessionId: string, pageId: string): void;
  };
  observer: Observer;                  // action-router §3.1
  cache: ActionCachePort;              // structural subset of ActionCacheStore
  runs: RunPort;                       // structural subset of RunStore
  models: { get(tier: ModelTier): ModelProvider | null };
  vision: VisionResolver;              // NullVisionResolver in MVP
  risk: RiskClassifier;
  permissions: PermissionGate;
  human: HumanGate;
  events: EventBus;
  clock: Clock;
  constants?: Partial<RouterConstants>;
  disabledTiers?: ReadonlyArray<'cache' | 'deterministic' | 'llm'>;   // benchmark/test-only
}

export interface ExecuteOptions {
  healIntent?: string | null;          // trajectory replay (action-router §5.4)
  recordedRisk?: RiskLevel | null;     // effective risk = max(live, recordedRisk) (SECURITY §5.4)
  recorder?: TrajectoryRecorder | null; // per task; passed by TaskManager
}

execute(action: BrowserAction, ctx: ExecutionContext, opts?: ExecuteOptions): Promise<ActionResult>;
```

Function names are final (they override names used in prose elsewhere):
- `PermissionGate.decide(risk, policy, origin): 'allow' | 'confirm' | 'deny'` and `PermissionGate.requestConfirmation(req: PermissionRequest): Promise<'approve' | 'reject'>` (no `check`)
- `TrajectoryRecorder.append(result, ctx, intent, risk)`, `isRecording()`, `finalize(success)`
- `resolveLocator(...)` is the public name; `tryResolveLocator` in action-router §5 means the same function
- `Resolution.element` carries `{ ref: string | null; role: string; name: string; context: string[] }`; `disabled` lives on `Resolution`

---

## 6. Driver call semantics (supersedes action-router §4 step F pseudo-code)

Drivers **return** a `DriverResult`; they never throw for action failures.

```text
r = driver.cdpPerform(action, target, value)
if !r.ok and r.effect == 'none' and r.error.code in {TARGET_OBSCURED, TARGET_NOT_INTERACTABLE, ACTION_FAILED}:
    r = driver.playwrightPerform(action, target, value)        # target = ResolvedTarget (carries the locator)
if !r.ok: return failure(r.error, details: { effect: r.effect })
```

- `VERIFICATION_FAILED` from `fill` has `effect: 'committed'` → **no** fallback, no retry. Return the failure. (This supersedes "retryable once via Playwright executor" in action-router §7.)
- `navigate` and `upload` go straight to the Playwright path.
- **`wait`**: `until: 'settled'` → `driver.settle(quietMs, timeoutMs ?? settleMaxMs)`; `'load'`/`'domcontentloaded'` → `driver.waitForLoadState(state, timeoutMs)` (add to `PageDriver`, implemented in P3-05).
- **`waitFor`**: the router polls `resolveLocator`/query/lexical resolution (no LLM) every `probeIntervalMs` until the target is visible (or absent for `state:'hidden'`), up to `timeoutMs ?? actionTimeoutMs`, then fails with `TIMEOUT`. Implemented in P7-02 (ref/query targets) and P7-03 (intent/locator targets).
- `PageDriver.mutationCounter()` is implemented in **P3-05** (settle needs it) via `HelperWorlds`.
- **New tabs:** `newPageId` detection is non-blocking. The driver records pages opened (via `onPage`) between dispatch and the end of `settle()`. No fixed wait.

Reconnect: on `BROWSER_DISCONNECTED` the router calls `sessions.reconnect` once and restarts resolution from tier 0/1.

---

## 7. Budgets

```ts
export interface Budget {
  llmCallsAction: number;   llmCallsActionMax: number;   // reset at the start of every execute()
  llmCallsTask: number;     llmCallsTaskMax: number;     // lives on the task (TaskManager), shared across execute() calls of that task
  deadline: number;
}
```

An LLM call is allowed only if both counters are below their max. Outside a task, `llmCallsTaskMax = Infinity`.

---

## 8. Challenges and human pauses (supersedes conflicting lines in action-router §4 D and P7-04)

- The **router** captures and checks `observation.challenge`. `HumanGate` never captures.
- On a challenge: if `PageContext.headless` → fail `SECURITY_CHALLENGE` (`details.reason = kind`). Otherwise → `human.pause({ reason: kind })`.
  - `done` → the router re-captures. If the challenge is gone, it restarts resolution. If still present, it pauses again. **Max 2 pauses per action**, then `HUMAN_REQUIRED` (`details.reason = kind`).
  - `abort` / timeout → `HUMAN_REQUIRED` with `details.reason = kind`.
- With the P7 stub gate (`RejectingHumanGate`, answers `abort`), a challenge yields `HUMAN_REQUIRED` with `details.reason = 'login'` etc. (P7-04 tests expect this, not `SECURITY_CHALLENGE`, unless the session is headless).
- Replayer rule: a failure with `SECURITY_CHALLENGE`, `HUMAN_REQUIRED` whose `details.reason` is a `ChallengeKind`, or `PERMISSION_DENIED` → do not call `recordRun`.

---

## 9. Human requests

```ts
export interface HumanRequest {
  id: string;                       // req_...
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
```

---

## 10. Tasks: modes and replacement

- `task.start({ mode: 'auto' })` with a live trajectory → returns the `Task` with `resolvedMode: 'replay'` and **does not execute anything**. The caller then calls `task.run` (the CLI prints `trajectory exists: run 'bos task run <key>'`) and the started task is closed as `cancelled`. With no live trajectory → `resolvedMode: 'record'`.
- `task.start({ mode: 'record' })` with a live trajectory → allowed. On `task.end({ success: true })` the TaskManager calls `TrajectoryStore.invalidate(key)` (add this method in P6-05), then `createRecorded`.
- `task.run` result: `{ task: Task; outputs: unknown[] }`, where `outputs` holds the `extracted` values of extract steps in order. Outputs are returned, never persisted.
- Before replaying, if the current page's `pathTemplate`/origin does not match step 0's `pre.urlPattern`/`trajectory.origin` and step 0 is not a `navigate`, the replayer navigates to `trajectory.startUrl` (params substituted).

---

## 11. Locator and DOM function signatures (final)

```ts
buildLocator(table: NodeTable, rowIdx: number, element: SemanticElement, observation: Observation): ElementLocator
applyParamsToLocator(locator: ElementLocator, paramValues: Record<string, string>): ElementLocator
matchLocator(observation: Observation, index: ObservationIndex, locator: ElementLocator, actionType?: ActionType)
  : { ref: string; entry: IndexEntry; score: number }[]           // sorted desc
verifyIdentity(candidate: ProbeCandidate, locator: ElementLocator, actionType?: ActionType): number
probe(cdp: CdpTransport, worlds: HelperWorlds, mainCdpFrameId: string, locator: ElementLocator): Promise<ProbeCandidate[]>
locatorFor(page /* Playwright Page, internal to browser */, locator: ElementLocator)
parseIntent(text: string): { tokens; exact; roleHints; searchBonus }    // dom (P4-01): renamed from normalizeIntent
normalizeIntent(text: string, params: Record<string,string>): string   // memory (P6-02): cache-key normalization
```

**One element line format:** dom-intelligence §6.4 is the single grammar (`(expanded)` only when `expanded === true`; nothing when false). The LLM prompt (action-router §5.2.1) uses exactly the same line format. `packages/ai` re-implements the formatter for `SemanticElement` (it cannot import dom). P7-04 adds a parity test comparing both on the same sample.

---

## 12. Fake model across processes and truth data

- `truth.json` entries carry role and name as well as css: `{ "action": "click", "intent": "...", "expect": { "css": "#q", "role": "combobox", "name": "Search people" } }`.
- `truthResponder(truth: TruthFile)` answers a `resolve_target` request by parsing the candidate lines in the prompt and returning the ref whose role and name equal `expect.role`/`expect.name` for that intent (else `ref: null`). It needs no access to observations, so it works inside the daemon.
- Test-only config provider (documented as such in protocol §6):
  `{ "provider": "fake", "truthFile": "<abs path>", "latencyMs": 0, "dumpRequestsTo": "<abs path to jsonl>" }`. The fake provider appends every `ModelRequest` as JSONL to `dumpRequestsTo`, so P8-08/P9-06 can inspect requests from another process.
- P5-01 `FakeModelProvider` options: `{ responder, latencyMs?, jitterMs?, clock? }` (jitter ±`jitterMs`, uniform). TESTING.md names (`fake.ts`, `respond`) are superseded by P5-01's names.
- Other config additions: `models.<tier>.maxTokensParam?: 'max_tokens' | 'max_completion_tokens'` (default `max_tokens`).

---

## 13. Browser launch details

- **Channel:** use exactly the profile's channel. `chrome`/`msedge` not installed → `BROWSER_NOT_FOUND` (never a silent fallback to bundled Chromium on the same profile). Only profiles created with channel `chromium` use Playwright's bundled Chromium.
- **Pid:** `launchPersistentContext` may not expose the browser process. `BrowserHandle.pid` / `Session.browserPid` may be `null`. Verify in P2-04 what Playwright exposes and note it.
- **Crash simulation in tests (P2-07):** send `Browser.close` through a page CDP session. If that is not permitted, POSIX tests kill the pid read from the profile's `SingletonLock` (`hostname-pid`) and Windows skips the crash test (documented).
- **S2 check:** no `DevToolsActivePort` file in the profile dir and no `--remote-debugging-port` in the launch args.
- `Session.cdpPort` is always `null` in protocol responses (internal only).

---

## 14. Daemon binary location (cli/sdk cannot import daemon)

- `@browser-os/cli` lists `@browser-os/daemon` in `dependencies` **only to ship its binary**. `check-boundaries.mjs` allows this declaration but still forbids importing it in `src/`.
- Spawn path resolution (SDK `autostart.ts`, CLI `daemon start`): `opts.daemonBin` → env `BOS_DAEMON_BIN` → `createRequire(import.meta.url).resolve('@browser-os/daemon/package.json')` → its `bin['bos-daemon']`. Not found → error telling the user to install `@browser-os/cli` or set `BOS_DAEMON_BIN`. Spawn with `process.execPath` + the resolved JS file.

---

## 15. Workspace test imports

- `tests/package.json` lists every workspace package as a dependency (`workspace:*`).
- Root `package.json` lists the workspace packages needed by `scripts/` as devDependencies.
- Browser tests inside `packages/<pkg>/test/` may import `@browser-os/tests` helpers (declare it as a devDependency of that package). `check-boundaries.mjs` scans `src/` only.
- `benchmarks/test/**/*.test.ts` is part of the vitest `unit` project.

---

## 16. Audit and events

- `ActionResult.risk` carries the computed risk, so audit rows (P9-04) read it from `action.completed`.
- Only **P9-04** writes audit rows. P9-02 emits `permission.requested/decided` events and does not write audit rows.
- `page.navigated` is emitted by the session manager on main-frame navigations. `download.completed` replaces the `session.status` "download-complete" reason.

---

## 17. Numbers and labels

- Performance numbers: **PERFORMANCE.md (L1–L18, E1–E8) is authoritative.** Numbers in ROADMAP or task cards are informal and lose on conflict.
- Supervision labels: the **Supervision column in `docs/tasks/README.md`** is authoritative.
- Benchmark file layout: the P10 task cards are authoritative over BENCHMARKS.md §2 file names.
