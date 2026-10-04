# History (non-authoritative)

These files are the original brainstorming material (copied ChatGPT conversations, mostly in Bahasa Indonesia). They are kept here for context only.

**They are NOT the spec.** Where they disagree with `docs/*.md` or `docs/adr/*.md`, the `docs/` files win. Coding agents should not implement anything from this folder directly.

| File | Chronology | What it is | Status |
|---|---|---|---|
| `01-master-spec-browserskill-ultra.txt` | 1st | "BrowserSkill Ultra" master spec: problem, MVP, execution hierarchy, CLI ideas, Python API idea, phases | Superseded by `PRD.md`, `ARCHITECTURE.md`, `ROADMAP.md` |
| `02-vision-naming-and-oss-survey.txt` | 2nd | Rename to **Browser-OS**, "OS" framing, first survey of BrowserSkill / Stagehand / Steel / Browser Use | Superseded by `PRD.md`, `OSS_STRATEGY.md` |
| `03-architecture-v0.1.txt` | 3rd | ARCHITECTURE.md v0.1 draft (64 sections) | Superseded by `ARCHITECTURE.md` + `specs/` |
| `04-oss-strategy-draft.txt` | 4th | First Use / Adapt / Build classification | Superseded by `OSS_STRATEGY.md` |

## What was kept from these documents

- The thesis: *use the cheapest, most deterministic mechanism that can complete the action*, and get faster with repeated use.
- Real Chrome/Edge over alternative engines; Lightpanda is a future provider only.
- TypeScript, Playwright, CDP, SQLite, local-first.
- Build ourselves: Action Router, DOM intelligence and compression, action cache, trajectory memory, execution policy, session abstraction, permissions, protocol, benchmarks.
- No forks on day one.
- Never bypass CAPTCHA, MFA or passkeys. Pause for a human instead.

## What was changed or dropped (and where the reasoning lives)

| Historical idea | Decision | Where |
|---|---|---|
| Python API (`from browser_ultra import Agent`) | Dropped for MVP. TypeScript only. | ADR-016 |
| Attach to the user's *existing daily* Chrome profile via CDP | Changed. MVP uses Browser-OS-owned persistent profiles (Chrome 136+ blocks remote debugging on the default profile). Attaching to the daily browser comes later through an extension provider. | ADR-003, ADR-013 |
| Chrome MV3 extension in MVP | Deferred to post-MVP | ADR-013 |
| Stagehand as an optional "AI execution layer" in the core | Reference only. No dependency. | ADR-006 |
| `cache/embeddings/` folder, semantic intent matching | Dropped. Exact task keys only; no vector DB. | ADR-011 |
| Autonomous planner / "Agent Runtime" inside Browser-OS | Out of MVP. The calling agent is the planner. Browser-OS provides intent-level `act()` and task record/replay. | ADR-010, PRD §6 |
| OpenTelemetry as an MVP dependency | Deferred. OTel-compatible event schema now, exporter later. | ADR-015 |
| Vision fallback in MVP | Interface only in MVP; implementation post-MVP | PRD §6 |
| `<20ms` cached action overhead as a promise | Reworded as a measured target with methodology | PERFORMANCE.md |
| Comparing against BrowserSkill / Browser Use / Stagehand in MVP benchmarks | Replaced by internal ablation baselines (LLM-every-step vs. no-cache vs. full). External comparisons later. | BENCHMARKS.md |
| CLI name `browser-ultra` | Renamed to `bos` | PRD §8 |
