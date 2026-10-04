# Roadmap

**Status:** Authoritative · **Version:** 1.0 (2026-10-02)
Task cards with exact requirements live in `docs/tasks/`. Status tracking: `docs/tasks/README.md`.

---

## Milestones

```
M0 Scaffold ──▶ M1 Hands ──▶ M2 Eyes ──▶ M3 THESIS ──▶ M4 Usable ──▶ M5 Safe ──▶ M6 Measured ──▶ M7 Real-world = MVP v0.1.0
 P0,P1          P2,P3        P4          P5,P6,P7      P8            P9          P10             P11,P12
```

| Milestone | Demonstrates | Exit check |
|---|---|---|
| **M0 Scaffold** | Monorepo builds, CI green, protocol types exist | `pnpm -r typecheck && pnpm lint && pnpm test` green in CI |
| **M1 Hands** | Persistent Chrome launched by Browser-OS; navigate, click and type via CDP; fallback via Playwright | P3-07 e2e passes; cookie persists across relaunch |
| **M2 Eyes** | Compact semantic observation; deterministic intent resolution; durable locators | Goldens pass; lexical precision ≥ 99%; mutation suite ≥ 95% |
| **M3 Thesis** | **Vertical slice: record → replay with 0 LLM calls, ≥ 3× faster; healing after mutation** | P7-08 passes (in-process) |
| **M4 Usable** | Daemon + CLI + SDK; any agent can drive it | P8-08 CLI e2e passes |
| **M5 Safe** | Risk confirmation, human gate, audit, secret canary | P9 tests pass |
| **M6 Measured** | Benchmark report with ablation H1–H4 | `docs/benchmarks/REPORT-*.md` committed |
| **M7 Real-world** | OOPIF, multi-tab, MFA flow, real-site matrix | COMPATIBILITY.md results filled; PRD §10 metrics met → tag v0.1.0 |

**Critical path:** P0 → P1 → P2 → P3 → P4 (capture/join/semantic/locator) → P6 (store/keys/cache/trajectory) → P7 → M3. P5 (AI) runs in parallel with P4/P6. P8 can start once P7-07 (`createRuntime`) exists.

```
P0 ─▶ P1 ─┬─▶ P2 ─▶ P3 ─┐
          │             ├─▶ P4 ─┐
          ├─▶ P5 ───────┼───────┼─▶ P7 ─▶ P8 ─▶ P9 ─▶ P10 ─▶ P11 ─▶ P12
          └─▶ P6 ───────┘       │
                                └─(P4-11 Observer needs P2-07)
```

---

## Phase 0: Repository scaffold & tooling

- **Goal:** empty but fully wired monorepo; CI; fixture server and pages.
- **Packages/files:** root configs, `packages/*/` skeletons, `scripts/check-boundaries.mjs`, `.github/workflows/ci.yml`, `fixtures/`.
- **Dependencies:** none.
- **Tasks:** P0-01 scaffold · P0-02 boundary checker · P0-03 CI · P0-04 fixture server + pages.
- **Acceptance:** fresh clone → `pnpm install && pnpm -r typecheck && pnpm lint && pnpm test` all green locally and in CI (ubuntu + windows).
- **Tests:** boundary checker unit tests with fake package trees; fixture server serves every page.
- **Performance criteria:** none.
- **Failure modes:** over-engineering configs; adding dependencies not in CODING_AGENT §6; Windows path issues in scripts (use `node:path`).

## Phase 1: Protocol

- **Goal:** the shared vocabulary from `specs/data-models.md`.
- **Packages:** `packages/protocol`.
- **Dependencies:** P0.
- **Tasks:** P1-01 ids+errors · P1-02 data model types · P1-03 zod schemas + rpc table · P1-04 mask + EventBus + paths + target syntax.
- **Acceptance:** all types compile; schemas accept valid samples and reject invalid ones; `maskAction` masks sensitive values; `resolveBosHome` correct on 3 OSes.
- **Tests:** unit (≥ 85% coverage).
- **Performance:** `newId` ≥ 1M/s (sanity), EventBus emit < 5 µs with 3 listeners.
- **Failure modes:** drifting from spec (types must match `data-models.md` exactly); classes where plain data is required.

## Phase 2: Browser runtime

- **Goal:** owned profiles, launch/attach providers, CDP transport, isolated worlds, session manager.
- **Packages:** `packages/browser`, `packages/runtime/src/sessions`.
- **Dependencies:** P1.
- **Tasks:** P2-01 executables · P2-02 profiles (fs) · P2-03 CDP transport + isolated worlds · P2-04 LaunchProvider · P2-05 CdpEndpointProvider · P2-06 manual setup mode · P2-07 SessionManager.
- **Acceptance:** launch persistent profile, list pages, open new page, close; cookies persist across relaunch; session reuse; crash → reconnect.
- **Tests:** unit (paths, discovery), browser tests with Playwright-managed Chromium in CI.
- **Performance:** cold launch measured (L1); warm `session.open` (reuse) p50 ≤ 5 ms.
- **Failure modes:** using the user's default profile (forbidden); leaking Playwright types; `Runtime.enable` usage; profile lock races on Windows.

## Phase 3: Action execution

- **Goal:** `PageDriver` with CDP executor + Playwright fallback + effect semantics + settle + extract + uploads/downloads.
- **Packages:** `packages/browser/src/driver`.
- **Dependencies:** P2.
- **Tasks:** P3-01 driver skeleton/navigate/readValue/extract · P3-02 CDP click/hover + hit-test · P3-03 CDP fill/press/select/scroll · P3-04 Playwright fallback + `locatorFor` · P3-05 settle · P3-06 uploads/downloads · P3-07 M1 e2e.
- **Acceptance:** every MVP action passes on fixture pages through CDP; obscured button → `TARGET_OBSCURED` → fallback succeeds; `effect` correct in all paths.
- **Tests:** browser tests per action; error-path tests.
- **Performance:** CDP click dispatch (resolved node → events sent) p50 ≤ 15 ms local; Playwright fallback measured.
- **Failure modes:** retrying after `effect:'unknown'`; coordinate bugs with scrolling/zoom; contenteditable fill.

## Phase 4: DOM intelligence

- **Goal:** semantic observation, lexical resolver, locators, probe, challenge detection, Observer.
- **Packages:** `packages/dom`, `packages/runtime/src/observer`.
- **Dependencies:** P1 (pure parts), P2-03 (capture/probe), P2-07 (Observer).
- **Tasks:** P4-01 normalize · P4-02 capture + record script · P4-03 join · P4-04 interactive/visibility · P4-05 semantic + serialize + goldens · P4-06 challenge · P4-07 lexical · P4-08 locator build/match · P4-09 probe · P4-10 Playwright oracle · P4-11 Observer · P4-12 mutation suite.
- **Acceptance:** goldens for all fixtures; oracle agreement ≥ 95%; lexical precision ≥ 99% at thresholds; mutation suite correct-best-with-margin ≥ 95%; probe ≤ 4 round trips.
- **Tests:** pure unit tests over recorded captures; browser tests for capture/probe.
- **Performance:** L6, L9, L16 (PERFORMANCE.md).
- **Failure modes:** emitting wrapper duplicates; missing elements inside shadow DOM; wrong iframe offsets; unstable ids leaking into locators; goldens updated blindly.

## Phase 5: AI providers

- **Goal:** provider-agnostic model access + resolve-target prompt.
- **Packages:** `packages/ai`.
- **Dependencies:** P1.
- **Tasks:** P5-01 FakeModelProvider · P5-02 OpenAI-compatible · P5-03 Anthropic · P5-04 registry from config · P5-05 resolve-target prompt + output validation.
- **Acceptance:** providers pass contract tests against local mock HTTP servers; prompt snapshot tests; no secret values in any prompt (canary).
- **Tests:** unit + mock-server tests. **No real API calls in CI.**
- **Performance:** prompt build ≤ 1 ms; prompt ≤ 1.5k tokens for 30 candidates.
- **Failure modes:** adding vendor SDKs; trusting model JSON without zod; leaking API keys into logs.

## Phase 6: Memory

- **Goal:** SQLite store, keys, cache and trajectory stores, runs/audit.
- **Packages:** `packages/memory`.
- **Dependencies:** P1.
- **Tasks:** P6-01 store + migrations · P6-02 keys · P6-03 profile/session/task stores · P6-04 action cache store · P6-05 trajectory store · P6-06 runs + audit + stats + retention.
- **Acceptance:** all store round trips; cache lifecycle transitions; unique live trajectory per key.
- **Tests:** `:memory:` SQLite.
- **Performance:** L10 (PERFORMANCE.md); `put` ≤ 1 ms.
- **Failure modes:** SQL outside memory package; JSON column drift from protocol types; secrets persisted.

## Phase 7: Router + tasks → **vertical slice (M3)**

- **Goal:** the full act pipeline, recorder, replayer, task manager, composition root, and the thesis test.
- **Packages:** `packages/runtime/src/{router,tasks,security(stubs),human(stub),telemetry}`, `examples/`.
- **Dependencies:** P2–P6.
- **Tasks:** P7-01 context/budgets/secrets/stub gates · P7-02 router core · P7-03 intent tiers (cache, deterministic, learning, stale heal) · P7-04 LLM tier + human hook · P7-05 recorder · P7-06 replayer + healing · P7-07 TaskManager + `createRuntime()` · P7-08 vertical slice e2e + example.
- **Acceptance:** PRD §7 sequence passes: replay `llmCalls == 0`, all steps tier `cache`, ≥ 3× faster than record run (FakeModel 800 ms latency); mutated variant succeeds (healed steps recorded).
- **Tests:** router unit tests with fakes (each tier, ladder, budgets, effect semantics); recorder/replayer unit tests; e2e on fixture SPA.
- **Performance:** router overhead (excluding CDP time) p50 ≤ 5 ms; cache-tier action p50 ≤ 50 ms.
- **Failure modes:** LLM calls sneaking into deterministic paths; replay doing full observation when probe would do; secrets reaching recorder.

## Phase 8: Daemon, CLI, SDK

- **Goal:** make the runtime usable by any agent.
- **Packages:** `packages/daemon`, `packages/sdk`, `packages/cli`.
- **Dependencies:** P7-07.
- **Tasks:** P8-01 WS server + JSON-RPC dispatch · P8-02 method handlers + events · P8-03 daemon lifecycle · P8-04 token auth + file permissions · P8-05 SDK · P8-06 CLI part 1 · P8-07 CLI part 2 · P8-08 CLI e2e.
- **Acceptance:** CLI vertical slice e2e; unauthenticated or Origin-bearing connections rejected; daemon autostart; single instance.
- **Tests:** daemon integration (real WS), CLI e2e spawning `bos`.
- **Performance:** RPC round trip overhead p50 ≤ 2 ms; CLI command total overhead (spawn + connect) p50 ≤ 150 ms.
- **Failure modes:** logging `secretValues`; token file readable by others; CLI framework dependency creep.

## Phase 9: Security & human-in-the-loop

- **Goal:** replace stubs with real risk classifier, permission gate, human gate; audit; injection and secret suites.
- **Packages:** `packages/runtime/src/{security,human}`.
- **Dependencies:** P7, P8.
- **Tasks:** P9-01 RiskClassifier · P9-02 PermissionGate · P9-03 HumanGate · P9-04 audit log · P9-05 prompt-injection suite · P9-06 secret canary e2e · P9-07 site access + upload/download policy.
- **Acceptance:** risk fixture requires approval; OTP fixture pauses and resumes; canary absent everywhere; injection page cannot change the chosen action type or select an element outside the candidate list.
- **Tests:** unit + e2e (SECURITY.md §15 checklist).
- **Performance:** risk classification ≤ 0.5 ms.
- **Failure modes:** risk lowered by cached data; confirmations auto-approved on timeout (must reject).

## Phase 10: Benchmarks

- **Goal:** reproducible measurements and the thesis experiment.
- **Packages:** `benchmarks/`.
- **Dependencies:** P7 (P8 for CLI overhead benches).
- **Tasks:** P10-01 harness · P10-02 pure micro benches · P10-03 browser micro benches · P10-04 task benches + ablation · P10-05 startup benches · P10-06 report + CI regression guard.
- **Acceptance:** report with H1–H4 verdicts (PERFORMANCE.md); CI guard on micro benches.
- **Performance:** this phase measures; targets in PERFORMANCE.md.
- **Failure modes:** noisy numbers (no warmup, shared CI machines); comparing unlike conditions; marketing claims.

## Phase 11: Compatibility hardening

- **Goal:** real-site robustness, evidence-gated optimizations.
- **Dependencies:** P10 (evidence), P9.
- **Tasks:** P11-01 real-site runner (opt-in) · P11-02 OOPIF · P11-03 multi-tab · P11-04 large-page partial AX (only if P10 shows need) · P11-05 paint-order occlusion · P11-06 shadow/contenteditable edge cases · P11-07 MFA pause/resume e2e.
- **Acceptance:** compatibility matrix updated with honest results; no regression in benches.
- **Failure modes:** site-specific hacks in core code (forbidden: site knowledge lives in data, not code); ToS violations during testing.

## Phase 12: MVP release

- **Tasks:** P12-01 package READMEs + USER_GUIDE · P12-02 packaging (`bos` via npm) · P12-03 MVP acceptance run.
- **Acceptance:** PRD §10 metrics met or gaps documented with an ADR; tag `v0.1.0`.

## Phase 13: Post-MVP backlog (ordered)

P13-01 ChromeConsentProvider (Chrome 144+ real-profile attach) · P13-02 MCP server · P13-03 vision tier · P13-04 ExtensionProvider · P13-05 OTel exporter · P13-06 optional internal planner (`bos run "<goal>"`) · P13-07 Lightpanda provider · P13-08 remote mode. Each needs a task card written by an expert before work starts.
