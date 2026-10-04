# ADR-002: Playwright vs Direct CDP

Status: Accepted (2026-10-02)

## Context

Browser-OS needs (a) reliable browser lifecycle, page/frame tracking, navigation, uploads and downloads, and (b) a very fast hot path for DOM capture, cached-target probing and input dispatch.

Research findings (2026):
- **Stagehand v3** dropped Playwright and wrote its own CDP driver ("Understudy": frame registry, execution-context registry, shadow piercer, deep XPath locators, network manager, lifecycle watcher). Its blog cites Playwright's actionability checks and auto-waiting as overhead and claims v3 is "44%+ faster" than v2 (vendor claim).
- **Browser Use** moved from Playwright to raw CDP (`cdp-use`) in Aug 2025, citing an extra network hop through the Node relay (they are Python), hangs, and trouble with cross-origin iframes and crashed tabs. They admit they now handle "10+ ways a tab can crash" themselves.
- **Playwright 1.63** (Sept 2026, Apache-2.0) adds public `ariaSnapshot({mode:'ai'})` with refs, `ariaSnapshotJSON()`, `browser.bind()`, and `context.newCDPSession(page|frame)` for raw CDP on both launched and connected browsers. `connectOverCDP` is documented as "significantly lower fidelity" than a Playwright-launched browser.
- For a Node/TypeScript runtime, Playwright runs in-process (no Python→Node hop), so Browser Use's main reason does not apply to us.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Playwright only (locators for everything) | Least code; robust actionability; mature frames/OOPIF handling | Actionability waits on every action; no backendNodeIds; less control of the hot path |
| Raw CDP only (own Understudy-style driver) | Full control, minimal overhead | Large, subtle surface (frames, OOPIF, lifecycle, crashes, downloads); high risk for cheap coding models; months of work before the thesis is tested |
| `chrome-remote-interface` / Puppeteer | Thinner than Playwright | Puppeteer duplicates Playwright; neither gives the fallback executor we want; another dependency |
| **Hybrid: Playwright for lifecycle + fallback, raw CDP for the hot path** | Mature lifecycle for free; hot path is ours; fallback for hard cases | Two mechanisms to understand; Playwright and our own CDP sessions coexist on the same targets |

## Decision

**Hybrid.**

- `playwright-core` is a **DEPENDENCY**, imported only inside `packages/browser` (enforced by `scripts/check-boundaries.mjs`). It is used for:
  - launch via `launchPersistentContext` (pipe transport, no TCP debugging port; ADR-003)
  - `connectOverCDP` for the `CdpEndpointProvider`
  - page/frame lifecycle, popups, navigation (`page.goto`)
  - uploads (`setInputFiles`) and downloads
  - the **fallback executor** (`locatorFor(locator)` → click/fill/selectOption with actionability waits)
- **Raw CDP** via `context.newCDPSession(page)`, wrapped as `CdpTransport`, for the hot path:
  - DOM capture (`DOMSnapshot.captureSnapshot` + `Accessibility.getFullAXTree`)
  - the cached-target probe (≤ 4 round trips)
  - `Input.*` dispatch with our own geometry and hit-test, and value read-back
- The router uses CDP first and Playwright only when the CDP attempt reported `effect: 'none'` (ADR-010).
- We do **not** build a full Understudy-like CDP driver in MVP.

Playwright types never leave `packages/browser`; other packages see `PageDriver`, `PageHandle`, and `CdpTransport` only.

## Consequences

Positive:
- Phase 2–3 are small; cheap models can implement them.
- Hot path latency is under our control and measurable (CDP vs Playwright click benchmark, P10-03).
- A future switch to pure CDP touches only `packages/browser`.

Negative:
- Some duplication of concepts (frames known by Playwright and by our capture).
- Playwright's own CDP traffic shares the connection; we must not disable domains Playwright relies on.

Follow-ups:
- P10-03 benchmarks CDP vs Playwright actions; P10-04 measures the Playwright share of replay latency.
- If replaced later: REPLACE LATER item in OSS_STRATEGY.md.

## Revisit when

- Benchmarks show Playwright-attributable time > 20% of cached-replay latency on fixture tasks, or
- Playwright blocks a needed capability (e.g. Chrome 144 consent attach not working, see P13-01), or
- Playwright's pipe launch prevents a required feature (reattach across daemon restarts becomes a requirement).

## References

- `specs/browser-runtime.md` §2, §4, §5; `specs/action-router.md` §6
- Stagehand v3: https://www.browserbase.com/blog/stagehand-v3 (vendor claims)
- Browser Use: https://browser-use.com/posts/playwright-to-cdp
- Playwright releases / API: https://github.com/microsoft/playwright/releases, https://playwright.dev/docs/api/class-browsertype
