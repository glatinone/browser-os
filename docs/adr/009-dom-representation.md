# ADR-009: DOM Representation

Status: Accepted (2026-10-02)

## Context

The DOM representation decides token cost, LLM accuracy, deterministic-tier coverage and cache durability. We need:
1. a compact per-observation view for agents and models (refs to act on),
2. a live handle for the CDP executor (backendNodeId),
3. a **durable** element description that survives page reloads and minor UI changes (for cache and trajectories).

Prior art converges: BrowserSkill (MIT), Stagehand v3/v4 and Browser Use all build from CDP (`DOMSnapshot.captureSnapshot` and/or `Accessibility.getFullAXTree`) rather than raw HTML or screenshots. Playwright 1.59+ exposes a public `ariaSnapshot({mode:'ai'})` with `[ref=eN]` refs (1.60 boxes, 1.63 JSON). Playwright MCP uses the same format.

CDP cost facts: `getFullAXTree` < 50 ms on normal pages, 200–500 ms at 10k+ AX nodes, pathological (~9.9 s) reported on a 35k-node page; `DOMSnapshot.captureSnapshot` ~60 ms / ~300 KB on a typical page (rough figure).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Raw HTML to model | Trivial | Huge tokens, hallucination, secrets in markup |
| Screenshots / vision-first | Works on canvas | Slow, expensive, imprecise; contradicts "DOM before vision" |
| Injected JS DOM walker (old Browser Use `buildDomTree.js` style) | Simple to write | Runs in page world (tamperable, observable); manual shadow DOM/frames; visibility needs layout anyway |
| Playwright `ariaSnapshot({mode:'ai'})` | Maintained, spec-correct roles/names, frames handled | No backendNodeIds, no stable attrs, no cssPath; refs tied to Playwright internal state; less control of filtering/format |
| **Own CDP pipeline: DOMSnapshot + AX joined by backendNodeId** | Native speed, layout + paint order + click listeners + computed AX in 2–4 calls; shadow DOM pierced; backendNodeIds for executor; we control locators | Most implementation effort; must handle frames and large pages carefully |

## Decision

**Own CDP pipeline** in `packages/dom` (`specs/dom-intelligence.md`):

- Capture: concurrent `DOMSnapshot.captureSnapshot` (styles, paint order, rects), `Accessibility.getFullAXTree` per same-process frame, `Page.getLayoutMetrics`, `Page.getFrameTree`; per-frame failure isolation; document-identity guard.
- Join by backendNodeId → interactivity rules → visibility + modal scoping → `SemanticElement[]` with **per-observation refs `e1..eN`** (not stable across observations, by design).
- Output formats: JSON `Observation` and **compact lines** (`e3 combobox "Search" placeholder="Search" [banner]`), ~4 chars/token estimate. LLM prompts get at most 30 candidates.
- Durable identity: **`ElementLocator`** (role, name or `nameIsDynamic`, stable attrs with unstable-id filtering, context, cssPath with shadow `>>>`, framePath, ordinal), matched by a **weighted fingerprint score** with acceptance threshold + margin; a ≤ 4-round-trip probe for cached targets.
- Internal `ObservationIndex` (ref → backendNodeId, frame, locator) never leaves the daemon.
- Playwright `ariaSnapshot({mode:'ai'})` is used as a **test oracle** for role/name agreement (P4-10, ≥ 95%), not in production.
- Screenshots only in the vision tier (post-MVP). OOPIFs listed but empty in MVP (P11-02). Large-page partial AX (P11-04) and paint-order occlusion (P11-05) only with benchmark evidence.

## Consequences

Positive: compact, deterministic, golden-testable output; durable locators enable zero-LLM replay; no page-world tampering.
Negative: the hardest code in the MVP (expert-supervised tasks P4-02…P4-05, P4-08, P4-09); large-page cost must be watched.
Follow-ups: P4-12 locator robustness suite on mutated fixtures; P10-03 observe benchmarks per fixture.

## Revisit when

- Oracle agreement < 95% persists and Playwright ariaSnapshot gains attribute/backendNodeId access → consider adopting it for role/name.
- Heavy pages exceed observe p95 targets in PERFORMANCE.md → prioritize P11-04.

## References

- `specs/dom-intelligence.md`, `specs/data-models.md` §4
- BrowserSkill commit 3f10983 `apps/extension/src/tools/vom/*` (ADR-005); Stagehand `understudy/a11y/snapshot/capture.ts` (ADR-006); Browser Use `browser_use/dom/` (ADR-008)
- https://playwright.dev/docs/api/class-locator, https://playwright.dev/mcp/snapshots
- AX cost report: https://github.com/openwong2kim/wmux/issues/1371 (third-party)
