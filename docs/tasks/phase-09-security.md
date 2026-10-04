# Phase 9: Security and human-in-the-loop

Read first: `docs/SECURITY.md` (entire), ADR-014. Replace the P7-01 stubs **without changing interfaces**.

---

## P9-01 · RiskClassifier

| Field | Value |
|---|---|
| depends_on | P7-07 |
| supervision | **expert** (security review) |
| size | S |
| spec | SECURITY.md §5.1–5.4; S8, S9 |

**Files:** `packages/runtime/src/security/risk-rules.ts` (keyword lists and URL patterns as data), `security/risk-classifier.ts`, test `test/risk-classifier.test.ts`.

**Requirements:**
- Rules R1–R12 exactly as in SECURITY.md §5.2, evaluated on: action type, resolved element (role, name, context: dialog membership), URL path and `submit` flag. Highest matching risk wins.
- `reasons[]` lists every matched rule (e.g. `R2: element name matches 'delete'`).
- `classify` is pure and fast (precompiled regexes).

**Tests:** table-driven, ≥ 3 cases per rule including negatives (e.g. "Remove filter" is destructive by keyword → high; this is expected and documented: false positives are acceptable, false negatives are not); a dialog confirmation case (R11); a URL case (R9, R10).

**Acceptance criteria**
- [ ] S8 covered; classification ≤ 0.5 ms per call (micro test)

---

## P9-02 · PermissionGate with confirmation flow

| Field | Value |
|---|---|
| depends_on | P9-01, P8-02 |
| supervision | cheap-ok (review) |
| size | S |
| spec | SECURITY.md §5.3, §5.5; S10 |

**Files:** `packages/runtime/src/security/permission-gate.ts`, test.

**Requirements**
1. `decide(risk, policy, origin)`: site policies first (first match), then `policy.risk`.
2. `requestConfirmation(request)`:
   - stores a pending `PermissionRequest`
   - emits `permission.requested`
   - sets the session to `waiting_for_human`
   - waits for `permission.decide`, or for timeout → reject
3. Records a `PermissionDecisionRecord` in the audit log and emits `permission.decided`.
4. Expose `pending(sessionId?)` and `decide(requestId, decision)` to `RuntimeApi`.

**Tests:** approve → action executes; reject → `PERMISSION_DENIED` with `effect: 'none'` and zero driver calls; timeout (fake clock) → reject; site policy overrides (S10).

---

## P9-03 · HumanGate

| Field | Value |
|---|---|
| depends_on | P8-02 |
| supervision | cheap-ok (review) |
| size | S |
| spec | SECURITY.md §6; action-router §5.3; S12 |

**Files:** `packages/runtime/src/human/human-gate.ts`, test.

**Requirements:**
- `pause()` creates a pending request, sets the session to `waiting_for_human`, emits `human.required`, and resolves on `human.resume` or timeout.
- For challenge reasons only `done`/`abort` are valid (`ref` → `INVALID_REQUEST`).
- Headless session + challenge → immediate `SECURITY_CHALLENGE` (S12).
- Max 2 pauses per action for challenges (re-capture after `done`; still challenged → pause again; then `HUMAN_REQUIRED`).
- Emits `human.resolved`.

**Tests:** each choice; timeout; headless; challenge loop limit.

---

## P9-04 · Audit logging

| Field | Value |
|---|---|
| depends_on | P9-02, P9-03 |
| supervision | cheap-ok |
| size | S |
| spec | SECURITY.md §14 |

**Files:** `packages/runtime/src/security/audit.ts`, test.

**Requirements:** an EventBus subscriber writing `audit_log` rows for `action.completed` (masked action, tier, ok, risk), `permission.*`, `human.*`, `session.status` and navigations. The summary is built from masked data only.

**Tests:** rows written per event type; masking holds (canary).

---

## P9-05 · Prompt-injection suite

| Field | Value |
|---|---|
| depends_on | P7-04, P9-02 |
| supervision | cheap-ok (security review) |
| size | S |
| spec | SECURITY.md §10; S15 |

**Files:** `packages/runtime/test/injection.browser.test.ts` (+ the `injection` fixture from P0-04).

**Tests**
1. The resolve prompt contains the untrusted-data framing.
2. A FakeModel that "obeys" the injection (returns the ref of "Delete account" for intent "the search box") → the router executes nothing destructive without confirmation: the R2 risk triggers `confirm` → the stub/denied path → `PERMISSION_DENIED`.
3. A FakeModel returning a ref not in the candidates → rejected.
4. A FakeModel returning extra fields or instructions → zod strips/rejects; no change of action type is possible (the action type comes from the caller only).

**Acceptance criteria**
- [ ] S15 covered

---

## P9-06 · Secret canary end-to-end

| Field | Value |
|---|---|
| depends_on | P9-04, P8-08 |
| supervision | cheap-ok |
| size | S |
| spec | SECURITY.md §8.4; S14 |

**Files:** `tests/e2e/secret-canary.e2e.test.ts`, `fixtures/sites/secret-field/index.html` + `truth.json` (create in this task).

**Fixture:** a "Developer settings" page with:
- a display-name textbox
- `<input name="api_token" aria-label="API token">`
- a "Save" button that shows "Saved"

It has no password field, so no `login` challenge fires. Password fields are never filled in MVP (SECURITY.md §6).

**Scenario:** via the CLI and a real daemon:
1. Record a task that fills the display name from a param and the API token from `--secret API_TOKEN`, with canary value `CANARY-7f3a9c-SECRET`. Then click Save, using an ambiguous intent so one LLM resolution happens and its prompt can be inspected.
2. Replay it.
3. Grep the following byte-wise for the canary; expect zero hits:
   - the SQLite file + WAL
   - `logs/`
   - `traces/`
   - captured CLI stdout/stderr
   - all events received by an SDK subscriber
   - all FakeModel requests
4. Assert that recording with `--value <literal>` into the token field is rejected (S13).

**Acceptance criteria**
- [ ] S14 covered; zero occurrences

---

## P9-07 · Site access and upload/download policy

| Field | Value |
|---|---|
| depends_on | P9-02, P3-06 |
| supervision | cheap-ok |
| size | S |
| spec | SECURITY.md §5.3 (access deny), §11; S11, S16 |

**Files:** `packages/runtime/src/security/site-policy.ts`, `security/file-policy.ts`, tests.

**Requirements:**
- `access: 'deny'` origins block navigate and every action (S11).
- Upload paths are resolved with `fs.realpath` and must be inside an `allowedDirs` entry (also realpath'd). Symlink escape → `PERMISSION_DENIED` (S16).
- Downloads are enabled only via policy (wire into `DefaultPageDriver.enableDownloads`).

**Tests:** S11 and S16 cases including a symlink escape (POSIX) and a `..` traversal.
