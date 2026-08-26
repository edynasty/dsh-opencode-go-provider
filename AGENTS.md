# AGENTS.md

## Mission

Work on this repository as a safety-critical DSH rc.6 provider bundle. Prefer small, reviewable, test-driven changes that preserve the credential boundary, deterministic artifacts, and the public package contract.

## Read first

Before changing code, read `CONTRIBUTING.md`, the relevant tests, and the affected implementation. For user-facing behavior, also read both `README.md` and `README.zh.md`.

## Required workflow

1. Inspect the repository and identify the smallest affected surface.
2. For behavior changes, add or update a failing test first when practical.
3. Implement the smallest correct change.
4. Run the narrowest relevant tests, then `pnpm run check` before declaring completion when a shell is available.
5. After a build, verify `git diff --exit-code -- lib` unless the change intentionally updates committed build output.
6. Review the final diff for secrets, machine-specific paths, unsafe casts, private DSH imports, and accidental network access.
7. Report commands run, results, and anything that could not be verified.

If no shell is available, use the `github-ci-loop` skill: make the change on a branch, rely on the repository CI as the execution environment, inspect failures, and iterate until green.

## Non-negotiable constraints

- Node.js: `^22.19.0 || >=24.0.0`; package manager: Corepack-managed `pnpm@11.7.0`.
- Preserve strict TypeScript. Do not introduce `any`, unsafe `as` casts, `@ts-ignore`, or `@ts-expect-error`.
- Never import `@deepseek-ai/<pkg>/src/*`; use public package entrypoints only.
- Keep production modules below the repository's 250 pure-LOC ceiling; split concerns instead of growing oversized files.
- Tests are offline by default. Never enable live network access in CI.
- Never read, print, commit, request, or reproduce real credentials. `OPENCODE_GO_API_KEY` remains behind the DSH credentials service boundary.
- Outward errors must stay sanitized and stable; do not leak upstream bodies, keys, URLs, local paths, or injected error strings.
- Protocol selection comes from catalog metadata; never infer protocol from model-name prefixes.
- Generated catalog and `lib/` artifacts must remain deterministic.
- User-facing behavior changes require synchronized English and Simplified Chinese documentation.
- Preserve third-party attribution and non-affiliation statements.

## Preferred verification

Focused loops first, full gate last:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec vitest run <relevant-specs>
pnpm run typecheck
pnpm run check
git diff --exit-code -- lib
```

Never run `scripts/live-smoke.mjs` with real credentials unless the user explicitly requests a live test and provides a safe execution environment. CI must never set `RUN_OPENCODE_GO_LIVE=1` or `OPENCODE_GO_API_KEY`.

## Agent delegation

Use specialized subagents when available:

- `explorer`: repository reconnaissance and impact analysis; read-only.
- `implementer`: focused implementation after scope is understood.
- `tester`: tests, type/build failures, CI diagnosis, and verification.
- `reviewer`: final correctness/security/contract review; read-only.
- `docs`: bilingual documentation and public-contract consistency.

Parallelize independent read-only investigation. Avoid parallel edits to the same files.

## Skills

Repository skills live under `.agents/skills/`. Prefer them over ad-hoc procedures:

- `repo-recon` for initial exploration and impact mapping.
- `tdd-change` for implementation work.
- `verify-change` for local verification.
- `github-ci-loop` when GitHub Actions is the available execution environment.
- `security-review` for credential/error/network boundary review.
- `bilingual-docs` for synchronized README changes.
- `release-readiness` for packaging and release-contract checks.

## MCP

Project-scoped Codex MCP configuration lives in `.codex/config.toml`. Treat MCP servers as privileged tools: keep secrets in environment variables or external credential stores, prefer read-only access by default, and do not add a new networked MCP server merely for convenience.

## Completion standard

A task is complete only when the requested behavior is implemented, relevant verification is green (locally or via CI), the final diff has been reviewed, and remaining uncertainty is stated explicitly.