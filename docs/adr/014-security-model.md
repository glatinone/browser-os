# ADR-014: Security Model

Status: Accepted (2026-10-02)

## Context

Browser-OS acts inside logged-in browser profiles (email, enterprise SSO, social accounts) on behalf of AI agents that read untrusted web content. Prompt injection against browser agents is an active attack class in 2026. Mistakes are irreversible (payments, deletions, permission changes). Comparable projects show gaps: BrowserSkill's local WebSocket accepts any client with an extension-shaped Origin header; Steel's issue #347 leaked cookies across sessions; several projects ship stealth/fingerprint evasion.

Full details live in `SECURITY.md`. This ADR records the binding principles.

## Options considered

| Area | Options | Choice |
|---|---|---|
| Local IPC | none / Origin check / **token + Origin rejection** | token + reject any `Origin` header |
| Credentials | let model see/type them / **ValueSource refs resolved at execution** | refs |
| Page content | trust / LLM judge / **untrusted data + code-enforced constraints** | code-enforced |
| Risky actions | auto / LLM decides / **rule-based risk + policy + human confirm** | rule-based |
| Security challenges | solve/bypass / **pause for human** | human |
| Bot detection | stealth/evasion / **honest automation** | honest |

## Decision

1. **Local-only, authenticated control plane:** daemon binds `127.0.0.1`; bearer token from an owner-only file (`daemon.token`, constant-time compare); WebSocket upgrades carrying an `Origin` header are rejected (blocks web pages / CSWSH).
2. **Profile isolation:** only Browser-OS-owned profiles under `<BOS_HOME>/profiles/<name>`; never the default user-data-dir; launch over pipe, no TCP debug port (ADR-003).
3. **Secrets:** typed values come from `ValueSource` (`literal` / `param` / `secret`). `secret` values are resolved only at execution, held in memory for the call/task, and **never** written to SQLite, logs, traces, events or prompts. Password/sensitive field values are masked (`••••`) in observations. Sensitive-literal guard while recording. Cookies, tokens and storage are never extracted or exposed.
4. **Model context boundary:** page content is untrusted data, framed as such in prompts; the model only chooses a `ref` from the candidates it was shown (zod-validated); model output never becomes selectors, URLs, code or new actions.
5. **Risk + permissions:** rule-based `RiskClassifier` (action type, element name/role keywords such as delete/pay/transfer/permissions, URL, site policy) → `low`/`medium`/`high`; default policy `low: allow, medium: allow, high: confirm`; per-site `deny`; confirmation pauses the session until a human decides. Cached trajectories are re-classified at replay.
6. **Human-in-the-loop for security challenges:** login walls, CAPTCHA, MFA, passkeys and OAuth consent → `WAITING_FOR_HUMAN`. Browser-OS never fills password/OTP/CAPTCHA fields itself in MVP. Logins are done by the human in manual setup mode.
7. **No automation hiding:** keep Playwright defaults including `--enable-automation`; forbidden: removing it, `AutomationControlled` tweaks, UA spoofing, stealth plugins, fingerprint injection. Sites that refuse automation are respected.
8. **Uploads/downloads** restricted by policy (allowed dirs; downloads off by default).
9. **Audit log** of actions, permissions, human interventions and navigations, masked, retained `retentionDays`.

## Consequences

Positive: a credible safety story for enterprise users; injection cannot escalate beyond choosing among visible elements for an action the caller requested.
Negative: more human interruptions (logins, high-risk confirmations); some sites block automated sessions.
Follow-ups: P8-04 token + ACL, P9-01…P9-07 security tasks, canary secret test.

## Revisit when

- Remote mode (P13-08) → requires TLS + paired device tokens (design in SECURITY.md).
- Users request automated login with stored credentials → new ADR (never MFA/CAPTCHA automation).

## References

- `SECURITY.md`, `specs/protocol.md` §2–3, `specs/dom-intelligence.md` §9, `specs/action-router.md` §4–5
- ADR-003, ADR-005 (BrowserSkill auth gap), ADR-007 (Steel #347)
- https://michaellivs.com/blog/state-of-browser-use-2026/ (prompt injection as active attack)
