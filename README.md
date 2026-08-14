# dsh-opencode-go-provider

OpenCode Go LLM provider bundle for DeepSeek Harness (DSH rc.6): a single
`opencode-go` model route over the OpenCode Go gateway, with a Web Connect
settings card.

**Status:** package scaffold (contract todo). Not yet published to npm; release
gates and bilingual documentation land with the release todo.

## Bundle contract

- `dsh.bundle.patch` → `cordis.patch.yml` mounts the `llm-opencode-go` bundle row.
- `dsh.client.inject` declares the Web settings client runtime packages.
- `lib/` is committed so commit-pinned GitHub installs load without a build step.

## Gates

Requires Node `^22.19.0 || >=24.0.0` and corepack-managed pnpm 11.7.0.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```
