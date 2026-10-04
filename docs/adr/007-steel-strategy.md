# ADR-007: Steel Strategy

Status: Accepted (2026-10-02)

## Context

Steel Browser (`steel-dev/steel-browser`, **Apache-2.0**, TypeScript, ~7.7k stars) is browser infrastructure for AI agents: a Fastify API (`/sessions`) around Chrome with a CDP WebSocket proxy, cookie/localStorage persistence, extension loading, proxy chains, Selenium compatibility, a session viewer and Docker images. The historical docs proposed adapting its session/lifecycle concepts.

Facts (2026):
- Built on **puppeteer-core 23.6.0** (pinned, fairly old), fastify, duckdb (session logs), fingerprint-generator/injector (stealth).
- Context restore by reading/writing Chrome's LevelDB storage.
- Self-hosted Steel is effectively **one browser, one active session per instance**; profiles API documented for Steel Cloud.
- **Issue #347** (opened 2026-08-24, open): operator-precedence bug collapses every caller-supplied `userDataDir` into one shared directory: cookies/tokens leak between sessions.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Depend on / run Steel as the browser layer | Ready session API, Docker | Server/Docker oriented (not local-first); Puppeteer instead of Playwright; single-session; current profile-isolation bug; stealth features conflict with ADR-014 |
| Fork | Own the infra code | Same mismatches; we would delete most of it |
| **Reference only** | Learn session lifecycle and remote-infra patterns | None significant |

## Decision

**REFERENCE only.** No dependency, no fork, no code copying in MVP.

Concepts noted for later:
- session lifecycle API shape (create / get / release, session metadata) → informs `session.*` methods (`specs/protocol.md` §4)
- CDP WebSocket proxying and the websocket registry → input for remote mode (P13-08)
- extension loading and proxy plumbing → future profile options
- the issue #347 lesson: **profile directory isolation must be tested** (our ProfileManager rejects paths outside `<BOS_HOME>/profiles/<name>`; P2-02 tests it)

Explicitly not adopted: fingerprint injection / stealth (ADR-014), LevelDB storage manipulation (we let Chrome own its profile).

## Consequences

Positive: no Puppeteer, no server stack, no stealth code in our tree.
Negative: remote/fleet features must be designed ourselves later.
Follow-ups: revisit Steel during P13-08 remote mode design.

## Revisit when

- Remote/cloud mode (P13-08) is scheduled; Steel's then-current architecture is re-evaluated as a possible remote provider behind `CdpEndpointProvider`.

## References

- https://github.com/steel-dev/steel-browser, https://github.com/steel-dev/steel-browser/issues/347
- https://docs.steel.dev/overview/profiles-api/overview
- `specs/browser-runtime.md`, `SECURITY.md`
