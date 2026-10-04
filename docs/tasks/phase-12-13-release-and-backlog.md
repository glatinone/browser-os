# Phase 12: MVP release · Phase 13: post-MVP backlog

---

## P12-01 · Package READMEs and user guide

| Field | Value |
|---|---|
| depends_on | all P9, P10 and P11 tasks `done` or `skipped` |
| supervision | cheap-ok |
| size | S |

**Files:** `packages/*/README.md` (purpose, public API, example), `docs/USER_GUIDE.md`.

The user guide covers:
- install
- `bos profile create/open` (manual login)
- `session open`
- observe/act
- the task record/replay workflow
- secrets
- confirmations and human prompts
- config (models: OpenAI-compatible, Anthropic, Ollama)
- troubleshooting (profile locked, browser not found, daemon token permissions)

---

## P12-02 · Packaging

| Field | Value |
|---|---|
| depends_on | P12-01 |
| supervision | cheap-ok |
| size | S |

**Requirements:**
- All packages build to `dist/` with type declarations. Package versions are `0.1.0`.
- `@browser-os/cli` exposes `bos`; `@browser-os/daemon` exposes `bos-daemon`. `npm pack` contents checked (no tests, no fixtures).
- `THIRD_PARTY_NOTICES.md` present (even if empty of ports).
- License: **Apache-2.0, decided (ADR-018)**. `LICENSE` and `NOTICE` already exist at the repo root. Every npm package must include `LICENSE` and `NOTICE` (add them to each package's `files` and copy them at build time).

---

## P12-03 · MVP acceptance run

| Field | Value |
|---|---|
| depends_on | P12-02 |
| supervision | **expert / human owner** |
| size | M |

**Checklist:**
- PRD §6.2 acceptance criteria for all 18 MVP IN rows
- PRD §10 metrics (from the latest benchmark report)
- SECURITY.md §15 S1–S20 all green
- COMPATIBILITY.md results table filled from P11-01 runs on the owner's own accounts
- `docs/benchmarks/REPORT-<date>.md` refreshed

For every gap: an ADR accepting it or a task to fix it. Then tag `v0.1.0`.

---

# Phase 13: Post-MVP backlog (ordered; each item needs a full task card written by an expert before work starts)

| ID | Item | Notes |
|---|---|---|
| P13-01 | **ChromeConsentProvider** | Chrome 144+ `chrome://inspect/#remote-debugging` consent attach to the user's real browser; verify Playwright ≥ 1.60 `connectOverCDP` support (issue #40027); per-connection Allow dialog UX; no automation flags involved. Reference: browser-harness, Chrome DevTools MCP `--autoConnect`. |
| P13-02 | **MCP server** (`packages/mcp`) | stdio MCP exposing observe/act/task tools as a thin SDK client. Reference: Playwright MCP. |
| P13-03 | **Vision tier** | `VisionResolver` with a vision model: screenshot → element/point; only when the provider has `screenshots`; budgets; never for CAPTCHA. Reference: Magnitude, Stagehand CUA. |
| P13-04 | **ExtensionProvider** | Own MV3 extension relaying `chrome.debugger` to the daemon with token pairing; Agent Window + tab borrowing concepts (BrowserSkill, MIT). ADR-013. |
| P13-05 | **OTel exporter** | `packages/otel` mapping BosEvents to spans/metrics (OTel SDK dependency, approved by a new ADR). |
| P13-06 | **Optional internal planner** | `bos run "<goal>"` for users without their own agent; uses the `capable` model; must reuse the router and trajectories. Only if user demand is demonstrated. |
| P13-07 | **LightpandaProvider** | Out-of-process CDP endpoint for headless extract-only jobs; capability flags; AGPL boundary (never linked). |
| P13-08 | **Remote mode** | `wss://` transport, device pairing tokens, rotation (SECURITY.md §4.3). |
