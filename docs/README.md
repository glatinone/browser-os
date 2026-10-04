# Browser-OS documentation

Browser-OS is a local-first TypeScript runtime between AI agents and a real Chrome/Edge browser. It compresses pages into semantic element lists, routes every action through the cheapest reliable mechanism (cache → deterministic → small LLM → human), and records task trajectories so repeated tasks run with zero LLM calls.

**Project status (2026-10-02):** planning complete, implementation not started. Next task: `P0-01`.

---

## Reading order

| # | Document | Read when | What it gives you |
|---|---|---|---|
| 1 | [CODING_AGENT.md](CODING_AGENT.md) | **always first** (coding agents) | rules, workflow, allowed dependencies, conflict protocol |
| 2 | [PRD.md](PRD.md) | always | what/why, MVP IN/OUT, vertical slice, success metrics |
| 3 | [ARCHITECTURE.md](ARCHITECTURE.md) | always | system map, packages, dependency graph, flows, lifecycles |
| 4 | [tasks/README.md](tasks/README.md) | before picking work | status table, order, milestone gates |
| 5 | `tasks/phase-XX-*.md` | for your task | exact requirements, files, tests, acceptance |
| 6 | `specs/*.md` | as your task card says | interfaces, algorithms, schemas |
| 7 | `adr/*.md` | when you wonder "why?" | decisions with options and trade-offs |

## Specs (authoritative interfaces and algorithms)

| Spec | Covers |
|---|---|
| [specs/integration.md](specs/integration.md) | **cross-task contracts; wins over all other specs on conflict** (masking, RouterDeps, driver semantics, budgets, challenges, tasks, fake model, launch details) |
| [specs/data-models.md](specs/data-models.md) | every shared TypeScript type (`packages/protocol`) |
| [specs/browser-runtime.md](specs/browser-runtime.md) | profiles, providers, sessions, CDP, PageDriver |
| [specs/dom-intelligence.md](specs/dom-intelligence.md) | capture → semantic observation, lexical resolver, locators, probe, challenge detection |
| [specs/action-router.md](specs/action-router.md) | tier ladder, drivers, effect semantics, healing, measurement |
| [specs/memory.md](specs/memory.md) | SQLite schema, cache, trajectories, record/replay |
| [specs/protocol.md](specs/protocol.md) | daemon JSON-RPC, CLI, SDK, config |

## Cross-cutting

| Document | Covers |
|---|---|
| [OSS_STRATEGY.md](OSS_STRATEGY.md) | OSS matrix, USE/DEPENDENCY/BUILD/… per subsystem, porting rules, licenses |
| [SECURITY.md](SECURITY.md) | threat model, IPC auth, risk rules R1–R12, human gate, secrets, injection, checklist S1–S20 |
| [PERFORMANCE.md](PERFORMANCE.md) | thesis, targets L1–L18 and E1–E8, hypotheses H1–H4 |
| [BENCHMARKS.md](BENCHMARKS.md) | methodology, suites, ablations, reports, CI guard |
| [TESTING.md](TESTING.md) | test layers, naming, fixtures, goldens, CI matrix |
| [COMPATIBILITY.md](COMPATIBILITY.md) | site-class matrix, manual real-site checklist |
| [ROADMAP.md](ROADMAP.md) | phases, milestones M0–M7, per-phase criteria and failure modes |
| [adr/README.md](adr/README.md) | ADR index (001–019) |
| [history/README.md](history/README.md) | original brainstorming (non-authoritative) |

## Authority order

`adr/` > `specs/integration.md` > other `specs/` + cross-cutting docs > `ARCHITECTURE.md` > `PRD.md` > `ROADMAP.md` / `tasks/` > code comments > `history/`.
Conflicts at the same level: stop and write to [tasks/CONFLICTS.md](tasks/CONFLICTS.md).
