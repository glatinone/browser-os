# ADR-016: Language and Toolchain

Status: Accepted (2026-10-02)

## Context

The historical master spec proposed "TypeScript or Python", preferring TypeScript, and sketched a Python API (`from browser_ultra import Agent`). The implementation will be done largely by cheaper coding models, so the toolchain must be simple, conventional and fast to verify.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **TypeScript (Node)** | Playwright's primary language; CDP ecosystem; one language for daemon, CLI, SDK, (future) extension; strong typing for protocol | Native module (better-sqlite3) builds |
| Python | Browser Use ecosystem; ML-friendly | Playwright Python goes through a Node driver; two languages if extension added; weaker fit for SDK/extension |
| Rust (BrowserSkill, agent-browser) | Speed, single binary | Slow iteration; harder for cheap models; Playwright not native |
| Both TS + Python in MVP | Wider audience | Doubles surface |

| Tooling choice | Selected | Rejected alternatives |
|---|---|---|
| Runtime | Node ≥ 22 LTS | Bun/Deno (compat risk with Playwright/better-sqlite3) |
| Package manager | pnpm workspaces | npm/yarn workspaces, Nx/Turborepo (unneeded) |
| Build | `tsc` project references, no bundler | tsup/esbuild/webpack |
| Tests | Vitest (incl. `bench`) | Jest, Mocha |
| Lint/format | Biome (single dev dep) | ESLint + Prettier |
| Scripts | `tsx` | ts-node |
| CLI parsing | `node:util` `parseArgs` | commander, yargs, oclif |

## Decision

- **TypeScript only** for MVP: `strict: true`, ESM only (`"type": "module"`), `NodeNext` module resolution, named exports only.
- Node ≥ 22 (`.nvmrc`), pnpm workspaces, `tsc -b` project references, Vitest, Biome, tsx.
- **No Python in MVP.** A Python client could later be generated from the JSON-RPC protocol (it is language-neutral), not a second runtime.
- Boundary enforcement via `scripts/check-boundaries.mjs` (CODING_AGENT §7).

## Consequences

Positive: one language, few tools, fast verification commands (`pnpm -r typecheck`, `pnpm lint`, `pnpm test`).
Negative: Python-first agent developers must use the CLI or protocol until a Python client exists.

## Revisit when

- Demand for a Python SDK is demonstrated (→ thin JSON-RPC client, not a port).
- `node:sqlite` stabilizes (ADR-004) or Node LTS changes require version bumps.

## References

- `CODING_AGENT.md` §6–7, `docs/history/01-master-spec-browserskill-ultra.txt` §34, §37
