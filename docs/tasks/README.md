# Task board

**How to use this file:** see `docs/CODING_AGENT.md` §4. Pick the lowest-numbered `todo` task whose `depends_on` are all `done` (or the task you were assigned). Do one task. Update its status here when finished.

Statuses: `todo` → `in_progress` → `review` (needs expert/human check) → `done` · `blocked` (see CONFLICTS.md) · `skipped` (evidence-gated task not needed; reason in its card).

Supervision: **cheap** = a cheaper coding model can do it end-to-end · **review** = cheap model may implement, an expert reviews before `done` · **expert** = needs a high-capability model or human engineer.

Task cards: `phase-XX-*.md` in this folder. Conflicts and questions: `CONFLICTS.md`.

**Before any task, also read `docs/specs/integration.md`.** It fixes the cross-task contracts and wins over conflicting text in cards and other specs. The **Supervision column below is authoritative** over labels inside the cards. A task card may be *more specific* than a spec (exact file names, helper names, test lists); that is a refinement, not a conflict.

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
| P1-03 | Zod schemas and RPC method table | P1-02 | cheap | todo |
| P1-04 | Masking, EventBus, paths, target syntax | P1-02 | cheap | todo |
| **Phase 2** | **Browser runtime** | | | |
| P2-01 | Browser executable discovery | P1-04 | cheap | todo |
| P2-02 | Profile directories (filesystem) | P1-04 | cheap | todo |
| P2-04 | LaunchProvider and PageHandle | P2-01, P2-02 | cheap | todo |
| P2-03 | CDP transport, counting wrapper, isolated worlds | P2-04 | review | todo |
| P2-05 | CdpEndpointProvider | P2-04 | cheap | todo |
| P2-06 | Manual setup mode launcher | P2-01, P2-02 | cheap | todo |
| P2-07 | Session manager | P2-04, P2-05 | review | todo |
| **Phase 3** | **Action execution** | | | |
| P3-01 | PageDriver skeleton, navigate, readValue, extract | P2-03, P2-04 | cheap | todo |
| P3-02 | CDP click/hover with hit-test and effect semantics | P3-01 | expert | todo |
| P3-03 | CDP fill, press, select, scroll | P3-02 | cheap | todo |
| P3-04 | Playwright fallback executor and `locatorFor` | P3-01 | cheap | todo |
| P3-05 | Settle | P3-01 | cheap | todo |
| P3-06 | Uploads and downloads | P3-01 | cheap | todo |
| P3-07 | **M1** e2e "Hands" | P2-07, P3-02, P3-03, P3-04, P3-05 | cheap | todo |
| **Phase 4** | **DOM intelligence** | | | |
| P4-01 | Text normalization utilities | P1-04 | cheap | todo |
| P4-02 | Raw capture + capture recorder script | P2-03, P3-05, P4-01 | review | todo |
| P4-03 | Join → NodeTable | P4-02 | expert | todo |
| P4-04 | Interactivity and visibility rules | P4-03 | review | todo |
| P4-05 | Semantic output, serialization, goldens | P4-04 | review | todo |
| P4-06 | Security challenge detection | P4-05 | cheap | todo |
| P4-07 | Lexical ranking (deterministic tier) | P4-05 | review | todo |
| P4-08 | Locator build, cssPath, matching | P4-05 | expert | todo |
| P4-09 | Probe (cache fast path) | P4-08, P2-03 | review | todo |
| P4-10 | Playwright ariaSnapshot oracle test | P4-05 | cheap | todo |
| P4-11 | Observer (runtime) | P4-06, P4-08, P2-07 | cheap | todo |
| P4-12 | Mutation fixtures + locator robustness suite | P4-08 | cheap | todo |
| **Phase 5** | **AI providers** | | | |
| P5-01 | FakeModelProvider | P1-02 | cheap | todo |
| P5-02 | OpenAI-compatible provider | P5-01 | cheap | todo |
| P5-03 | Anthropic provider | P5-02 | cheap | todo |
| P5-04 | Model registry from config | P5-02, P5-03, P1-03 | cheap | todo |
| P5-05 | Resolve-target prompt + output validation | P5-01 | review | todo |
| **Phase 6** | **Memory** | | | |
| P6-01 | Store, migrations, schema 001 | P1-02 | cheap | todo |
| P6-02 | Keys and normalization | P1-02 | cheap | todo |
| P6-03 | Profile, session, task stores | P6-01 | cheap | todo |
| P6-04 | Action cache store | P6-01, P6-02 | cheap | todo |
| P6-05 | Trajectory store | P6-01 | cheap | todo |
| P6-06 | Run log, audit log, stats, retention | P6-01 | cheap | todo |
| **Phase 7** | **Router + tasks → M3** | | | |
| P7-01 | Execution context, budgets, secrets, stub gates | P1-04, P6-01 | cheap | todo |
| P7-02 | Router core | P7-01, P3-03, P3-04, P3-05, P4-11, P6-06 | expert | todo |
| P7-03 | Intent tiers: cache, deterministic, learning | P7-02, P4-07, P4-09, P6-04 | expert | todo |
| P7-04 | LLM tier and human hook | P7-03, P5-05 | review | todo |
| P7-05 | Trajectory recorder | P7-03, P6-05 | review | todo |
| P7-06 | Trajectory replayer with healing | P7-04, P7-05 | review | todo |
| P7-07 | TaskManager + `createRuntime()` | P7-06, P2-06, P2-07, P3-06, P5-04, P6-03 | review | todo |
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
