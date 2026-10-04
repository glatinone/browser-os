# ADR-008: Browser Use Strategy

Status: Accepted (2026-10-02)

## Context

Browser Use (`browser-use/browser-use`, **MIT**, Python 3.11+, ~117k stars, 0.13.10 on 2026-09-04) is an LLM-in-the-loop agent: each step is an observation followed by a tool call. The historical docs listed it as a reference and benchmark target.

Facts (2026):
- Moved from Playwright to raw CDP (`cdp-use`, MIT) in Aug 2025; event bus `bubus` with "watchdogs" (downloads, crashes, popups, CAPTCHA, storage, security).
- DOM serializer: `DOMSnapshot.captureSnapshot` (paint order, rects, a few computed styles) + `DOM.getDocument(pierce)` + per-frame `Accessibility.getFullAXTree`; clickable heuristics include JS click listeners; paint-order occlusion filtering; bounding-box containment pruning; indexed interactive elements.
- `Agent.load_and_rerun(history)` re-identifies elements with a **5-level ladder**: element hash → stable hash → XPath → tag + AX name → unique attribute.
- **workflow-use** (deterministic workflows from recordings, fallback to the agent, healing): **AGPL-3.0**, self-described "very early development".
- **Browser Harness** (MIT): one CDP websocket to the user's real Chrome via the Chrome 144+ `chrome://inspect/#remote-debugging` consent toggle; `browser-harness-js` (MIT, TS/Bun) generates typed CDP wrappers.
- **jev-ultrafast** (MIT, needs a paid hosted policy model): single atomic snapshot call, freshness and occlusion checks before every input, tiny post-action waits, and the rule *"Model output never becomes selectors, coordinates, shell commands, or executable JavaScript."* Vendor claims (n=3, one task): 9.45 s → 7.09 s median.
- Cloud "skills" that learn across users exist, shared server-side (privacy concern for local-first).
- Benchmarks are vendor-run (e.g. Online-Mind2Web 97% for cloud, WebVoyager 89.1%).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Depend (Python sidecar) | Mature agent | Python process next to a TS runtime; LLM-per-step model is the opposite of our thesis; owns browser connection |
| Use workflow-use for replay | Ready concept | **AGPL**; early; tied to the Browser Use agent |
| Fork | — | Wrong language, wrong core loop |
| **Reference only** | Strongest public prior art for CDP DOM serialization and re-identification | Re-implement in TS |

## Decision

**REFERENCE only.** No dependency, no fork. **Never copy code from workflow-use (AGPL-3.0).** Reading Browser Use (MIT) for ideas is fine; any port needs an authorizing task card and a `THIRD_PARTY_NOTICES.md` entry.

Concepts adopted:
- CDP serializer inputs (DOMSnapshot + AX), clickable heuristics (DOMSnapshot `isClickable` + cursor/tabindex/role), paint-order occlusion as a Phase 11 optimization (P11-05)
- the **multi-signal element re-identification ladder** → our weighted `ElementLocator` matching (`specs/dom-intelligence.md` §8.4) and probe strategy order (§8.3)
- watchdog idea → our event-driven session status, popup/new-page and download handling
- jev's rules: model output only selects among provided refs (`specs/action-router.md` §5.2); freshness + occlusion check before input (hit-test, `TARGET_OBSCURED`); minimal bounded settle waits
- workflow-use's idea of semantic target + ordered selector strategies (idea only) → our step `intent` + locator

Not adopted: LLM call per step as default; cloud-shared skills; index-only references (unstable between snapshots).

## Consequences

Positive: proven techniques without Python or AGPL exposure.
Negative: re-implementation effort in `packages/dom`.
Follow-ups: Browser Use as an optional external benchmark baseline post-MVP (BENCHMARKS.md); Browser Harness notes feed P13-01 (consent attach).

## Revisit when

- A TS-native, MIT/Apache Browser Use component appears that fits behind `CdpTransport` and benchmarks better than our serializer.

## References

- https://github.com/browser-use/browser-use, https://browser-use.com/posts/playwright-to-cdp
- https://github.com/browser-use/workflow-use (AGPL-3.0), https://github.com/browser-use/browser-harness, https://github.com/browser-use/jev-ultrafast
- https://browser-use.com/posts/web-agents-that-actually-learn
