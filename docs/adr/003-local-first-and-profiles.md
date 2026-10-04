# ADR-003: Local-First Architecture and Browser Profile Strategy

Status: Accepted (2026-10-02)

## Context

The historical documents wanted Browser-OS to "attach to the user's existing, logged-in Chrome". Research shows:

- **Chrome 136+** ignores `--remote-debugging-port` / `--remote-debugging-pipe` on the **default** user-data-dir (it uses a different encryption key; motivated by infostealers stealing cookies over CDP). Edge behaves the same. A non-default `--user-data-dir` is required.
- Playwright docs: "Automating the default Chrome user profile is not supported." One Chrome process per user-data-dir.
- **Chrome 144+** offers a user-consented path into the real profile: `chrome://inspect/#remote-debugging` plus an **Allow** dialog per connection. Playwright support was fixed around 1.60 (issue #40027) but is unverified for us.
- Any open TCP debugging port on loopback can be used by any local process to read cookies of that profile. That is exactly the infostealer vector Chrome closed for the default profile.
- Identity providers (Google, Microsoft) may refuse sign-in in automated browsers.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Attach to the user's daily profile via debug port | "Just works" with existing logins | Blocked by Chrome 136+; most sensitive profile; unsafe |
| Chrome 144+ consent attach | Real profile, user-consented, no extension | Allow dialog on every connection; Playwright support unverified; Chrome-version dependent |
| MV3 extension (BrowserSkill model) | Real profile, works on older Chrome | Extension dev + store/side-load; chrome.debugger infobar and domain limits; more moving parts |
| **Browser-OS-owned persistent profiles, launched over pipe** | Allowed by Chrome; isolated from the daily profile; no TCP port exposed; highest Playwright fidelity | User must log in once per profile; browser lifetime tied to daemon |
| Launch owned profile with TCP debug port | Reattach after daemon restart; interop | Local processes can attach and read cookies |
| Cloud-first browsers (Steel/Browserbase style) | Scale | Contradicts local-first; credentials leave the machine |

## Decision

- **Local-first:** one daemon per user (`BOS_HOME`), loopback only. Cloud/remote is post-MVP (P13-08).
- **Profiles are Browser-OS-owned** directories at `<BOS_HOME>/profiles/<name>`. `ProfileManager` rejects any path outside that folder. Browser-OS never touches the user's default Chrome/Edge user-data-dir (CODING_AGENT rule 18).
- **Manual setup mode** `bos profile open <name>` launches the real browser executable with `--user-data-dir` and **no automation** (no CDP, no Playwright, no `--enable-automation`). The human logs in, completes MFA or passkeys, installs extensions, then closes the window. Automated sessions reuse the cookies. This is the supported authentication path.
- **LaunchProvider** uses Playwright `launchPersistentContext` over a **pipe**. No TCP debugging port is opened. Trade-off accepted: browser lifetime = daemon lifetime, so there is no reattach after a daemon restart (cookies persist on disk; a restart is a cold launch, still logged in).
- `CdpEndpointProvider` (loopback endpoints only) exists for tests and power users who start Chrome themselves.
- Access to the user's **real daily browser** is deferred to `ChromeConsentProvider` (P13-01, evaluated first) or `ExtensionProvider` (P13-04, ADR-013).

## Consequences

Positive:
- Works on current Chrome without fighting browser security.
- A compromise of a Browser-OS profile does not expose the user's daily profile.
- No exposed CDP port → local malware cannot trivially hijack logged-in sessions.

Negative:
- One-time login per profile per site.
- No warm reattach after daemon restarts.
- Extensions installed in the daily profile are not available unless installed in the owned profile.

Follow-ups:
- P2-02 profile directory management and lock detection; P2-06 manual setup launcher; P13-01 consent attach.

## Revisit when

- Users routinely need daily-profile access (→ prioritize P13-01/P13-04).
- Daemon restarts become frequent enough that cold launches show up in benchmarks (→ consider an opt-in TCP-port mode with explicit security warning).

## References

- https://developer.chrome.com/blog/remote-debugging-port
- https://github.com/microsoft/playwright/issues/40027, https://playwright.dev/agent-cli/commands/attach
- `specs/browser-runtime.md` §1–3, `specs/memory.md` §2, `SECURITY.md`
