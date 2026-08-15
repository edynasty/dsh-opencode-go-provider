# dsh-opencode-go-provider

OpenCode Go LLM provider bundle for DeepSeek Harness (DSH rc.6): a single
`opencode-go` model route over the OpenCode Go gateway, with a Web Connect
settings card, a stale-while-revalidate model catalog and safe diagnostic
commands.

> **Status: community software, not published to npm.** This package is
> installed as a commit-pinned Git dependency into a DSH profile; the npm
> registry is **not** an installation path. It is not affiliated with,
> endorsed by, or sponsored by DeepSeek, OpenCode, or any model provider
> vendor. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Requirements

- DeepSeek Harness **DSH rc.6** (the bundle targets the `0.1.0-rc.6` peer graph).
- Node.js `^22.19.0 || >=24.0.0`.
- corepack-managed **pnpm 11.7.0** (`corepack enable` first if `pnpm --version`
  does not resolve through Corepack).
- An OpenCode Go API key. The key is stored and resolved **only** through the
  DSH credentials service at operation time under the ref
  `OPENCODE_GO_API_KEY`; it is never written into settings, the catalog, logs,
  errors or the package.

## Installation (Git, commit-pinned)

The package is not published to npm; the supported installation is a
commit-pinned Git dependency for the DSH **web** profile:

```sh
dsh plugin --profile web add github:edynasty/dsh-opencode-go-provider#db9644fc35ccd11f83e713e27d6a0dbd23f37f1e
```

`lib/` is committed to the repository, so the Git install loads the bundle
without a build step. Uninstall removes the package and its bundle row:

```sh
dsh plugin --profile web remove dsh-opencode-go-provider
```

## What the bundle registers

- One provider route: **`opencode-go`**, mounted by the `llm-opencode-go`
  bundle row (`cordis.patch.yml`).
- One settings namespace: `llm-opencode-go` (refresh interval, freshness
  window, network timeout, deprecated grace, credential ref).
- A Web Connect settings card (injected through `dsh.client.inject`) that can
  connect, test the connection, run diagnostics and disconnect.
- A standalone `bin` (`dsh plugin --profile web exec dsh-opencode-go-provider`)
  for `status`, `doctor`, `migration-dry-run` and `migration-apply`.

## Model catalog and protocols

The embedded catalog (`catalog/models.json`) is derived from OpenCode's
models.dev metadata (`https://models.opencode.ai/api.json`); only the
`opencode-go` provider record is retained. Each model carries its own protocol
from that metadata, and the adapter dispatches per model with **no
model-name-prefix guessing**:

| Protocol | Selection |
| --- | --- |
| `openai-responses` | models whose models.dev SDK metadata maps to `@ai-sdk/openai` |
| `openai-completions` | models mapped to `@ai-sdk/openai-compatible` (the default class) |
| `anthropic-messages` | models mapped to `@ai-sdk/anthropic` (base URL `https://opencode.ai/zen/go`) |

Model availability is checked against the live endpoint
`https://opencode.ai/zen/go/v1/models`, which contributes **only** available
ids; models.dev remains the sole authority for protocol, context, modalities,
cost and reasoning metadata.

### Catalog lifecycle (stale-while-revalidate)

- **Embedded catalog** is available immediately at boot — offline and without
  a credential.
- Background refresh keeps a **5-minute freshness** window; within it reads
  never touch the network.
- A **60-minute** periodic refresh revalidates; a stale read schedules one
  single-flight background refresh.
- Every network attempt is bounded by a **10-second** timeout.
- Successful refresh writes the cache **atomically** (same-directory temp,
  `0600`, fsync, rename) at
  `$DSH_HOME/cache/dsh-opencode-go-provider/catalog.json` and only then swaps
  the in-memory snapshot; in-flight requests keep the snapshot they started
  with.
- **Offline fallback**: a missing or corrupt cache serves the embedded catalog
  (`origin: embedded`/`corrupt`); the corrupt file is never deleted, and
  failures never overwrite the last good state.
- **Quarantine**: a live id with no models.dev metadata is recorded with a
  sanitized machine-readable reason and is never exposed as a callable model.
- **14-day deprecated grace**: a models.dev-known model missing from live
  availability stays selectable with a `deprecatedAt` timestamp; after 14 days
  it is evicted (and resurrects if it returns to live).

## Connect / status / doctor / disconnect

- **Connect** (Web card or Host route) stores the key **only** in the DSH
  credentials service under `OPENCODE_GO_API_KEY`; keys are never rendered
  back, echoed or written anywhere else.
- **Status** reports sanitized facts only: configured yes/no, source
  (embedded/cache/refreshed), model count, last refresh, last attempt, refresh
  ok/failed counts.
- **Test connection / doctor** performs exactly one authenticated
  `GET https://opencode.ai/zen/go/v1/models` and reports sanitized counts and
  fixed error codes; it never calls generation endpoints.
- **Disconnect** removes **only** the `OPENCODE_GO_API_KEY` credential. The
  `opencode-go` route and Connect card remain registered and selectable —
  disconnect never removes the provider, writes it to a disabled list, or
  touches other providers.

`connect`/`disconnect` are Host-only: the standalone `bin` refuses them with a
fixed message because the DSH credential store is owned by the running Host.

## Migrating the manual route

If an older setup configured `llm-pi-ai.providers.opencode-go` by hand, the
bundle can migrate it away:

```sh
dsh plugin --profile web exec dsh-opencode-go-provider migration-dry-run <settings.yaml>
dsh plugin --profile web exec dsh-opencode-go-provider migration-apply --revision <64-hex> <settings.yaml>
```

- `migration-dry-run` is read-only and prints the target, the SHA-256 revision
  and removed key/line **counts** (never the key names or values).
- `migration-apply` verifies the expected revision, acquires a same-directory
  lock, re-reads and re-hashes immediately before writing, creates a
  timestamped recoverable backup (never touching credentials files), and
  publishes atomically. A concurrent edit yields `conflict` with zero
  residue; a second apply is an idempotent `no-change`.
- Only conservative YAML shapes are supported: **block mappings without flow
  maps, anchors or aliases** are migrated; unsupported shapes abort
  (`unsupported-shape`) before any lock, backup or write.
- The migration preserves the **default model**, all other providers, comments,
  quoting and key order — only the `llm-pi-ai.providers.opencode-go` block is
  removed, and the credential ref is left untouched.

## Security

See [SECURITY.md](SECURITY.md) for the supported scope, the private reporting
route, credential handling and the safe-diagnostics contract.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the TDD workflow, the
strict-type/no-private-import rules, the 250-LOC production ceiling and the
full local gate:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

CI (`.github/workflows/ci.yml`) runs the same gates on Node 22.19.0, 24 and 26
with pnpm 11.7.0 and a frozen lockfile. Live smoke requires **both** a local
`RUN_OPENCODE_GO_LIVE=1` opt-in **and** a local `OPENCODE_GO_API_KEY`; CI
injects neither, so the step always skips.

## License

MIT — see [LICENSE](LICENSE). Upstream notices and attribution are retained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
