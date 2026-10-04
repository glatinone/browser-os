# Browser-OS Architecture

**Status:** Authoritative · **Version:** 1.0 (2026-10-02)
**Read with:** `PRD.md` (what/why), `specs/*.md` (exact interfaces and algorithms), `adr/*.md` (why these choices)

This document is the map. Every box links to the spec that defines it precisely. If this document and a spec disagree, the spec wins (see `CODING_AGENT.md` §3).

---

## 1. Principles

1. **Cheapest sufficient mechanism.** Cache → deterministic → small LLM → (vision) → human. AI is a fallback, never the default executor.
2. **Structure before pixels.** Accessibility tree + layout via CDP. No screenshots unless the vision tier runs.
3. **Real browser, owned profiles.** Chrome/Edge with persistent Browser-OS profiles; humans log in manually once.
4. **Learn and validate.** Everything learned (locators, trajectories) is re-validated against the live page before use. Never execute a stale selector blindly.
5. **Replaceable providers.** Browser, model and storage sit behind interfaces in `protocol`. Vendor types never cross package boundaries.
6. **Safe by construction.** Secrets are references; models only choose refs; risky actions need confirmation; challenges go to humans; no blind retries.
7. **Measure everything.** Every action reports tier, driver, latency, LLM usage.

---

## 2. System context

```
┌──────────────────────────────────────────────────────────────────────┐
│ AI agents / developer code                                           │
│ Claude Code · Codex · Cursor · custom TS agents · scripts            │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ shell: `bos …`                │ import '@browser-os/sdk'
                ▼                               ▼
        ┌──────────────┐                ┌──────────────┐
        │  bos CLI     │───────────────▶│  SDK client  │
        └──────────────┘                └──────┬───────┘
                                               │ JSON-RPC 2.0 / WebSocket
                                               │ 127.0.0.1 + bearer token
┌──────────────────────────────────────────────▼───────────────────────┐
│ Browser-OS daemon (Node ≥ 22, one per user)                           │
│                                                                      │
│  Task Manager ── Recorder / Replayer                                 │
│        │                                                             │
│  Action Router ── Policy/Risk/Permissions ── Human Gate              │
│     │      │            │                                            │
│  Observer  Model registry (fast / capable / vision)                  │
│  (DOM)        │                                                      │
│     │         └── OpenAI-compatible · Anthropic · Fake ──▶ LLM APIs  │
│  Session Manager ── Browser Providers (Launch, CdpEndpoint)          │
│     │                                                                │
│  Memory (SQLite): profiles · sessions · action_cache · trajectories  │
│                   tasks · action_runs · audit_log                    │
│  Event Bus ──▶ subscribers (CLI/SDK) · traces · stats                │
└──────────────┬───────────────────────────────────────────────────────┘
               │ Playwright pipe (launch)  /  CDP sessions (hot path)
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Chrome / Edge / Chromium, Browser-OS profile <BOS_HOME>/profiles/<n> │
│ cookies · storage · extensions · logged-in sessions                  │
└──────────────┬───────────────────────────────────────────────────────┘
               ▼
              Web
```

---

## 3. Process architecture

| Process | Lifetime | Owns | Talks to |
|---|---|---|---|
| `bos` CLI | one command | nothing persistent; `cli-state.json` (current session/observation/task ids) | daemon via SDK |
| daemon | long-lived (auto-started by CLI/SDK) | runtime, SQLite connection, browser processes, CDP sessions, in-memory secrets for active calls | browsers (pipe/CDP), LLM APIs (HTTPS) |
| Chrome/Edge | while its session is open (≤ daemon lifetime for LaunchProvider) | profile data | daemon only (no TCP debug port) |
| Chrome (manual setup mode) | until the user closes it | profile data | nobody (no automation) |

Single-instance rule: one daemon per `BOS_HOME` (pid in `daemon.json`, verified with `system.hello`).

---

## 4. Repository and package architecture

```
browser-os/
├── AGENTS.md                 entry point for coding agents → docs/CODING_AGENT.md
├── CLAUDE.md                 "@AGENTS.md"
├── README.md
├── package.json              pnpm workspace root (scripts: build, typecheck, test, test:browser, lint, format, bench)
├── pnpm-workspace.yaml
├── tsconfig.base.json        strict, ES2023, module NodeNext
├── biome.json
├── vitest.workspace.ts
├── packages/
│   ├── protocol/   @browser-os/protocol   types, zod schemas, errors, ids, mask, EventBus, paths, rpc method table
│   ├── browser/    @browser-os/browser    providers, profiles (fs), executables, CDP transport, isolated worlds, PageDriver
│   ├── dom/        @browser-os/dom        capture → join → interactive/visibility → semantic → serialize; lexical; locator; probe; challenge
│   ├── ai/         @browser-os/ai         ModelProvider impls (openai-compatible, anthropic, fake), registry, prompts
│   ├── memory/     @browser-os/memory     SQLite store, migrations, keys, cache/trajectory/task/run/audit stores
│   ├── runtime/    @browser-os/runtime    session manager, observer, router, security, human gate, tasks (recorder/replayer), createRuntime()
│   ├── daemon/     @browser-os/daemon     WS server, auth, JSON-RPC dispatch, lifecycle
│   ├── sdk/        @browser-os/sdk        typed client
│   └── cli/        @browser-os/cli        `bos` binary
├── fixtures/
│   ├── server.ts             startFixtureServer() (node:http static)
│   └── sites/<name>/index.html + truth.json   (basic, spa, iframe, shadow, dynamic, modal, overlay, login, risk, injection, upload, contenteditable, heavy, mutations…)
├── tests/
│   ├── helpers/              withFixtureServer, withTempBosHome, launchTestBrowser, fakeClock
│   └── e2e/                  vertical-slice, cli, hands e2e tests
├── benchmarks/
│   ├── harness.ts
│   ├── baseline/micro.json   CI regression baseline
│   ├── micro/  browser/  tasks/  startup/  real-sites/ (opt-in, never CI)
├── examples/
│   └── vertical-slice.ts
├── scripts/
│   ├── check-boundaries.mjs
│   └── record-capture.ts
└── docs/                     this documentation
```

Why these nine packages and not more: each package is a **replaceable boundary** (browser automation library, DOM algorithms, model vendors, storage) or a **delivery surface** (daemon, sdk, cli). Security, telemetry, recovery and tasks live inside `runtime` as folders, because they share its lifecycle and have no reason to be swapped independently. Fewer packages also means less boilerplate for coding agents.

### 4.1 Dependency graph (enforced by `scripts/check-boundaries.mjs`)

```
                    ┌───────────┐
                    │ protocol  │  (zod only)
                    └─────┬─────┘
      ┌──────────┬────────┼─────────┬───────────┐
      ▼          ▼        ▼         ▼           ▼
   ┌─────┐   ┌──────┐ ┌───────┐ ┌────────┐  ┌──────┐
   │ dom │   │  ai  │ │memory │ │browser │  │ sdk  │ (ws)
   └──┬──┘   └──┬───┘ └───┬───┘ └───┬────┘  └──┬───┘
      │         │  (sqlite)│ (playwright-core)  │
      └─────────┴────┬─────┴─────────┘          ▼
                     ▼                       ┌─────┐
               ┌──────────┐                  │ cli │
               │ runtime  │                  └─────┘
               └────┬─────┘
                    ▼
               ┌──────────┐
               │  daemon  │ (ws)
               └──────────┘
```

- `dom` never imports `browser`. It receives a `CdpTransport` (interface in `protocol`). That keeps DOM logic testable with recorded JSON.
- `runtime` is the only package that composes everything (`createRuntime()` is the composition root).
- `sdk` and `cli` depend only on `protocol` (+ `ws`). They never import runtime code.

---

## 5. Runtime architecture (inside the daemon)

```
createRuntime(config)
 ├── store            = openStore(<BOS_HOME>/browser-os.db)                [memory]
 ├── events           = new EventBus()                                     [protocol]
 ├── models           = ModelRegistry.fromConfig(config.models)            [ai]
 ├── providers        = { launch: LaunchProvider, 'cdp-endpoint': ... }    [browser]
 ├── sessions         = SessionManager(providers, store.sessions, events)  [runtime/sessions]
 ├── observer         = Observer(dom, sessions, events)                    [runtime/observer]
 ├── security         = { risk: RiskClassifier, permissions: PermissionGate, audit }   [runtime/security]
 ├── human            = HumanGate(sessions, events)                        [runtime/human]
 ├── router           = ActionRouter({ driver, observer, cache, model, risk, permissions, human, events })
 ├── tasks            = TaskManager(router, store.trajectories, store.tasks, events)   [runtime/tasks]
 └── api              = RuntimeApi  (methods 1:1 with specs/protocol.md §4)
```

Runtime folders (`packages/runtime/src/`): `sessions/`, `observer/`, `router/`, `security/`, `human/`, `tasks/`, `telemetry/` (run persistence, stats, traces), `config/`, `runtime.ts`, `api.ts`.

---

## 6. Data flow: observe

```
observe(sessionId)
  │
  ├─ Observer: reuse latest Observation if (no action, no navigation, mutation counter unchanged)
  │
  └─ else dom.captureRaw(cdp)     ── parallel CDP: DOMSnapshot.captureSnapshot · Accessibility.getFullAXTree
        │                                          Page.getLayoutMetrics · Page.getFrameTree
        ▼
     join → NodeTable (DOM ⨝ layout ⨝ AX by backendNodeId; frame offsets)
        ▼
     interactive ∧ visible (+ modal scoping)
        ▼
     semantic → SemanticElement[] (+ TextBlock[]), refs e1..eN, frames f0..fn, challenge
        ▼
     Observation (public)  +  ObservationIndex (daemon-only: ref → backendNodeId, frame, locator)
        ▼
     serialize → compact lines for CLI/LLM · event observation.captured
```

Spec: `specs/dom-intelligence.md`.

---

## 7. Action flow: act

```
act(action, ctx)
  │
  ├─ site access check (policy)                                         [security]
  ├─ targetless? (navigate/wait/press-without-target) → driver → done
  │
  ├─ resolveTarget:
  │     ref ───────────────▶ ObservationIndex (stale → heal via locator)
  │     locator ───────────▶ CACHE tier: probe (≤4 CDP RTT) → full match
  │     query ─────────────▶ DETERMINISTIC: structured filter
  │     intent ─┬──────────▶ CACHE tier via action_cache(origin, pathTemplate, type, intent)
  │             ├──────────▶ DETERMINISTIC: lexical rank (accept ≥0.75, margin ≥0.15)
  │             ├──────────▶ LLM: fast model picks ref from ≤30 candidates (JSON, zod)
  │             ├──────────▶ VISION (post-MVP; returns null in MVP)
  │             └──────────▶ HUMAN: pause → human picks ref / does it / aborts
  │
  ├─ challenge on page? → HUMAN pause (captcha/mfa/passkey/login/consent)
  ├─ risk classify → permission: allow | confirm (pause for approval) | deny
  ├─ resolve value (secrets only now, in memory)
  ├─ execute: CDP executor ──(TARGET_OBSCURED/ACTION_FAILED with effect=none)──▶ Playwright executor
  ├─ verify (fill/select read-back) · settle (network+DOM quiet, capped)
  ├─ learn: write action_cache (if resolved by deterministic/llm/human-ref) · recorder.append (if task)
  └─ persist action_runs · emit action.completed → ActionResult
```

Spec: `specs/action-router.md`.

---

## 8. Browser lifecycle

```
            bos profile create work
                     │
                     ▼
   <BOS_HOME>/profiles/work  (empty user-data-dir)
                     │
       bos profile open work      ← manual setup mode: plain Chrome, no automation;
                     │              human logs in, installs extensions, closes window
                     ▼
       session.open(profile=work) ── profile locked by a running Chrome? → PROFILE_LOCKED
                     │
                     ▼
   LaunchProvider: launchPersistentContext(dir, channel, pipe)   (≈1–2 s cold)
                     │
                     ▼
            Chrome running (owned by daemon) ◀──────────────┐
                     │                                       │
      crash / killed │                                       │ reconnect(): relaunch same profile,
                     ▼                                       │ restore last URL
               DISCONNECTED ─────────────────────────────────┘
                     │
         session.close / daemon stop
                     ▼
                Chrome exits (profile data persists on disk)
```

---

## 9. Session lifecycle

```
 starting ──▶ ready ◀──────────────┐
                │                  │
     act/observe│ (page lock)      │ done
                ▼                  │
              busy ────────────────┘
                │
   challenge /  │ ambiguity / confirmation
                ▼
        waiting_for_human ──(resume / approve)──▶ busy
                │ (abort / reject / timeout) ───▶ ready (action fails)
                │
   browser gone ▼
          disconnected ──reconnect──▶ ready
                │
          close ▼
              closed
```

Pages: `pg_…` ids. A tab opened by an action becomes the active page. Per-page mutex: one action at a time per page. Different pages and sessions run concurrently. Spec: `specs/browser-runtime.md` §3.

---

## 10. AI routing

| Purpose | Model tier | Input | Output | When |
|---|---|---|---|---|
| `resolve_target` | `fast` | action type, intent, url/title, dialogs, ≤ 30 element lines | `{ref, confidence}` | cache and deterministic tiers failed |
| `extract` (structured, post-MVP) | `fast`/`capable` | text blocks of target | JSON per schema | `extract` with schema |
| `vision_locate` (post-MVP) | `vision` | screenshot + intent | point / element | vision tier enabled |

Rules: temperature 0; JSON schema output validated with zod; returned ref must be in the candidate list (model output never becomes a selector); budget per action (2) and per task (20); no model configured → tier disabled, system still works. Providers: plain `fetch`, no vendor SDKs (ADR-012).

The planner tier (`capable`) is configured but **unused in MVP**. Multi-step planning belongs to the calling agent.

---

## 11. Memory lifecycle

```
           FIRST RUN (record)                         LATER RUN (replay)
task.start(key, params)                       task.run(key, params)
   │                                             │
   ├─ act(intent) → deterministic/llm            ├─ step i: substitute params/secrets
   │     └─ cache.put(locator)                   │     check pre.urlPattern (wait for SPA route)
   │     └─ recorder.append(step: locator,       │     router.execute(locator, healIntent)
   │          intent, param refs, risk)          │        ├─ probe ✓ → execute (0 tokens)
   ├─ …                                          │        └─ probe ✗ → match ✗ → heal via
task.end(success)                                │             deterministic/llm → healed[]
   └─ trajectory v1 (active)                     ├─ success → stats++, healed → v+1
                                                 └─ failure → suspect → (2nd) invalid → next run records
```

Cache entries: `active` → 3 consecutive misses or 1 false hit → `invalid` → overwritten by next successful resolution. Spec: `specs/memory.md`.

---

## 12. Failure recovery

| Failure | Detected by | Recovery | Bound |
|---|---|---|---|
| Stale ref | ObservationIndex epoch | heal through stored locator (deterministic) | once |
| Cached locator not found | probe + match | next tier (deterministic → llm → human) | each tier once |
| Ambiguous target | score margin | next tier; LLM ambiguous → human | — |
| Obscured / not interactable | CDP hit-test | Playwright executor (waits for actionability) | once, only if `effect='none'` |
| Effect unknown (timeout after input) | driver | **no retry**; report `ACTION_FAILED{effect:'unknown'}` | 0 |
| Navigation timeout | driver | report retryable `TIMEOUT` | caller decides |
| Browser crash / disconnect | provider event | `reconnect` (relaunch profile, restore URL), re-run resolution | once |
| Security challenge | `challenge.ts` | human pause; resume continues | human timeout |
| LLM unavailable / invalid output | provider / zod | one retry for invalid JSON; then skip to human | 1 retry |
| Budget exceeded | budget counters | fail `BUDGET_EXCEEDED` | — |
| Trajectory step precondition fails | replayer | fail step → trajectory suspect/invalid | 2 strikes |

`act` never throws for action failures. It returns `ActionResult{ok:false}` with an error code. Retries are bounded by `policy.budgets.maxRetriesPerAction`.

---

## 13. Security boundaries

```
 ┌───────────────────── trust: user ─────────────────────┐
 │  CLI/SDK caller (token holder)                        │
 └───────────────┬───────────────────────────────────────┘
                 │ loopback WS + bearer token; Origin header rejected
 ┌───────────────▼───────────────────────────────────────┐
 │ daemon (trusted)                                      │
 │  secrets: in memory per call only                     │
 │  policy/risk/permission gate · audit log (masked)     │
 └───────┬───────────────────────────┬───────────────────┘
         │ pipe (no TCP port)        │ HTTPS: compact element lines only
 ┌───────▼──────────┐        ┌───────▼────────────────────────┐
 │ browser profile  │        │ LLM provider (semi-trusted)    │
 │ cookies/tokens   │        │ never receives cookies, tokens,│
 │ never exported   │        │ full HTML, sensitive values    │
 └───────┬──────────┘        └────────────────────────────────┘
         │
 ┌───────▼──────────────────────────────┐
 │ web pages (UNTRUSTED: prompt injection)│
 │ page text = data; model picks refs only│
 └──────────────────────────────────────┘
```

Details: `SECURITY.md`.

---

## 14. IPC

- Transport: WebSocket `ws://127.0.0.1:<port>/rpc` (`ws` library), JSON-RPC 2.0, `protocolVersion: "1"`.
- Auth: bearer token from `<BOS_HOME>/daemon.token` (owner-only permissions), constant-time compare; any `Origin` header → 403.
- Server push: `event` notifications after `events.subscribe`.
- Why not named pipes / unix sockets (BrowserSkill's choice): WebSocket works identically on Windows/macOS/Linux, works with the same client code in the SDK, and gets authentication from the token rather than from filesystem ACLs alone. Spec: `specs/protocol.md`; ADR-017.

---

## 15. Extension points (designed, not built in MVP)

| Interface | MVP implementations | Future |
|---|---|---|
| `BrowserProvider` | Launch, CdpEndpoint | ChromeConsent (P13-01), Extension (P13-04), Lightpanda (P13-07), Remote (P13-08) |
| `ModelProvider` | openai-compatible, anthropic, fake | any HTTP model |
| `VisionResolver` | null resolver | P13-03 |
| Delivery | CLI, SDK | MCP server (P13-02) |
| Event sinks | CLI subscribers, JSONL traces, SQLite runs | OTel exporter (P13-05) |

---

## 16. What Browser-OS owns vs. uses

| Owns (BUILD) | Uses (DEPENDENCY / USE) |
|---|---|
| Action Router, execution policy, recovery | Chrome/Edge/Chromium, CDP |
| DOM intelligence, semantic compression, locators, probe | Playwright (`playwright-core`) |
| Action cache, trajectory memory, healing | SQLite (`better-sqlite3`) |
| Session abstraction, provider abstraction | `ws`, `zod` |
| Permission/risk model, human gate, secrets handling | LLM APIs over HTTPS |
| Protocol, SDK, CLI, benchmarks | |

Classification for every subsystem, with OSS evidence: `OSS_STRATEGY.md`.
