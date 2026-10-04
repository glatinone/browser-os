# Phase 7: Router, recorder, replayer → vertical slice (M3)

Read first: `docs/specs/action-router.md` (entire, twice), `docs/specs/memory.md` §5–7, `docs/PRD.md` §7, ADR-010, ADR-011.
This phase is the **core of Browser-OS**. Most tasks need expert review.

Security pieces (`RiskClassifier`, `PermissionGate`, `HumanGate`) get **stub implementations** in P7-01. Phase 9 replaces them without changing the interfaces.

---

## P7-01 · Execution context, budgets, secrets, stub gates

| Field | Value |
|---|---|
| depends_on | P1-04, P6-01 |
| supervision | cheap-ok |
| size | S |
| spec | data-models §7–8; action-router §3 |

**Files:**
- `packages/runtime/src/router/context.ts`
- `src/security/interfaces.ts`
- `src/security/stubs.ts`
- `src/secrets.ts`
- tests

**Requirements**
1. `createExecutionContext({ sessionId, pageId, taskId, policy, params, secrets, clock, signal })` with `budget` initialized from the policy.
2. `budgetAvailable(ctx)`, `consumeLlmCall(ctx)` (throws `BUDGET_EXCEEDED`).
3. `SecretResolver` implementations:
   - `MapSecretResolver(values)` for per-call `secretValues`
   - `EnvSecretResolver(env)` for `BOS_SECRET_<NAME>`
   - `chain(a, b)`

   Missing secret → `PERMISSION_DENIED` with the name only.
4. Interfaces:
   - `RiskClassifier.classify(action, element | null, url, policy) → { risk, reasons }`
   - `PermissionGate.decide(...) → 'allow' | 'confirm' | 'deny'` and `requestConfirmation(...) → Promise<'approve' | 'reject'>`
   - `HumanGate.pause({ sessionId, taskId, reason, message, candidates? }) → Promise<HumanAnswer>`
5. Stubs:
   - `StaticRiskClassifier` (always `low`)
   - `PolicyPermissionGate` (uses `policy.risk`, auto-rejects `confirm` in stub mode)
   - `RejectingHumanGate` (immediately `{ choice: 'abort' }`)

**Tests:** budgets; resolver chain; secrets never appear in error messages.

---

## P7-02 · Router core

| Field | Value |
|---|---|
| depends_on | P7-01, P3-03, P3-04, P3-05, P4-11, P6-06 |
| supervision | **expert** |
| size | L (split the PR into two commits: pipeline, then tests) |
| spec | action-router §3, §4, §4.1, §6, §7, §9; SECURITY.md S20 |

**Files:**
- `packages/runtime/src/router/router.ts`
- `router/constants.ts`
- `router/resolve-ref.ts`
- `router/resolve-query.ts`
- `router/execute.ts`
- `router/verify.ts`
- tests `packages/runtime/test/router-core.test.ts` (fakes), `test/router-core.browser.test.ts`

**Requirements**
1. `ActionRouter.execute(action, ctx, opts)` implementing §4 steps A, B, C (ref and query targets only; intent and locator come in P7-03), E (using the gate interfaces), F, G and the `action_runs` persistence. Events: `action.started`, `action.tier`, `action.completed`.
2. `execute` never throws except `CANCELLED`. All failures become `ActionResult{ ok: false }`.
3. Driver fallback only when `effect === 'none'`. `effect: 'unknown'` → `ACTION_FAILED` with `details.effect`, no retry (S20).
4. Per-page lock via `SessionManager.withPageLock`. `observer.invalidate(pageId)` after every executed action.
5. Stale ref healing (§5 `case 'ref'`) using the locator from the old index + `matchLocator` on a fresh observation (probe not required here).
6. `disabledTiers` option (benchmark-only).
7. Verification and settle per §7; `pageChanged`, `url`, `newPageId` → session active page.

**Tests:**
- Unit with fakes:
  - targetless navigate
  - ref happy path
  - stale ref heal
  - query unique, ambiguous and not found
  - fallback on `TARGET_OBSCURED`
  - no fallback on `unknown`
  - verification failure path
  - `action_runs` row written
  - events order
- Browser: click and fill on `basic` by ref from a real observation; obscured overlay button falls back to Playwright.

**Acceptance criteria**
- [ ] S20 test present
- [ ] Router overhead (fake driver, fake observer) p50 ≤ 5 ms in a micro test

---

## P7-03 · Intent tiers: cache, deterministic, learning

| Field | Value |
|---|---|
| depends_on | P7-02, P4-07, P4-09, P6-04 |
| supervision | **expert** |
| size | M |
| spec | action-router §5 (`case 'intent'`, `case 'locator'`), §5.1, §5.4; memory §4–5 |

**Files:** `packages/runtime/src/router/resolve-intent.ts`, `router/resolve-locator.ts`, `router/learn.ts`, tests `test/router-intent.test.ts`, `test/router-intent.browser.test.ts`.

**Requirements**
1. `resolveLocator` per §5.1: probe loop (main frame) → full match → thresholds from constants.
2. Intent path: cache lookup (`cacheKey`, then `siteKey`) → `tryResolveLocator` → `recordMiss` on failure → lexical decision → (LLM in P7-04) → (human in P7-04).
3. `{kind:'locator'}` targets plus `opts.healIntent` per §5.4.
4. Learning per §4 step H: `applyParamsToLocator(locator, ctx.params)` then `cache.put` for intent targets resolved by `deterministic`/`llm`/`human(ref)`; `recordHit` for cache-tier successes; `invalidate` on false hit (cache-tier resolution followed by `VERIFICATION_FAILED`).
5. Compatibility filter (`isCompatible`) applied before lexical ranking.

**Tests:**
- Unit:
  - first intent call → deterministic + cache write
  - second identical call → cache tier, `FakeModelProvider.calls === 0`
  - site-key fallback on another path
  - 3 misses → invalid
  - false hit → invalidate
  - healIntent path continues at the deterministic tier
- Browser (fixture `spa`): second run of the same intent resolves via probe without a full observation (assert `observer.capture` not called, using a spy).

**Acceptance criteria**
- [ ] Zero model calls asserted in every cache/deterministic test
- [ ] L12 printed (informational)

---

## P7-04 · LLM tier and human hook

| Field | Value |
|---|---|
| depends_on | P7-03, P5-05 |
| supervision | **expert** (review) |
| size | S |
| spec | action-router §5 (tiers 3–5), §5.2, §5.3; SECURITY.md §9 |

**Files:** `packages/runtime/src/router/resolve-llm.ts`, `router/resolve-human.ts`, `router/vision.ts` (`NullVisionResolver`), tests.

**Requirements**
1. Candidate selection (`topK` with viewport fill) per §5.2 → `resolveWithModel` → budget consumption → validated ref → index entry.
2. Skip when `policy.tiers.llm` is false or no `fast` model (`LLM_DISABLED` attempt) or the budget is exhausted (`BUDGET_EXCEEDED` attempt).
3. `VisionResolver` interface (`resolve(observation, action, intent, ctx) → Promise<IndexEntry | null>`) with a `NullVisionResolver` that returns null without recording an attempt. MVP never calls a vision model.
4. Human tier per §5.3 through `HumanGate.pause`: `ref` → resolved (tier `human`, cache written); `done` → `ok: true`, no execution; `abort`/timeout → `HUMAN_REQUIRED`.
5. A security challenge on the page (observation.challenge) → `HumanGate.pause({ reason: challenge })` before resolution continues (§4 step D). With `RejectingHumanGate` → `SECURITY_CHALLENGE` failure.

**Tests:** ambiguous intent → LLM picks a ref (truthResponder); LLM returns out-of-list ref → next tier; budget exhausted → no call; a human `ref` answer writes the cache; a `done` answer; `login` fixture with the stub gate → `SECURITY_CHALLENGE`.

**Acceptance criteria**
- [ ] No prompt contains a secret or password value (canary in test)

---

## P7-05 · Trajectory recorder

| Field | Value |
|---|---|
| depends_on | P7-03, P6-05 |
| supervision | cheap-ok (review) |
| size | S |
| spec | memory §6.1; SECURITY.md S13 |

**Files:** `packages/runtime/src/tasks/recorder.ts`, test.

**Requirements:**
- Implement every row of the memory §6.1 table: param substitution in values and URLs, intent capture, pre/post url patterns, risk, and the human-manual representation.
- Compaction rules.
- The sensitive-literal guard is enforced by the router (P7-02/P7-03 call `recorder.isRecording()` + `isSensitiveField` before execution; add that check if missing, with S13 test).
- `finalize(success)` → steps or null.

**Tests:** each table row; compaction; S13 (rejected before any driver call: fake driver call count 0).

---

## P7-06 · Trajectory replayer with healing

| Field | Value |
|---|---|
| depends_on | P7-04, P7-05 |
| supervision | **expert** (review) |
| size | M |
| spec | memory §6.2–6.3; action-router §5.4; SECURITY.md S9 |

**Files:** `packages/runtime/src/tasks/replayer.ts`, test.

**Requirements:**
- The replay algorithm in memory §6.2 exactly: param/secret checks, url precondition wait (poll `pathTemplate(currentUrl)` every 50 ms up to `probeTimeoutMs`), `router.execute(action, ctx, { healIntent })`, heal detection, and the `TrajectoryStore.recordRun` call.
- Every step is re-classified by the router; the recorded `risk` is never used to lower the live risk (S9).
- A step that fails because of a security challenge (`SECURITY_CHALLENGE`, or `HUMAN_REQUIRED` with a challenge reason) or `PERMISSION_DENIED` fails the task but is **not** counted as a trajectory failure: do not call `recordRun` (SECURITY.md §6.1).

**Tests:**
- all-cache replay → zero model calls
- a healed step → new version
- a failing step → suspect; a second failure → invalid
- precondition mismatch
- missing param → `INVALID_REQUEST` before any action
- S9

---

## P7-07 · TaskManager and `createRuntime()`

| Field | Value |
|---|---|
| depends_on | P7-06, P2-06, P2-07, P3-06, P5-04, P6-03 |
| supervision | cheap-ok (review) |
| size | M |
| spec | memory §7; ARCHITECTURE.md §5; protocol §4 (method semantics) |

**Files:**
- `packages/runtime/src/tasks/task-manager.ts`
- `src/runtime.ts` (`createRuntime(config, { bosHome, env, providers?, models?, gates? })`)
- `src/api.ts` (`RuntimeApi`: one method per protocol method, returning protocol types)
- `src/config/load-config.ts`
- tests

**Requirements**
1. TaskManager: `start` (auto-mode resolution), `end` (persist/discard; replaces an invalid trajectory), `run` (replay mode end-to-end), stats aggregation into `Task.stats`, events `task.*`, `TaskStore` persistence. One running task per session (a second `start` → `INVALID_REQUEST`).
2. `createRuntime` wires everything per ARCHITECTURE §5:
   - opens the store
   - marks stale sessions closed
   - registers the probe helper with `IsolatedWorlds`
   - persists sessions via `SessionStore`
   - supports injected fakes for tests
3. `RuntimeApi` covers every method in protocol §4 except `system.*`/`events.subscribe` (daemon-level).

**Tests:** API smoke over a fixture with a fake model; task lifecycle; config loading with defaults.

**Acceptance criteria**
- [ ] `RuntimeApi` method names and param/result types match `RPC_METHODS`

---

## P7-08 · Vertical slice e2e (Milestone M3, the thesis)

| Field | Value |
|---|---|
| depends_on | P7-07 |
| supervision | **expert** (review results) |
| size | S |
| spec | PRD §7; PERFORMANCE.md L18, E2, E4; TESTING.md (M3 row) |

**Files:** `tests/e2e/vertical-slice.e2e.test.ts`, `examples/vertical-slice.ts`.

**Scenario:** exactly PRD §7, in-process via `createRuntime`, headless Chromium, fixture `spa`, `FakeModelProvider` with `truthResponder` and `latencyMs: 800`.

**Assertions**
- Record run: success; at least one step used the `llm` tier (the "first result" intent); trajectory v1 saved with 3 locator steps + 1 extract.
- Replay run with a different param: success; `stats.llmCalls === 0`; every step tier `cache`; extracted email (from `task.run` result `outputs`, integration §10) corresponds to the new query's person; replay E2E time ≤ ⅓ of record time.
- Mutated variant replay: success; `healedSteps` reported (may be 0 if matching absorbed the changes); if > 0, trajectory version incremented.

`examples/vertical-slice.ts` prints a table: run, tiers per step, llm calls, tokens, ms.

**Acceptance criteria**
- [ ] Test green 3 consecutive runs in CI
- [ ] Output table pasted into the task's implementation notes
