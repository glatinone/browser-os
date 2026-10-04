# ADR-019: Real-site compatibility test targets

Status: Accepted (2026-10-02). Decided by the owner, who delegated the choice to the architect.

## Context
COMPATIBILITY.md needs real-world evidence (P11-01, P12-03). Real sites differ in ToS, ban risk, auth complexity and stability. Testing on a personal main account, or on an employer tenant without approval, creates account-ban, legal and security risks. LinkedIn's User Agreement and Instagram's Terms explicitly prohibit bots, scrapers and other automated access without permission.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Test directly on LinkedIn/Instagram/corporate SSO with main accounts | Most "real" | Ban risk, ToS violation, possible security incident on a corporate tenant |
| Only local fixtures | Safe, reproducible | Misses real-world SPA, auth and layout drift |
| **Tiered targets: automation-friendly public sites → self-hosted realistic stack → owner's own low-risk accounts; ToS-restricted sites out of the automated matrix** | Real evidence with controlled risk; most of it reproducible | Some popular sites stay "unverified" in MVP |

## Decision

**Tier 1: automation-friendly public practice sites** (built for automation testing; run freely, still rate-limited):

| Target | Site class covered (COMPATIBILITY ids) |
|---|---|
| `the-internet.herokuapp.com` | iframes (nested frames, TinyMCE), multiple windows (multi-tab), file upload/download, dynamic loading, infinite scroll, JS alerts, shadow DOM page |
| `demoqa.com` | forms, widgets, modal dialogs, browser windows, upload/download |
| `www.saucedemo.com` (public demo creds `standard_user` / `secret_sauce`) | login form → shop SPA → cart → checkout (exercises **high-risk confirmation** on "Finish"; no real payment) |
| TodoMVC React example (`todomvc.com`) | React SPA, contenteditable-like inline edit |
| `practicetestautomation.com` practice pages | simple login + exceptions/dynamic elements |
| Wikipedia (read-only: search, navigate, extract) | static/large pages (heavy DOM, L7), extraction |

**Tier 2: self-hosted realistic stack** (Docker, local test accounts, no ToS issues; task P11-08):

| Target | Covers |
|---|---|
| **Keycloak** (`quay.io/keycloak/keycloak`) as an OIDC identity provider, with OTP (TOTP) required | OAuth/SSO redirect flows, `login` + `mfa` challenge detection, **MFA pause/resume** with a real IdP UI |
| A demo app protected by that Keycloak realm (Keycloak's account console is enough) | post-login enterprise-style dashboard, multi-tab, session persistence across restarts |

**Tier 3: owner's own accounts, human-assisted, low volume** (manual setup mode, dedicated Browser-OS profiles):

| Target | Rule |
|---|---|
| GitHub (personal account; test repo) | allowed: navigate, search, open issues/PRs in your own test repo. No bulk actions |
| Google account (**personal, not employer**) | login only through `bos profile open`; then light read-only tasks (e.g. open Google Drive file list) |
| Microsoft account / **Microsoft 365 Developer tenant** (not the employer tenant) | Entra login via manual setup mode; light read-only tasks |
| Employer tenant (name withheld for public release) or internal apps | **only with written IT/security approval**; otherwise out of scope |

**Out of the automated matrix in MVP:** LinkedIn, Instagram, Facebook, X and any site whose ToS prohibits automation. COMPATIBILITY rows C12/C13 are marked **"Not tested: ToS restricts automation"**. If the owner later wants evidence there: at most a few manual, human-supervised, read-only sessions on their own account, never scraping third-party data, accepting the ban risk personally.

**Best practices (mandatory for P11-01 runs):**
1. One Browser-OS profile per site (`bos profile create rs-<site>`), never shared, never the user's daily browser.
2. Dedicated test accounts. Never a main personal account for write actions. Never an employer account without approval.
3. Credentials only via manual setup mode or `--secret` env vars. Nothing in the repo, task files or results.
4. Headful, manual start, `--i-understand-tos`, ≥ 2 s between actions, ≤ 30 actions per site per day.
5. Read-only scenarios first. Write actions only on Tier 1/2 or your own test repo.
6. Any CAPTCHA, MFA or unusual-activity prompt → stop the run, resolve it by hand, and record it as a finding. Never retry aggressively.
7. Record the date, Chrome version, Browser-OS commit and per-step tiers using the COMPATIBILITY.md §3 template.
8. Re-verify that each Tier 1 site is still online and still allows automation before each campaign (public demo sites change).

## Consequences
Positive: real-world coverage of every MVP site class except ToS-restricted social sites; Tier 1–2 are reproducible; MFA/SSO is tested against a real IdP without risking real accounts.
Negative: there are no LinkedIn/Instagram claims in MVP marketing or reports.
Follow-ups: P11-08 (self-hosted stack), P11-01 task files for Tier 1, COMPATIBILITY.md updated.

## Revisit when
A ToS-restricted platform offers an official automation/API permission, or the owner obtains written permission from the employer for internal-app testing.

## References
COMPATIBILITY.md; SECURITY.md §7; task P11-01, P11-08.
