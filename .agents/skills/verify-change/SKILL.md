---
name: verify-change
description: Verify a completed change using focused tests, the repository full gate, deterministic artifact checks, and final diff review.
---

# Verify change

When a shell is available:

1. Ensure dependencies are installed with the pinned toolchain: `corepack enable` and `pnpm install --frozen-lockfile` when needed.
2. Run the narrowest relevant Vitest specs.
3. Run `pnpm run typecheck`.
4. Run `pnpm run check` before completion.
5. Run `git diff --exit-code -- lib` after the build unless committed build output is intentionally changing.
6. Run `pnpm run scan:secrets` for security-sensitive or packaging changes.
7. Inspect `git diff --check` and the final diff.
8. Ask the `reviewer` agent for a read-only final review when multi-agent support is available.

When no shell is available, invoke `github-ci-loop` and use CI as the execution oracle.

Report exactly what ran, what passed, and what remains unverified.