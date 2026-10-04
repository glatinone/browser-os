# ADR-006: Stagehand Strategy

Status: Accepted (2026-10-02)

## Context

Stagehand (`browserbase/stagehand`, **MIT**, TypeScript, ~25.5k stars) is the most direct prior art for "AI primitives + action cache + self-healing". The historical docs proposed it as an optional AI execution layer.

Facts (2026):
- **v3** (latest 3.7.3, Aug 2026, still maintained in parallel): dropped Playwright for its own CDP driver "Understudy". APIs `act`/`observe`/`extract`/`agent()`. Local cache via `cacheDir`: JSON files keyed by `sha256(instruction, normalized URL with sorted query, sorted variable names)`. Page content is **not** in the key (docs say otherwise; source says so). Replay uses stored XPath; `selfHeal` re-infers on failure and rewrites the entry. **No automatic invalidation** (docs: delete the directory). Vendor claim: replay "sub-100ms, zero LLM cost".
- **v4** (4.1.0, announced 2026-08-06): Understudy moved into a Chrome extension; SDKs (TS/Python/Go) are thin RPC clients. **Client-side caching removed**; "Browserbase Cache" is server-side, requiring a Browserbase API key and session (local users get no cache). `agent()` removed. Local mode loads the extension with `--enable-unsafe-extension-debugging` + `--remote-debugging-port`; attaching to an existing real profile is uncertain.
- Hybrid snapshot: AX tree text outline + `xpathMap` with encoded ids `frameOrdinal-backendNodeId`, shadow piercing, OOPIF XPath stitching. Two-step act with a diff prompt for dropdowns.
- Models via Vercel AI SDK (v3); Browserbase Model Gateway (v4).
- Vendor performance claims: v4 "2x faster than Playwright", one 50-action Wikipedia run (vendor says treat as one run).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Depend on Stagehand v4 | Maintained, multi-language | No local cache; cloud coupling; extension + RPC hop; owns the browser connection; agent loop removed |
| Depend on Stagehand v3 | Local cache exists | Parallel line with unclear EOL; URL-only cache key; no invalidation; brings Vercel AI SDK and its own CDP driver alongside ours; would own the hot path |
| Fork v3 | Working cache + self-heal | Large driver to maintain; diverging upstream; still lacks routing tiers, trajectories, security model |
| **Reference only** | Learn from the closest prior art; full control of hot path and memory | Implement ourselves |

## Decision

**REFERENCE only.** No dependency, no fork, no code copying by default. (MIT would permit attributed porting; any port requires an explicit task card and a `THIRD_PARTY_NOTICES.md` entry.)

Concepts adopted:
- `act` / `observe` / `extract` API shape (our `act(BrowserAction)`, `observe`, `extract`)
- cache keyed by **variable names, not values**, with values substituted at replay (`specs/memory.md` §4.2 param substitution)
- self-heal then rewrite the stored entry (our trajectory healing with versions, `specs/memory.md` §6.2)
- hybrid AX + DOM snapshot with frame-aware encoded ids (ADR-009)
- v4's hit/miss telemetry idea (`missReason`, `tokensSaved`) → our `TierAttempt.reason` and `cache.*` events

Improvements over Stagehand v3:
- key = origin + **path template** + action type + normalized intent, with site-wide fallback, instead of full URL
- **validation before every cached execution** (probe + fingerprint match) instead of trusting an XPath
- explicit cache lifecycle (3 consecutive misses / false hit → invalid)
- a deterministic tier between cache and LLM
- multi-step trajectories, not only single actions
- everything local; no server dependency

## Consequences

Positive: full ownership of the differentiating layer (router + memory); no cloud coupling.
Negative: no free ride on Stagehand's driver work.
Follow-ups: benchmark comparison vs Stagehand v3 is optional, post-MVP (BENCHMARKS.md external baselines).

## Revisit when

- Stagehand ships a local, content-aware cache with validation and a stable embeddable driver, and benchmarks show it beats our hot path.

## References

- https://github.com/browserbase/stagehand, https://www.browserbase.com/blog/stagehand-v3, https://www.browserbase.com/blog/stagehand-v4
- https://docs.stagehand.dev/v3/best-practices/caching, https://docs.stagehand.dev/v4/best-practices/caching, https://docs.stagehand.dev/v4/migrations/v3
- `specs/memory.md`, `specs/action-router.md`
