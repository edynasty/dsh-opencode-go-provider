# Contributing to dsh-opencode-go-provider

Thanks for contributing! This is a small, safety-critical DSH rc.6 provider
bundle; the gates below keep the packed artifact honest and the credential
boundary intact.

## Setup

- Node.js `^22.19.0 || >=24.0.0`.
- corepack-managed **pnpm 11.7.0** (the repo pins `pnpm@11.7.0` in
  `package.json`; run `corepack enable` if pnpm does not resolve through
  Corepack).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

## Development workflow

- **TDD**: write the failing test first (red), capture the failure, then
  implement (green). Tests live in `tests/**/*.spec.{ts,tsx}` and run under
  Vitest 4.
- **No live network by default**: the test suite uses fail-closed fake fetch
  seams and fake clocks; it never touches models.dev, the OpenCode Go gateway
  or the DSH credential store. The only live surface is the opt-in
  `scripts/live-smoke.mjs`, which requires BOTH `RUN_OPENCODE_GO_LIVE=1` and a
  local `OPENCODE_GO_API_KEY`; CI injects neither.
- **Never read or reproduce real credentials**: tests use fixture-only fake
  keys (allowlisted, never shipped). Do not add real keys, tokens or machine
  paths to tests, fixtures, docs or evidence.
- **Bilingual docs**: user-facing behavior changes must update both
  `README.md` and `README.zh.md` (Simplified Chinese), and the docs-contract
  tests assert the exact tokens (pinned SHA, protocols, credential boundary,
  non-affiliation, npm-unpublished status) in both files.

## Code rules

- **Strict types**: the project compiles with `strict`, `noImplicitAny`,
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`, no
  unsafe `as` casts, no `@ts-ignore`/`@ts-expect-error`.
- **No private imports**: never import `@deepseek-ai/<pkg>/src/*` — only the
  public package entrypoints of the DSH rc.6 peer graph.
- **250-LOC production ceiling**: every production module stays under 250 pure
  LOC (docstrings excluded from the count by the awk convention). Split a
  concern into a new module rather than growing one.
- **Stable, sanitized errors**: outward error messages are fixed-category
  codes or fixed sentences; injected error text, bodies, keys, URLs and paths
  never reach messages, logs or renderers.
- **No prefix guessing**: protocol selection comes only from catalog metadata
  (`sdkToProtocol`); model-name prefixes never choose a transport.
- **Deterministic artifacts**: `catalog/*.json` and `lib/` must stay
  byte-stable across rebuilds; the generator is idempotent.

## The full local gate

Run before any PR:

```sh
pnpm run check
```

`check` chains: typecheck (Host + client programs) → vitest (all specs,
including docs-contract and CI-contract) → tsdown build → publint → pack:check
(tarball audit + packed install/remove lifecycle + Git-install proof) →
package-contract. A rebuild must leave `lib/` byte-identical
(`git diff --exit-code -- lib`).

Focused quick loops:

```sh
pnpm exec vitest run tests/docs-contract.spec.ts tests/ci-contract.spec.ts tests/live-smoke.spec.ts
pnpm run pack:check
```

CI (`.github/workflows/ci.yml`) runs the same gates on Node 22.19.0, 24 and 26
with pnpm 11.7.0 and a frozen lockfile, plus the deterministic credential
scan. Workflow changes must keep `permissions: contents: read`, inject no
secrets, and never set `RUN_OPENCODE_GO_LIVE=1` or `OPENCODE_GO_API_KEY`.

## Pull request checklist

- [ ] Red test captured before implementation (where behavior changed).
- [ ] `pnpm run check` green; focused specs green.
- [ ] `git diff --exit-code -- lib` clean after rebuild.
- [ ] Bilingual README updated; docs-contract tokens intact.
- [ ] THIRD_PARTY_NOTICES.md attribution retained and extended only with
      verified entries.
- [ ] No secrets, machine paths or private imports in the diff or tarball.
