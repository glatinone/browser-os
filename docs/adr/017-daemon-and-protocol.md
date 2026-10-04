# ADR-017: Daemon and Protocol

Status: Accepted (2026-10-02)

## Context

Agents (Claude Code, Codex, custom TS code) issue many separate commands against a persistent browser. Keeping the browser, CDP sessions, observation state and SQLite handles hot between commands is central to latency. The historical docs proposed a daemon with WebSocket/local IPC and a versioned protocol.

BrowserSkill uses CLI-per-call → daemon over Unix socket / Windows named pipe (no token) → WebSocket to the extension. Playwright MCP / Chrome DevTools MCP expose MCP over stdio. Vercel agent-browser is a native CLI speaking raw CDP.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| CLI-only, in-process each call | No daemon | Reconnect/re-observe every call (100s of ms); no warm state; LaunchProvider pipe would die with each process |
| Unix socket / named pipe IPC | OS-level access control (POSIX) | Two transports per OS; Windows pipe ACL pitfalls (BrowserSkill default ACL); awkward for SDKs in other languages |
| HTTP REST | Familiar | No server push for events; ad-hoc schemas |
| gRPC | Typed, streaming | Heavy toolchain; codegen |
| MCP-first | Direct agent integration | Ties core API to one agent protocol; stdio per agent process can't share a daemon by itself |
| **Long-lived daemon + JSON-RPC 2.0 over loopback WebSocket + token** | One transport on all OSes; bidirectional (events); trivial clients in any language; zod-validated | Must implement auth carefully (token + Origin rejection) |

## Decision

- **One long-lived daemon per `BOS_HOME`** holds sessions, browser handles, CDP sessions, observer state, router and SQLite. Single-instance check via `daemon.json` + `system.hello`. CLI auto-starts it unless `--no-autostart`.
- **Transport:** `ws://127.0.0.1:<port>/rpc` (port 0 = OS-assigned, written to `daemon.json`); max message 8 MB.
- **Auth:** `Authorization: Bearer <token>` from owner-only `daemon.token` (constant-time compare); reject any upgrade with an `Origin` header (blocks browser pages).
- **Protocol:** JSON-RPC 2.0; `protocolVersion: "1"`; method table + zod schemas in `packages/protocol/src/rpc.ts`; server events as `event` notifications; errors carry `data.bosCode`. `act` returns `ActionResult` even on failure.
- **Clients:** `@browser-os/sdk` (typed TS client) and `bos` CLI (built on the SDK). In-process embedding via `createRuntime()` for tests/benchmarks.
- **MCP** is a post-MVP thin adapter over the SDK (P13-02), adding no runtime logic.
- Remote mode later: same protocol over `wss://` with paired device tokens (P13-08).

## Consequences

Positive: warm state across commands; language-neutral protocol; events for human/permission flows; one code path for CLI, SDK and MCP.
Negative: a background process to manage (start/stop/status); daemon restart = cold browser launch (ADR-003).
Follow-ups: P8-01…P8-08.

## Revisit when

- Per-call WebSocket overhead shows up in benchmarks (> 5 ms p50 per RPC on loopback).
- MCP becomes the dominant integration path → keep MCP as adapter, unless it needs features the protocol lacks.

## References

- `specs/protocol.md`, `SECURITY.md`, ADR-014
- BrowserSkill `crates/bsk-cli/src/daemon/{ipc.rs,ws.rs}` (ADR-005); https://github.com/microsoft/playwright-mcp; https://github.com/vercel-labs/agent-browser
