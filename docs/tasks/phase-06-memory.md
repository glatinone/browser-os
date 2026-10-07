# Phase 6: Memory (`packages/memory`)

Read first: `docs/specs/memory.md` (entire), ADR-004, ADR-011.
Runtime dependency added in this phase: `better-sqlite3` (in `packages/memory` only).
**Rule:** no SQL outside this package. Stores accept and return `protocol` types.

---

## P6-01 · Store, migrations, schema 001

| Field | Value |
|---|---|
| depends_on | P1-02 |
| supervision | cheap-ok |
| size | S |
| spec | memory §3 |

**Files:** `packages/memory/src/store.ts`, `src/migrate.ts`, `migrations/001_init.sql` (exact DDL from the spec), `test/store.test.ts`.

**Requirements**
1. `openStore(path | ':memory:') → Store` sets the pragmas, runs migrations in a transaction, and exposes the store objects (added in later tasks) plus `close()`.
2. The migration runner reads `migrations/*.sql` sorted by numeric prefix and records them in `schema_migrations`. Idempotent.
3. Ship the `.sql` files with the package build (copy them into `dist/migrations`, or embed them as TS strings via a generated `migrations.ts`; pick embedding to avoid file-path issues and note it).

**Tests:** fresh DB has all tables; reopening doesn't re-run; pragmas set (`PRAGMA journal_mode` = `wal` on a temp file).

**Implementation notes**
`openStore(path)` in `packages/memory/src/store.ts` loads `better-sqlite3`, sets `foreign_keys`,
`busy_timeout`, `synchronous`, and WAL for file paths, then runs `runMigrations` from
`src/migrate.ts`. Migrations stay as `.sql` files under `migrations/` and are read at open time
(the runner sorts by numeric prefix and records each in `schema_migrations`, so reopening is a
no-op). `001_init.sql` ships the full schema (profiles, sessions, action_cache, trajectories,
trajectory_versions, tasks, action_runs, audit_log).

---

## P6-02 · Keys and normalization

| Field | Value |
|---|---|
| depends_on | P1-02 |
| supervision | cheap-ok |
| size | S |
| spec | memory §4 |

**Files:** `packages/memory/src/keys.ts`, `test/keys.test.ts`.

**Requirements:** `pathTemplate(url, paramValues)`, `normalizeIntent(text, params: Record<string,string>)`, `cacheKey(...)`, `siteKey(...)` (sha256 via `node:crypto`), and `urlMatches(template, actualTemplate)` (exact equality, plus `/**` suffix prefix-matching).

**Tests:** all examples in the spec plus edge cases (root path, encoded segments, param substitution in intent and path, query/hash ignored, truncation).

**Acceptance criteria**
- [x] 100% branch coverage

**Implementation notes**
`packages/memory/src/keys.ts` implements §4 exactly: `pathTemplate` masks digits, UUIDs, hex runs
≥8, alnum segments ≥6, and current param values, caps at 6 segments then `/**`; `normalizeIntent`
lowercases, substitutes `{param}`, strips punctuation, drops articles a/an/the;
`cacheKey`/`siteKey` are sha256 over newline-joined parts (siteKey uses the `*` path slot, so
`siteKey === cacheKey(pathTemplate:'*')`); `urlMatches` accepts exact or `/**` prefix on a
segment boundary. Tests in `test/keys.test.ts` cover every spec example plus edge cases.

---

## P6-03 · Profile, session and task stores

| Field | Value |
|---|---|
| depends_on | P6-01 |
| supervision | cheap-ok |
| size | S |
| spec | memory §3, §7 |

**Files:** `packages/memory/src/stores/profile-store.ts`, `session-store.ts`, `task-store.ts`, tests.

**Requirements**
- `ProfileStore`: `create`, `getByName`, `getById`, `list`, `delete`, `touch(lastUsedAt)`.
- `SessionStore`: `upsert(Session)`, `get`, `listLive`, `markAllLiveClosed(now)` (used at daemon start).
- `TaskStore`: `insert(Task)`, `update(Task)`, `get`, `list({ key?, limit })`.

Prepared statements, and JSON columns (de)serialized inside the store.

**Tests:** round trips; unique profile name → `INVALID_REQUEST`; `markAllLiveClosed`.

**Implementation notes**
`src/stores/profile-store.ts`, `session-store.ts`, `task-store.ts` all map onto the tables that
`001_init.sql` already defines (no new migrations): profiles generate a UUID id and enforce name
uniqueness in the store, sessions upsert reactivates a closed row (`closed_at` clears) and
`markAllLiveClosed` closes everything open for the daemon-start hook, tasks serialize
`params`/`secret_names`/`stats` into their `*_json` columns inside the store and hydrate on read.
Generated task ids carry a random suffix so inserts in the same millisecond never collide.
Tests: `test/profile-store.test.ts`, `test/session-store.test.ts`, `test/task-store.test.ts`.

---

## P6-04 · Action cache store

| Field | Value |
|---|---|
| depends_on | P6-01, P6-02 |
| supervision | cheap-ok |
| size | S |
| spec | memory §5 |

**Files:** `packages/memory/src/stores/action-cache-store.ts`, test.

**Requirements**
1. `get({ origin, pathTemplate, actionType, intent })` → active entry by `cacheKey`, else by `siteKey`, else null.
2. `put({ origin, pathTemplate, actionType, intent, locator })` upserts both keys (status active, counters reset).
3. `recordHit(key)`, `recordMiss(key)` (→ invalid at `consecutive_misses ≥ 3`), `invalidate(key, reason)`.
4. `list({ origin? })`, `clear({ origin? }) → deleted`.

**Tests:** every transition in memory §5; site-key fallback; invalid entries skipped.

**Acceptance criteria**
- [x] L10 micro bench (P10-02) target achievable: `get` is one indexed lookup per key

**Implementation notes**
`src/stores/action-cache-store.ts` implements the §5 lifecycle. `get` does at most two PRIMARY
KEY lookups (cacheKey, then the siteKey fallback) and skips `status='invalid'` rows; `put` writes
both rows with one upsert each and resets counters; `recordHit` bumps hits and zeroes
`consecutive_misses`; `recordMiss` increments and invalidates at `MISS_LIMIT = 3`;
`invalidate` retires a row immediately for false hits; `list`/`clear` support `--origin`.
Tests in `test/action-cache-store.test.ts` cover every transition in §5 including the
exact→site fallback chain after invalidation.

---

## P6-05 · Trajectory store

| Field | Value |
|---|---|
| depends_on | P6-01 |
| supervision | cheap-ok |
| size | M |
| spec | memory §3, §6 |

**Files:** `packages/memory/src/stores/trajectory-store.ts`, test.

**Requirements**
1. `getLive(taskKey)` (status active or suspect), `getById`, `list`, `delete(taskKey)`, `invalidate(taskKey)` (live → invalid; used when a new recording replaces it, integration §10).
2. `createRecorded({ taskKey, origin, params, secretNames, steps })` → v1 + `trajectory_versions` row (`recorded`). An existing **invalid** row for the key stays. An existing **live** row → `INVALID_REQUEST` (the caller must delete or invalidate it first; the TaskManager handles replacement).
3. `recordRun(id, { success, healed?: { index, locator }[] })` applies the memory §6.2 rules (stats, status transitions, healed → new version + versions row) in one transaction.
4. `exportJson(taskKey)` (no secrets exist by construction) and `importJson(json)` (zod-validated, becomes v1 `active`).

**Tests:** live-key uniqueness; success/failure/heal transitions; suspect → invalid after 2 consecutive failures; version history; export/import round trip.

**Implementation notes**
`src/stores/trajectory-store.ts` reads and writes the `trajectories` / `trajectory_versions` pair.
`getLive` matches `status != 'invalid'` (the partial unique index on `task_key` guarantees at most
one live row per key), and `createRecorded` rejects a key that still has one with
`INVALID_REQUEST` while leaving earlier `invalid` rows as history. `recordRun` applies §6.2 in a
single transaction: success bumps counters, zeroes `consecutive_failures`, restores `active`, and
folds `healed` locators into `steps_json` with `version++` plus a `healed` versions row; failure
moves the trajectory to `suspect` after 1 and `invalid` after 2. `invalidate` is the
TaskManager's pre-replacement hook (integration §10); `delete` removes rows *and* their version
history inside one transaction, because `foreign_keys = ON` would otherwise reject it.
`exportJson` returns the `Trajectory` as JSON (secret *names* only, safe by construction) and
`importJson` validates against `TrajectorySchema`, then lands a fresh version 1 `active` row
(reusing the exported id when it is free, so copies between databases never collide).
**Migration 002** adds `trajectories.start_url`: the `Trajectory.startUrl` field the replayer
needs (integration §10) postdates schema 001, and `store.test.ts` now asserts against the number
of shipped migration files rather than a hardcoded count.

---

## P6-06 · Run log, audit log, stats, retention

| Field | Value |
|---|---|
| depends_on | P6-01 |
| supervision | cheap-ok |
| size | S |
| spec | memory §3; action-router §8 |

**Files:** `packages/memory/src/stores/run-store.ts`, `audit-store.ts`, `src/stats.ts`, tests.

**Requirements**
1. `RunStore.insert(ActionResult + context)` writes the `action_runs` row (attempts JSON).
2. `AuditStore.insert({ kind, sessionId, taskId, origin, risk, summary })`: `summary` must be passed in already masked; the store asserts no key named `value`/`secret` holds a non-masked string (defensive check, throws `INTERNAL`).
3. `stats({ since, origin?, taskKey? })` → tier distribution, cache hit rate, false-hit count, LLM calls per action, tokens per action, p50/p95 latency per tier (percentiles computed in JS from the selected rows), escalation rate.
4. `prune(olderThanMs)` for both logs.

**Tests:** stats on a synthetic dataset with known answers; prune; audit defensive check.

**Implementation notes**
`src/stores/run-store.ts` writes one `action_runs` row per action (`insert(ctx, result)`, deriving
`action_type`/`tier`/`ok`/`error_code`/`llm` fields from `ActionResult` and parking the per-tier
breakdown in `attempts_json`). `src/stores/audit-store.ts` writes `audit_log` and refuses any
summary carrying an unmasked string under a `value`/`secret` key, walking nested objects and
arrays and throwing `INTERNAL` before a row exists; masked, empty, non-string and reference
values pass. `src/stats.ts` is the §8 metric table: tier distribution (shares over *resolved*
actions), cache hit rate (hits / actions that consulted the cache tier), false-hit rate
(cache resolutions that ended in `VERIFICATION_FAILED` or a human correction), LLM calls and
tokens per action, p50/p95 per tier from `attempts[].ms` (nearest-rank, computed in JS over the
selected rows), and escalation rate (actions whose attempts span more than one distinct tier).
`since`/`origin`/`taskKey` filter in SQL (`taskKey` joins `tasks`). Both logs expose
`prune(olderThanMs)` for the daemon-start retention sweep (memory §3, default 30 days).
`stats.test.ts` pins every metric against a five-row fixture whose answers were computed by hand.
