# Browser-OS

**An AI-native browser execution runtime.** It sits between AI agents and your real Chrome or Edge, and makes logged-in web apps programmable, safe and cheap to automate. Repeated tasks get faster each time they run.

> Status: **planning complete, implementation not started** (2026-10-02). Start at [`docs/README.md`](docs/README.md).

## The idea in 30 seconds

```
first run:   agent → bos click "the April invoice"  → observe → small LLM picks element → act → learn
later runs:  bos task run download-invoice --param month=May → cached locators → validate → act   (0 LLM calls)
```

- **Real browser, real logins:** persistent Browser-OS profiles in Chrome/Edge. You log in once by hand.
- **Cheapest mechanism first:** learned locator → deterministic match → small LLM → human. Vision comes later.
- **Compact pages:** the accessibility tree and layout become about 1k tokens of element lines, not megabytes of HTML or screenshots.
- **Learns and self-heals:** tasks are stored as parameterized trajectories, validated on every replay and repaired when a site changes.
- **Safe by construction:** secrets are never stored or sent to models; risky actions need confirmation; CAPTCHA and MFA always go to a human; it never hides being automation.

## For coding agents

Read [`AGENTS.md`](AGENTS.md), then [`docs/CODING_AGENT.md`](docs/CODING_AGENT.md), then pick a task from [`docs/tasks/README.md`](docs/tasks/README.md).

## Documentation

| | |
|---|---|
| Product | [`docs/PRD.md`](docs/PRD.md) |
| Architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/specs/`](docs/specs/) |
| Decisions | [`docs/adr/`](docs/adr/) |
| OSS strategy | [`docs/OSS_STRATEGY.md`](docs/OSS_STRATEGY.md) |
| Plan | [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/tasks/`](docs/tasks/) |
| Quality | [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md), [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md), [`docs/TESTING.md`](docs/TESTING.md), [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) |
| Origins | [`docs/history/`](docs/history/) (non-authoritative brainstorming) |
