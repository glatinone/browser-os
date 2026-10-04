# ADR-004: SQLite for Local Persistence

Status: Accepted (2026-10-02)

## Context

Browser-OS persists profiles, sessions metadata, the action cache, trajectories (with versions), task history, per-action run metrics and an audit log. The access pattern is local, single-writer (the daemon), many small reads on the hot path (cache lookup target: p50 < 1 ms). Browser state itself (cookies, storage) stays in the Chrome profile and is never copied.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **better-sqlite3** | Mature, synchronous (no async overhead on hot path), very fast, prebuilt binaries incl. Windows, WAL support | Native module (install can fail on unusual platforms) |
| `node:sqlite` (built-in) | Zero dependency | Stability/feature status still maturing in Node 22–24; API differences |
| JSON files per entry (Stagehand v3 `cacheDir` style) | Trivial | No queries, no atomic multi-row updates, no stats aggregation, poor invalidation |
| External DB (Postgres, Redis) | Scales, multi-host | Violates local-first; operational burden; unnecessary for MVP |
| ORM (Prisma, Drizzle, TypeORM) | Typed queries | Large dependency, codegen; prepared statements suffice |
| Vector DB | Semantic lookup | No demonstrated need (ADR-011) |

## Decision

- Use **`better-sqlite3`**, imported only in `packages/memory`.
- One database file `<BOS_HOME>/browser-os.db`, opened with `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=2000`, `synchronous=NORMAL`.
- Schema via ordered SQL migrations in `packages/memory/migrations/NNN_name.sql`, tracked in `schema_migrations`, each applied in a transaction. Initial schema: `specs/memory.md` §3.
- Small store classes with prepared statements; JSON columns (de)serialized inside the stores; `protocol` types in and out. **No SQL outside `packages/memory`. No ORM.**
- Retention: `action_runs` and `audit_log` pruned after `retentionDays` (default 30). Cache and trajectories are invalidated by validation, not TTL.

## Consequences

Positive:
- Sub-millisecond cache lookups; transactional trajectory updates; SQL aggregation for `bos stats`.
- Easy to inspect and back up (single file).

Negative:
- Native build dependency; CI must cover Windows and Linux installs.
- Single-machine only (fine for local-first; remote mode would need a different story).

Follow-ups:
- `node:sqlite` is a **REPLACE LATER** candidate once stable in the supported Node LTS. The store-class boundary makes the swap local to `packages/memory`.

## Revisit when

- `node:sqlite` is marked stable in the minimum supported Node LTS and passes the store test suite (drop the native dependency).
- Remote/multi-host mode (P13-08) requires shared state.
- Write contention appears in benchmarks (busy timeouts in logs).

## References

- `specs/memory.md` §2–3, `CODING_AGENT.md` §6
- Stagehand v3 local cache uses JSON files in `cacheDir` (see ADR-006)
