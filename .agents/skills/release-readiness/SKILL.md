---
name: release-readiness
description: Check package, generated artifacts, documentation contracts, attribution, and CI before a release or pinned Git installation update.
---

# Release readiness

1. Run `verify-change` first.
2. Run `pnpm run pack:check`, `pnpm run publint`, `pnpm run package-contract`, `pnpm run docs-contract`, and `pnpm run scan:secrets` when a shell is available.
3. Verify rebuilt `lib/` is deterministic and expected generated catalog files are stable.
4. Review `package.json` exports/files, `cordis.patch.yml`, catalog metadata, README installation instructions, and `THIRD_PARTY_NOTICES.md`.
5. Confirm no live credentials or network-only assumptions are required for normal CI/install.
6. If an installation pin is intentionally advanced, update both language READMEs and all contract fixtures/tests that deliberately track it.
7. Review CI status and final diff before declaring release readiness.

Do not publish to npm; this repository documents commit-pinned Git installation as its supported path.