# Architecture Decision Records

ADRs are the **highest-authority** documents in this repository (see `docs/CODING_AGENT.md` §3). Each records one meaningful decision, the options considered, and when to revisit it.

**Rule: decisions are never edited in place to change their outcome.** Changing a decision = write a new ADR that supersedes the old one, and set the old one's status to `Superseded by ADR-0NN`. Typos and clarifications that do not change the decision may be edited directly.

Coding agents must not write or supersede ADRs on their own. Propose one through `docs/tasks/CONFLICTS.md`; the human owner approves.

## Index

| # | Title | Status | Decision (one line) |
|---|---|---|---|
| [001](001-browser-engine.md) | Browser engine | Accepted | Real Chrome/Edge/Chromium via CDP only; Lightpanda = future out-of-process provider |
| [002](002-playwright-vs-cdp.md) | Playwright vs direct CDP | Accepted | Hybrid: playwright-core for lifecycle + fallback (only in `packages/browser`), raw CDP for capture/probe/input |
| [003](003-local-first-and-profiles.md) | Local-first & profiles | Accepted | Local daemon; Browser-OS-owned profiles launched over pipe; manual setup mode for logins; never the default profile |
| [004](004-sqlite.md) | SQLite | Accepted | better-sqlite3, WAL, SQL migrations, no ORM; `node:sqlite` replace-later candidate |
| [005](005-browserskill-strategy.md) | BrowserSkill strategy | Accepted | Reference + selective port (MIT, commit 3f10983); no dependency, no fork |
| [006](006-stagehand-strategy.md) | Stagehand strategy | Accepted | Reference only; adopt cache/self-heal concepts, improve keys + validation |
| [007](007-steel-strategy.md) | Steel strategy | Accepted | Reference only; revisit for remote mode |
| [008](008-browser-use-strategy.md) | Browser Use strategy | Accepted | Reference only; never copy workflow-use (AGPL) |
| [009](009-dom-representation.md) | DOM representation | Accepted | Own CDP pipeline (DOMSnapshot + AX), per-observation refs, durable ElementLocator; ariaSnapshot as test oracle |
| [010](010-action-router.md) | Action router | Accepted | Fixed tiers ref→cache→deterministic→llm→vision→human; caller names action type; calling agent plans |
| [011](011-trajectory-memory.md) | Trajectory memory | Accepted | Exact task keys, parameterized locator steps, validation-based invalidation, no vector DB, no stored secrets |
| [012](012-model-provider-abstraction.md) | Model provider abstraction | Accepted | Own interface + fetch-based OpenAI-compatible/Anthropic/Fake providers; no LLM SDKs |
| [013](013-extension-architecture.md) | Extension architecture | Accepted — deferred implementation | No extension in MVP; consent attach first, then small token-paired MV3 relay |
| [014](014-security-model.md) | Security model | Accepted | Loopback + token, owned profiles, secret refs, untrusted page content, risk confirm, human for challenges, no stealth |
| [015](015-observability.md) | Observability | Accepted | Typed event bus + SQLite metrics + JSONL traces; OTel exporter post-MVP |
| [016](016-language-toolchain.md) | Language & toolchain | Accepted | TypeScript strict ESM, Node ≥22, pnpm, tsc, Vitest, Biome; no Python in MVP |
| [017](017-daemon-and-protocol.md) | Daemon & protocol | Accepted | Long-lived daemon, JSON-RPC 2.0 over loopback WebSocket with bearer token; MCP as post-MVP adapter |
| [018](018-license.md) | License | Accepted | Apache-2.0 + NOTICE; DCO sign-off, no CLA |
| [019](019-real-site-test-targets.md) | Real-site test targets | Accepted | Tiered: automation-friendly practice sites → self-hosted Keycloak stack → own low-risk accounts; LinkedIn/Instagram out of matrix |

## Template

```markdown
# ADR-0NN: <Title>

Status: Proposed | Accepted (YYYY-MM-DD) | Superseded by ADR-0MM

## Context
<Problem, constraints, facts (with sources). Mark vendor claims as vendor claims.>

## Options considered
| Option | Pros | Cons |
|---|---|---|

## Decision
<What we do. Concrete: packages, interfaces, numbers.>

## Consequences
Positive: ...
Negative: ...
Follow-ups: <task ids P<phase>-<nn>>

## Revisit when
<Measurable triggers.>

## References
<Specs, URLs, ADRs.>
```
