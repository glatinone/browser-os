# PERFORMANCE.md: Performance Model and Targets

**Status:** Authoritative for MVP · **Related:** BENCHMARKS.md (how to measure), `specs/action-router.md` (tiers, constants), `specs/dom-intelligence.md`, ADR-010

---

## 1. The thesis

> **Performance comes primarily from avoiding unnecessary work, not from a faster model.**

In a browser-agent loop, the expensive things are (in order of typical cost): **LLM calls** (hundreds of ms to seconds, plus tokens), **screenshots and vision** (seconds), **full page observations** (tens to hundreds of ms on heavy pages), **browser startup** (≈1–2 s), and **fixed sleeps**. A raw CDP input event costs single-digit milliseconds.

So Browser-OS is fast when it **does not do** the expensive things:

```
                       cost per action (order of magnitude)
 cache tier (probe)    ▏ 5–50 ms         0 tokens     ◄── replay of a learned task
 deterministic tier    ▎ 50–400 ms       0 tokens     ◄── observation + lexical match
 llm tier              ██████ 0.5–3 s    ~1–1.5k tok  ◄── fast model picks a ref
 vision tier (post-MVP)████████████ 2–10 s  image tokens
 human tier            ████████████████████  seconds–minutes
```

The goal is that a **repeated task** spends almost all of its actions in the top row. This document defines the targets and the experiment that proves (or disproves) the thesis.

---

## 2. Cost model per action

For one action the wall time is:

```
T_action = T_resolve(tier) + T_permission + T_dispatch(driver) + T_verify + T_settle
```

| Term | Cache tier | Deterministic | LLM | Notes |
|---|---|---|---|---|
| `T_resolve` | probe: ≤ 4 CDP round trips (+ poll until target appears, ≤ `probeTimeoutMs`) | observation (reused if unchanged) + lexical rank (pure, < 5 ms) | observation + candidate selection + **model call** | observation reuse: dom-intelligence §10 |
| `T_permission` | rule eval < 1 ms | same | same | human confirmation excluded from automated metrics |
| `T_dispatch` | CDP: scrollIntoView + quads + hit-test + 3 mouse events | same | same | Playwright fallback adds actionability waits |
| `T_verify` | 0–1 round trip | same | same | |
| `T_settle` | ≤ `settleMaxMs` (2000) cap, typically `settleQuietMs` (100) after quiet | same | same | **site-dependent**; excluded from "Browser-OS overhead" |

**Browser-OS overhead** = `T_action − T_settle − (time the page itself takes to react)`. It is measured as the sum of our own processing plus CDP round trips, excluding settle waits and model latency. This is the number our targets bound. Site/network time is reported separately and never counted as our overhead.

Per task:

```
T_task ≈ Σ T_action + T_navigation(site) + T_human
LLM_calls(task) = Σ llm-tier resolutions (+ healing)       → 0 on a clean replay
tokens(task)    = Σ (input + output tokens of those calls)
```

---

## 3. Targets

All latency targets are **machine-dependent engineering targets**, not guarantees. The reference machine is a 2023+ laptop (8+ cores, 16 GB RAM, SSD) running Chrome stable, measured with the local fixture server (no internet) per BENCHMARKS.md. Each report records the actual machine. A target "fails" when the p50 exceeds it on the reference machine. Rows marked **report** have no pass/fail; they are measured and published.

### 3.1 Latency

| # | Measurement | Scope | p50 | p95 | p99 | Bench |
|---|---|---|---|---|---|---|
| L1 | Cold browser startup (launch persistent profile → first page ready) | LaunchProvider, headful, warm OS cache | ≤ 1500 ms | ≤ 2500 ms | report | `startup/cold-launch` |
| L2 | Warm session open (profile already has a live session → returned) | SessionManager reuse | ≤ 5 ms | ≤ 20 ms | report | `startup/warm-open` |
| L3 | Attach via `cdp-endpoint` | connectOverCDP to local Chromium | ≤ 300 ms | ≤ 600 ms | report | `startup/attach` |
| L4 | CDP click dispatch (resolved target → events dispatched, no settle) | CDP executor | ≤ 15 ms | ≤ 40 ms | ≤ 80 ms | `browser/cdp-click` |
| L5 | Playwright fallback click (same target) | Playwright executor | report | report | report | `browser/pw-click` (compare to L4) |
| L6 | Observation capture+build, fixture pages (≤ 3k DOM nodes) | `observer.capture()` uncached | ≤ 150 ms | ≤ 400 ms | report | `browser/observe` |
| L7 | Observation capture+build, heavy page (≥ 15k nodes, `fixtures/sites/heavy`) | same | report | report | report | `browser/observe-heavy` |
| L8 | Observation reuse check (unchanged page) | mutation-counter round trip | ≤ 5 ms | ≤ 15 ms | report | `browser/observe-reuse` |
| L9 | Semantic serialization (200 elements → compact lines) | pure | ≤ 2 ms | ≤ 5 ms | report | `micro/serialize` |
| L10 | Cache lookup (SQLite, `cacheKey` then `siteKey`) | `ActionCacheStore.get` | ≤ 0.5 ms | ≤ 2 ms | ≤ 5 ms | `micro/cache-lookup` |
| L11 | Probe of cached target (single candidate, target present) | `dom.probe` | ≤ 20 ms | ≤ 50 ms | report | `browser/probe` |
| L12 | **Cache-tier action, Browser-OS overhead** (lookup + probe + verifyIdentity + permission + CDP dispatch + verify; settle excluded) | router | ≤ 50 ms | ≤ 150 ms | report | `tasks/*` per-action breakdown |
| L13 | Deterministic-tier action, Browser-OS overhead (fixture page) | router | ≤ 250 ms | ≤ 500 ms | report | `tasks/*` |
| L14 | LLM-tier action | router + model | **report** (provider-dominated) | report | report | `tasks/*` with real model (labeled) |
| L15 | Vision tier | post-MVP | n/a | n/a | n/a | — |
| L16 | Lexical rank (200 elements) | pure | ≤ 2 ms | ≤ 5 ms | report | `micro/lexical` |
| L17 | Fingerprint match (200 elements) | pure | ≤ 3 ms | ≤ 8 ms | report | `micro/match` |
| L18 | **E2E task: replay vs record** (8-action fixture workflow, FakeModel at 800 ms simulated latency) | full stack in-process | replay ≤ **⅓** of record time | — | — | `tasks/multi-step` |

### 3.2 Resources

| # | Measurement | Target |
|---|---|---|
| R1 | Daemon RSS idle, no sessions (excluding browser processes) | < 150 MB |
| R2 | Daemon RSS with 1 live session after 100 actions (excluding browser) | < 250 MB, no monotonic growth over 1000 actions (leak check) |
| R3 | Daemon CPU idle | ~0% (no polling loops while idle) |
| R4 | Browser processes per session | report (Chrome-controlled) |
| R5 | SQLite DB growth per 1000 actions | report; < 5 MB expected |

### 3.3 Intelligence efficiency (the thesis metrics)

| # | Measurement | Target (fixtures) |
|---|---|---|
| E1 | Tokens per LLM resolution (input + output) | p50 ≤ 1.0k, **p95 ≤ 1.5k** |
| E2 | LLM calls per replayed task, unchanged fixture | **0** (hard requirement, tested) |
| E3 | Vision calls per task (MVP) | 0 |
| E4 | Cache hit rate on replay of unchanged fixtures | **≥ 90%** of resolved actions at cache tier (target 100%) |
| E5 | Task success rate (fixture task suite, full mode) | **≥ 95%** |
| E6 | Deterministic-tier precision (vs `truth.json`) | ≥ 99% |
| E7 | Heal success on mutation variants (`fixtures/sites/mutations/`) | report; goal ≥ 80% of steps resolved without human |
| E8 | Screenshots taken in non-vision runs | 0 |

---

## 4. Performance rules for coding agents

These follow from the cost model. Violations are review blockers (CODING_AGENT rules 9, 13, 14):

1. **No LLM call on a deterministic path.** Cache and deterministic tiers never touch `ModelProvider`. Tests assert `FakeModelProvider.calls === 0`.
2. **Reuse observations.** Call `observer.capture()`, which reuses the last observation when no action, navigation or mutation happened (dom-intelligence §10). Never call `captureRaw` directly from the router.
3. **Probe before full observe.** For cached locators, the probe (≤ 4 round trips) comes before any full capture (action-router §5.1).
4. **Parallelize independent CDP calls.** Capture issues DOMSnapshot, AX tree, layout metrics and frame tree in one `Promise.all`. Probe candidates are verified concurrently.
5. **No screenshots** outside the vision tier or an explicit user request.
6. **Do not call `Runtime.enable`.** Use isolated worlds via `Page.createIsolatedWorld` (browser-runtime §4).
7. **No fixed sleeps.** Use `settle()` (capped at `settleMaxMs`) or the probe loop. `wait-ms`-style sleeps are allowed only in an explicit `wait` action.
8. **Cap everything.** Settle ≤ 2 s, probe ≤ 1.5 s, AX per frame ≤ 1.5 s, model call timeout 10 s, budgets per action/task.
9. **Keep the hot path synchronous where possible.** better-sqlite3 is synchronous and fast. Do not wrap it in worker threads or add async layers without benchmark evidence.
10. **Prompt size is a performance budget.** At most `llmCandidates` (30) elements; truncate names to 120 chars; no page text in resolution prompts.
11. **Measure before and after** any hot-path change and report the numbers (BENCHMARKS.md §8).

---

## 5. Validating the thesis experimentally

### 5.1 Ablation modes

The same task suite (BENCHMARKS.md §4) runs in-process under three router configurations:

| Mode | Configuration | Simulates |
|---|---|---|
| **A: `llm-always`** | cache disabled, deterministic tier disabled, every intent resolved by the llm tier | a typical "LLM decides every click" agent on the same infrastructure |
| **B: `no-cache`** | cache disabled; deterministic + llm tiers enabled | DOM intelligence without memory |
| **C: `full`** | all tiers; run 1 records, runs 2..N replay | Browser-OS as designed |

All three use the same browser, fixtures, `FakeModelProvider` (correct answers from `truth.json`, simulated latency 800 ms ± 200 ms, token counts computed from prompt length), and machine. Optionally a labeled run uses a real fast model.

### 5.2 Hypotheses and pass/fail criteria

| ID | Hypothesis | Pass criterion (fixture suite, reference machine) |
|---|---|---|
| **H1** | Replay avoids LLM work entirely on unchanged sites | Mode C runs 2..N: LLM calls = 0 and tokens = 0 on 100% of unchanged-fixture tasks |
| **H2** | Avoiding work beats a faster model | Mode C replay p50 task time ≤ ⅓ of mode A p50 **and** still faster than mode A with simulated model latency set to 0 ms for steps that need resolution (i.e. our savings are not only model latency, but also fewer observations) |
| **H3** | DOM intelligence alone removes a meaningful share of LLM calls | Mode B LLM calls per task ≤ 50% of mode A, with task success no worse than mode A − 2 pp |
| **H4** | Learned trajectories survive moderate site change | On mutation variants after recording: ≥ 80% of steps resolve at cache or deterministic tier, task success ≥ 90%, LLM calls ≤ 25% of mode A |

If a hypothesis fails, the report says so, together with the data. That is a finding, not something to hide. Thresholds are revisited only via ADR.

### 5.3 What is not claimed

- No "fastest browser agent" claims (BENCHMARKS.md §9).
- Real-site latencies are reported as observations with conditions, never as targets.

---

## 6. Optimization backlog (gated by evidence)

Each item starts only when a benchmark shows the bottleneck. The PR must include before/after numbers.

| Item | Trigger | Task |
|---|---|---|
| Large-page mode: partial AX fetching for candidates near the viewport | L7 p50 > 500 ms on heavy fixtures or real-site reports | P11-04 |
| Paint-order occlusion filtering in extraction | `TARGET_OBSCURED` > 5% of actions or LLM confusion from covered elements | P11-05 |
| Replace the Playwright fallback with a CDP-only actionability wait | fallback rate > 10% or L5 dominating replay time | ADR required |
| `node:sqlite` instead of better-sqlite3 | native build problems or L10 regression; `node:sqlite` stable in target Node LTS | ADR required |
| Incremental observation (diff-based) | observation dominates deterministic-tier time on SPA fixtures | ADR required |
| Speculative pre-probe of the next replay step | replay time dominated by probe polling | ADR required |
| Batched CDP over a single session for capture | capture round-trip overhead > 30% of L6 | P11 follow-up |
