# BENCHMARKS.md: Benchmark Suite and Methodology

**Status:** Authoritative for MVP · **Related:** PERFORMANCE.md (targets, hypotheses), TESTING.md, tasks P10-01…P10-06

Benchmarks answer two questions:
1. Does each component meet its latency/resource target (PERFORMANCE.md §3)?
2. Is the thesis true: does avoiding work (cache, deterministic resolution, observation reuse) beat calling a model every step (PERFORMANCE.md §5)?

---

## 1. Methodology

### 1.1 Environment capture

Every benchmark run records, in its JSON output:
- OS name/version, CPU model, core count, RAM, power mode if detectable (`node:os`)
- Node version, Browser-OS git commit and dirty flag
- browser channel and exact version (`browser.version()`)
- Playwright version
- headless/headful
- model provider id and whether it was `fake` or real

A run without this metadata is invalid.

### 1.2 Repetitions and statistics

- **3 warm-up iterations** (discarded), then **N = 30 measured iterations** per benchmark (micro benches: Vitest bench defaults, at least 1 s of samples).
- Report **p50, p95, p99, min, max, mean, stddev** and N. Percentiles use nearest-rank on sorted samples (`benchmarks/lib/stats.ts`).
- Timing with `performance.now()` inside the daemon/runtime process. Never wall-clock from the CLI unless the benchmark is explicitly "CLI end-to-end".
- Close other heavy applications. For reports, use a power-connected laptop.

### 1.3 Removing variance

- **Local fixture server** (`fixtures/server.ts`, `startFixtureServer()`) serves all pages. No internet access in task, browser or micro benches.
- Fixture pages may contain deterministic artificial delays (e.g. SPA renders after 150 ms) to model real behaviour. Delays are fixed values, never random.
- **FakeModelProvider** for deterministic accounting: answers from the fixture's `truth.json`, simulated latency configurable (`BOS_BENCH_MODEL_LATENCY_MS`, default 800, jitter ±200 from a seeded PRNG), and token counts computed as `ceil(promptChars/4)` input and `ceil(outputChars/4)` output.
- **Real-model runs** are optional and always labeled `model: <provider:id>` in the report. They are never mixed into fake-model aggregates.

### 1.4 Cold vs warm definitions

| Term | Definition |
|---|---|
| **Cold browser** | No browser process for the profile; launch measured from `session.open` call to first page ready. OS file cache warm (run once before measuring). |
| **Warm session** | Browser for the profile already running; `session.open` returns the live session. |
| **Cold memory** | Empty `action_cache` and `trajectories` (fresh `BOS_HOME` in a temp dir). |
| **Warm memory** | Memory populated by a previous recording run of the same task. |
| **Uncached observation** | First capture after navigation or mutation. |
| **Reused observation** | Capture call with no change since the last capture. |

Task benches measure **cold memory** (run 1, record) and **warm memory** (runs 2..N, replay), always with a **warm session** unless the benchmark is a startup benchmark.

---

## 2. Suite layout

```
benchmarks/
├── lib/                 harness (P10-01): runner, stats, env capture, report writer
├── micro/               pure functions, no browser (P10-02)       *.bench.ts (vitest bench)
│   ├── cache-lookup.bench.ts      L10
│   ├── lexical.bench.ts           L16
│   ├── match.bench.ts             L17
│   └── serialize.bench.ts         L9
├── browser/             component benches with real Chromium (P10-03)
│   ├── observe.bench.ts           L6, L8 (all fixtures), L7 (heavy)
│   ├── probe.bench.ts             L11 (+ CDP round-trip count)
│   ├── click.bench.ts             L4 vs L5
│   └── settle.bench.ts            settle behaviour on quiet / polling pages
├── tasks/               end-to-end task scenarios with ablation (P10-04)
│   ├── scenarios/*.ts
│   └── run-ablation.ts
├── startup/             L1, L2, L3 (P10-05)
├── real-sites/          manual, opt-in, never CI (P11-01)
└── results/             raw JSON outputs (gitignored except files referenced by reports)
```

Commands:

```
pnpm bench:micro            # vitest bench, fast, CI-safe
pnpm bench:browser          # needs Chromium
pnpm bench:tasks [--mode A|B|C|all] [--scenario <name>] [--n 30]
pnpm bench:startup
pnpm bench:report           # aggregates latest results → docs/benchmarks/REPORT-YYYY-MM-DD.md
```

Fixture pages used by benches, in addition to the test fixtures: `fixtures/sites/heavy/` (generated page with ≥ 15k DOM nodes: long tables, nested lists, many links) for L7.

---

## 3. Ablation modes

Defined in PERFORMANCE.md §5.1. Implementation: `run-ablation.ts` builds the runtime with router overrides:

| Mode | Router config |
|---|---|
| A `llm-always` | `cache: disabled`, `deterministic: disabled`, `llm: enabled` |
| B `no-cache` | `cache: disabled`, `deterministic: enabled`, `llm: enabled` |
| C `full` | all enabled; iteration 1 in `record` mode, iterations 2..N in `replay` mode with a warm memory copy |

The router exposes these switches only through a **benchmark/test-only** constructor option (`RouterDeps.constants` + `disabledTiers`), never through the public protocol or config.

---

## 4. Task scenarios (`benchmarks/tasks/scenarios/`)

Each scenario is a fixed list of `BrowserAction`s with `intent` targets (the "calling agent script"), a task key, params, and a success check (DOM assertion on the final page).

| Scenario | Fixture | Steps | What it exercises |
|---|---|---|---|
| `basic-form` | `basic` | navigate, fill name, fill email, select country, check terms, click submit (6) | form controls, lexical resolution |
| `spa-search-open` | `spa` | navigate, fill search (param `query`), press Enter, wait settled, click first result, extract heading (6) | SPA routing, delayed rendering, param substitution |
| `iframe-form` | `iframe` | navigate, fill field in same-origin iframe, click submit inside iframe (3) | frame handling, framePath |
| `shadow-dom` | `shadow` | navigate, fill input in shadow root, click shadow button (3) | shadow piercing, ` >>> ` css paths |
| `modal-flow` | `modal` | navigate, click "Open settings", toggle switch in dialog, click "Save" (4) | modal scoping, dialogs |
| `dynamic-list` | `dynamic` | navigate, wait for list, click item by name (param), verify badge text (4) | late elements, probe polling, dynamic names |
| `multi-step` | `spa` + `basic` | 8 actions across 2 pages (navigate, search, open, fill 3 fields, select, submit) | L18 replay vs record |
| `mutation-replay` | record on `spa`, replay on `spa?variant=mutated` (changed classes, reordered nav, extra wrappers, count badge change) | as `spa-search-open` | H4 healing |
| `overlay-fallback` | `overlay` | click button covered by transparent overlay → CDP `TARGET_OBSCURED` → Playwright fallback | driver fallback rate and cost |

Success is checked by a deterministic assertion per scenario (e.g. final URL pattern + heading text). A run that fails its assertion counts as a failure in success rate, and its timings are excluded from latency percentiles (but counted in `failures`).

---

## 5. Metrics definitions

| Metric | Definition | Source |
|---|---|---|
| `task_ms` | wall time from `task.start` (or `task.run`) to `task.end` | runtime timers |
| `action_ms` | `ActionResult.ms` | ActionResult |
| `overhead_ms` | `action_ms − settle waitedMs − model latencyMs` | `attempts[]` + settle result + `model.call` events |
| `tier_distribution` | count of actions per resolving `tier` | ActionResult.tier |
| `llm_calls`, `input_tokens`, `output_tokens` | sum over actions | ActionResult.llm |
| `vision_calls` | count (must be 0 in MVP) | events |
| `screenshots` | count of `PageDriver.screenshot` calls (must be 0) | counting driver wrapper |
| `cache_hit_rate` | cache-tier resolutions / actions that had a cache entry or locator target | attempts[] |
| `heal_rate` | steps resolved by tier ≠ cache in replay / replayed steps | replayer |
| `success_rate` | scenarios passing their assertion / runs | harness |
| `observations` | number of uncached captures per task | `observation.captured` events |
| `cdp_round_trips` | per probe / per capture | `CountingCdpTransport` |
| `fallback_rate` | actions executed by `playwright` driver / actions with a target | ActionResult.driver |
| `rss_mb`, `cpu_pct` | daemon process `process.memoryUsage().rss`, `process.cpuUsage()` deltas | harness sampler (1 s) |

---

## 6. Output format

### 6.1 Raw JSON (`benchmarks/results/<suite>-<timestamp>.json`)

```ts
interface BenchResultFile {
  schema: 'bos-bench/1';
  suite: 'micro' | 'browser' | 'tasks' | 'startup';
  startedAt: string;            // ISO
  env: {
    os: string; cpu: string; cores: number; ramGb: number;
    node: string; commit: string; dirty: boolean;
    browser: { channel: string; version: string; headless: boolean };
    playwright: string;
    model: { provider: string; fake: boolean; simulatedLatencyMs?: number };
  };
  results: Array<{
    name: string;               // e.g. "tasks/spa-search-open/C/replay"
    target?: string;            // PERFORMANCE.md id, e.g. "L12"
    n: number; warmup: number;
    unit: 'ms' | 'tokens' | 'count' | 'ratio' | 'mb';
    p50: number; p95: number; p99: number; min: number; max: number; mean: number; stddev: number;
    extra?: Record<string, number>;   // llm_calls, cache_hit_rate, success_rate, ...
    pass?: boolean;             // compared with target when one exists
  }>;
}
```

### 6.2 Markdown report (`docs/benchmarks/REPORT-YYYY-MM-DD.md`)

Generated by `pnpm bench:report` (P10-06). Sections:
1. Environment table
2. Targets table: id, measurement, p50/p95/p99, target, PASS/FAIL/REPORT
3. Ablation table: mode × scenario → task p50, LLM calls, tokens, success rate
4. Hypotheses H1–H4 with PASS/FAIL and the numbers behind them
5. Notable regressions vs the previous report
6. Raw file references

Reports are committed. Raw JSON referenced by a committed report is committed too. Other raw results stay gitignored.

---

## 7. CI regression guard

- CI runs **`pnpm bench:micro` only** (pure functions, low noise) on every PR (TESTING.md §7). Browser, task and startup benches run nightly or manually.
- Baseline: `benchmarks/baseline/micro.json`, updated intentionally by a PR that states why.
- **Fail the job if any micro bench p50 regresses by more than +25%** vs baseline. Report (warn, do not fail) for +10–25%.
- Nightly browser/task benches post results as artifacts. A hypothesis flipping from PASS to FAIL opens an issue (manual triage in MVP).

---

## 8. Rules for performance-sensitive PRs

1. Name the targets affected (PERFORMANCE.md ids).
2. Run the relevant benches before and after on the same machine, same commit base, N = 30.
3. Paste p50/p95 before → after in the task report (`BENCHMARK:` line, CODING_AGENT §10).
4. Do not change a target or a threshold constant (action-router `constants.ts`) without data. Constant changes must cite fixture precision (E6) and success (E5) results.

---

## 9. Rules for claims

- **No "fastest" claims** anywhere (README, docs, release notes) without a controlled, reproducible comparison.
- Every published number carries its conditions (machine, browser version, fixture vs real site, fake vs real model).
- Real-site timings (P11-01) are anecdotes with conditions, never targets or headline numbers.
- **External comparisons are post-MVP** and require identical conditions (same machine, browser version, fixtures, task scripts, model):
  - raw Playwright script with hand-written selectors (the **lower bound**: no resolution cost at all)
  - Stagehand (local, v3 cache mode), Browser Use, BrowserSkill (`bsk`)
  - each comparison documents versions and configuration, and is reproducible from `benchmarks/external/`.
- Results that make Browser-OS look bad are published with the same prominence as good ones.
