# Spec: Daemon Protocol, CLI, SDK, Config (`packages/protocol/src/rpc.ts`, `packages/daemon`, `packages/sdk`, `packages/cli`)

**Status:** Authoritative for MVP · **Related:** ADR-017 (daemon & protocol), `SECURITY.md` §4

---

## 1. Processes

```
 AI agent (Claude Code, Codex, custom TS code, ...)
   │  shell: `bos <cmd>`            or      TS: `import { connect } from '@browser-os/sdk'`
   ▼                                          │
 bos CLI (short-lived) ──── @browser-os/sdk ──┘
   │  JSON-RPC 2.0 over WebSocket, ws://127.0.0.1:<port>/rpc, token-authenticated
   ▼
 bos daemon (long-lived, one per user/BOS_HOME)
   │  runtime: sessions, router, memory, security, events
   │  Playwright pipe (no TCP port)
   ▼
 Chrome / Edge (Browser-OS profile)
```

- One daemon per `BOS_HOME`. `bos daemon start` refuses to start a second one if `daemon.json` points to a live pid that answers `system.hello`.
- The CLI auto-starts the daemon (detached) if none is running, unless `--no-autostart`.
- In-process use (tests, benchmarks, embedding) uses `createRuntime()` from `@browser-os/runtime` directly, with no daemon.

---

## 2. Transport and authentication

- Listen on `127.0.0.1` only, port from `config.daemon.port` (default `0` = OS-assigned). Write the actual port to `daemon.json`.
- Path `/rpc`. Any other path → HTTP 404.
- **Origin check:** reject the WebSocket upgrade with 403 if an `Origin` header is present (browsers always send one; CLI/SDK never do). This blocks cross-site WebSocket hijacking from web pages.
- **Token:** `daemon.token` (32 random bytes, hex) is created at first start with owner-only permissions (POSIX `0600`; Windows: ACL restricted to the current user via `icacls`, task P8-04). The client must send `Authorization: Bearer <token>` on the upgrade request. Missing or wrong → 401. Compare in constant time (`crypto.timingSafeEqual`).
- Max message size 8 MB. Idle connections are kept open (events).

---

## 3. Message format

JSON-RPC 2.0. Requests `{ jsonrpc: "2.0", id, method, params }`. Notifications from server: `{ jsonrpc: "2.0", method: "event", params: BosEvent }`.

Every request's `params` may include `protocolVersion: "1"`. The server rejects unknown major versions with `INVALID_REQUEST`.

Errors:

```json
{ "jsonrpc": "2.0", "id": 7, "error": { "code": -32000, "message": "Target not found", "data": { "bosCode": "TARGET_NOT_FOUND", "retryable": false, "details": {} } } }
```

JSON-RPC parse/validation errors use the standard codes (-32700, -32600, -32601, -32602) with `data.bosCode = 'INVALID_REQUEST'`.

`act` returns an `ActionResult` even when the action fails (`ok: false`). RPC-level errors are reserved for invalid requests, auth, unknown session and internal failures.

**Secrets in transit:** requests may carry `secretValues: Record<string,string>`. The daemon holds them in memory for the duration of that call or task only, never logs them (the request logger masks the field), and never persists them.

---

## 4. Methods (MVP)

All params and results are validated with zod schemas in `packages/protocol/src/rpc.ts`.

| Method | Params | Result |
|---|---|---|
| `system.hello` | `{ client: string, protocolVersion: "1" }` | `{ version, protocolVersion, pid }` |
| `system.shutdown` | `{}` | `{ ok: true }` (closes sessions gracefully) |
| `profile.create` | `{ name, channel? }` | `BrowserProfile` |
| `profile.list` | `{}` | `BrowserProfile[]` |
| `profile.delete` | `{ name, confirm: true }` | `{ ok }` (refuses if a session is live) |
| `profile.openManual` | `{ name }` | `{ pid }` (manual setup mode, browser-runtime §1.1) |
| `session.open` | `{ profile, provider?, headless?, cdpEndpoint? }` | `Session` |
| `session.list` / `session.get` / `session.close` / `session.reconnect` | `{ sessionId? }` | `Session[]` / `Session` / `{ok}` / `Session` |
| `page.list` / `page.new` / `page.select` / `page.close` | `{ sessionId, pageId?, url? }` | `PageInfo[]` / `PageInfo` / `{ok}` / `{ok}` |
| `observe` | `{ sessionId, pageId?, includeText?, viewportOnly?, format?: 'json'\|'lines' }` | `Observation` or `{ observationId, lines: string }` |
| `act` | `{ sessionId, pageId?, action: BrowserAction, taskId?, secretValues? }` | `ActionResult` |
| `upload` | `{ sessionId, target: Target, paths: string[] }` | `ActionResult` |
| `task.start` | `{ sessionId, key, mode?, params?, secretNames? }` | `Task` |
| `task.end` | `{ taskId, success }` | `Task` |
| `task.run` | `{ sessionId, key, params?, secretNames?, secretValues? }` | `Task` (completed or failed, with stats) |
| `task.get` / `task.list` | `{ taskId }` / `{ key?, limit? }` | `Task` / `Task[]` |
| `trajectory.list` / `.get` / `.delete` / `.export` / `.import` | … | management (export contains no secrets) |
| `cache.list` / `cache.clear` | `{ origin? }` | entries / `{ deleted }` |
| `human.pending` | `{ sessionId? }` | pending human requests |
| `human.resume` | `{ sessionId, choice: 'ref'\|'done'\|'abort', ref?, observationId? }` | `{ ok }` |
| `permission.pending` | `{ sessionId? }` | `PermissionRequest[]` |
| `permission.decide` | `{ requestId, decision: 'approve'\|'reject' }` | `{ ok }` |
| `stats.get` | `{ since?, origin?, taskKey? }` | aggregated metrics (action-router §8) |
| `events.subscribe` | `{ sessionId?, types?: string[] }` | `{ subscriptionId }`, then `event` notifications |

---

## 5. CLI (`bos`)

Argument parsing with `node:util` `parseArgs`. No CLI framework. Every command supports `--json` (machine output) and `--session <id>` (default: the CLI's current session from `<BOS_HOME>/cli-state.json`, set by `session open`).

```
bos daemon start [--foreground] | stop | status
bos profile create <name> [--channel chrome|msedge|chromium]
bos profile list | rm <name> --yes | open <name>          # open = manual login/setup mode
bos session open [--profile default] [--headless] [--cdp <ws-or-http-url>]
bos session list | close [<id>] | reconnect [<id>]
bos page list | new [<url>] | select <pageId> | close <pageId>
bos observe [--text] [--viewport] [--json]
bos navigate <url>
bos click <target> [--right] [--double]
bos fill <target> (--value <v> | --param <name> | --secret <NAME>) [--submit]
bos press <key> [--target <target>]
bos select <target> (--value <v> | --param <name>)
bos hover <target>
bos scroll [<target>] [--up] [--px 600]
bos wait [--until load|domcontentloaded|settled] [--for <target>] [--timeout ms]
bos extract [<target>] [--format text|links|table]
bos upload <target> <file...>
bos task start <key> [--param k=v]... [--secret NAME]... [--mode auto|record|replay]
bos task end [--fail]
bos task run <key> [--param k=v]... [--secret NAME]...
bos task list [--key k]
bos trajectory list | show <key> | rm <key> --yes | export <key> [-o file] | import <file>
bos cache list [--origin o] | clear [--origin o]
bos human status | resume (--ref @e12 | --done | --abort)
bos permission list | approve <id> | reject <id>
bos stats [--since 24h] [--origin o] [--task k]
```

**Target syntax** (`<target>` argument → `Target`):
- `@e12` → `{kind:'ref', ref:'e12', observationId: <last observation id from cli-state>}`
- `role=button name="Sign in"` / `css=#submit` / `text="Next"` (space-separated `key=value` pairs) → `{kind:'query', ...}`
- anything else → `{kind:'intent', text}`

**Secrets:** `--secret NAME` reads `BOS_SECRET_<NAME>` from the CLI's environment and sends it in `secretValues`. If missing → error before contacting the daemon. Secret values are never printed.

**Current task:** `bos task start` stores the task id in `cli-state.json`; subsequent action commands attach `taskId` automatically until `bos task end`.

**Output:** human-readable by default (observe prints compact lines; act prints one line `ok tier=cache driver=cdp 42ms llm=0` or the error). `--json` prints the raw result object.

Exit codes: `0` ok, `1` action failed (`ok:false`), `2` usage error, `3` daemon unreachable/auth, `4` waiting for human/permission (with instructions printed).

---

## 6. Config (`<BOS_HOME>/config.json`, zod-validated, all fields optional)

```jsonc
{
  "defaultProfile": "default",
  "defaultChannel": "chrome",
  "daemon": { "port": 0 },
  "sessionIdleMinutes": 0,
  "retentionDays": 30,
  "models": {
    "fast":    { "provider": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "<small model id>", "apiKeyEnv": "OPENAI_API_KEY", "supportsJsonSchema": true },
    "capable": { "provider": "anthropic", "model": "<model id>", "apiKeyEnv": "ANTHROPIC_API_KEY" },
    "vision":  null
  },
  "policy": {
    "risk": { "low": "allow", "medium": "allow", "high": "confirm" },
    "sites": [ { "originPattern": "*.bank.example", "access": "deny" } ],
    "tiers": { "llm": true, "vision": false, "human": true },
    "budgets": { "maxLlmCallsPerAction": 2, "maxLlmCallsPerTask": 20, "maxRetriesPerAction": 2, "actionTimeoutMs": 15000, "humanTimeoutMs": 600000 },
    "uploads": { "allowedDirs": [] },
    "downloads": { "enabled": false, "dir": null }
  }
}
```

- API keys are **never** stored in config, only the env var name.
- No model configured → the llm tier is disabled (`LLM_DISABLED` in attempts), and everything else works.
- Local models: `openai-compatible` with `baseUrl: "http://localhost:11434/v1"` (Ollama), vLLM, LM Studio, llama.cpp server.

---

## 7. SDK (`@browser-os/sdk`)

Thin typed client over the protocol (uses `ws`). Reads `daemon.json` and `daemon.token` from `BOS_HOME`.

```ts
import { connect } from '@browser-os/sdk';

const bos = await connect();                        // autostart daemon unless { autostart: false }
const s = await bos.sessions.open({ profile: 'default' });
await s.navigate('https://www.linkedin.com/');
const obs = await s.observe();
await s.click({ kind: 'intent', text: 'the search box' });
await s.fill({ kind: 'intent', text: 'the search box' }, { kind: 'literal', value: 'John Smith' }, { submit: true });

// task recording / replay
const t = await s.tasks.start({ key: 'linkedin.search-people', params: { query: 'John Smith' } });
await s.click('the search box');                                         // string → CLI target syntax
await s.fill('the search box', { kind: 'param', name: 'query' }, { submit: true });
await t.end({ success: true });
const result = await s.tasks.run({ key: 'linkedin.search-people', params: { query: 'Jane Doe' } });
console.log(result.stats.llmCalls); // 0 on a clean replay

bos.on('event', (e) => { /* BosEvent */ });
```

Convenience methods (`click`, `fill`, `press`, …) build `BrowserAction`s and call `act`. A string target is treated by the SDK exactly like the CLI target syntax (§5).

---

## 8. Post-MVP surfaces (not in MVP, designed for)

- **MCP server** (`packages/mcp`): exposes `observe`, `act`, `task.*` as MCP tools over stdio. It is a thin SDK client and adds no runtime logic. First post-MVP item (ROADMAP Phase 13).
- Remote mode: same protocol over `wss://` with paired device tokens (SECURITY.md §4.3).
