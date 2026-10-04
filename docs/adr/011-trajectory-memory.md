# ADR-011: Action Cache and Trajectory Memory

Status: Accepted (2026-10-02)

## Context

Repeated workflows must get cheaper: first run AI-assisted, later runs zero-LLM. We need to decide how tasks are identified, what is stored, how stored strategies are validated and invalidated, and how secrets stay out.

Prior art: Stagehand v3 keys a local file cache by instruction + full URL + variable names, with no invalidation; Stagehand v4 moved caching server-side. Browser Use reruns history with a 5-level element re-identification ladder. workflow-use (AGPL) stores semantic workflows with variables and falls back to an agent. BrowserSkill records traces but never replays them. Browser Use cloud "skills" learn across users server-side.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Semantic task matching via embeddings + vector DB | Matches paraphrased instructions | New dependency, false matches on risky tasks, no demonstrated need |
| **Exact task key chosen by the caller** (`linkedin.search-people`) | Predictable, safe, trivial lookup | Caller must name tasks |
| Store raw selectors/XPath | Simple | Brittle; Stagehand v3 needs manual cache deletion |
| **Store `ElementLocator` fingerprints + original intent** | Validated matching; healing possible | More logic (matching, versions) |
| Store typed values | Faithful replay | Secrets/PII leak into storage |
| **Parameterized values (`param` / `secret` refs)** | Reusable, safe | Caller supplies params at replay |

## Decision

Two memories in SQLite (`specs/memory.md`):

1. **Action cache (site memory):** key = `sha256(origin, pathTemplate, actionType, normalizedIntent)` with param values replaced by `{name}`; plus a **site-wide** key (`pathTemplate = '*'`). Value = `ElementLocator`. Every cached use is **validated** (probe + fingerprint match) before execution. Lifecycle: hit → counters; miss → `consecutive_misses++`, **3 → invalid**; **false hit** (verification failure or human correction) → invalid immediately; later successful resolution overwrites.
2. **Trajectories (workflow memory):** exact **task key chosen by the caller**; steps hold `BrowserAction` with `{kind:'locator'}` targets (or `{kind:'intent'}` for human-manual steps), `param`/`secret` value refs, `{{param}}` URL placeholders, `pre.urlPattern`, risk, and the original **intent for healing**. Modes `record` / `replay` / `auto`. Replay heals via the router (`healIntent`); healed locators bump `version` (history in `trajectory_versions`). Status: success → `active`; 1 consecutive failure → `suspect`; 2 → `invalid` (next `auto` run records again).

Rules:
- **No vector DB, no embeddings** in MVP. No global/cross-site memory.
- **Secrets never stored**: only `secret` names. A `literal` into a sensitive field during recording is rejected before execution (sensitive-literal guard). Canary test proves no secret reaches DB, logs or traces.
- Browser state (cookies/storage) stays in the Chrome profile; never copied into memory.
- Memory is local only; no sharing across users.

## Consequences

Positive: zero-LLM replay on unchanged sites; self-repair on drift; explainable state machine; no privacy leakage.
Negative: callers must name tasks and declare params; paraphrased tasks don't share trajectories.
Follow-ups: P6-02 keys, P6-04/05 stores, P7-05 recorder, P7-06 replayer, P9-06 canary test.

## Revisit when

- Benchmarks/user data show exact keys cause frequent duplicate recordings of equivalent tasks → evaluate embedding-assisted *suggestion* (never silent replay of risky tasks), via a new ADR.
- Site-wide cache entries produce measurable false hits (> 1% of cache-tier resolutions) → drop or restrict site-wide keys.

## References

- `specs/memory.md`, `specs/action-router.md` §5.1, §5.4, `specs/dom-intelligence.md` §8
- ADR-006 (Stagehand caching), ADR-008 (Browser Use rerun ladder, workflow-use AGPL), ADR-005 (BrowserSkill trace v3)
