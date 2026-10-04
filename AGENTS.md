# AGENTS.md

You are working on **Browser-OS**, a local-first TypeScript runtime between AI agents and a real Chrome/Edge browser. It turns pages into compact semantic element lists, executes actions through the cheapest reliable mechanism (cache → deterministic → small LLM → human), and records task trajectories so repeated tasks run with **zero LLM calls**.

## Before you do anything

1. Read `docs/CODING_AGENT.md` completely. It is the contract you work under.
2. Then `docs/PRD.md` and `docs/ARCHITECTURE.md`.
3. Then `docs/specs/integration.md` (cross-task contracts that override everything else).
4. Then open `docs/tasks/README.md`, take **one** task (the one you were assigned, or the lowest-numbered `todo` task whose dependencies are `done`), and read its card in `docs/tasks/phase-XX-*.md` plus the specs it lists.

## Non-negotiables (summary; details in docs/CODING_AGENT.md §5)

- One task at a time, small changes, tests included, `pnpm build && pnpm -r typecheck && pnpm lint && pnpm test` green.
- No dependencies beyond the pre-approved list. No forking or copying other projects' code without explicit authorization.
- Never bypass CAPTCHA, MFA, passkeys or bot detection. Never hide automation. Pause for a human instead.
- Secrets never reach SQLite, logs, events or model prompts.
- No LLM call on a deterministic path. No screenshots outside the vision tier.
- Playwright stays in `packages/browser`, SQLite in `packages/memory`, vendor LLM details in `packages/ai`.
- If the task conflicts with the architecture: **stop** and write to `docs/tasks/CONFLICTS.md`.

## Commands (after P0-01 exists)

```bash
pnpm install
pnpm -r typecheck
pnpm lint            # biome + package boundary checker
pnpm test            # unit
pnpm test:browser    # needs Chromium: pnpm exec playwright-core install chromium
pnpm test:e2e
```
