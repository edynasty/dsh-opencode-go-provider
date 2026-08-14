# Catalog Generation Fixtures

Frozen inputs for the catalog generator (`scripts/update-models.ts`).

**Default mode is bootstrap**: the embedded `catalog/models.json` is derived
from the public models.dev metadata only, with `availability.kind =
"unverified"`. No live observation is claimed, so the committed product
artifacts carry no quarantine warnings and no deprecated state.

`live-models.json` is **test-only**. It is never used to generate the
committed product artifacts and it is excluded from the npm tarball
(`package.json` `files` lists the four catalog artifacts explicitly).
Tests feed it to the generator via `--live <file>` (which marks availability
`verified/fixture` — test semantics only) or through the library API.
`--network` is the only way to obtain production availability, and it
requires `OPENCODE_GO_API_KEY`.

## Provenance

| File | Source | Date | Notes |
| --- | --- | --- | --- |
| `models-dev-opencode-go.json` | `https://models.opencode.ai/api.json` | 2026-08-14 | The `opencode-go` provider record only (24 models); the full ~3.6 MB single-line payload was fetched, extracted, and discarded — it is not stored here. This is the sole input for the committed bootstrap catalog. |
| `live-models.json` | synthetic | 2026-08-14 | **NOT an authenticated live `/v1/models` response and NOT a source for committed product artifacts.** No credential-free authenticated snapshot exists, so this fixture is a documented stand-in: the 24 models.dev IDs plus one clearly labeled synthetic probe ID `synthetic-unknown-live-probe` (25 IDs total). The probe exists solely to exercise the quarantine path in tests. |

Regenerating the bootstrap catalog with the same metadata fixture, patches and
clock produces byte-identical output.

## Evidence for the anthropic base URL patch

`catalog/patches.json` declares `baseUrlByProtocol["anthropic-messages"] =
"https://opencode.ai/zen/go"`. Evidence: the official OpenCode Go docs endpoint
table (https://opencode.ai/docs/go/, fetched 2026-08-14) lists every
`@ai-sdk/anthropic` model (minimax-m2.5, minimax-m2.7, minimax-m3, qwen3.6-plus,
qwen3.7-max, qwen3.7-plus, qwen3.8-max) with endpoint
`https://opencode.ai/zen/go/v1/messages`. The `@ai-sdk/anthropic` client appends
`/v1/messages` to its configured base URL, so the correct SDK base URL is the
endpoint minus `/v1/messages`: `https://opencode.ai/zen/go`. The current
models.dev snapshot carries no per-model `provider.api` override for these
models, so the doc-evidenced value lives in the patch layer.

The models.dev provider-level `api` (`https://opencode.ai/zen/go/v1`) remains
the base URL for `openai-responses` and `openai-completions` models; the
`@ai-sdk/openai` / `@ai-sdk/openai-compatible` clients append their own
`/responses` / `/chat/completions` paths.
