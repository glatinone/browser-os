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
- [ ] 100% branch coverage

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
- [ ] L10 micro bench (P10-02) target achievable: `get` is one indexed lookup per key

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
