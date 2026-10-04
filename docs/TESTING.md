# TESTING.md: Testing Strategy

**Status:** Authoritative for MVP · **Related:** CODING_AGENT.md rules 7–9, SECURITY.md §15, BENCHMARKS.md, every `specs/*.md` "Test requirements" section

Principles:
- **Deterministic.** No real websites and no real LLM APIs in CI. Everything browser-facing runs against the local fixture server; everything model-facing uses `FakeModelProvider` or a local fake HTTP server.
- **Pure where possible.** Most DOM, memory and router logic is pure and tested without a browser (recorded CDP fixtures, in-memory SQLite, fakes).
- **Behaviour over implementation.** Tests assert outputs, events, persisted rows and call counts, not private internals.
- **Every invariant has a test.** "No LLM call on replay", "no secret in storage" and "no retry on unknown effect" are tests, not comments.

---

## 1. Test pyramid

```
                 ┌───────────────┐
                 │ e2e (few)     │  vertical slice in-process; CLI e2e        *.e2e.test.ts
               ┌─┴───────────────┴─┐
               │ browser integration│ real Chromium + fixture server           *.browser.test.ts
             ┌─┴────────────────────┴─┐
             │ component (fakes)       │ router, replayer, daemon handlers,      *.test.ts
           ┌─┴─────────────────────────┴─┐
           │ unit (pure)                  │ dom (goldens), keys, lexical, match,   *.test.ts
           └──────────────────────────────┘ masks, schemas, risk rules, stores
```

Rough proportions: ~70% unit/component, ~25% browser integration, ~5% e2e.

---

## 2. Test layers

| Layer | What | How | Packages |
|---|---|---|---|
| **Unit** | pure functions and classes | Vitest, no I/O; table-driven where natural | all |
| **Integration (browser)** | anything that talks to Chrome | real Chromium (Playwright-managed in CI), `startFixtureServer()`, temp `BOS_HOME` | browser, dom (capture/probe), runtime |
| **Adapter** | model providers, browser providers | providers hit a **local fake HTTP server** (`node:http`) that returns recorded responses; no network. Browser providers tested against fixture Chromium | ai, browser |
| **Router** | tier ladder, budgets, healing, effect semantics | component tests with fake `Observer`, fake `PageDriver`, `FakeModelProvider`, in-memory stores; plus browser integration on fixtures | runtime |
| **DOM** | capture → observation pipeline | **golden tests** from recorded raw captures (§5); rule-level unit tests with hand-built NodeTables; oracle test vs Playwright `ariaSnapshot` (P4-10) | dom |
| **Memory** | stores, migrations, keys, lifecycle | `better-sqlite3` with `:memory:` (or a temp file for WAL behaviour) | memory |
| **Security** | SECURITY.md §15 checklist S1–S20 | unit + browser + e2e; canary scan | all |
| **Performance** | micro benches in CI, others nightly | BENCHMARKS.md | benchmarks |
| **E2E** | (a) vertical slice in-process (M3, P7-08); (b) CLI e2e: real daemon process + `bos` commands against fixtures (P8-08) | spawn processes, temp `BOS_HOME`, fixture server | tests/e2e |

---

## 3. File naming and location

| Pattern | Meaning | Runs in |
|---|---|---|
| `packages/<pkg>/test/*.test.ts` | unit/component, no browser, no network | `pnpm test` |
| `packages/<pkg>/test/*.browser.test.ts` | needs Chromium + fixture server | `pnpm test:browser` |
| `tests/e2e/*.e2e.test.ts` | multi-package / multi-process end-to-end | `pnpm test:e2e` |
| `benchmarks/**/*.bench.ts` | benchmarks | `pnpm bench:*` |
| `packages/<pkg>/test/fixtures/` | recorded data (raw captures, HTTP recordings, goldens) | — |
| `fixtures/sites/<name>/index.html` + `truth.json` | shared fixture website | all browser tests and benches |

Test helpers shared across packages live in `tests/helpers/` (not published): `withFixtureServer()`, `withTempBosHome()`, `launchTestBrowser()`, `CountingCdpTransport` re-export, `fakeClock()`.

---

## 4. Vitest configuration

Root `vitest.workspace.ts` (or `projects` in `vitest.config.ts`) defines three projects:

| Project | include | Settings |
|---|---|---|
| `unit` | `packages/*/test/**/*.test.ts` excluding `*.browser.test.ts` | `pool: 'threads'`, default timeout 5 s |
| `browser` | `packages/*/test/**/*.browser.test.ts` | `pool: 'forks'`, `fileParallelism` limited to 2, timeout 30 s, `retry: 1` |
| `e2e` | `tests/e2e/**/*.e2e.test.ts` | `pool: 'forks'`, sequential, timeout 120 s, `retry: 1` |

Root scripts: `test` (unit), `test:browser`, `test:e2e`, `test:all`, `test:coverage`.

---

## 5. Fixtures

### 5.1 Fixture site server

`fixtures/server.ts` exports `startFixtureServer(opts?: { port?: number }): Promise<{ baseUrl: string; close(): Promise<void> }>`. It is a static `node:http` server on `127.0.0.1` (random port), serving `fixtures/sites/` with correct MIME types, no caching headers, and optional route handlers for SPA fallback (`/spa/*` → `spa/index.html`) and fake form POSTs.

Fixture pages (P0-04, extended in P4/P9/P10): `basic`, `spa`, `iframe`, `shadow`, `dynamic`, `modal`, `overlay`, `login` (password + OTP step), `risk` (delete account, pay now), `mutations/` (variants), `injection` (prompt-injection text), `heavy` (benchmarks).

`truth.json` per fixture:

```json
{
  "intents": [
    { "action": "fill", "intent": "the search box", "expect": { "css": "#q", "role": "searchbox", "name": "Search" } },
    { "action": "click", "intent": "Sign in button", "expect": { "css": "button[type=submit]", "role": "button", "name": "Sign in" } },
    { "action": "click", "intent": "the blue thing", "expect": null }
  ]
}
```

`expect: null` means "must NOT be resolved deterministically" (an ambiguity test). Truth files feed lexical precision tests (E6), FakeModel answers and benchmarks.

### 5.2 Recorded CDP fixtures (DOM goldens)

Workflow:
1. `pnpm tsx scripts/record-capture.ts <fixture-name>` (P4-02) launches Chromium, opens the fixture, runs `captureRaw(cdp)` and writes `packages/dom/test/fixtures/<name>.raw.json` (with stable viewport 1280×800, device scale 1).
2. Unit tests load the raw JSON, run join → semantic → serialize, and compare with `<name>.observation.txt`.
3. **Golden update policy:** goldens change only intentionally. Run `pnpm test -u` (or `--update`) for the dom project, then review the diff line by line in the PR. A PR that updates goldens must say why in its report. Re-record raw captures only when the fixture HTML changes or Chrome changes capture output. Note the Chrome version in the JSON header field `_chromeVersion`.
4. A browser test (`capture.browser.test.ts`) re-captures live and asserts the **serialized observation** equals the golden. It does not compare raw JSON, which is too volatile across Chrome versions. This catches drift between recordings and live Chrome.

### 5.3 Recorded HTTP for model providers

`packages/ai/test/fixtures/*.http.json` holds request/response pairs (with API keys removed). The fake server asserts the request shape (path, headers present, JSON body structure) and returns the recorded response. Error cases (429, 500, timeout, malformed JSON) are hand-written.

---

## 6. FakeModelProvider

`packages/ai/src/fake.ts` (P5-01):

```ts
const model = new FakeModelProvider({
  respond: (req) => ({ ref: 'e3', confidence: 0.9 }),   // or a queue of scripted responses, or truth-based answering
  latencyMs: 0,                                         // benches set e.g. 800
});
// ... run code under test ...
expect(model.calls).toBe(0);                            // invariant: no LLM on deterministic/cache paths
expect(model.requests[0].messages[0].content).not.toContain(canarySecret);
```

Capabilities: call counter, recorded requests (for prompt assertions), scripted responses, truth-based answers (`FakeModelProvider.fromTruth(truthJson, observation)`), failure injection (`throwOnCall: 'LLM_UNAVAILABLE'`, invalid JSON, out-of-list refs).

**Mandatory zero-call assertions:**
- replay of an unchanged fixture task (P7-06, P7-08)
- cache-tier and deterministic-tier router tests (P7-03)
- `ref` and `query` targets (P7-02)

---

## 7. What runs where

| Job | Trigger | Steps |
|---|---|---|
| **CI: ubuntu-latest** (required) | every push/PR | `pnpm install --frozen-lockfile` → `pnpm -r typecheck` → `pnpm lint` (Biome + `scripts/check-boundaries.mjs`) → `pnpm test` (unit) → `npx playwright-core install chromium` → `pnpm test:browser` → `pnpm test:e2e` → `pnpm bench:micro` (regression guard, BENCHMARKS.md §7) |
| **CI: windows-latest** (required) | every push/PR | typecheck → unit → selected browser tests tagged `@windows` (profile paths, executable discovery, token ACL, launch/close) |
| **Nightly** | schedule | full `test:all` on both OSes + `bench:browser`, `bench:tasks --mode all`, `bench:startup`; artifacts uploaded |
| **Manual only** | developer | real-site runner (P11-01), real-model task benches, external comparisons |

**Never in CI:** real websites (including "harmless" ones like example.com), real LLM APIs, anything needing credentials, headful-only tests. Network access in tests is blocked by convention. The fixture server binds to loopback, and providers in tests point at local fakes. A test that needs the internet is a bug.

Chromium in CI is Playwright-managed `chromium` channel, headless. Headful-dependent behaviour (manual mode, human resume) is tested through test hooks, not real humans.

---

## 8. Flakiness policy

- **No fixed sleeps** in tests. Wait on conditions: events, `settle()`, probe polling, or `vi.waitFor` with a timeout.
- Browser and e2e projects allow **`retry: 1`**. Unit tests: **no retries**.
- A test that fails intermittently twice in a week gets the `quarantine` label: moved to `*.quarantine.test.ts` (excluded from required jobs), plus an issue with a fix owner. Quarantined tests must be fixed or deleted within 2 weeks.
- Use fake clocks (`Clock` injection, `vi.useFakeTimers`) for timeouts and retention logic.
- Random data in tests uses a seeded PRNG.
- Each browser test uses its own temp `BOS_HOME` and profile; never share profiles between tests.

---

## 9. Coverage expectations

Measured with `vitest --coverage` (v8), lines:

| Package | Minimum |
|---|---|
| `protocol`, `dom`, `memory` | ≥ 85% |
| `runtime/src/router`, `runtime/src/tasks`, `runtime/src/security` | ≥ 85% |
| everything else (`browser`, `ai`, `daemon`, `sdk`, `cli`, rest of `runtime`) | ≥ 70% |

Coverage is reported in CI. Falling below the minimum fails the job from P10 onwards. Before P10 it only warns, so the scaffold phases are not blocked. Coverage numbers never justify skipping a behaviour test listed in a spec.

---

## 10. Per-milestone acceptance tests

| Milestone | Acceptance test |
|---|---|
| M0 | CI green on empty packages; boundary checker rejects a planted violation |
| M1 | `tests/e2e/hands.e2e.test.ts`: launch profile → navigate `basic` → fill/click via css-resolved backendNodeId → cookie persists across relaunch (P3-07) |
| M2 | goldens for all fixtures; lexical precision ≥ 99% on `truth.json`; oracle agreement ≥ 95% |
| M3 | `tests/e2e/vertical-slice.e2e.test.ts` (P7-08): record task with FakeModel → replay → 0 LLM calls, all cache tier, faster than run 1 |
| M4 | `tests/e2e/cli.e2e.test.ts` (P8-08): the same scenario through the `bos` CLI and a real daemon process |
| M5 | SECURITY.md §15 S1–S20 all green |
| M6 | benchmark report generated; H1–H4 evaluated |
| M7 | compatibility results table filled (COMPATIBILITY.md §4) |
