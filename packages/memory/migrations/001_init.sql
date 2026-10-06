CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

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
  key TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  path_template TEXT NOT NULL,
  action_type TEXT NOT NULL,
  intent TEXT NOT NULL,
  locator_json TEXT NOT NULL,
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
  params_json TEXT NOT NULL,
  secret_names_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
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
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (trajectory_id, version)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  resolved_mode TEXT,
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
  kind TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  origin TEXT,
  risk TEXT,
  summary_json TEXT NOT NULL
);
CREATE INDEX audit_ts ON audit_log(ts);
