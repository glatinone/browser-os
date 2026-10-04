# COMPATIBILITY.md: Real-World Compatibility Matrix

**Status:** Authoritative for MVP · **Related:** SECURITY.md §6–§7, TESTING.md, BENCHMARKS.md, tasks P11-01…P11-07, P12-03

Websites differ. This document says which classes of sites the MVP must handle, how each is tested, and what is deliberately out of scope.

**Ground rules for real-site testing**
- Real-site testing is **manual and opt-in** (P11-01 runner). It never runs in CI.
- Use **your own accounts or dedicated test accounts**. Never other people's accounts.
- Respect terms of service. LinkedIn, Instagram and others restrict automation. Keep runs few, slow and human-like, and do not scrape third-party data at scale. Responsibility for ToS compliance is the user's (SECURITY.md §7).
- **Google, Microsoft (Entra) and other identity providers:** authenticate via **manual setup mode** (`bos profile open <name>`), then run automated sessions on the logged-in profile.
- Some sites block or degrade automated sessions. **Bypassing that is not a goal.** Record it as "blocked by site" and move on.
- **Which sites:** the tiered target list in **ADR-019** (`docs/adr/019-real-site-test-targets.md`) is authoritative, including its 8 mandatory best practices. Tier 1 = automation-friendly practice sites, Tier 2 = self-hosted Keycloak stack (P11-08), Tier 3 = the owner's own low-risk accounts. LinkedIn/Instagram are not tested in MVP.

---

## 1. Target levels

| Level | Meaning |
|---|---|
| **Full** | Observe + act + record + replay work without a human (except for policy confirmations). |
| **Partial** | Core flows work; known gaps listed; some steps may need the llm tier or fail. |
| **Human-assisted** | Browser-OS pauses for a human by design (auth, challenges), then continues. |
| **Out of scope** | Not supported in MVP; may be future work. |

---

## 2. Matrix

| # | Site class | MVP level | How tested | Known risks | Related tasks |
|---|---|---|---|---|---|
| C1 | Simple static site (forms, links) | **Full** | fixture `basic`; real: Tier 1 the-internet.herokuapp.com, Wikipedia (read-only) | none significant | P3, P4, P7 |
| C2 | SPA (history-API routing, delayed render) | **Full** | fixture `spa`, `dynamic` | route-change timing; elements rendered late (probe polling); stale refs after re-render (heal) | P4-11, P7-03, P7-06 |
| C3 | React application (synthetic events, controlled inputs) | **Full** | fixture `spa` (controlled-input behaviour emulated); real: Tier 1 TodoMVC React, saucedemo | controlled inputs ignoring `insertText` → fill verification fails → native setter + events fallback; generated ids filtered as unstable | P3-03, P4-08 |
| C4 | iframe-heavy, same-origin | **Full** | fixture `iframe` | frame offset maths; `framePath` matching | P4-03, P4-08 |
| C5 | Cross-origin iframes (OOPIF) | **Partial** → Full after P11-02 | fixture `iframe` with second origin (fixture server on a second port) | MVP observes OOPIF frames as empty (`outOfProcess: true`); child sessions and coordinate composition land in P11-02 | P11-02 |
| C6 | Shadow DOM: open roots | **Full** | fixture `shadow` | css path ` >>> ` probing; nested shadow roots | P4-08, P4-09 |
| C7 | Shadow DOM: closed roots | **Partial** | fixture `shadow` (closed variant) | AX tree and DOMSnapshot see into them, but the probe's css strategies cannot → full-match path; focus handling edge cases | P11-06 |
| C8 | contenteditable / rich-text editors (Slate, ProseMirror, Lexical) | **Partial** | fixture `basic` (contenteditable field); real: an editor demo | editors intercept input; `insertText` usually works; select-all semantics differ; value verification via `textContent` | P3-03, P11-06 |
| C9 | OAuth login flows (redirect to IdP and back) | **Human-assisted** | fixture `login`; real: Tier 2 Keycloak-protected app (P11-08) | Browser-OS never fills passwords (MVP); `login`/`consent` challenge → pause; redirects across origins during replay | P9-03, P11-07 |
| C10 | Microsoft Entra (login.microsoftonline.com) | **Human-assisted** for auth; **Partial** for post-login apps | Tier 2 Keycloak OIDC+OTP (proxy for SSO behaviour, P11-08); Tier 3 Microsoft 365 **Developer** tenant via manual setup mode, never the employer tenant without IT approval | automated sessions may be challenged again; conditional access policies; device compliance checks may refuse the profile; push MFA → pause | P11-01, P11-07 |
| C11 | Google login (accounts.google.com) | **Human-assisted** via manual setup mode | Tier 3: personal (non-employer) Google account via manual setup mode, read-only tasks | Google may refuse sign-in in automated browsers ("browser may not be secure"); that is why login happens in manual mode. Session cookies can still be invalidated by Google risk checks. | P2-06, P11-01 |
| C12 | LinkedIn | **Not tested: ToS restricts automation** (ADR-019) | not in the MVP matrix | LinkedIn User Agreement prohibits bots/automated access; account-ban risk. The Partial technical expectation (heavy DOM, A/B layouts → healing) is unverified | — |
| C13 | Instagram | **Not tested: ToS restricts automation** (ADR-019) | not in the MVP matrix | Instagram Terms prohibit automated access without permission; frequent login challenges | — |
| C14 | Enterprise dashboard (tables, filters, modals, grids) | **Partial** | fixture `modal`, `heavy`; real: Tier 2 Keycloak account console; Tier 1 demoqa widgets | virtualized grids (rows not in DOM); custom comboboxes; large pages | P11-04, P11-05 |
| C15 | Multi-tab workflows (target=_blank, popups) | **Partial** → Full after P11-03 | fixture `multitab` (P11-03); real: Tier 1 the-internet "Multiple Windows", demoqa browser windows | active-page switching in replay; popup blockers | P2-07, P11-03 |
| C16 | Download workflow | **Partial** (policy-gated, off by default) | fixture with a download link | filename sanitization; downloads triggered via JS blobs | P3-06, P9-07 |
| C17 | Upload workflow | **Partial** (policy-gated, off by default) | fixture with file input + drop zone | drop zones without `<input type=file>` are out of MVP; path policy | P3-06, P9-07 |
| C18 | MFA pause/resume | **Human-assisted** | fixture `login` OTP step; real: Tier 2 Keycloak with TOTP required (P11-08) | headless sessions cannot resume (→ `SECURITY_CHALLENGE`); push approval detection relies on text heuristics | P9-03, P11-07 |
| C19 | Infinite scroll / lazy lists | **Partial** | fixture `dynamic` (append-on-scroll variant) | target below fold requires scroll actions by the caller; replay of "item N" is index-fragile, so prefer name-based intents | P4, P7 |
| C20 | Canvas / WebGL apps (maps, editors, games) | **Out of scope** (MVP) | none | no DOM semantics; needs the vision tier (post-MVP, P13) | P13 |
| C21 | CAPTCHA-protected flows | **Human-assisted** (pause only) | fixture with fake captcha iframe | Browser-OS never solves CAPTCHAs | P9-03 |
| C22 | Sites that block automated browsers | **Out of scope** (by policy) | — | no evasion (SECURITY.md §7) | — |

---

## 3. Manual real-site test checklist (template)

Copy into `docs/compat/<site>-<YYYY-MM-DD>.md` for each manual run (P11-01).

```markdown
# Compatibility run: <site> — <date>

- Tester: <name/role>
- Account: own / test account (never third-party)
- Browser-OS commit: <sha>   Chrome version: <ver>   OS: <os>
- Profile: <name>  (authenticated via `bos profile open`: yes/no)
- Model (if llm tier used): <provider:model> / none

## Scenario
- Task key: <key>    Params: <non-secret params>
- Steps (intents): 1. … 2. … 3. …
- Success check: <what must be true at the end>

## Run 1 (record)
- [ ] session opened (warm/cold), page reachable
- [ ] observation useful (elements present, names sensible, no secrets in output)
- [ ] each step resolved — tier per step: …
- [ ] challenges encountered: none / login / mfa / captcha / consent → paused correctly? 
- [ ] high-risk actions asked for confirmation (if any)
- [ ] success check passed
- Metrics: task_ms=…, llm_calls=…, tokens=…, observations=…

## Run 2 (replay, same params)  and  Run 3 (replay, different params)
- [ ] all steps at cache tier? (list exceptions)
- [ ] llm_calls == 0 ?
- [ ] success check passed
- Metrics: …

## Issues
- <description, step, error code, screenshot only if taken manually by the tester>

## Verdict: Full / Partial / Human-assisted / Blocked by site
```

---

## 4. Results table (filled at P12-03)

| # | Site class | Site / fixture | Date | Commit | Level achieved | Run1 LLM calls | Replay LLM calls | Replay success | Notes |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Simple static | | | | | | | | |
| C2 | SPA | | | | | | | | |
| C3 | React app | | | | | | | | |
| C4 | iframe same-origin | | | | | | | | |
| C5 | OOPIF | | | | | | | | |
| C6 | Shadow open | | | | | | | | |
| C7 | Shadow closed | | | | | | | | |
| C8 | contenteditable | | | | | | | | |
| C9 | OAuth login | | | | | | | | |
| C10 | Microsoft Entra | | | | | | | | |
| C11 | Google login | | | | | | | | |
| C12 | LinkedIn | | | | | | | | |
| C13 | Instagram | | | | | | | | |
| C14 | Enterprise dashboard | | | | | | | | |
| C15 | Multi-tab | | | | | | | | |
| C16 | Download | | | | | | | | |
| C17 | Upload | | | | | | | | |
| C18 | MFA pause/resume | | | | | | | | |
| C19 | Infinite scroll | | | | | | | | |
| C20 | Canvas | n/a | | | Out of scope | | | | |
| C21 | CAPTCHA | | | | | | | | |

**MVP compatibility exit criterion (P12-03):** C1–C4, C6 at Full; C9, C10 or C11 (at least one IdP), C18 Human-assisted working end to end; C12 or C13 (at least one heavy social SPA) Partial with replay success ≥ 80% over 3 runs; one multi-tab workflow (C15) passing.
