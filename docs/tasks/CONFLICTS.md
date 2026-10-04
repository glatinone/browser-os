# Conflicts, blockers and open questions

Coding agents append entries here when a task conflicts with the architecture, needs an unapproved dependency, or has impossible or ambiguous acceptance criteria (CODING_AGENT.md §8). The human owner or an expert resolves them and records the decision (and an ADR if architecture changes).

Template:

```
## <YYYY-MM-DD> — <task id> — <one-line title>
- Conflict: <what contradicts what, with file paths>
- Options: <A / B / ...>
- Recommendation: <option + why>
- Status: OPEN | RESOLVED (<decision>, <who>, <date>)
```

---

## Open questions for the owner (from planning, 2026-10-02)

## 2026-10-02 — P12-02 — Project license
- Conflict: none yet. The license is not decided.
- Options: Apache-2.0 (patent grant; matches Playwright/Steel) / MIT (matches BrowserSkill/Stagehand/Browser Use).
- Recommendation: Apache-2.0.
- Status: RESOLVED (Apache-2.0, owner delegated to architect, 2026-10-02). See ADR-018. Owner action: confirm employer permission before the first public push.

## 2026-10-02 — P11-01 — Which real sites to test with
- Conflict: none. The compatibility matrix needs owner-chosen sites and owner-owned test accounts.
- Options: owner lists 5–8 sites (e.g. one enterprise SSO app, LinkedIn, Google Workspace, an internal dashboard).
- Recommendation: decide before Phase 11; prefer sites whose ToS permit automation of your own account.
- Status: RESOLVED (tiered targets, owner delegated to architect, 2026-10-02). See ADR-019.

## 2026-10-04 — P0-01 — Toolchain: corepack/pnpm pin and Node version do not match this machine
- Conflict: the `P0-01` card pins `"packageManager": "pnpm@9.15.0"` (exact version; **corepack**) and the repo says
  Node 22 (`.nvmrc`, `engines`). Node 25+ no longer bundles corepack, so the activation mechanism the card relies on
  does not exist on this machine; the installed toolchain is pnpm 12.8.1 on Node 26.7.0. `CODING_AGENT.md` §6 and
  ADR-016 were written before either. No behavioural contract is affected.
- Options: **A** keep the pin — install Node 22 and pnpm 9.15.0 for this repo only (local ≠ CI risk disappears, at the
  cost of maintaining a second toolchain); **B** use the installed pnpm 12.8.1 and Node 26 everywhere.
- Recommendation: **B**, and it was verified before any code existed — `better-sqlite3@13.0.3` installs and opens a
  `:memory:` database under Node 26 (ABI 147) with no MSVC present, and `playwright-core` launches the installed
  Chrome 154 through `launchPersistentContext({ pipe: true })` in ~3.1 s with working CDP sessions
  (`Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`). Downgrading buys nothing.
- Status: RESOLVED (owner, 2026-10-04 — option B). Applied in P0-01: `packageManager: pnpm@12.8.1`, `.nvmrc` = `26`,
  `engines.node` = `">=26"`. **Note the cost:** `engines.node >=26` deliberately excludes Node 22/24 users, so CI must run
  Node 26 (P0-03). Relax the floor only when the suite is proven on an older LTS.

## 2026-10-04 — P0-01 — pnpm 12 renamed the build-script allowlist
- Conflict: none with the docs, but with pnpm's own behaviour. pnpm ≥10 blocks dependency lifecycle scripts; the widely
  documented key is `onlyBuiltDependencies` (a list). pnpm 12 accepts only `allowBuilds` (a map) and ignores the old key
  silently — `pnpm install` then fails with `ERR_PNPM_IGNORED_BUILDS` because `esbuild` (via `tsx`) cannot run its postinstall.
- Options: **A** `pnpm approve-builds` interactively per machine (not reproducible, not in the repo); **B** declare it in
  `pnpm-workspace.yaml` as `allowBuilds: { esbuild: true }`.
- Recommendation: **B** — reproducible for every agent and CI runner, and it makes the allowlist auditable in the diff.
- Status: RESOLVED (implemented in P0-01). `pnpm-workspace.yaml` carries the key with a comment naming the pnpm 12
  rename, so the next agent does not repeat the `onlyBuiltDependencies` dead end. Future native deps
  (`playwright-core` in P2-04, `better-sqlite3` in P6-01) must be added there deliberately, not by approving broadly.
