# ADR-010: Action Router

Status: Accepted (2026-10-02)

## Context

The core thesis: *use the cheapest, fastest, most deterministic mechanism capable of completing the action.* The historical docs list the hierarchy cache → deterministic DOM/CDP → Playwright → small LLM → vision → human, but leave open: who plans tasks, what input the router receives, how CDP vs Playwright is chosen, and how decisions are measured.

Existing systems: Stagehand goes cache → full inference only. Browser Use is LLM-in-the-loop unless replaying history. BrowserSkill has no routing (always CDP at a ref chosen by the agent). None has a deterministic tier between cache and LLM.

## Options considered

| Question | Options | Choice |
|---|---|---|
| Input granularity | (a) free-form instruction "click the search box"; (b) explicit action type + NL target; (c) structured only | **(b)**: verb parsing is brittle; agents can always name the verb. Keeps deterministic tiers deterministic. |
| Who plans multi-step tasks | (a) internal planner/agent in Browser-OS; (b) calling agent plans, Browser-OS records/replays | **(b) for MVP**. Avoids building another agent framework; optional planner = P13-06. |
| Tier order | fixed vs learned/adaptive ordering | **Fixed** order; adaptive ordering only with benchmark evidence (new ADR). |
| CDP vs Playwright | router tier vs driver fallback | **Driver fallback** after resolution: CDP first, Playwright only if CDP reported `effect: 'none'`. |
| Thresholds | hard-coded vs tunable | **Constants file** tuned against fixtures with ground truth. |

## Decision

- Fixed tier ladder: **`ref` → `cache` → `deterministic` → `llm` → `vision` (post-MVP, interface only) → `human`** (`specs/action-router.md` §2). Each tier is tried at most once per call; bounded retries; `execute` never throws (except cancellation).
- The caller always specifies the action type; only the **target** may be natural language (`Target.kind = 'intent'`).
- Cache tier = cheap probe then full fingerprint match; deterministic tier = structured query or lexical scorer (accept ≥ 0.75 with margin ≥ 0.15); LLM tier = fast model picks a `ref` from ≤ 30 compressed candidates. **Model output never becomes a selector**: unknown refs are rejected.
- Driver: CDP executor (scroll, quads, hit-test, `Input.*`), Playwright fallback only when `effect == 'none'`; `effect == 'unknown'` is never retried (no double submits).
- Security check (risk + permission) after resolution, before execution; challenges pause for a human.
- Learning: successful non-cache intent resolutions write the action cache; recording tasks append trajectory steps.
- Healing: trajectory replay passes `healIntent`; locator failure continues from the deterministic tier.
- All thresholds live in `packages/runtime/src/router/constants.ts`. **Deterministic-tier precision ≥ 99%** on fixtures is a hard target; coverage can be lower.
- Measurement: every `ActionResult` carries per-tier `attempts`; persisted to `action_runs`; `bos stats` reports tier distribution, cache hit / false-hit rate, LLM calls and tokens per action, per-tier p50/p95, escalation rate.

## Consequences

Positive: AI appears only where uncertainty exists; behaviour is explainable per action; easy ablation (disable tiers) for benchmarks.
Negative: Browser-OS alone cannot complete open-ended tasks in MVP (needs a calling agent or a recorded trajectory).
Follow-ups: P7-02…P7-04 implementation; P10-04 ablation benchmark validates the ordering; P13-03 vision tier; P13-06 optional planner.

## Revisit when

- Ablation data shows a different order is cheaper at equal success (e.g. LLM before deterministic on some site class).
- Deterministic precision falls below 99% at current thresholds → retune or narrow the tier.

## References

- `specs/action-router.md`, `specs/dom-intelligence.md` §7–8, `specs/memory.md` §6
- jev-ultrafast rule "model output never becomes selectors" (ADR-008); BrowserSkill `effect_state` (ADR-005); Stagehand cache → inference fallback (ADR-006)
