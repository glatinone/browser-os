# ADR-005: BrowserSkill Strategy

Status: Accepted (2026-10-02)

## Context

BrowserSkill (Tencent, `github.com/Tencent/BrowserSkill`) is the project closest to Browser-OS's "browser layer". Research was done on commit **`3f10983`** (2026-09-30, workspace version 0.3.2, same as the locally installed `bsk`). Note: the user's local folder `browserskills-tencent` is empty; a fresh clone was analysed.

Facts:
- **License: MIT**, "Copyright (c) 2026 Tencent". No NOTICE/third-party constraints. `packages/vom` has zero runtime dependencies.
- ~59k lines Rust (CLI + daemon in one binary) and ~134k lines TS/TSX (WXT MV3 extension, `packages/vom`).
- Architecture: `bsk` CLI (one process per command) → daemon (Unix socket / Windows named pipe, JSON Lines) → WebSocket on loopback port 52800 → MV3 extension → `chrome.debugger` (CDP) in the user's running browser.
- Observation: CDP-native `DOMSnapshot.captureSnapshot` + per-frame `Accessibility.getFullAXTree`, joined on `(frameId, backendNodeId)`, OOPIF via flattened sessions, document-identity staleness guard, per-frame failure isolation, modal/mask layer folding by paint order, clickable-div recovery, name-resolution priority chain, `[ctx:]` disambiguation, budgeted hover probes.
- Actions: CDP `Input.*` at quad centroid; `effect_state` none/committed/unknown prevents blind retries; no Playwright-style actionability or hit-test check.
- `record` produces trace v3 (state → action → state); **no replay, no caching, no learning**. Refs are not stable across observations and do not self-heal.
- Weaknesses: local WebSocket auth checks only the `Origin` header shape (TODO in `daemon/ws.rs` admits it); Windows pipe has default ACL; no token. No library API: integrations spawn `bsk --json`. Protocol is internal and moving (1.3, trace v3 within ~3 months; CLI auto-updates). Small eval corpus.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Depend on `bsk` (spawn CLI / speak its WS protocol) | Real-profile access today | No library API; process spawn per call; unstable internal protocol + auto-update; weak local auth; no cache/router hooks; Rust + extension stack outside our control |
| Fork the repo | Start with a working system | ~190k LOC to own; upstream divergence; Rust + TS + extension; our core (router, memory) is not there anyway |
| **Reference + selective port** | Reuse proven ideas; MIT allows porting with notice | We implement our own capture (more work than depending) |
| Ignore | Simplest | Wastes the best available prior art for CDP observation |

## Decision

**REFERENCE + SELECTIVE PORT.** No dependency, no fork.

Concepts adopted (implemented from our specs):
- DOMSnapshot + AX fusion keyed by backendNodeId (ADR-009, `specs/dom-intelligence.md` §2–3)
- document-identity guard and per-frame failure isolation (§2)
- `effect` semantics for safe retries (`specs/action-router.md` §4.1)
- name-resolution priority chain (§6.1)
- modal/mask layer folding and paint-order occlusion (P11-05)
- OOPIF frame-geometry composition (P11-02)
- Agent Window / tab-borrowing / single-use interrupt UX, for the future ExtensionProvider (P13-04, ADR-013)
- trace v3 shape as input to trajectory design (we add locators, params, healing)

Porting code is allowed **only** when a task card explicitly authorizes it, from pinned commit `3f10983`, with the MIT copyright and permission notice added to `THIRD_PARTY_NOTICES.md` and a header comment in each ported file. Candidate files: `packages/vom/src/{layers.ts,render.ts}`, `apps/extension/src/tools/frame-geometry.ts`, `geometry/frame-context.ts`.

Not copied: the agent/skill layer, the extension transport's auth model, the CLI-per-call design.

## Consequences

Positive:
- Our observation design is validated by a working MIT implementation.
- Browser-OS keeps control of the hot path and adds what BrowserSkill lacks: cache, trajectories, router, token-authenticated IPC.

Negative:
- We re-implement capture instead of reusing it.
- Ideas from a fast-moving repo may drift; we pin the reference commit.

Follow-ups:
- Interop idea (post-MVP): a BrowserSkill-backed provider is possible but not planned.

## Revisit when

- BrowserSkill publishes a stable library API or stable protocol with real authentication, and benchmark/compat data shows it beats our capture.
- Users need daily-profile access before P13-01/P13-04 are ready.

## References

- https://github.com/Tencent/BrowserSkill (commit 3f10983): `docs/architecture.md`, `apps/extension/src/tools/vom/*`, `packages/vom/src/*`, `crates/bsk-cli/src/daemon/ws.rs`, `crates/bsk-protocol/src/tools/record_v3.rs`
- `OSS_STRATEGY.md`, `specs/dom-intelligence.md`
