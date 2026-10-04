# Phase 11: Compatibility hardening

Read first: `docs/COMPATIBILITY.md`, `docs/PERFORMANCE.md` (optimization backlog), `docs/SECURITY.md` §7.
**Rule:** no site-specific code in core packages. Site knowledge lives in data (cache/trajectories), never in `if (host === 'linkedin.com')`.

---

## P11-01 · Real-site runner (opt-in, never CI)

| Field | Value |
|---|---|
| depends_on | P8-08 |
| supervision | cheap-ok |
| size | S |
| spec | COMPATIBILITY.md (manual checklist, results template) |

**Files:** `benchmarks/real-sites/README.md`, `benchmarks/real-sites/run.ts`, `benchmarks/real-sites/tasks/*.task.json` (examples only, with no credentials).

**Requirements:**
- Runs a task file against a dedicated profile, headful, with an explicit `--i-understand-tos` flag. **Targets and the 8 mandatory best practices come from ADR-019.** Ship example task files for the Tier 1 sites (the-internet, demoqa, saucedemo, TodoMVC, Wikipedia read-only).
- Records per-step tiers and timings into `benchmarks/results/real-sites-*.json`.
- Refuses to run in CI (`process.env.CI` set → exit with a message).
- Rate limit: ≥ 2 s between actions by default.

---

## P11-02 · Out-of-process iframes (OOPIF)

| Field | Value |
|---|---|
| depends_on | P10-06 |
| supervision | **expert** |
| size | L |
| spec | dom-intelligence §2 (OOPIF note); browser-runtime §5 (coordinates) |

**Goal.** Elements inside cross-origin iframes appear in observations and are actionable.

**Requirements**
1. Per-page target tracking with `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })`, recursively on child sessions.
   - Alternative: Playwright `newCDPSession(frame)` for OOPIF frames. Pick one and justify it in the implementation notes.
2. Capture each OOPIF with its own session and merge it into the NodeTable, offsetting coordinates by the host iframe's content box.
3. Index entries carry the CDP session id. Executors use the right session; `Input.*` is dispatched on the top-level target using page coordinates.
4. Probe still returns `[]` for framePath locators. Full matching works across frames.

**Tests:** new fixture `oopif` served from two ports (cross-origin) on the fixture server (add a second server instance); observe + click + fill inside the cross-origin iframe; goldens.

---

## P11-03 · Multi-tab workflows

| Field | Value |
|---|---|
| depends_on | P10-06 |
| supervision | cheap-ok (review) |
| size | S |
| spec | browser-runtime §3 (active page) |

**Requirements:**
- Fixture `multitab`: a link with `target=_blank` opens a details page; a form there; closing it returns to the opener.
- Verify record and replay across the tab switch (the new tab becomes active automatically).
- Fix gaps. Add `pageChanged`/`newPageId` handling in the recorder if steps need it (e.g. a `post.urlPattern` on the new page).

**Tests:** e2e record/replay across tabs.

---

## P11-04 · Large-page mode (evidence-gated)

| Field | Value |
|---|---|
| depends_on | P10-06 |
| supervision | **expert** |
| size | M |
| spec | dom-intelligence §2 (large-page guard); PERFORMANCE.md backlog trigger |

**Gate:** start only if the P10 report shows L7 p50 > 500 ms or real-site reports show slow observations. Otherwise mark `skipped` with the evidence.

**Requirements:** for `stats.large` pages, fetch the AX tree only for candidate nodes (DOMSnapshot-derived interactive candidates within viewport ± 1 screen) via concurrent `Accessibility.getPartialAXTree` calls, or `queryAXTree`. Keep output identical in format; flag `warnings: ['large-page-mode']`.

**Tests:** heavy fixture: L7 improves ≥ 2× with ≥ 98% of in-viewport elements identical to full mode.

---

## P11-05 · Paint-order occlusion filtering

| Field | Value |
|---|---|
| depends_on | P10-06 |
| supervision | **expert** (review) |
| size | M |
| spec | dom-intelligence §5 (modal scoping note); OSS_STRATEGY §3 (Browser Use paint order, BrowserSkill layers) |

**Requirements:** using `paintOrder` and bounds, drop elements fully covered by later-painted opaque elements (rect-union approach, capped at 5,000 rects). Non-modal overlays (cookie banners, sticky headers covering content) are handled. Must not drop elements covered only by transparent or `pointer-events:none` layers.

**Tests:** new fixtures: cookie banner over content, sticky header, transparent overlay (must not drop); goldens updated with review.

---

## P11-06 · Shadow DOM and contenteditable edge cases

| Field | Value |
|---|---|
| depends_on | P10-06 |
| supervision | cheap-ok |
| size | S |
| spec | dom-intelligence §4, §8.2 |

**Requirements:** closed shadow roots (DOMSnapshot pierces them; verify that the executor can click and fill inside); nested shadow roots in cssPath; slotted content; rich-text editors (contenteditable with nested formatting) fill and readback.

**Tests:** fixtures + browser tests.

---

## P11-07 · MFA pause/resume e2e

| Field | Value |
|---|---|
| depends_on | P9-03 |
| supervision | cheap-ok |
| size | S |
| spec | SECURITY.md §6.1; S12 |

**Scenario:** headful test (CI uses `xvfb-run` on linux, or mark it manual-only if xvfb is unavailable):
1. Replay a trajectory on the `login` fixture where step 2 shows the OTP page.
2. Assert `human.required` with reason `mfa`.
3. The test (acting as the human) fills the OTP directly via Playwright, then calls `human.resume --done`.
4. The replay continues to "Welcome".
5. The trajectory is not marked as failed.

Also: a headless session gets `SECURITY_CHALLENGE`.

---

## P11-08 · Self-hosted realistic test stack (Keycloak OIDC + OTP)

| Field | Value |
|---|---|
| depends_on | P11-01 |
| supervision | cheap-ok |
| size | M |
| spec | ADR-019 (Tier 2); SECURITY.md §6; COMPATIBILITY.md C9, C10, C14, C18 |

**Goal.** Real SSO and MFA behaviour without touching real accounts or ToS-restricted sites.

**Files:** `benchmarks/real-sites/stack/docker-compose.yml`, `benchmarks/real-sites/stack/realm-browseros.json` (realm export), `benchmarks/real-sites/stack/README.md`, `benchmarks/real-sites/tasks/keycloak-*.task.json`.

**Requirements**
1. `docker compose up` starts `quay.io/keycloak/keycloak` (pin a version tag; dev mode, `start-dev`, bound to `127.0.0.1` only) with an imported realm `browseros`:
   - test user `alice` (password defined in the README as a **local-only test value**)
   - required action: configure OTP (TOTP)
2. Scenarios (run with the P11-01 runner, headful):
   - (a) First login through `bos profile open rs-keycloak`: the human sets up TOTP and logs in. Then an automated session reuses the cookies and opens the account console (expect: no challenge).
   - (b) Expire the session (Keycloak admin "sign out all sessions"), then replay a trajectory: the `login` challenge is detected, `human.required` fires, the human logs in plus OTP, `bos human resume --done`, and the replay continues.
   - (c) Account console navigation (personal info form, sessions list, multi-tab "linked accounts" if present): record → replay with 0 LLM calls.
3. The README documents: no internet exposure, test credentials only, how to reset the realm.
4. Results go in the COMPATIBILITY.md §4 table (C9, C10-proxy, C14, C18).

**Out of scope:** automating OTP entry (the human does it, SECURITY.md §6); CI integration (optional later, nightly only).

**Acceptance criteria**
- [ ] Scenarios a–c run and are documented with the §3 template
- [ ] No credential other than the documented local test user appears in the repo
