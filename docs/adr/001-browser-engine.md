# ADR-001: Browser Engine

Status: Accepted (2026-10-02)

## Context

Browser-OS must operate authenticated, persistent, complex web applications: Microsoft Entra, Google SSO, LinkedIn, Instagram, enterprise SPAs, iframes, shadow DOM, extensions, WebAuthn/passkeys. The historical documents (`docs/history/`) agree that compatibility with the real web matters more than synthetic browser speed.

The thesis (PRD) is that performance comes from **avoiding unnecessary work** (LLM calls, screenshots, re-observation, browser launches), not from a faster rendering engine. The engine choice is about compatibility first.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Real Chrome / Edge / Chromium over CDP | Full web compatibility; real profiles, extensions, enterprise policies, WebAuthn; CDP is mature and documented; Playwright supports it natively | Heavier (RAM/CPU per process); automated sessions are detectable as automated (we accept that, ADR-014) |
| Lightpanda (Zig, headless, CDP server) | Vendor claims ~11x faster and ~9x less memory than headless Chrome (vendor benchmark, Jan 2026); CDP-compatible enough for Puppeteer/Playwright `connectOverCDP` | **AGPL-3.0**; not Chrome parity (incomplete Web APIs and CDP domains); no real screenshots (vision tier impossible); OAuth/WebAuthn/complex SPAs need per-site testing; no native Windows binary (WSL2 only); no persistent-profile model comparable to a Chrome user-data-dir; 1.0 only just tagged (2026-10-02, unverified) |
| Firefox / WebKit via Playwright | Engine diversity | No CDP; worse fit for real-profile/extension workflows; not where target users' logins live |
| Build/fork a browser | Total control | Absurd cost; violates "do not build another browser" |

## Decision

- **MVP engine: real Chromium-family browsers only**: `chrome` (default), `msedge`, `chromium` (Playwright-managed, mainly CI), controlled through CDP (with Playwright for lifecycle, ADR-002).
- Headed by default (real sites + human takeover need a visible window); headless is opt-in per profile.
- **Lightpanda** is recorded as a possible future `LightpandaProvider` (P13-07) for headless read/extract-only workloads. If it is ever adopted it must run **out of process** and be spoken to only over CDP, never linked or bundled (AGPL). Its provider must declare `capabilities.screenshots = false` and `persistentProfile = false` so the router skips unsupported tiers.
- No custom browser, no browser fork.

## Consequences

Positive:
- Maximum compatibility with the target sites; authenticated state lives in a real Chrome profile.
- One protocol (CDP) for every MVP provider.

Negative:
- Per-session memory cost of a full Chrome process. Accepted. We optimize by reusing warm sessions instead of launching new browsers (CODING_AGENT rule 17).
- Automated sessions are visibly automated. Some identity providers may refuse them; the answer is manual setup mode (ADR-003), not evasion.

Follow-ups:
- `BrowserProvider` interface with `ProviderCapabilities` (specs/browser-runtime.md §2) keeps the door open for other engines.
- P13-07 Lightpanda provider evaluation (license review, compatibility corpus) only after MVP.

## Revisit when

- A benchmarked workload shows browser engine time (not LLM/observation time) is > 50% of end-to-end latency on headless extract-only tasks, **and** Lightpanda (or another engine) passes the fixture compatibility suite for those tasks.
- Chrome changes remote-debugging policy in a way that blocks owned-profile automation.

## References

- `docs/PRD.md`, `docs/ARCHITECTURE.md`, `specs/browser-runtime.md` §2
- Lightpanda: https://github.com/lightpanda-io/browser (AGPL-3.0); vendor performance claims via https://wavect.io/blog/lightpanda-headless-browser-ai-agents/
- Chrome remote debugging changes: https://developer.chrome.com/blog/remote-debugging-port
- History: `docs/history/01-master-spec-browserskill-ultra.txt` §6, `03-architecture-v0.1.txt` §2.3
