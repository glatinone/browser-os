# OSS Strategy: Use, Adapt, Build

**Status:** Authoritative · **Version:** 1.0 (2026-10-02) · Research verified against current repositories on 2026-10-02.
**Related ADRs:** 001, 002, 005, 006, 007, 008, 012, 013

---

## 0. The hard rule

> **Do not fork, vendor, replace, or substantially modify an existing OSS dependency unless the task explicitly identifies a measured limitation, licensing requirement, security requirement, or performance bottleneck, and an ADR approves it.**

Corollaries for coding agents:
- Reading other projects for ideas is encouraged. **Copying code is not allowed** unless a task card says `port: allowed` **and** the source license is permissive (MIT/Apache-2.0/BSD), and you follow §5.
- **Never copy from AGPL/SSPL/GPL projects** (workflow-use, Lightpanda, Skyvern, Notte, …), not even small snippets.
- New runtime dependencies need an ADR. Pre-approved list: `CODING_AGENT.md` §6.

---

## 1. OSS landscape matrix

Legend for Use/Fork/Reference/Avoid: ✅ = yes, ➖ = no, 🔍 = study concepts.

| Project | Purpose | License | Language | Use (dep) | Fork | Reference | Avoid | Reason |
|---|---|---|---|---|---|---|---|---|
| **Chromium / Chrome / Edge** | Browser engine | BSD / proprietary builds | C++ | ✅ USE | ➖ | — | Forking Chromium | Real-site compatibility (SSO, MFA, passkeys, extensions). Far too large to fork. |
| **Chrome DevTools Protocol** | Low-level browser control | BSD | protocol | ✅ USE | ➖ | — | Building a full CDP framework | Hot path: DOMSnapshot, AX tree, Input. |
| **Playwright** 1.63 | Browser automation | Apache-2.0 | TS | ✅ `playwright-core` (only in `packages/browser`) | ➖ | 🔍 `ariaSnapshot({mode:'ai'})` as test oracle | Leaking Playwright types; relying on private APIs (`_snapshotForAI`) | Mature launch/persistent contexts/frames/fallback actions. CDP sessions via `newCDPSession`. |
| **SQLite** via `better-sqlite3` | Local persistence | Public domain / MIT | C / C++ | ✅ (only in `packages/memory`) | ➖ | — | ORMs, external DBs | Single-file, fast, sync API. |
| **ws** | WebSocket | MIT | JS | ✅ | ➖ | — | — | Daemon/SDK transport. |
| **zod** | Runtime validation | MIT | TS | ✅ | ➖ | — | — | Protocol, config, LLM output validation. |
| **OpenTelemetry JS** | Telemetry | Apache-2.0 | TS | ➖ (post-MVP exporter, P13-05) | ➖ | 🔍 naming conventions | Heavy SDK in MVP | Event schema is OTel-compatible already (ADR-015). |
| **BrowserSkill** (Tencent) 0.3.2, commit `3f10983` | Agent → CLI → daemon → MV3 extension → `chrome.debugger` on the user's real browser | **MIT** | Rust + TS | ➖ (no library API; CLI-per-call; internal protocol 1.3 changing fast; auto-update) | ➖ | 🔍 **SELECTIVE PORT allowed** (MIT) | Unauthenticated local WS/pipe design; "no cache/no replay" model | Best-in-class CDP observation pipeline (DOMSnapshot ⨝ AX by backendNodeId, per-frame isolation, document-identity guard, modal layer folding, `effect_state`). Agent Window/borrow UX for a future extension provider. |
| **Stagehand** v4.1 / v3.7 | AI browser SDK: act/observe/extract | **MIT** | TS | ➖ | ➖ | 🔍 (v3 cache + self-heal; Understudy CDP driver; hybrid AX snapshot) | v4 server-side cache (Browserbase-only), URL-only cache keys, no invalidation | v4 removed local caching and `agent()`; v4 runs inside an extension; Browserbase coupling. v3 is the best prior art for cache → LLM fallback. |
| **Browser Use** 0.13 | Autonomous browser agent | **MIT** | Python | ➖ (Python) | ➖ | 🔍 (CDP DOM serializer, paint-order filter, clickable heuristics, 5-level re-identification ladder, watchdogs) | LLM-in-the-loop as default; cloud-shared skills (privacy) | Can't be a TS dependency; different product (agent, not runtime). |
| **browser-use/workflow-use** | Record → deterministic workflow → agent fallback | **AGPL-3.0** | Python + TS | ➖ | ➖ | 🔍 concepts only (semantic target text + ordered selector strategies) | **Any code** (AGPL) | Closest concept to trajectories, but AGPL and "not for production". |
| **browser-use/browser-harness(-js)** | Thin CDP harness to the user's real Chrome | MIT | Python / TS (Bun) | ➖ | ➖ | 🔍 Chrome 144+ `DevToolsActivePort` attach, typed CDP codegen | — | Reference for ChromeConsentProvider (P13-01). |
| **jev-ultrafast** (Browser Use) | Fast agent loop with hosted policy model | MIT (needs paid API) | Python + JS | ➖ | ➖ | 🔍 "model output never becomes selectors", freshness/occlusion guards, short post-action waits | Hosted policy dependency | Speed ideas only. |
| **Steel browser** | Browser/session API server | **Apache-2.0** | TS (Fastify + Puppeteer 23) | ➖ | ➖ | 🔍 session lifecycle API, CDP proxy, extension/proxy plumbing | Puppeteer stack; single-session design; profile isolation bug #347 | Infrastructure, not intelligence; server/Docker-oriented. |
| **Lightpanda** | Headless browser in Zig | **AGPL-3.0** (commercial available) | Zig | ➖ (future out-of-process provider, P13-07) | ➖ | 🔍 PandaScript (replayable sessions) | Linking or copying code; making it the default engine | Not Chrome parity, no real screenshots, no Windows binary, AGPL. |
| **Playwright MCP** | MCP server, a11y snapshot + refs | Apache-2.0 | TS | ➖ | ➖ | 🔍 incremental snapshots, extension bridge, ref format | — | Agent surface; no learning. Reference for P13-02 MCP. |
| **Chrome DevTools MCP** | MCP for DevTools | Apache-2.0 | TS (Puppeteer) | ➖ | ➖ | 🔍 `--autoConnect` (Chrome 144+) | Telemetry on by default | Reference for consent attach. |
| **Vercel agent-browser** | Rust CLI, raw CDP, refs, sessions | Apache-2.0 | Rust | ➖ | ➖ | 🔍 CLI ergonomics, `@eN` refs, session/profile flags | — | Strong competitor at the CLI layer; reinforces that our differentiation must be routing + memory, not the CLI. |
| **Magnitude** | Vision-first agent | Apache-2.0 | TS | ➖ | ➖ | 🔍 vision tier design (P13-03) | — | Vision reference. |
| **Nanobrowser** | In-browser extension agent | Apache-2.0 | TS | ➖ | ➖ | 🔍 extension architecture (P13-04) | — | Extension reference. |
| **Skyvern** | Vision-first workflows | **AGPL-3.0** | Python | ➖ | ➖ | concepts only | **Any code** | License. |
| **Notte** | Perception layer / agent | **SSPL-1.0** | Python | ➖ | ➖ | concepts only | **Any code** | License. |

---

## 2. Source strategy per Browser-OS subsystem (definitive)

Exactly one classification each. Vocabulary: **USE** (run/speak to it as-is), **DEPENDENCY** (npm dependency), **ADAPTER** (our interface wrapping a dependency), **SELECTIVE PORT** (permitted copying of specific MIT/Apache code, task-authorized), **REFERENCE ONLY** (concepts, no code), **BUILD** (our own code), **FORK**, **VENDOR**, **REPLACE LATER** (a dependency we expect to swap once evidence arrives).

| Subsystem | Classification | Source / notes |
|---|---|---|
| Browser engine (Chrome/Edge/Chromium) | **USE** | ADR-001 |
| CDP | **USE** | raw sessions via Playwright `newCDPSession` |
| Playwright | **DEPENDENCY** → wrapped by **ADAPTER** (`packages/browser`) | ADR-002; candidate **REPLACE LATER** for the fallback executor only if benchmarks show overhead matters |
| Browser providers (`BrowserProvider`) | **BUILD** (ADAPTER over Playwright) | `specs/browser-runtime.md` §2 |
| Profile management + manual setup mode | **BUILD** | ADR-003 |
| Session manager | **BUILD** | concepts from Steel/BrowserSkill (REFERENCE) |
| CDP executor (click/fill/press/select/scroll) | **BUILD** | geometry/hit-test ideas from BrowserSkill `interaction.ts` (REFERENCE) |
| Playwright fallback executor | **ADAPTER** | |
| DOM capture (DOMSnapshot + AX) | **BUILD** (SELECTIVE PORT allowed from BrowserSkill `tools/vom/*`, MIT) | default: implement from spec; porting only if a task card says so |
| Semantic DOM / compression / serialization | **BUILD** | BrowserSkill `packages/vom` render ideas (REFERENCE / SELECTIVE PORT allowed) |
| Element locator + matching + probe | **BUILD** | ideas from Browser Use re-identification ladder (REFERENCE) and Stagehand XPath stitching (REFERENCE) |
| Lexical deterministic resolver | **BUILD** | |
| Challenge detection | **BUILD** | |
| Action Router + execution policy + recovery | **BUILD** | core IP |
| Action cache | **BUILD** | improves on Stagehand v3 (REFERENCE) |
| Trajectory memory (record/replay/heal) | **BUILD** | concepts from workflow-use (REFERENCE ONLY, AGPL) and BrowserSkill trace v3 schema (REFERENCE) |
| Model provider abstraction + providers | **BUILD** (plain `fetch`) | ADR-012; no vendor SDKs |
| Prompts (resolve target) | **BUILD** | |
| Storage | **DEPENDENCY** (`better-sqlite3`) behind **ADAPTER** (`packages/memory`); **REPLACE LATER** candidate: `node:sqlite` | ADR-004 |
| Security: risk, permissions, human gate, secrets | **BUILD** | ADR-014 |
| Telemetry / events / stats | **BUILD**; OTel exporter later (**DEPENDENCY** post-MVP) | ADR-015 |
| Daemon + JSON-RPC protocol | **BUILD** on `ws` (**DEPENDENCY**) | ADR-017 |
| SDK, CLI | **BUILD** (`node:util` parseArgs) | |
| Benchmarks + fixtures | **BUILD** | |
| Extension provider | **BUILD** later (REFERENCE: Playwright MCP Bridge, BrowserSkill, Nanobrowser) | ADR-013, P13-04 |
| Chrome 144 consent attach | **BUILD** later (REFERENCE: browser-harness, Chrome DevTools MCP) | P13-01 |
| Lightpanda | **USE** later, out-of-process only | P13-07 |
| Vision tier | **BUILD** later (REFERENCE: Magnitude, Stagehand CUA) | P13-03 |
| MCP server | **BUILD** later (REFERENCE: Playwright MCP) | P13-02 |

Nothing in Browser-OS is classified **FORK** or **VENDOR**.

---

## 3. What we deliberately take from each project (concepts)

| From | Concept | Where it lands |
|---|---|---|
| BrowserSkill | DOMSnapshot ⨝ AX by `(frameId, backendNodeId)`; per-frame failure isolation; document-identity guard | `specs/dom-intelligence.md` §2–3 |
| BrowserSkill | `effect_state` none/committed/unknown → no blind retries | `specs/action-router.md` §4.1 |
| BrowserSkill | name-resolution priority; modal/mask layer folding; context disambiguation | dom §5–6, P11-05 |
| BrowserSkill | Agent Window, tab borrowing with confirmation, single-use user interrupt | future ExtensionProvider (P13-04) |
| Stagehand v3 | cache keyed by instruction + normalized URL + variable *names*; self-heal then rewrite | `specs/memory.md` §4–6 (improved: path templates, validation, lifecycle) |
| Stagehand v3/v4 | `observe()` returning selectors so credentials are typed without the model seeing them | ValueSource secrets (SECURITY.md §8) |
| Browser Use | paint-order occlusion filter; clickable heuristics incl. JS listeners; 5-level re-identification ladder | dom §4, §8.4, P11-05 |
| jev-ultrafast | model output never becomes selectors/coordinates/JS; freshness + occlusion check before input; short post-action waits | router §5.2, browser-runtime §5 |
| workflow-use (AGPL: concepts only) | steps carry semantic target text + ordered selector strategies; agent fallback on failure | `TrajectoryStep.intent` + locator + healing |
| Steel | session lifecycle API shape; future remote browser plumbing | protocol §4, P13-08 |
| Playwright MCP | ref format; incremental snapshots (future optimization); extension bridge token | P13-02, P13-04 |

---

## 4. What we deliberately avoid

- Making any agent framework (Browser Use, Stagehand) the core loop, or putting an autonomous planner in the runtime (MVP).
- Server-side or cloud-shared memory (Stagehand v4 cache, Browser Use cloud skills): privacy plus local-first.
- URL-only cache keys and "rm -rf to invalidate" caches.
- Index-only element references persisted across runs (unstable).
- Origin-header-only local authentication (BrowserSkill's local WS).
- Stealth/fingerprint plugins (Steel ships fingerprint injection; we do not; SECURITY.md §7).
- Puppeteer + Playwright side by side (one automation library only).
- Python sidecars.

---

## 5. Porting procedure (only when a task card authorizes it)

1. The task card must state: `port: allowed from <repo>@<commit> <path(s)>`.
2. Verify the license at that commit (MIT/Apache-2.0/BSD only).
3. Copy the minimum necessary, adapt to our types and conventions, and add a header comment:
   `// Portions adapted from <repo> (<license>), <path>@<commit>. See THIRD_PARTY_NOTICES.md.`
4. Add or extend `THIRD_PARTY_NOTICES.md` at the repo root with the project name, license text and copyright line.
5. Tests for ported code are ours. Do not port tests that depend on their harness.
6. Mention the port in the task report under DECISIONS.

Pinned references: BrowserSkill `github.com/Tencent/BrowserSkill@3f10983` (MIT, © 2026 Tencent). Stagehand `github.com/browserbase/stagehand` v3 line (`@browserbasehq/stagehand@3.7.3`, MIT).

---

## 6. Re-evaluation triggers

| Trigger | Re-evaluate |
|---|---|
| Benchmarks show Playwright fallback/launch overhead > 20% of replay latency | ADR-002: replace fallback executor with own CDP actionability layer |
| `node:sqlite` stable and faster in our benches | ADR-004 |
| Playwright public APIs gain backendNodeId/attribute access in ariaSnapshot JSON | ADR-009: consider using it as the production observer |
| Chrome 144+ consent attach works reliably with Playwright ≥ 1.60 | P13-01 priority up, ADR-013 extension deferred further |
| Lightpanda reaches CDP parity for our fixture suite and ships Windows builds | P13-07 |
| BrowserSkill publishes a stable library API or adds caching | ADR-005 |
