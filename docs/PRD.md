# Browser-OS: Product Requirements Document

**Status:** Authoritative · **Version:** 1.0 (2026-10-02) · **Scope:** MVP v0.1.0
**Supersedes:** `docs/history/01-…` through `04-…`

---

## 1. What Browser-OS is (technical definition)

Browser-OS is a **local daemon plus a TypeScript SDK and a CLI** that let any AI agent operate a real, persistent, logged-in Chrome or Edge browser through a small set of structured actions (`observe`, `click`, `fill`, `press`, `select`, …).

For each action it does three things:

1. It converts the page into a **compact semantic list of interactive elements**, built from Chrome's own accessibility tree and layout via CDP, typically 20–200 lines instead of megabytes of HTML.
2. It resolves the action's target through a **fixed cost ladder**: learned locator (cache) → deterministic matching → small LLM → human. It executes through raw CDP input, with Playwright as a fallback.
3. It **learns**. Every successful resolution is cached per site. Every successful task (a named, parameterized sequence of actions) is stored as a **trajectory**. The next run of that task replays the trajectory and validates each step against the live page, with **zero LLM calls** when the site has not changed. It self-heals the steps that did change.

In one line:

> **Browser-OS makes the LLM unnecessary for as much of a browser task as possible, and gets cheaper and faster each time a task repeats.**

Browser-OS is **not** a browser engine, not a browser UI, not an LLM, not an autonomous agent framework, not a cloud browser service, and not a clone of Browser Use, Stagehand, Steel or BrowserSkill.

---

## 2. Who uses it

| User | How they use Browser-OS | Example |
|---|---|---|
| **AI coding/desktop agents** (Claude Code, Codex, Cursor, custom agents) | shell out to `bos` CLI (later MCP) | "Open my Jira board and list tickets assigned to me" |
| **Developers building agents or automations** in TypeScript | `@browser-os/sdk` | nightly "download last month's invoices" job |
| **Power users / automation teams** with repetitive authenticated web work | record once, replay with params | CRM data entry, enterprise portal reports |
| **Researchers** | benchmarks, ablations, trajectory data | measuring LLM-free replay rates |

The MVP is **developer-first**. It ships a CLI and SDK, with no GUI.

---

## 3. The problem

Today's browser agents spend most of their time and money on work that does not need intelligence:

1. **An LLM call per click.** An agent loop sends page state to a model for every action, even when the action is obvious or was done identically yesterday.
2. **Huge observations.** Raw HTML or screenshots are sent where a few hundred tokens of structure would do.
3. **No memory.** The tenth run of a workflow costs the same as the first.
4. **Fresh, logged-out browsers.** Tools spin up clean browsers, which breaks SSO, MFA and enterprise auth, or they need fragile credential automation.
5. **Unsafe defaults.** Page text can steer the model, and nothing stops a "delete account" click.

Measured by **total task latency and cost**, the bottleneck is usually not Chrome. It is how often the agent has to think, how much data it sends to a model, and how often it re-observes.

---

## 4. Why existing tools are not enough

Verified against current repositories (October 2026). Details: `OSS_STRATEGY.md`.

| Tool | What it does well | Why it is not Browser-OS |
|---|---|---|
| **Playwright** (Apache-2.0) | Mature, reliable deterministic automation; persistent contexts; new public `ariaSnapshot({mode:'ai'})` | No intelligence: a human writes selectors. No intent resolution, no learning, no routing, no session daemon for agents. We **use** it. |
| **Browser Use** (MIT, Python) | Strong autonomous agent loop, CDP-native DOM serializer | LLM-in-the-loop by design. Python (cannot be a TS dependency). Replay exists but is not a local, validated, self-invalidating cache. The deterministic workflow project (workflow-use) is AGPL and early-stage. |
| **Stagehand** (MIT, TS) | `act/observe/extract` primitives; v3 had a local action cache with self-heal | v4 (Aug 2026) **removed local caching** (Browserbase-server only) and removed `agent()`. The v3 cache keys on URL + instruction with no page validation and no invalidation. No task-level trajectories, no tiered router, no persistent-profile session daemon. |
| **BrowserSkill** (MIT, Tencent) | Real logged-in Chrome via MV3 extension + daemon; excellent CDP observation pipeline | No caching, no replay, no learning, no adaptive routing. Refs are not stable across observations. CLI-per-call with no library API. Local IPC is not authenticated. |
| **Steel** (Apache-2.0) | Browser/session infrastructure API, Docker self-host | Infrastructure only, with no intelligence layer. Puppeteer-based, single-session per instance, open profile-isolation bug (#347). Server-oriented, not local-first. |
| **Vercel agent-browser, Playwright MCP, Chrome DevTools MCP** | Agent-facing CLIs/MCP with accessibility snapshots and refs | Every action still goes through the calling model. Nothing is learned between runs. |

**Gap:** no current project combines (a) a persistent real-browser session runtime, (b) a cost-ordered resolution ladder where the LLM is a fallback, and (c) **local, validated, self-healing task trajectories** that drive repeat runs to zero LLM calls.

---

## 5. Technical differentiation (what we actually build)

1. **Action Router**: deterministic tier ladder with measured per-tier cost and precision (spec: `specs/action-router.md`).
2. **Durable element identity**: `ElementLocator` fingerprints (role, accessible name, stable attributes, context, css path, frame path) resolved by weighted matching, plus a ≤ 4-round-trip probe fast path (spec: `specs/dom-intelligence.md` §8).
3. **Trajectory memory**: parameterized, secret-free step lists with validation, healing, versioning and invalidation (spec: `specs/memory.md`).
4. **Semantic DOM compression**: CDP DOMSnapshot + accessibility tree → compact lines; LLM sees ≤ 30 candidates (~1k tokens).
5. **Safety by construction**: secrets never persisted or sent to models; LLM output can only pick a ref from the list; high-risk actions require confirmation; CAPTCHA, MFA and login always go to a human.
6. **Measurement**: every action records which tier resolved it and what it cost. The benchmark suite includes ablations that test the thesis.

---

## 6. MVP

### 6.1 Thesis the MVP must prove

> A real persistent browser can execute common web tasks with dramatically less AI overhead by combining deterministic browser control, semantic DOM intelligence, adaptive routing, and learned trajectories.

Concretely, **M3 + M6 acceptance**: on the fixture benchmark suite, replaying a recorded task makes **0 LLM calls**, runs **≥ 3× faster** end-to-end than the recording run (with simulated LLM latency), and succeeds **≥ 95%** of the time. After controlled DOM mutations it still succeeds ≥ 90% of the time through cache matching or healing.

### 6.2 MVP IN

| # | Feature | Why | Priority | Depends on | Acceptance criteria |
|---|---|---|---|---|---|
| 1 | Owned persistent profiles + manual setup mode | Auth state is the asset; humans log in once without automation | P0 | — | Cookie set in session A is present after close/reopen; `bos profile open` launches without automation flags |
| 2 | LaunchProvider (Playwright persistent context, pipe) + session manager with reuse/reconnect | Warm sessions; no exposed debug port | P0 | 1 | Second `session.open` returns same session; killed browser → `reconnect` restores last URL |
| 3 | CdpEndpointProvider (attach to loopback CDP) | Tests, interop, power users | P2 | 2 | Attaches to a test-launched Chromium; rejects non-loopback |
| 4 | CDP action executor + Playwright fallback, with `effect` semantics | Fast hot path, reliable fallback, no blind retries | P0 | 2 | All MVP actions pass on fixtures; obscured click → fallback; `unknown` effect never retried |
| 5 | Semantic observation (DOMSnapshot + AX) with refs, modal scoping, challenge detection | Compact, structured page state | P0 | 2 | Golden tests pass on all fixtures; ≥ 95% role/name agreement with Playwright ariaSnapshot oracle |
| 6 | Deterministic resolution (structured query + lexical intent) | Avoid LLM for obvious targets | P0 | 5 | ≥ 99% precision on fixture truth sets |
| 7 | ElementLocator build/match + probe | Durable identity for cache/replay | P0 | 5 | Mutation suite: correct element best with margin in ≥ 95% of cases |
| 8 | LLM tier (fast model), provider-agnostic (OpenAI-compatible + Anthropic + Fake) | Fallback for ambiguous intents | P0 | 5,6 | Valid ref chosen on fixture intents with FakeModel; invalid refs rejected; no secrets in prompts |
| 9 | Action cache (site memory) with lifecycle | Repeat single actions without LLM | P0 | 7 | Second identical intent resolves at cache tier with 0 model calls |
| 10 | Task record/replay (trajectory memory) with healing + invalidation | The core thesis | P0 | 7,9 | Vertical slice test (§7) passes |
| 11 | Human gate (pause/resume) for ambiguity and security challenges | Safety + robustness | P0 | 5 | Fixture OTP page pauses; `bos human resume --done` continues the task |
| 12 | Risk classification + permission confirmation | Prevent destructive actions | P0 | 5 | "Delete account" fixture requires approval; reject → `PERMISSION_DENIED` |
| 13 | Secrets as references (`ValueSource.secret`) | Never persist or leak secrets | P0 | 10 | Canary secret absent from DB, logs, traces, events, prompts |
| 14 | Daemon (JSON-RPC over loopback WS, token auth) + CLI `bos` + SDK | Usable by any agent | P0 | 1–13 | CLI e2e of the vertical slice passes; unauthenticated connection rejected |
| 15 | Telemetry: events, `action_runs`, `bos stats` | Measure the thesis | P1 | 14 | Stats show tier distribution, cache hit rate, LLM calls/task |
| 16 | Benchmark suite with ablation modes | Prove the thesis | P0 | 10 | Report with H1–H4 results (PERFORMANCE.md) |
| 17 | Compatibility hardening: OOPIF, multi-tab, MFA flow, large pages (evidence-gated) | Real websites | P1 | 10 | COMPATIBILITY.md matrix filled at P12-03 |
| 18 | Uploads (allow-listed dirs) and downloads (opt-in) | Common real workflows | P2 | 4 | Fixture upload/download tests pass; outside-dir upload rejected |

### 6.3 MVP OUT (do not build yet)

| Not in MVP | Reason | When |
|---|---|---|
| Autonomous multi-step planner inside Browser-OS | The calling agent is the planner; building one duplicates Browser Use and blurs the product | Maybe P13-06, only if users need `bos run "<goal>"` |
| Vision / computer-use tier | Expensive; DOM covers most cases; needs evidence | P13-03 (interface exists in MVP) |
| Chrome extension / attach to the user's daily browser | Big surface; Chrome 144 consent flow may make it unnecessary | P13-01 (consent), P13-04 (extension) |
| MCP server | Thin adapter; CLI + SDK prove the core first | P13-02 (first post-MVP item) |
| Remote/cloud mode, browser fleets, Kubernetes | Local-first thesis first | P13-08 |
| Lightpanda or other engines | Compatibility first; AGPL | P13-07 |
| OpenTelemetry SDK exporter | Event schema is OTel-compatible; exporter later | P13-05 |
| Vector DB, embeddings, semantic task matching | No evidence exact keys are insufficient | Only with benchmark evidence |
| Global (cross-site) memory | Needs data first | Future |
| UI / dashboard | Not needed to prove thesis | Future |
| Python SDK | TypeScript first | Future |
| Automatic password/OTP filling, CAPTCHA handling | Security boundary: human does it | Never automatic for CAPTCHA/MFA; password autofill possibly later behind explicit policy |
| Stealth / anti-bot evasion | Ethics + security stance (SECURITY.md §7) | Never |

---

## 7. First vertical slice (milestone M3, the thesis demo)

```
Launch persistent Chrome profile "bench" (LaunchProvider, pipe)
        ↓
Create Browser-OS session; navigate to fixture SPA (fixtures/sites/spa)
        ↓
task.start(key="spa.search-and-open", params={query:"Ada Lovelace"})       ← record mode
        ↓
act fill  {intent:"the search box"} value={param:query} submit   → tier: deterministic or llm
act click {intent:"the first result"}                             → tier: llm (ambiguous for lexical)
act click {intent:"the Contact tab"}                              → tier: deterministic
extract   {format:"text", target:{intent:"the email field"}}
        ↓
task.end(success) → trajectory saved (3 locators + intents + params)
        ↓
task.run(key="spa.search-and-open", params={query:"Alan Turing"})        ← replay mode
        ↓
each step: probe(locator) → verify identity → CDP execute → no observation needed when probe succeeds
        ↓
assert: stats.llmCalls == 0, all tiers == cache, success, E2E ≥ 3× faster than run 1 (FakeModel latency 800 ms)
        ↓
mutate fixture (?variant=mutated: classes renamed, order changed, wrapper added)
        ↓
task.run again → still success; healed steps (if any) recorded as new trajectory version
```

Acceptance tests: `tests/e2e/vertical-slice.e2e.test.ts` (task P7-08) and its CLI twin `tests/e2e/cli.e2e.test.ts` (P8-08). The script `examples/vertical-slice.ts` prints a run 1 vs run 2 comparison table.

---

## 8. User experience (MVP)

```console
$ bos profile create work
$ bos profile open work            # log in to sites by hand, then close the window
$ bos session open --profile work
session ses_01J… ready (chrome, profile work)

$ bos navigate https://app.example.com
$ bos observe
url: https://app.example.com/home
e1 searchbox "Search" [banner]
e2 link "Invoices" [navigation:Main]
...
$ bos task start example.download-invoice --param month=April
$ bos click "Invoices"                      ok tier=deterministic driver=cdp 61ms llm=0
$ bos click "the April invoice download"    ok tier=llm driver=cdp 912ms llm=1
$ bos task end
trajectory example.download-invoice v1 saved (2 steps)

$ bos task run example.download-invoice --param month=May
step 1 click  tier=cache 38ms
step 2 click  tier=cache 44ms
done in 0.4s · llm calls 0 · cache hits 2
```

Note: "April invoice" contains the param value `April` → the locator for step 2 is stored with a dynamic name and matched by role/context/attributes, so `month=May` works on replay. If the structure differs, healing (LLM) repairs the step once and records version 2.

---

## 9. Goals and non-goals

**Goals (MVP):** prove the thesis; real authenticated sessions; zero-LLM replay; safety by construction; reproducible measurements; maintainable codebase that cheaper coding models can extend.

**Non-goals:** best-in-class autonomous agent success rates on open-ended benchmarks; cloud scale; bypassing site protections; supporting non-Chromium browsers.

---

## 10. Success metrics (MVP exit)

| Metric | Target | Where measured |
|---|---|---|
| LLM calls per replayed task (unchanged fixtures) | 0 | P10-04 |
| Replay vs record E2E speedup (FakeModel 800 ms) | ≥ 3× p50 | P10-04 |
| Task success, fixtures, replay | ≥ 95% | P10-04 |
| Task success after mutations (cache or heal) | ≥ 90% | P10-04 |
| Deterministic-tier precision | ≥ 99% | P4-07, P10-02 |
| Cache-tier action latency (Browser-OS overhead, local) | p50 ≤ 50 ms, p95 ≤ 150 ms | P10-03 |
| Tokens per LLM resolution | p95 ≤ 1.5k | P10-04 |
| Secret leakage | 0 occurrences (canary) | P9-06 |
| Real-site matrix | filled with honest results; ≥ 4 site classes "Full" | P12-03 |

---

## 11. Naming

- Product: **Browser-OS**. Packages: `@browser-os/*`. CLI binary: `bos`. Data dir: `BOS_HOME`.
- Older names in history files ("BrowserSkill Ultra", `browser-ultra`) are obsolete.
