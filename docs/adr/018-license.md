# ADR-018: Project license

Status: Accepted (2026-10-02). Decided by the owner, who delegated the choice to the architect.

## Context
Browser-OS will be open source. It depends on Playwright (Apache-2.0), better-sqlite3/ws/zod (MIT). It may selectively port MIT code (BrowserSkill, Stagehand v3; OSS_STRATEGY §5) and must never include AGPL/SSPL code. The project is meant to be embedded by companies building agents. It handles authenticated browser sessions, so contributor patent claims are a realistic concern.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **Apache-2.0** | Explicit patent grant + patent-retaliation clause; enterprise legal teams approve it routinely; same license as Playwright; compatible with MIT inbound ports; NOTICE mechanism for attribution | Slightly longer; requires NOTICE handling and marking modified files |
| MIT | Shortest, most permissive; matches BrowserSkill/Stagehand/Browser Use | No patent grant; weaker protection for users and contributors |
| MPL-2.0 | File-level copyleft keeps core improvements open | Friction for embedding; uncommon in the TS agent ecosystem |
| AGPL-3.0 | Forces SaaS forks to share changes | Kills enterprise and agent-framework adoption; conflicts with the "embed anywhere" goal |

## Decision
- **Apache-2.0** for the whole repository: `LICENSE` (full text) and `NOTICE` (`Copyright 2026 The Browser-OS Authors`) at the repo root.
- Every `package.json`: `"license": "Apache-2.0"`.
- Contributions: inbound = outbound under Apache-2.0, with **DCO sign-off** (`git commit -s`). No CLA (`CONTRIBUTING.md`).
- Ported MIT/Apache code keeps its original notices in `THIRD_PARTY_NOTICES.md` and a header comment in the file (OSS_STRATEGY §5).
- Per-file license headers are not required. `// SPDX-License-Identifier: Apache-2.0` is optional.

## Consequences
Positive: maximum adoption, patent protection, clean compatibility with all permitted dependencies and ports.
Negative: competitors may build closed products on it (accepted: the moat is execution quality and data, not license).
Follow-ups: P0-01 sets `"license"` in every package; P12-02 verifies LICENSE/NOTICE ship in every npm package.

## Owner action item (not a blocker for coding)
The copyright line uses "The Browser-OS Authors". If the project is built using an employer's time, equipment or accounts, confirm with that employer that you may release it as open source **before the first public push**, and adjust `NOTICE` if the employer should be named.

## Revisit when
A foundation donation or a commercial dual-licensing plan appears (that needs a new ADR).

## References
OSS_STRATEGY.md §0, §5; https://www.apache.org/licenses/LICENSE-2.0; https://developercertificate.org/
