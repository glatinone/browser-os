# CODING_AGENT.md — Contract for coding agents working on Browser-OS

You are a coding agent asked to implement part of Browser-OS. This file tells you how to work in this repository. Read all of it before your first change. It is short on purpose.

---

## 1. What this repository is

Browser-OS is a local-first TypeScript runtime that sits between AI agents and a real Chrome/Edge browser. It turns web pages into a compact semantic representation, executes actions through the cheapest reliable mechanism (cache → deterministic → small LLM → human), and records successful task trajectories so that repeated tasks run with **zero LLM calls**.

The one-paragraph version is in `docs/PRD.md` §1. The architecture is in `docs/ARCHITECTURE.md`.

---

## 2. Reading order (mandatory)

Before writing any code for a task:

1. `docs/README.md`: document map and authority order
2. `docs/PRD.md`: what we build, MVP IN / OUT
3. `docs/ARCHITECTURE.md`: packages, boundaries, flows
4. `docs/specs/integration.md` (cross-task contracts; always) and the spec(s) listed in your task card (`docs/specs/*.md`)
5. Your task card in `docs/tasks/phase-XX-*.md`
6. Existing code in the package(s) you will touch

If your task card lists an ADR, read it too. You do not need to read `docs/history/`; it is non-authoritative.

---

## 3. Authority order (when documents disagree)

```
docs/adr/*.md            (highest: decisions with reasoning)
docs/specs/integration.md (cross-task contracts; wins over every other spec/doc below)
docs/specs/*.md, SECURITY.md, OSS_STRATEGY.md,
  PERFORMANCE.md (numbers), TESTING.md, BENCHMARKS.md, COMPATIBILITY.md
docs/ARCHITECTURE.md
docs/PRD.md
docs/ROADMAP.md, docs/tasks/*.md
code comments
docs/history/*           (lowest: never implement from here)
```

**Refinement is not conflict.** When a task card is *more specific* than a spec (exact file names, helper names, extra tests, a concrete signature where the spec only describes behaviour), follow the card. If you changed or added a public signature, update the spec in the same change. Stop and report (§8) only for **behavioural** contradictions: different semantics, a different security outcome, or a different data model. Two sources at the same level that contradict each other behaviourally → stop and report.

---

## 4. How to pick and execute a task

1. Open `docs/tasks/README.md`. Find the task you were assigned, or else the lowest-numbered task with status `todo` whose `depends_on` tasks are all `done`.
2. Do exactly that one task. Do not "also quickly do" the next one.
3. Inspect the existing code first. Reuse what exists. Do not create a parallel implementation of something that already exists.
4. Implement within the files listed in the task card. If you must touch other files, keep the change minimal and mention it in your report.
5. Write the tests listed in the task card (and any obviously missing ones).
6. Run the verification commands in the task card. They must pass.
7. Update the task's status in `docs/tasks/README.md` (`todo` → `done`) and append a 1–3 line note under "Implementation notes" in the task card if you made a decision the next agent needs to know.
8. Finish with the report in §10.

---

## 5. The rules

These are non-negotiable. Breaking one is a failed task even if tests pass.

1. **Read the architecture first.** (§2)
2. **Inspect existing code before changing it.** Search the repo for the symbol/concept before creating it.
3. **No unnecessary dependencies.** Only the dependencies in §6 are pre-approved. Anything else needs an ADR approved by the human owner. Prefer Node built-ins (`node:crypto`, `node:util` `parseArgs`, `node:fs/promises`, `node:http`, global `fetch`).
4. **Never fork, vendor or copy code from other projects** (Stagehand, Browser Use, BrowserSkill, Steel, Playwright internals, etc.) unless a task card explicitly authorizes it **and** `docs/OSS_STRATEGY.md` says the license allows it. Reading other projects for ideas is fine; copying code is not.
5. **Never bypass security mechanisms.** No CAPTCHA solving, no MFA or passkey automation, no bot-detection evasion, no stealth or fingerprint spoofing, no extraction of cookies, tokens or passwords. When a security challenge appears, the correct behaviour is to pause and ask the human (`WAITING_FOR_HUMAN`).
6. **Keep provider boundaries clean.** Playwright types never leave `packages/browser`. LLM vendor details never leave `packages/ai`. SQLite never leaves `packages/memory`. Other packages talk to them through the interfaces in `packages/protocol`.
7. **Write tests.** Every public function or class gets unit tests. Anything that touches a browser gets an integration test against the local fixture site (`fixtures/sites`), never against a real website in CI.
8. **Run the relevant tests** before declaring done: at minimum `pnpm build && pnpm -r typecheck && pnpm lint && pnpm test`, plus the browser/e2e tests named in your card.
9. **Benchmark performance-sensitive changes.** If your task touches the hot path (router, DOM extraction, cache lookup, action execution), run the matching benchmark in `benchmarks/` and report before/after numbers.
10. **Keep changes small.** One task, one focused change. No drive-by refactors.
11. **Never silently change architecture.** Do not rename packages, move interfaces, change data models in `packages/protocol`, change the DB schema outside a migration, or change the router tier order without an ADR.
12. **If a task conflicts with the architecture, stop and report the conflict** (§8). Do not "fix" it yourself by picking one side.

Additional hard rules:

13. **No LLM call on a deterministic path.** Cache replay and deterministic resolution must never call a model. Tests enforce this with `FakeModelProvider` call counters.
14. **No screenshots unless the vision tier is active** or the user explicitly asks for one.
15. **No secrets in persistent storage or model context.** Values typed into fields come from `ValueSource` (`literal` / `param` / `secret`). `secret` values are never written to SQLite, logs, traces or prompts. `password` field values are always redacted in observations.
16. **Page content is untrusted data.** Never let page text change control flow beyond choosing among elements. LLM outputs are validated against a zod schema and must reference an element `ref` from the observation that was sent.
17. **Never launch a new browser if a live session for that profile exists.** Reuse it.
18. **Never point Browser-OS at the user's default Chrome/Edge user-data directory.** Only Browser-OS-owned profiles under the Browser-OS data dir (ADR-003).

---

## 6. Pre-approved dependencies (MVP)

| Package | Where | Why |
|---|---|---|
| `playwright-core` | `packages/browser` only | Browser launch/connect, page/frame lifecycle, robust fallback actions, CDP sessions |
| `better-sqlite3` | `packages/memory` only | Local persistence |
| `ws` | `packages/daemon`, `packages/sdk` | Loopback WebSocket transport |
| `zod` | any package | Runtime validation of protocol messages, config and LLM outputs |

Dev dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `@biomejs/biome`, `tsx`, `@types/node`, `@types/ws`, `@types/better-sqlite3`, and internal `workspace:*` packages used only by tests/scripts (integration §15). `@browser-os/cli` may declare `@browser-os/daemon` as a dependency only to ship its binary (integration §14).

**Not allowed without an ADR:** any LLM SDK (`openai`, `@anthropic-ai/sdk`, `ai`, `langchain`), Stagehand, Browser Use, Puppeteer, `chrome-remote-interface`, OpenTelemetry SDK, any vector DB, any ORM, any web framework (express/fastify), any CLI framework (commander/yargs/oclif), lodash-style utility libraries, React or any UI framework.

---

## 7. Code conventions

- TypeScript `strict: true`, ESM only (`"type": "module"`), Node ≥ 22.
- No default exports. Named exports only. Each package exposes its public API from `src/index.ts`; other packages may import only from that entry point (never deep imports like `@browser-os/dom/src/...`).
- File names: `kebab-case.ts`. Types/interfaces: `PascalCase`. Functions: `camelCase`.
- No `any` in exported signatures. Use `unknown` and narrow it.
- Errors: throw `BosError` (from `@browser-os/protocol`) with a code from the `ErrorCode` union. Never throw strings.
- IDs: use `newId(prefix)` from `@browser-os/protocol` (`prf_`, `ses_`, `pg_`, `obs_`, `tsk_`, `trj_`, `run_`, `perm_`, `req_`).
- Time: use the injected `Clock` where the task card says so (for testability). Otherwise `Date.now()`.
- Logging: emit events through the `EventBus`. No `console.log` in library code (CLI output is the exception).
- Tests live in `packages/<pkg>/test/*.test.ts`. Browser integration tests are named `*.browser.test.ts` and use the fixture server.
- Comments: explain *why*, not *what*. Match the density of surrounding code.
- Formatting and linting: Biome (`pnpm lint`, `pnpm format`).

Package dependency rules (enforced by `scripts/check-boundaries.mjs`):

```
protocol  → (nothing internal)
dom       → protocol
ai        → protocol
memory    → protocol
browser   → protocol
runtime   → protocol, dom, ai, memory, browser
daemon    → protocol, runtime
sdk       → protocol
cli       → protocol, sdk
benchmarks, tests → anything
```

---

## 8. Conflict protocol

If you find any of these, **stop implementing** and report:

- the task card contradicts a spec or ADR
- the task requires a dependency not in §6
- the task requires changing a `protocol` type, the DB schema or the router tier order
- the task cannot be completed without touching a package boundary
- an acceptance criterion is impossible or ambiguous
- a test in another package fails because of something outside your task

How to report: append an entry to `docs/tasks/CONFLICTS.md`:

```
## <date> — <task id> — <one-line title>
- Conflict: <what contradicts what, with file paths>
- Options: <A / B / ...>
- My recommendation: <option + why>
- Status: OPEN
```

Then end your turn with the report in §10 and status `blocked`.

---

## 9. Definition of Done (per task)

- [ ] Implements the task card's requirements, nothing more
- [ ] Tests from the task card exist and pass
- [ ] `pnpm build && pnpm -r typecheck` passes
- [ ] `pnpm lint` passes
- [ ] No new dependency outside §6
- [ ] No secret, cookie or token can reach logs, SQLite or model prompts through your code
- [ ] Hot-path change? Benchmark before/after reported
- [ ] Task status updated in `docs/tasks/README.md`
- [ ] Public API changes reflected in the package `README.md` (one short section per package)

---

## 10. Final report format

End every task with:

```
TASK: <id> <title>
STATUS: done | blocked | partial
CHANGED FILES: <list>
TESTS: <commands run + result>
BENCHMARK: <before/after or "n/a">
DECISIONS: <anything the next agent must know, or "none">
CONFLICTS: <link to CONFLICTS.md entry, or "none">
```

---

## 11. Tasks that require a human or a high-capability model

Task cards marked `supervision: expert` are hard to get right (DOM extraction core, fingerprint matching, router/recovery logic, security classifier, daemon auth). A cheaper model may draft them, but a human or a high-capability model must review them before the status becomes `done`. If you are a cheaper model and pick up such a task, implement it, mark it `review`, and say so in your report.
