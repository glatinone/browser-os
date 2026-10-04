# Phase 10: Benchmarks

Read first: `docs/BENCHMARKS.md` (entire), `docs/PERFORMANCE.md` (targets L1–L18, E1–E8, hypotheses H1–H4).
All tasks: `supervision: cheap-ok`, except P10-04, which needs **expert review of results**.

---

## P10-01 · Benchmark harness

| Field | Value |
|---|---|
| depends_on | P7-07 |
| size | S |
| spec | BENCHMARKS.md (methodology, output format) |

**Files:** `benchmarks/package.json`, `benchmarks/harness.ts`, `benchmarks/machine.ts`, `benchmarks/report.ts`, test `benchmarks/test/harness.test.ts`.

**Requirements:**
- `bench(name, fn, { iterations = 30, warmup = 3 })` → `{ name, samples, p50, p95, p99, mean, min, max }` using `performance.now()`.
- `machine()` → OS, CPU model and cores, RAM, Node version, Chrome version (when given a browser).
- Writes JSON results to `benchmarks/results/<suite>-<timestamp>.json` (git-ignored) using the schema in BENCHMARKS.md.
- `report.ts` renders markdown tables.

**Tests:** percentile math on known samples; JSON schema validation.

---

## P10-02 · Pure micro benchmarks

| Field | Value |
|---|---|
| depends_on | P10-01 |
| size | S |
| spec | PERFORMANCE.md L9, L10, L16, L17 |

**Files:** `benchmarks/micro/{serialize,cache-lookup,lexical,match}.bench.ts`, root script `bench:micro`.

**Requirements:** use recorded raw captures (largest fixture, plus a synthetic 200-element observation); in-memory SQLite with 10k cache rows for lookups. Print a table and write JSON.

---

## P10-03 · Browser micro benchmarks

| Field | Value |
|---|---|
| depends_on | P10-01 |
| size | S |
| spec | PERFORMANCE.md L4–L8, L11 |

**Files:** `benchmarks/browser/{cdp-click,pw-click,observe,observe-heavy,observe-reuse,probe}.bench.ts`, script `bench:browser`.

**Requirements:** fixture server + headless Chromium; each bench resets page state between iterations. `CountingCdpTransport` is used to report round trips alongside latency.

---

## P10-04 · Task benchmarks with ablation (the thesis experiment)

| Field | Value |
|---|---|
| depends_on | P10-01, P7-08 |
| supervision | **expert** (review results) |
| size | M |
| spec | BENCHMARKS.md (scenarios, ablation modes); PERFORMANCE.md H1–H4, L12, L13, L18, E1–E8 |

**Files:** `benchmarks/tasks/scenarios/*.ts` (one per BENCHMARKS.md scenario), `benchmarks/tasks/run.ts`, script `bench:tasks`.

**Requirements**
1. For each scenario, run the modes `llm-always` (`disabledTiers: ['cache','deterministic']`), `no-cache` (`disabledTiers: ['cache']`), and `full` (record, then replay N times), plus a `mutated` replay for scenarios that have a mutated variant (`spa?variant=mutated`).
2. Use FakeModel with `latencyMs` 800 (default; flag `--latency`) and token estimates. Optional `--real-model` flag uses the configured fast model; label those results "real model" and never mix them with Fake results.
3. Metrics per run: E2E ms, LLM calls, tokens, tiers per step, cache hits, healed steps, success.
4. Evaluate H1–H4 pass/fail exactly as PERFORMANCE.md defines them and print a verdict table.

**Acceptance criteria**
- [ ] Verdicts reported honestly; failures become CONFLICTS.md entries with data (do not tune the benchmark to pass)

---

## P10-05 · Startup benchmarks

| Field | Value |
|---|---|
| depends_on | P10-01, P8-03, P8-06 |
| size | S |
| spec | PERFORMANCE.md L1–L3 |

**Files:** `benchmarks/startup/{cold-launch,warm-open,attach,cli-overhead}.bench.ts`, script `bench:startup`.

**Requirements:** cold launch with a fresh daemon-less runtime; warm open via SessionManager reuse; attach via `cdp-endpoint`; CLI overhead (spawn `bos observe --json` against a running daemon). N = 10 for cold launches (expensive).

---

## P10-06 · Report and CI regression guard

| Field | Value |
|---|---|
| depends_on | P10-02, P10-03, P10-04, P10-05 |
| size | S |
| spec | BENCHMARKS.md (report, CI guard) |

**Files:** `benchmarks/compare.ts`, `benchmarks/baseline/micro.json`, `docs/benchmarks/REPORT-<date>.md` (first report), CI updates (`ci.yml`: micro benches on PRs; nightly job runs browser/tasks/startup and uploads artifacts).

**Requirements:** `compare.ts` fails if any micro bench p50 regresses > 25% vs baseline and warns for 10–25%. The report includes machine info, every L/E metric with its target and status, and the H1–H4 verdicts.

**Acceptance criteria**
- [ ] First report committed (Milestone M6)
