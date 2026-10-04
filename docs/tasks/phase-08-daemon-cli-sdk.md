# Phase 8: Daemon, SDK, CLI

Read first: `docs/specs/protocol.md` (entire), `docs/SECURITY.md` §4 and §8, ADR-017.
Runtime dependency added: `ws` (daemon, sdk).

---

## P8-01 · WebSocket server and JSON-RPC dispatcher

| Field | Value |
|---|---|
| depends_on | P1-03, P7-07 |
| supervision | cheap-ok (security review) |
| size | M |
| spec | protocol §2–3; SECURITY.md S5, S7 |

**Files:** `packages/daemon/src/server.ts`, `src/dispatch.ts`, `src/log.ts` (request logger with masking), tests `packages/daemon/test/server.test.ts`.

**Requirements**
1. `startServer({ api, auth, port, host: '127.0.0.1' })` uses `ws` `WebSocketServer({ noServer: true })` on a `node:http` server.
   - Path `/rpc`, else 404.
   - Upgrade with an `Origin` header → 403.
   - Auth is checked via the `auth.verify(header)` callback (implemented in P8-04; use an always-true stub until then, behind a test-only flag).
   - `maxPayload: 8 * 1024 * 1024` (S7).
2. Dispatcher: parse JSON (→ -32700), validate the envelope (→ -32600), unknown method (→ -32601), validate params with `RPC_METHODS[method].params` (→ -32602), call `api[method]`, validate the result in dev/test mode, and map errors with `toRpcError`.
3. Request logging: method, duration, ok/error code. **Never params.** `secretValues` must never be logged even at debug level (test with a canary).
4. Notifications: `send(event)` to subscribed connections (subscription filters are handled in P8-02).

**Tests:** real WS client: valid call; each JSON-RPC error class; Origin → 403; oversized message rejected; logger canary.

---

## P8-02 · Method handlers and event subscriptions

| Field | Value |
|---|---|
| depends_on | P8-01 |
| supervision | cheap-ok |
| size | S |
| spec | protocol §4 |

**Files:** `packages/daemon/src/handlers.ts`, `src/subscriptions.ts`, tests.

**Requirements:**
- Bind every method in protocol §4 to `RuntimeApi`.
- `system.hello` returns version, protocolVersion and pid.
- `system.shutdown` closes sessions and the server gracefully.
- `events.subscribe({ sessionId?, types? })` registers a filter per connection; it is removed on disconnect.
- `secretValues` from `act`/`task.run` become a `MapSecretResolver` scoped to that call or task and are dropped afterwards.

**Tests:** every method reachable (table test with a fake RuntimeApi); subscription filtering; secretValues not retained after the call (inspect the runtime's resolver registry).

---

## P8-03 · Daemon lifecycle

| Field | Value |
|---|---|
| depends_on | P8-02 |
| supervision | cheap-ok |
| size | S |
| spec | protocol §1; memory §2–3 (retention) |

**Files:** `packages/daemon/src/main.ts` (entry: `bos-daemon` bin), `src/lifecycle.ts`, tests.

**Requirements**
1. Resolve `BOS_HOME`, ensure the directories, and load the config.
2. Single instance: if `daemon.json` exists with a live pid that answers `system.hello` → exit with code 3 and a message. A stale file → overwrite.
3. `createRuntime`, then prune logs (retention), then start the server, then write `daemon.json` `{ pid, port, startedAt, version }`.
4. Log to `<BOS_HOME>/logs/daemon.log` (append, rotate at 10 MB, keep 3).
5. Graceful shutdown on SIGINT/SIGTERM/`system.shutdown`: close sessions, close the store, remove `daemon.json`.
6. `--foreground` flag (no detaching; the CLI handles detaching).

**Tests:** start/stop in a temp `BOS_HOME`; second instance refused; stale `daemon.json` replaced.

---

## P8-04 · Token authentication and file permissions

| Field | Value |
|---|---|
| depends_on | P8-01 |
| supervision | **expert** (security review) |
| size | S |
| spec | protocol §2; SECURITY.md §4.1, S5, S6 |

**Files:** `packages/daemon/src/auth.ts`, `src/file-permissions.ts`, tests.

**Requirements**
1. On first start, create `daemon.token` (32 random bytes, hex) atomically (write a temp file then rename).
2. Permissions:
   - POSIX: `chmod 0600`; verify at start and refuse to start if the mode is looser (S6).
   - Windows: run `icacls <file> /inheritance:r /grant:r "%USERNAME%:F"` via `child_process.execFile` (no shell); verify by parsing `icacls <file>` output (only the current user, SYSTEM and Administrators allowed). Refuse to start on failure, with an actionable message.
3. `verify(authorizationHeader)`: `Bearer <hex>`, compared with `crypto.timingSafeEqual` on equal-length buffers. Wrong length → false without comparing.
4. Replace the P8-01 stub.

**Tests:** missing/wrong/correct token (401/401/ok); lax permissions refused (POSIX); Windows ACL parsing unit test with sample `icacls` outputs; timing-safe compare is used (spy).

**Acceptance criteria**
- [ ] S5, S6 covered

---

## P8-05 · SDK client

| Field | Value |
|---|---|
| depends_on | P8-04 |
| supervision | cheap-ok |
| size | M |
| spec | protocol §7 |

**Files:** `packages/sdk/src/client.ts`, `src/session.ts`, `src/autostart.ts`, tests.

**Requirements**
1. `connect({ bosHome?, autostart = true, timeoutMs = 5000 })`: reads `daemon.json` and `daemon.token`, connects with the Bearer header, and calls `system.hello`. If unreachable and `autostart` is on: spawn `bos-daemon --foreground` detached (`stdio` → the daemon log file), poll `daemon.json` for up to 5 s, then connect.
2. A typed `call(method, params)` generic over `RPC_METHODS`.
3. The ergonomic `SessionClient` from the spec example (`navigate`, `observe`, `click`, `fill`, `press`, `select`, `hover`, `scroll`, `wait`, `extract`, `upload`, `tasks.start/end/run`). String targets go through `parseTargetString`.
4. `on('event', cb)` with automatic `events.subscribe`.
5. `ActionResult` with `ok: false` is returned, not thrown. RPC errors throw a `BosError` reconstructed from `data.bosCode`.

**Tests:** against a real daemon started in-process on a temp `BOS_HOME` with a fake runtime; autostart path with a stub spawn.

---

## P8-06 · CLI part 1: daemon, profile, session, page, observe, navigate

| Field | Value |
|---|---|
| depends_on | P8-05 |
| supervision | cheap-ok |
| size | M |
| spec | protocol §5 |

**Files:** `packages/cli/src/bin.ts`, `src/commands/*.ts`, `src/state.ts` (`cli-state.json`), `src/output.ts`, tests.

**Requirements:**
- `node:util` `parseArgs`. Commands `daemon start|stop|status`, `profile create|list|rm|open`, `session open|list|close|reconnect`, `page list|new|select|close`, `observe`, `navigate`.
- Human-readable output by default, `--json` for raw output.
- Exit codes per spec.
- `cli-state.json` stores `currentSessionId`, `lastObservationId` and `currentTaskId`.
- `daemon start` spawns the daemon detached unless `--foreground`.
- `profile open` calls `profile.openManual`.

**Tests:** argument parsing table; output formatting snapshots; state file handling; exit codes.

---

## P8-07 · CLI part 2: actions, tasks, trajectories, cache, human, permission, stats

| Field | Value |
|---|---|
| depends_on | P8-06 |
| supervision | cheap-ok |
| size | M |
| spec | protocol §5 |

**Files:** `packages/cli/src/commands/*.ts` (remaining), tests.

**Requirements:**
- All remaining commands in protocol §5.
- `--secret NAME` reads `BOS_SECRET_NAME` from the env (missing → exit 2 before connecting); secret values are never printed.
- Action output line format: `ok tier=<tier> driver=<driver> <ms>ms llm=<calls>`, or `fail <CODE>: <message>`.
- `task run` prints per-step lines and a summary.
- Exit code 4 with instructions when a human or a permission decision is pending (`bos human status`, `bos permission list`).

**Tests:** parsing; output snapshots; secret env handling (canary not printed).

---

## P8-08 · CLI e2e (Milestone M4)

| Field | Value |
|---|---|
| depends_on | P8-07 |
| supervision | cheap-ok |
| size | S |
| spec | TESTING.md (M4 row); PRD §7 |

**Files:** `tests/e2e/cli.e2e.test.ts`.

**Scenario:** temp `BOS_HOME` with a `config.json` that uses a `fake` model provider (add `provider: 'fake'` with a `truthFile` option to the registry if missing; test-only). Spawn the real `bos` binary for the PRD §7 sequence (session open headless → navigate → task start → fill/click → task end → task run → stats). Assert exit codes, `llm=0` on replay, and that `bos stats --json` shows cache hits.

**Acceptance criteria**
- [ ] Passes on linux CI; Windows run documented (manual) in the implementation notes
