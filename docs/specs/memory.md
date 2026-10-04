# Spec: Memory: Action Cache, Trajectories, Persistence (`packages/memory`, `packages/runtime/src/tasks`)

**Status:** Authoritative for MVP · **Owner packages:** `@browser-os/memory` (storage), `@browser-os/runtime` (recorder/replayer)
**Related:** ADR-004 (SQLite), ADR-011 (trajectory memory), `specs/action-router.md`

---

## 1. Memory layers

| Layer | Lifetime | Where | Contents (MVP) |
|---|---|---|---|
| **Ephemeral task memory** | one action / one task | process memory | `ExecutionContext`, latest `Observation` + `ObservationIndex` per page, tier attempts, recorder buffer |
| **Session memory** | one browser session | process memory + `sessions` table | session ↔ profile ↔ browser pid/port, page registry, page epochs |
| **Workflow memory** | until invalidated | `trajectories` (+ `trajectory_versions`) | task key → parameterized step list with locators |
| **Site memory** | until invalidated | `action_cache` | (origin, path template, action type, intent) → locator |
| **Global memory** | n/a | **not in MVP** | Cross-site generalization ("search boxes usually look like…") is future work and needs evidence first |

**No vector database. No embeddings.** Lookup is by exact normalized keys. Semantic similarity for task matching would only be considered after benchmarks show exact keys miss too often (ADR-011).

Browser state (cookies, localStorage, IndexedDB) lives **only** in the Chrome profile directory managed by Chrome. Browser-OS never copies it into SQLite.

---

## 2. Data directory

`BOS_HOME` env var, else:
- Windows: `%LOCALAPPDATA%\browser-os`
- macOS: `~/Library/Application Support/browser-os`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/browser-os`

```
<BOS_HOME>/
├── browser-os.db          SQLite (WAL)
├── config.json            user config (specs/protocol.md §6)
├── daemon.json            { pid, port, startedAt, version }   (no secrets)
├── daemon.token           random 32-byte token, hex; file mode 0600 (Windows: ACL current user only)
├── profiles/<name>/       Chrome user-data-dirs (owned by Chrome)
├── traces/<taskId>.jsonl  optional per-task event traces (masked)
├── downloads/
└── logs/daemon.log
```

`packages/protocol/src/paths.ts` exports `resolveBosHome(env, platform, homedir)` (pure, unit-tested for all three OSes). It lives in `protocol` because the daemon, CLI, SDK, browser and memory packages all need it.

---

## 3. SQLite schema (migration `001_init.sql`)

Opened by `openStore(dbPath)` with `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA synchronous=NORMAL;`. Migrations live in `packages/memory/migrations/NNN_name.sql` and run in order inside a transaction. Applied versions are stored in `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`.

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('chrome','msedge','chromium')),
  user_data_dir TEXT NOT NULL,
  headless INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  status TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK (ownership IN ('launched','attached')),
  browser_pid INTEGER,
  cdp_port INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX sessions_profile ON sessions(profile_id) WHERE closed_at IS NULL;

CREATE TABLE action_cache (
  key TEXT PRIMARY KEY,                 -- sha256 hex, see §4.2
  origin TEXT NOT NULL,
  path_template TEXT NOT NULL,          -- '*' for site-wide entries
  action_type TEXT NOT NULL,
  intent TEXT NOT NULL,                 -- normalized
  locator_json TEXT NOT NULL,           -- ElementLocator
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  consecutive_misses INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_hit_at INTEGER
);
CREATE INDEX action_cache_origin ON action_cache(origin);

CREATE TABLE trajectories (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  version INTEGER NOT NULL,
  params_json TEXT NOT NULL,            -- string[]
  secret_names_json TEXT NOT NULL,      -- string[]
  steps_json TEXT NOT NULL,             -- TrajectoryStep[]
  status TEXT NOT NULL CHECK (status IN ('active','suspect','invalid')),
  runs INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX trajectories_live_key ON trajectories(task_key) WHERE status != 'invalid';

CREATE TABLE trajectory_versions (
  trajectory_id TEXT NOT NULL REFERENCES trajectories(id),
  version INTEGER NOT NULL,
  steps_json TEXT NOT NULL,
  reason TEXT NOT NULL,                 -- 'recorded' | 'healed'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (trajectory_id, version)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  resolved_mode TEXT,                   -- 'record' | 'replay' after 'auto' is decided
  params_json TEXT NOT NULL,
  secret_names_json TEXT NOT NULL,
  status TEXT NOT NULL,
  trajectory_id TEXT,
  stats_json TEXT NOT NULL,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX tasks_key ON tasks(key, started_at);

CREATE TABLE action_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  origin TEXT NOT NULL,
  action_type TEXT NOT NULL,
  tier TEXT,
  driver TEXT,
  ok INTEGER NOT NULL,
  error_code TEXT,
  ms INTEGER NOT NULL,
  llm_calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  attempts_json TEXT NOT NULL
);
CREATE INDEX action_runs_ts ON action_runs(ts);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- 'action' | 'permission' | 'human' | 'session' | 'navigation'
  session_id TEXT,
  task_id TEXT,
  origin TEXT,
  risk TEXT,
  summary_json TEXT NOT NULL            -- masked; never contains values of sensitive fields or secrets
);
CREATE INDEX audit_ts ON audit_log(ts);
```

Retention: at daemon start, delete `action_runs` and `audit_log` rows older than `config.retentionDays` (default 30). Cache and trajectories have no TTL (validation-based invalidation, §5).

Store API (`packages/memory/src/`): `ProfileStore`, `SessionStore`, `ActionCacheStore`, `TrajectoryStore`, `TaskStore`, `RunStore`, `AuditStore`. All are synchronous (better-sqlite3) behind small classes with prepared statements. The `protocol` types are the inputs and outputs, and JSON columns are (de)serialized inside the store. **No SQL outside `packages/memory`.**

---

## 4. Keys and normalization (`packages/memory/src/keys.ts`, pure)

### 4.1 `pathTemplate(url, paramValues): string`

1. Take `pathname` only (drop query and hash). Lowercase. Strip trailing `/` (except root).
2. Split by `/`. Replace a segment with `*` if any:
   - only digits
   - UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-/i`)
   - hex run ≥ 8 chars
   - length ≥ 6 and contains both letters and digits
   - equals (case-insensitive, URL-decoded) a current task param value
3. Keep at most 6 segments, then append `/**` if truncated.

Examples: `/in/john-smith-a1b2c3/` → `/in/*`; `/search/results/people/` → `/search/results/people`; `/orders/12345/invoice` → `/orders/*/invoice`.

### 4.2 Cache key

```
normalizeIntent(text, paramValues):
  lowercase → replace each param value occurrence with "{<paramName>}" → strip punctuation except {}
  → remove articles (a, an, the) → collapse whitespace → trim
cacheKey = sha256(`${origin}\n${pathTemplate}\n${actionType}\n${normalizedIntent}`)
siteKey  = sha256(`${origin}\n*\n${actionType}\n${normalizedIntent}`)
```

Lookup order: `cacheKey`, then `siteKey`. On a successful non-cache resolution, write **both** entries (same locator). Validation (§5) protects against a site-wide entry that is wrong for a specific page.

---

## 5. Action cache lifecycle

```
            resolve via deterministic / llm / human(ref)
                          │
                          ▼
   ┌──────────── put(cacheKey & siteKey, locator) ─────────────┐
   │                                                           │
   ▼                                                           │
 ACTIVE ── cache tier resolves + action verified ──► hits++, consecutive_misses=0, last_hit_at
   │
   ├── cache tier cannot resolve (probe+match fail) ──► misses++, consecutive_misses++
   │        └── consecutive_misses ≥ 3 ──► INVALID
   │
   ├── resolved by cache but VERIFICATION_FAILED or human corrected ──► INVALID immediately (false hit)
   │
   └── later successful resolution by another tier ──► locator overwritten, status ACTIVE, counters reset
```

`INVALID` entries are skipped on lookup and overwritten on the next successful write. `bos cache clear [--origin <o>]` deletes rows.

---

## 6. Trajectory recording (`packages/runtime/src/tasks/recorder.ts`)

A task scope is opened by `task.start({ key, mode, params, secretNames })` and closed by `task.end({ success })`.

Mode resolution for `auto`: if a trajectory with `task_key = key` and `status IN ('active','suspect')` exists → `replay`, else `record`.

### 6.1 In record mode

For each **successful** `ActionResult` executed with `ctx.taskId = task.id`, the recorder appends a `TrajectoryStep`:

| Field | Rule |
|---|---|
| `action.target` | `{kind:'locator', locator: result.locator}`; if the step was done manually by a human (router §5.3 `done`) → `{kind:'intent', text}` |
| `action.value` (fill/select) | `param` and `secret` refs are kept as-is. A `literal` equal to a param value becomes `{kind:'param', name}`. Other literals are kept **only if the target is not a sensitive field**. |
| `navigate.url` | param values in the URL are replaced with `{{paramName}}` placeholders |
| `intent` | the original `{kind:'intent'}` text if the caller used one; for `ref`/`query` targets → `"<role> \"<name>\""` of the resolved element |
| `pre.urlPattern` | `pathTemplate(urlBefore)` |
| `post.urlPattern` | `pathTemplate(urlAfter)` if `pageChanged` |
| `risk` | risk level computed by the router |

**Sensitive literal guard:** in a recording task, a `fill` with a `literal` value into a sensitive field (dom-intelligence §6.1 `isSensitiveField`) is rejected **before execution** with `INVALID_REQUEST` ("use a secret reference for sensitive fields while recording"). Nothing sensitive can enter a trajectory by accident.

Failed actions are not recorded (callers may retry differently). Compaction at `task.end`: consecutive `fill`s on the same locator keep only the last one, and `wait` steps immediately followed by a `waitFor` are dropped.

On `task.end({ success: true })`: persist a new trajectory (`version = 1`, `status = 'active'`) and a `trajectory_versions` row (`reason = 'recorded'`). An existing trajectory with the same key and `status = 'invalid'` is kept for history and the new one becomes the live one. On `success: false` the buffer is discarded.

`origin` = origin of the page where the first step executed.

### 6.2 Replay (`packages/runtime/src/tasks/replayer.ts`)

```text
replay(task, trajectory, ctx):
  require all trajectory.params present in task.params and all secretNames resolvable, else fail INVALID_REQUEST
  healed = []
  for step in trajectory.steps:
      action = substitute(step.action, task.params)            # {{param}} in urls, param refs in values
      if !urlMatches(pathTemplate(currentUrl), step.pre.urlPattern):
          waitForUrl(step.pre.urlPattern, timeout = probeTimeoutMs)   # SPA route changes
          if still no match: fail TRAJECTORY_STEP_FAILED { step, reason: 'precondition' }
      result = router.execute(action, ctx, { healIntent: step.intent })   # action-router §5.4
      if !result.ok: fail TRAJECTORY_STEP_FAILED { step, cause: result.error }
      if result.tier != 'cache' and step has a locator target:
          healed.push({ index: step.index, locator: result.locator })
  success
```

After the replay:
- **success:** `runs++`, `successes++`, `consecutive_failures = 0`, `last_success_at`, `status = 'active'`. If `healed` is non-empty: write the new locators into `steps_json`, `version++`, insert a `trajectory_versions` row (`reason = 'healed'`), emit `trajectory.healed` for each step.
- **failure:** `runs++`, `failures++`, `consecutive_failures++`; `status = 'suspect'` after 1 consecutive failure, `'invalid'` after 2. The task fails with the step error.

"Zero LLM calls on replay" holds when every step resolves at the cache tier. Healing may use the LLM tier within the task budget. That is intended: the site changed and the trajectory repairs itself.

### 6.3 Stale workflow recovery

| Situation | Behaviour |
|---|---|
| A few locators drifted (classes, order, counts changed) | fingerprint matching still resolves (cache tier) → no healing needed |
| A locator no longer matches but the intent still makes sense | healing via deterministic/LLM tier → step rewritten, version++ |
| Page flow changed (step precondition fails) | step fails → trajectory `suspect` → next failure `invalid` |
| Trajectory `invalid` | next `auto` run records again (the calling agent performs the steps again; Browser-OS does not plan in MVP) |
| Login wall / MFA appears mid-replay | challenge → human pause (not a trajectory failure if the human resolves it and the replay resumes) |

---

## 7. Task API summary (exposed via protocol)

| Method | Effect |
|---|---|
| `task.start({ sessionId, key, mode='auto', params, secretNames })` | returns `Task` (with `resolved_mode`) |
| `task.run({ sessionId, key, params, secretNames })` | start in replay mode, replay all steps, end. Fails `TRAJECTORY_NOT_FOUND` if none |
| `task.end({ taskId, success })` | close the scope; persist or discard the recording |
| `task.get`, `task.list` | history |
| `trajectory.list`, `trajectory.get`, `trajectory.delete`, `trajectory.export` (JSON with no secrets), `trajectory.import` | management |

---

## 8. Test requirements (summary)

- `keys.ts`: table-driven tests for `pathTemplate` and `normalizeIntent` (including param substitution).
- Stores: in-memory SQLite (`:memory:`) round trips for each table; migration idempotence; unique live trajectory per key.
- Cache lifecycle state machine: every transition in §5.
- Recorder: param substitution, sensitive-literal guard (rejected before execution), compaction, human-manual step representation.
- Replayer with fakes: all-cache replay makes zero model calls; healed step increments version; two consecutive failures → invalid; precondition mismatch fails the step.
- Secret invariant: after recording and replaying the `secret-field` fixture (API-token field) with a `secret` value, `grep` over the SQLite file bytes, traces and logs finds no secret value (test writes a unique canary secret).
