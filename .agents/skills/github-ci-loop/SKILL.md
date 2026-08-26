---
name: github-ci-loop
description: Use GitHub Actions as the execution environment when the agent cannot run the repository locally.
---

# GitHub CI loop

Use this workflow only on a task branch or pull request; never make diagnostic commits directly to `main`.

1. Read `.github/workflows/ci.yml` and preserve its least-privilege/no-secrets contract.
2. Make the smallest intended code/test/docs change and push it to the task branch.
3. Inspect the commit's GitHub Actions workflow runs.
4. If a run fails, inspect the failed job, step, and logs. Do not guess from the summary alone.
5. Classify the failure as implementation, test expectation, typecheck, build/determinism, packaging, credential scan, infrastructure, or unrelated/flaky.
6. For product failures, make the smallest corrective edit and repeat. For infrastructure/flaky failures, retry only when evidence supports it.
7. Continue until required CI is green or a genuine external blocker is identified.
8. Perform a final diff review and summarize iterations and evidence.

Never modify CI to weaken a gate merely to obtain green status. Never add secrets, enable live smoke, or grant write permissions to the CI workflow for this loop.