# Task board

**How to use this file:** see `docs/CODING_AGENT.md` §4. Pick the lowest-numbered `todo` task whose `depends_on` are all `done` (or the task you were assigned). Do one task. Update its status here when finished.

Statuses: `todo` → `in_progress` → `review` (needs expert/human check) → `done` · `blocked` (see CONFLICTS.md) · `skipped` (evidence-gated task not needed; reason in its card).

Supervision: **cheap** = a cheaper coding model can do it end-to-end · **review** = cheap model may implement, an expert reviews before `done` · **expert** = needs a high-capability model or human engineer.

Task cards: `phase-XX-*.md` in this folder. Conflicts and questions: `CONFLICTS.md`.

**Before any task, also read `docs/specs/integration.md`.** It fixes the cross-task contracts and wins over conflicting text in cards and other specs. The **Supervision column below is authoritative** over labels inside the cards. A task card may be *more specific* than a spec (exact file names, helper names, test lists); that is a refinement, not a conflict.

---

## Review disposition (2026-10-07)

Phase 4 and Phase 5 shipped with 11 tasks in `review`. The owner stated he cannot review this
material himself, so the disposition was decided with Jev (`typesafe/jev-1.13`), asking one
choice question over the five candidate paths and one yes/no on whether a high-capability model
can stand in as reviewer.

Result: `mechanical_only_then_parallel` **0.55**, `delegate_expert_review` 0.45,
`promote_all_now` 0, `block_on_human` 0, `drop_review_gate` 0 (confidence 0.44). The follow-up
"high-capability reviewer satisfies the rule for expert tasks" scored **0.49** — not established,
which is why no expert-labeled task was promoted.

The rule applied: **a task moves to `done` only when its acceptance criterion is itself a passing
assertion.**

| Promoted to `done` | AC is a passing test assertion |
|---|---|
| P4-04 | every §4/§5 bullet has a test |
| P4-05 | expert review 12 Okt: 12 goldens deterministik (regenerasi `vitest -u` tidak mengubah satu pun SHA-256) + kedua AC kartu lulus |
| P4-06 | no false positive on non-login fixtures |
| P4-07 | ≥ 99% precision at 0.75 / 0.15 |
| P4-09 | probe round-trip budget assertions |
| P4-08 | round-trip passes on all 12 fixtures (expert review 2026-10-12) |
| P5-05 | prompt carries the untrusted-data framing sentence |
| P5-01 | expert review 14 Okt (Eng 5 run `70a6d4bf`): AC "used by router tests to assert calls === 0" holds — `router-intent.test.ts:383` + 7 zero-call assertions on deterministic paths |

Promoted later, 2026-10-12, by expert review **STA-160** (Engineering 3, run `afe3b38f`): its AC is
not a test assertion but a provenance check, and it now passes — see the table below.

| Promoted to `done` | Why |
|---|---|
| P4-02 | AC "raw fixtures committed for all non-heavy fixture pages" holds (21 `*.raw.json` tracked: 12 top-level + 9 `mutations/`, only `heavy` absent as the card requires) and the provenance gate passes: the card states no `port: allowed`, the P4-02 files carry no port/adaptation markers, and `THIRD_PARTY_NOTICES.md` correctly reads "None yet". `pnpm build`, `pnpm -r typecheck`, `pnpm test` (590 passed) and `pnpm test:browser` (74 passed) all green. |
| P4-03 | Requirement 4 (coordinate conversion) implemented in `join.ts`: subtracts `viewport.pageX/pageY` and adds iframe host offset. Measured on `iframe.raw.json`: host at `(8, 79.875, 364, 204)`, child `input#frame-username` at `(80.86, 95.875, 177, 21)` — top-level coords within 0.5px tolerance. All 12 fixtures pass full invariant suite (backendNodeId > 0, parents precede children, child-doc `frameId ≠ main`, shadow `shadowHostIdx`, `basic` email bounds/role/placeholder). Golden snapshots pass unchanged. `pnpm build`/`pnpm test`/`pnpm lint` exit 0. |
| P7-05 | Expert review 13 Okt (STA-202/STA-211, Engineering 5, run `1ead2c2a`), HEAD `a528878` == `origin/lane-p7-05`, worktree clean. Every memory §6.1 table row has a dedicated test in `packages/runtime/test/recorder.test.ts` (17 tests: templated navigate URL, param/secret refs kept, literal→param promotion, literal kept on non-sensitive / masked on sensitive target, intent capture incl. `"<role> \"<name>\""` form, human-manual `{kind:'intent'}` target per router §5.3, router risk carried on step, `post.urlPattern` only on `pageChanged`); compaction rules tested (consecutive fills collapse to last, `wait`+`waitFor` dropped with dense indices); `finalize(false)` discards → null, `finalize(true)` persists version-1 trajectory with origin/params/secret names. S13 guard verified at `router.ts:188-201` — rejected before the driver is called, proven by a fake driver with call count 0. Gates re-run on the merge of `a528878` into this lane: `pnpm build` exit 0, full `vitest run` 719 passed / 3 skipped, `biome check .` 0 errors, `check-boundaries.mjs` OK. |
| P5-02 | Expert review 14 Okt (Eng 5 run `8eff0657`), HEAD `5873b02`: the manual Ollama AC was executed by hand (ollama 0.40.4, llama3.2, `ModelRegistry` -> `openai-compatible` at `localhost:11434/v1` -> `{"ref":null}` parsed, usage from wire `usage` fields). Requirements traced: `openai-compatible.ts:54` wire url, `:48-50` json_schema strict vs json_object+append (`:33-36`), `:41-45` model/temperature/max-tokens switch, `:81-87` image data URLs, `:72-73` usage w/ Fake-style estimate, `http.ts:16` retry statuses, `:62` 250ms/1s backoff w/ `Retry-After`<=5s (`:39-44`), `:31-32` missing key names env only, key header-only (`openai-compatible.ts:56`). Tests 6/6 named in `test/openai-compatible.test.ts` verbose; full gates green (build/typecheck/test 664 pass/2 skip/lint/boundaries exit 0). |
| P7-07 | Implemented + reviewed 16 Okt (Eng 5 run `19e33bf8`), commits `fc48065`→`0ca4ea6`. `task-manager.ts`: `auto` resolution against the live row, one-running-task-per-session, record persist/discard at `end` (S13), `task.run` replay bookkeeping (stats fold + `recordRun` exactly once per §6.2 incl. the throw-path), `task.*` events, `TaskStore` rows; integration §10 replacement now holds — explicit `record` over a live trajectory is allowed and `end(true)` calls `invalidate(key)` before `createRecorded` (test: old row → `invalid`, fresh row live, failed replacement leaves live row). `runtime.ts` wires §5 (store, `markAllLiveClosed`, probe helper via `IsolatedWorlds`, SessionStore persistence, injected fakes); `api.ts` types pinned to `RPC_METHODS` via `RpcParams`/`RpcResult` so the AC holds by construction — smoke test re-parses results through the RPC schemas. Gap fixes found by the new tests: `task.run` spec deviation on record-over-live; `ProfileStore.create` wrote a bare UUID breaking `BrowserProfileSchema` (`prf_` prefix, `profile-store.ts:45`). Tests: `task-manager.test.ts` 12, `config.test.ts` 6, `api-smoke.test.ts` 2 (fixture + `ModelRegistry` fake provider, in-process, no daemon). Gates: `pnpm build` 0, unit 699 pass/2 skip, browser 74 pass/1 skip, `biome check .` 0 errors, boundaries OK. |
| P7-06 | Implemented + expert-reviewed 14 Okt (Eng 5 run `869720f1`). `packages/runtime/src/tasks/replayer.ts` implements memory §6.2 exactly: param/secret pre-flight → `INVALID_REQUEST` before any action (test asserts zero router calls + zero recorded runs), `{{param}}` substitution in navigate URLs, precondition poll of `pathTemplate(currentUrl)` every `probeIntervalMs` up to `probeTimeoutMs` (stuck page times out → `TRAJECTORY_STEP_FAILED`, step never executed; SPA route landing mid-budget is waited for), every step via `router.execute(action, ctx, { healIntent, recordedRisk })`, heal detection (locator step resolved off the `cache` tier → fresh locator into `healed`), and exactly one `TrajectoryStore.recordRun` per replay. S9: recorded risk travels only as `ExecuteOptions.recordedRisk` (max(live, recorded)); test asserts the execute opts carry nothing else. §6.1/§8: `SECURITY_CHALLENGE`, challenge-shaped `HUMAN_REQUIRED`, `PERMISSION_DENIED` fail the task with `recorded: false` and never touch counters (test asserts `runs: 0` in the store after each). 15 tests in `packages/runtime/test/replayer.test.ts` cover every card bullet (all-cache → zero model calls; healed step → version 2 + `trajectory.healed` event; fail → suspect → invalid; precondition mismatch; missing param → INVALID_REQUEST; S9). Gates: `pnpm build` exit 0, unit suite 68 files green incl. the new file (run with `--reporter=verbose`, all 15 replayer test names listed), `biome check` on the two files: 0 errors, 12 warnings, all `noNonNullAssertion` in test assertions — the same accepted style as `recorder.test.ts` (33 warnings), `check-boundaries.mjs` OK. Bug fixed while reviewing: `failStep` left `recorded: false` despite calling `recordRun(false)` — counters were written but the flag lied; now set true (`replayer.ts:318`). |

Phase 7 work proceeds in parallel: these four are inputs Phase 7 reads but does not modify.

---

## Status table

| ID | Title | Depends on | Supervision | Status |
|---|---|---|---|---|
| **Phase 0** | **Scaffold** | | | |
| P0-01 | Monorepo scaffold | — | cheap | done |
| P0-02 | Package boundary checker | P0-01 | cheap | done |
| P0-03 | CI workflow | P0-02 | cheap | done |
| P0-04 | Fixture server and fixture sites | P0-01 | cheap | done |
| **Phase 1** | **Protocol** | | | |
| P1-01 | IDs and errors | P0-01 | cheap | done |
| P1-02 | Data model types | P1-01 | cheap | done |
| P1-03 | Zod schemas and RPC method table | P1-02 | cheap | done |
| P1-04 | Masking, EventBus, paths, target syntax | P1-02 | cheap | done |
| **Phase 2** | **Browser runtime** | | | |
| P2-01 | Browser executable discovery | P1-04 | cheap | done |
| P2-02 | Profile directories (filesystem) | P1-04 | cheap | done |
| P2-04 | LaunchProvider and PageHandle | P2-01, P2-02 | cheap | done |
| P2-03 | CDP transport, counting wrapper, isolated worlds | P2-04 | review | done |
| P2-05 | CdpEndpointProvider | P2-04 | cheap | done |
| P2-06 | Manual setup mode launcher | P2-01, P2-02 | cheap | done |
| P2-07 | Session manager | P2-04, P2-05 | review | done |
| **Phase 3** | **Action execution** | | | |
| P3-01 | PageDriver skeleton, navigate, readValue, extract | P2-03, P2-04 | cheap | done |
| P3-02 | CDP click/hover with hit-test and effect semantics | P3-01 | expert | done |
| P3-03 | CDP fill, press, select, scroll | P3-02 | cheap | done |
| P3-04 | Playwright fallback executor and `locatorFor` | P3-01 | cheap | done |
| P3-05 | Settle | P3-01 | cheap | done |
| P3-06 | Uploads and downloads | P3-01 | cheap | done |
| P3-07 | **M1** e2e "Hands" | P2-07, P3-02, P3-03, P3-04, P3-05 | cheap | done |
| **Phase 4** | **DOM intelligence** | | | |
| P4-01 | Text normalization utilities | P1-04 | cheap | done |
| P4-02 | Raw capture + capture recorder script | P2-03, P3-05, P4-01 | review | done |
| P4-03 | Join → NodeTable | P4-02 | expert | done |
| P4-04 | Interactivity and visibility rules | P4-03 | review | done |
| P4-05 | Semantic output, serialization, goldens | P4-04 | review | done |
| P4-06 | Security challenge detection | P4-05 | cheap | done |
| P4-07 | Lexical ranking (deterministic tier) | P4-05 | review | done |
| P4-08 | Locator build, cssPath, matching | P4-05 | expert | done |
| P4-09 | Probe (cache fast path) | P4-08, P2-03 | review | done |
| P4-10 | Playwright ariaSnapshot oracle test | P4-05 | cheap | done |
| P4-11 | Observer (runtime) | P4-06, P4-08, P2-07 | cheap | done |
| P4-12 | Mutation fixtures + locator robustness suite | P4-08 | cheap | done |
| **Phase 5** | **AI providers** | | | |
| P5-01 | FakeModelProvider | P1-02 | cheap | done |
| P5-02 | OpenAI-compatible provider | P5-01 | cheap | done |
| P5-03 | Anthropic provider | P5-02 | cheap | done |
| P5-04 | Model registry from config | P5-02, P5-03, P1-03 | cheap | done |
| P5-05 | Resolve-target prompt + output validation | P5-01 | review | done |
| **Phase 6** | **Memory** | | | |
| P6-01 | Store, migrations, schema 001 | P1-02 | cheap | done |
| P6-02 | Keys and normalization | P1-02 | cheap | done |
| P6-03 | Profile, session, task stores | P6-01 | cheap | done |
| P6-04 | Action cache store | P6-01, P6-02 | cheap | done |
| P6-05 | Trajectory store | P6-01 | cheap | done |
| P6-06 | Run log, audit log, stats, retention | P6-01 | cheap | done |
| **Phase 7** | **Router + tasks → M3** | | | |
|| P7-01 | Execution context, budgets, secrets, stub gates | P1-04, P6-01 | cheap | done |
|| P7-02 | Router core | P7-01, P3-03, P3-04, P3-05, P4-11, P6-06 | expert | done |
| P7-03 | Intent tiers: cache, deterministic, learning | P7-02, P4-07, P4-09, P6-04 | expert | done |
| P7-04 | LLM tier and human hook | P7-03, P5-05 | review | done |
| P7-05 | Trajectory recorder | P7-03, P6-05 | review | done |
| P7-06 | Trajectory replayer with healing | P7-04, P7-05 | review | done |
| P7-07 | TaskManager + `createRuntime()` | P7-06, P2-06, P2-07, P3-06, P5-04, P6-03 | review | done |
| P7-08 | **M3** vertical slice e2e (the thesis) | P7-07 | review | todo |
| **Phase 8** | **Daemon / SDK / CLI** | | | |
| P8-01 | WebSocket server + JSON-RPC dispatcher | P1-03, P7-07 | review | todo |
| P8-02 | Method handlers + event subscriptions | P8-01 | cheap | todo |
| P8-03 | Daemon lifecycle | P8-02 | cheap | todo |
| P8-04 | Token auth + file permissions | P8-01 | expert | todo |
| P8-05 | SDK client | P8-04 | cheap | todo |
| P8-06 | CLI part 1 | P8-05 | cheap | todo |
| P8-07 | CLI part 2 | P8-06 | cheap | todo |
| P8-08 | **M4** CLI e2e | P8-07 | cheap | todo |
| **Phase 9** | **Security & human** | | | |
| P9-01 | RiskClassifier | P7-07 | expert | todo |
| P9-02 | PermissionGate + confirmation flow | P9-01, P8-02 | review | todo |
| P9-03 | HumanGate | P8-02 | review | todo |
| P9-04 | Audit logging | P9-02, P9-03 | cheap | todo |
| P9-05 | Prompt-injection suite | P7-04, P9-02 | review | todo |
| P9-06 | Secret canary end-to-end | P9-04, P8-08 | cheap | todo |
| P9-07 | Site access + upload/download policy | P9-02, P3-06 | cheap | todo |
| **Phase 10** | **Benchmarks → M6** | | | |
| P10-01 | Benchmark harness | P7-07 | cheap | todo |
| P10-02 | Pure micro benchmarks | P10-01 | cheap | todo |
| P10-03 | Browser micro benchmarks | P10-01 | cheap | todo |
| P10-04 | Task benchmarks + ablation (thesis experiment) | P10-01, P7-08 | review | todo |
| P10-05 | Startup benchmarks | P10-01, P8-03, P8-06 | cheap | todo |
| P10-06 | Report + CI regression guard | P10-02..P10-05 | cheap | todo |
| **Phase 11** | **Compatibility → M7** | | | |
| P11-01 | Real-site runner (opt-in, never CI) | P8-08 | cheap | todo |
| P11-02 | Out-of-process iframes (OOPIF) | P10-06 | expert | todo |
| P11-03 | Multi-tab workflows | P10-06 | review | todo |
| P11-04 | Large-page mode (evidence-gated) | P10-06 | expert | todo |
| P11-05 | Paint-order occlusion filtering | P10-06 | review | todo |
| P11-06 | Shadow DOM + contenteditable edge cases | P10-06 | cheap | todo |
| P11-07 | MFA pause/resume e2e | P9-03 | cheap | todo |
| P11-08 | Self-hosted test stack (Keycloak OIDC + OTP) | P11-01 | cheap | todo |
| **Phase 12** | **Release** | | | |
| P12-01 | Package READMEs + user guide | all P9–P11 done/skipped | cheap | todo |
| P12-02 | Packaging | P12-01 | cheap | todo |
| P12-03 | MVP acceptance run → v0.1.0 | P12-02 | expert / owner | todo |

Phase 13 (post-MVP) items are listed in `phase-12-13-release-and-backlog.md`. They have no cards yet.

---

## Suggested execution order (critical path first)

```
P0-01 → P0-02 → P0-03            P0-04 (parallel)
P1-01 → P1-02 → P1-03, P1-04
        ├─▶ P5-01 → P5-02 → P5-03 → P5-04 ; P5-05                 (parallel lane A: AI)
        ├─▶ P6-01 → P6-02..P6-06                                   (parallel lane B: memory)
        └─▶ P2-01, P2-02 → P2-04 → P2-03, P2-05, P2-06 → P2-07     (critical path)
                 → P3-01 → P3-02 → P3-03 ; P3-04 ; P3-05 ; P3-06 → P3-07 (M1)
                 → P4-01 → P4-02 → P4-03 → P4-04 → P4-05 → P4-06, P4-07, P4-08 → P4-09, P4-11, P4-12 ; P4-10 (M2)
                 → P7-01 → P7-02 → P7-03 → P7-04, P7-05 → P7-06 → P7-07 → P7-08 (M3: THESIS)
→ P8 (M4) → P9 (M5) → P10 (M6) → P11 → P12 (M7, v0.1.0)
```

Parallelism: lanes A (P5) and B (P6) can run alongside P2–P4 with separate agents, because they touch different packages. Never run two agents on the same package at the same time.

---

## Milestone gates (stop and get a human review)

| Gate | After | Review focus |
|---|---|---|
| G1 | P3-07 (M1) | Browser control is correct; `effect` semantics; no exposed debug port |
| G2 | P4-05 goldens | Do the observations look right? (they define behaviour for everything after) |
| G3 | P7-08 (M3) | **Thesis demo works.** Decide whether to continue as planned |
| G4 | P8-04 | Daemon security |
| G5 | P10-06 (M6) | Benchmark verdicts H1–H4; decide Phase 11 priorities (evidence-gated tasks) |
| G6 | P12-03 | MVP acceptance |
