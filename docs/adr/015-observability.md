# ADR-015: Observability

Status: Accepted (2026-10-02)

## Context

The thesis must be proven with numbers: per-tier latency, LLM calls, tokens, cache hit rate, success rate. Every action must be explainable ("why was this slow / why did it call the model?"). The historical docs list OpenTelemetry as an MVP dependency.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| OpenTelemetry SDK in MVP | Standard, exporters | Heavy dependency tree; configuration burden; no consumer yet in a local-first tool |
| console logs only | Trivial | Not queryable; not testable; leaks risk |
| **Typed event bus + SQLite metrics + optional JSONL traces, OTel-compatible naming** | Zero extra deps; testable; queryable via `bos stats`; exporter can be added later | Custom code; no out-of-the-box dashboards |

## Decision

- One typed event union `BosEvent` (`specs/data-models.md` §10) emitted through a tiny `EventBus` in `@browser-os/protocol`. No `console.log` in library code.
- Every action produces an `ActionResult` with per-tier `TierAttempt`s; the runtime persists one row per action to `action_runs` and security-relevant events to `audit_log` (masked).
- Optional per-task JSONL traces at `<BOS_HOME>/traces/<taskId>.jsonl` (masked events).
- `events.subscribe` streams events to clients (CLI, SDK, benchmarks).
- `bos stats` and the benchmark harness compute tier distribution, cache hit/false-hit rate, LLM calls and tokens per action/task, per-tier p50/p95/p99, escalation rate.
- Field naming follows OpenTelemetry semantic style so a future exporter needs no renames.
- **No OpenTelemetry SDK in MVP.** An OTel exporter is a separate post-MVP package (P13-05) subscribing to the bus.
- Invariant (tested): no event, row or trace contains secret values or sensitive field values.

## Consequences

Positive: measurability from day one; benchmarks reuse production telemetry.
Negative: no standard dashboards until P13-05.

## Revisit when

- A user or deployment needs traces in an existing OTel backend (→ P13-05), or remote mode needs distributed tracing.

## References

- `specs/data-models.md` §10, `specs/action-router.md` §8, `specs/memory.md` §3, `PERFORMANCE.md`, `BENCHMARKS.md`
