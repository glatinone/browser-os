# ADR-013: Extension Architecture

Status: Accepted — deferred implementation (2026-10-02)

## Context

The historical docs included a Chrome MV3 extension in the MVP stack (BrowserSkill style: daemon ↔ WebSocket ↔ extension ↔ `chrome.debugger`). Its value is access to the user's **real, daily browser**. Since ADR-003 makes Browser-OS-owned profiles the MVP model, the extension is not on the critical path of the thesis.

Facts:
- `chrome.debugger` exposes a subset of CDP domains (Accessibility, DOM, DOMSnapshot, Input, Network, Page, Runtime, Target subset, …; not Browser/SystemInfo), flat sessions since Chrome 125, cannot attach to `chrome://`/Web Store/other extensions' pages, and shows the "started debugging this browser" infobar on all tabs while attached (only hidden by `--silent-debugger-extension-api`).
- BrowserSkill (MIT) implements this well (Agent Window, tab borrowing with confirmation, single-use interrupt) but its local WS auth only checks the Origin header shape (ADR-005).
- Playwright MCP Bridge (Apache-2.0) relays CDP over `chrome.debugger` with a token to skip repeat approvals; Nanobrowser (Apache-2.0) runs agents inside an MV3 extension.
- Stagehand v4 moved its driver into an extension (ADR-006).
- Chrome 144+ offers a consent-based attach to the real profile with **no extension** (`chrome://inspect/#remote-debugging`).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Extension in MVP | Daily-profile access early | Extension build/sideload/store, infobar, domain limits, second transport, delays thesis proof |
| **No extension in MVP; ExtensionProvider later** | Thesis first; simpler MVP | Daily-profile users wait |
| ChromeConsentProvider instead of extension | No extension; user consents | Per-connection Allow dialog; Chrome 144+ only; Playwright support unverified |

## Decision

- **No extension in MVP.**
- Post-MVP order: evaluate **ChromeConsentProvider** first (P13-01) since it needs no extension; build **ExtensionProvider** (P13-04) if consent attach is insufficient.
- When built, the extension must:
  - stay small: a CDP relay and tab/window control surface only. **No agent reasoning, no router, no memory in the extension.**
  - implement `BrowserProvider` / `CdpTransport` so the runtime is unchanged
  - pair with the daemon using a **token** (one-time pairing code exchanged for a device token), not an Origin check
  - use an Agent Window and explicit tab borrowing with user confirmation (concepts from BrowserSkill)
  - declare provider capabilities honestly (e.g. no Browser domain)

## Consequences

Positive: MVP stays focused; the provider interface is ready for it.
Negative: no daily-profile automation in MVP; users log in once in owned profiles (manual setup mode).

## Revisit when

- MVP is complete and user feedback ranks daily-profile access above other post-MVP items, or
- P13-01 shows consent attach is impractical (dialog per connection, Playwright incompatibility).

## References

- https://developer.chrome.com/docs/extensions/reference/api/debugger
- https://github.com/microsoft/playwright-mcp (extension bridge), Nanobrowser, BrowserSkill (ADR-005)
- `specs/browser-runtime.md` §2, ADR-003
