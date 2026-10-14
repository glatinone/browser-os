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
## 2026-10-12 — P7-04 — LLM/human tiers exist but the intent ladder they extend is un-wired (P7-03 still `todo`)
- Conflict: P7-04's card lists `depends_on: P7-03, P5-05` and its requirements are the LLM and human
  tiers of the *intent* resolution ladder (action-router §5, tiers 3–5). P5-05 is done. P7-03 is
  still `todo`, yet `packages/runtime/src/router/resolve-locator.ts` (committed as
  `39128d9 feat(P7-03): tier 1 cache locator resolution`) already sits on this branch **un-wired**:
  nothing in `packages/runtime/src/` imports it, and `ActionRouter.resolveIntentTarget`
  (`packages/runtime/src/router/router.ts:367-374`) still throws
  `BosError('TARGET_NOT_FOUND', 'Intent resolution not implemented')`. So the deterministic tier
  (tier 2) does not run either, and no end-to-end test can exercise tier 3.
  Meanwhile `docs/CODING_AGENT.md` §5.11 forbids changing the router tier order without an ADR,
  and §4.2 forbids doing the next task ("Do not 'also quickly do' the next one"), so P7-04 may not
  silently finish P7-03.
- Options: **A** ship tiers 3–5 as self-contained modules with their own tests, leaving the router
  un-wired (tests call the tier functions directly); **B** also wire the intent ladder in
  `router.ts`, which means doing P7-03's work inside P7-04 (violates §4.2 and blurs review
  ownership); **C** block P7-04 until P7-03 is done.
- Recommendation: **A**. It keeps lane ownership clean, it is the only option that produces
  verifiable output this run, and the wiring is a small, reviewable diff once P7-03 lands —
  `resolveLlmTier` / `resolveHumanTier` are already shaped to drop into the tier-3 / tier-5
  positions of `resolveIntentTarget`. Requirement 5's `SECURITY_CHALLENGE` path is implemented in
  the new module and tested there, and will be picked up verbatim when the ladder is wired.
- Status: OPEN (recommendation A taken this run; awaiting expert review of P7-04, and P7-03 landing).
