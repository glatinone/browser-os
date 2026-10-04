# Third-party notices

Browser-OS is licensed under Apache-2.0 (see `LICENSE` and `NOTICE`).

## 1. Code adapted from other projects (ports)

None yet. Every port must follow `docs/OSS_STRATEGY.md` §5: a task card authorizes it, the source license is MIT, Apache-2.0 or BSD, and the source is pinned to a commit. Add one entry per port:

```
### <Project> (<license>)
- Source: <repo>@<commit>, <paths>
- Used in: <our files>
- Copyright: <original copyright line>
- License text: <full text or link to the bundled copy>
```

Never add code from AGPL, SSPL or GPL projects (workflow-use, Lightpanda, Skyvern, Notte, …).

## 2. Runtime dependencies (informational; installed via npm, not vendored)

| Package | License | Used by |
|---|---|---|
| playwright-core | Apache-2.0 | `@browser-os/browser` |
| better-sqlite3 | MIT (bundles SQLite, public domain) | `@browser-os/memory` |
| ws | MIT | `@browser-os/daemon`, `@browser-os/sdk` |
| zod | MIT | all packages |

Update this table whenever a dependency is added through an ADR.
