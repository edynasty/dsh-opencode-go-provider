---
name: repo-recon
description: Map the repository and affected surfaces before changing code. Use for unfamiliar tasks, bugs, refactors, and impact analysis.
---

# Repository reconnaissance

1. Read `/AGENTS.md` and `/CONTRIBUTING.md`.
2. Inspect `package.json`, relevant source, nearest tests, generated outputs, and docs.
3. Search for the requested symbol/behavior and all callers or contract tests.
4. Identify credential, network, error-sanitization, protocol, packaging, and deterministic-build boundaries touched by the task.
5. Produce a short change map: files to edit, tests to add/update, docs implications, and focused verification commands.
6. Prefer delegating read-only exploration to the `explorer` agent when multi-agent support is available.

Do not edit until the impact surface is understood.