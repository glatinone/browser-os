# Browser-OS

A local-first TypeScript runtime that sits between AI agents and a real, logged-in Chrome or Edge browser, and makes repeated browser tasks run with as few LLM calls as possible.

> **Status: implementation in progress.** Phases P0 to P6 (scaffold, protocol, browser runtime, action execution, DOM intelligence, AI providers, memory) are merged into `main`. Phase 7 (the action router and the record/replay vertical slice) is under way. The daemon, SDK and `bos` CLI are still scaffolds, so there is no end-user workflow yet. Live task status: [`docs/tasks/README.md`](docs/tasks/README.md).

## Why

Browser agents spend most of their time and money on work that does not need a model:

- one LLM call per click, even for an action that was done identically yesterday;
- raw HTML or screenshots sent where a few hundred tokens of structure would do;
- no memory, so the tenth run of a workflow costs the same as the first;
- fresh, logged-out browsers that break SSO and MFA;
- unsafe defaults, where page text can steer the model and nothing stops a "delete account" click.

Browser-OS treats the LLM as a fallback, not the loop. The goal ([`docs/PRD.md`](docs/PRD.md)) is that a repeated task replays from memory with zero LLM calls when the site has not changed, and heals only the steps that did.

## What it does

Designed as a local daemon plus a TypeScript SDK and a `bos` CLI. For every action (`observe`, `click`, `fill`, `press`, `select`, ...):

1. **Compact observation.** The page is turned into a short list of interactive elements built from Chrome's accessibility tree and layout over CDP, typically 20 to 200 lines instead of megabytes of HTML.
2. **Cheapest mechanism first.** The target is resolved through a fixed ladder: learned locator (cache), then deterministic lexical matching, then a small LLM, then a human. Actions are dispatched as raw CDP input, with Playwright as a fallback.
3. **Learning.** Successful resolutions are cached per site. Successful tasks are stored as parameterized trajectories, validated step by step on replay and repaired when a page changes.
4. **Safety.** Persistent Browser-OS profiles (never the user's default profile), secrets never stored or sent to models, confirmation for risky actions, CAPTCHA and MFA always handed to a human. See [`docs/SECURITY.md`](docs/SECURITY.md).

## What exists today

| Package | Contents | State |
|---|---|---|
| `@browser-os/protocol` | shared types, zod schemas, errors, ids, masking, EventBus, RPC table | done |
| `@browser-os/browser` | executable discovery, persistent profiles, launch and CDP-endpoint providers, CDP transport, `PageDriver` (click, fill, press, select, scroll, uploads, downloads, settle) with Playwright fallback | done |
| `@browser-os/dom` | capture, join, interactivity/visibility rules, semantic serialization, lexical ranking, locators, probe, challenge detection | done; some tasks awaiting expert review |
| `@browser-os/ai` | fake, OpenAI-compatible and Anthropic providers (plain HTTP, no vendor SDKs), model registry, resolve-target prompt | done; some tasks awaiting review |
| `@browser-os/memory` | SQLite store (`better-sqlite3`), migrations, action cache, trajectory, run and audit stores | done |
| `@browser-os/runtime` | session manager, observer, action router with cache, deterministic and LLM tiers | in progress (Phase 7) |
| `@browser-os/daemon`, `sdk`, `cli` | WebSocket JSON-RPC daemon, typed client, `bos` binary | scaffold only (Phase 8) |

Every phase has acceptance criteria written as tests; a task is marked `done` only when its criterion is a passing assertion.

## Quick start (development)

Requirements: Node.js 26 (see `.nvmrc`), pnpm 12.8.1 (pinned in `packageManager`), and Chrome, Edge or Playwright's Chromium for browser tests.

```bash
git clone https://github.com/glatinone/browser-os.git
cd browser-os
pnpm install

pnpm build          # tsc -b across all packages
pnpm lint           # biome + package boundary checker
pnpm test           # unit tests (vitest)
pnpm test:browser   # browser tests against local fixture sites
pnpm test:e2e       # end-to-end tests
```

For browser tests, install Chromium once with `pnpm --filter @browser-os/browser exec playwright-core install chromium`.

## How it works

```
agent ──▶ bos CLI / SDK ──▶ daemon (JSON-RPC over WebSocket, token auth)
                               │
                               ▼
                            runtime: sessions · observer · router · tasks · security
                               │            │             │
                               ▼            ▼             ▼
                            browser       dom           memory (SQLite)      ai (LLM fallback)
                            (CDP + Playwright fallback)
                               │
                               ▼
                         real Chrome / Edge with a persistent Browser-OS profile
```

Package boundaries are enforced by `scripts/check-boundaries.mjs` in CI. The full design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), with interfaces and algorithms in [`docs/specs/`](docs/specs/) and the reasoning behind each decision in [`docs/adr/`](docs/adr/).

## Roadmap

```
M0 Scaffold ─▶ M1 Hands ─▶ M2 Eyes ─▶ M3 Thesis ─▶ M4 Usable ─▶ M5 Safe ─▶ M6 Measured ─▶ M7 Real-world (v0.1.0)
```

M3 is the thesis test: record a task, replay it with zero LLM calls, and heal it after the page is mutated. Performance targets and the benchmark method are defined in [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) and [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md); no benchmark results have been published yet. Details: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Documentation

Start at [`docs/README.md`](docs/README.md) for the reading order.

| | |
|---|---|
| Product | [`docs/PRD.md`](docs/PRD.md) |
| Architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/specs/`](docs/specs/) |
| Decisions | [`docs/adr/`](docs/adr/) |
| OSS strategy | [`docs/OSS_STRATEGY.md`](docs/OSS_STRATEGY.md) |
| Plan | [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/tasks/`](docs/tasks/) |
| Quality | [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md), [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md), [`docs/TESTING.md`](docs/TESTING.md), [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) |

Coding agents: read [`AGENTS.md`](AGENTS.md), then [`docs/CODING_AGENT.md`](docs/CODING_AGENT.md), then pick a task from [`docs/tasks/README.md`](docs/tasks/README.md). Contributors: see [`CONTRIBUTING.md`](CONTRIBUTING.md) (DCO sign-off required).

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
