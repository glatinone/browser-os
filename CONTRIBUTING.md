# Contributing to Browser-OS

Thanks for helping. Short version:

1. **License:** Apache-2.0. By contributing, you agree that your contribution is licensed under Apache-2.0 (inbound = outbound, License §5).
2. **Sign-off (DCO):** every commit must carry a `Signed-off-by: Your Name <email>` line (`git commit -s`). This certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/). No CLA is required.
3. **No copied code** from other projects unless `docs/OSS_STRATEGY.md` §5 allows it. Never from AGPL, SSPL or GPL projects.
4. **Workflow:** follow `docs/CODING_AGENT.md`. It applies to humans too: one task, tests, `pnpm build && pnpm -r typecheck && pnpm lint && pnpm test`.
5. **Security issues:** do not open public issues. See `docs/SECURITY.md` §16.
6. **File headers:** not required. Optional: `// SPDX-License-Identifier: Apache-2.0`.
