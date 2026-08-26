---
name: tdd-change
description: Implement a repository behavior change with a narrow red-green-refactor loop and contract-aware verification.
---

# TDD change

1. Run `repo-recon` or otherwise establish the exact affected surface.
2. Add/update the smallest focused test that demonstrates the requested behavior; capture the expected failure when a shell is available.
3. Implement the smallest change that makes the test pass.
4. Keep production modules below 250 pure LOC and preserve strict TypeScript/public imports.
5. Run the focused spec until green.
6. Run `pnpm run typecheck`.
7. If user-facing behavior changed, invoke `bilingual-docs`.
8. Invoke `security-review` for changes touching credentials, requests, errors, model metadata, or settings.
9. Finish with `verify-change`.

Never use real credentials or enable live networking as part of the normal loop.