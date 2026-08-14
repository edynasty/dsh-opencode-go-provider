# Third-Party Notices

`dsh-opencode-go-provider` is an independent bundle for DeepSeek Harness and
is not affiliated with DeepSeek or OpenCode. This package is installed into a
DSH profile and links against the following runtime packages, which are
declared as `peerDependencies` and distributed under their own licenses:

| Package | License | Copyright |
| --- | --- | --- |
| DeepSeek Harness (`@deepseek-ai/*`, DSH rc.6) | MIT | (c) 2026 DeepSeek |
| `@deepseek-ai/cordis` | MIT | per its package manifest |
| `cordis` | MIT | per its package manifest |
| `@deepseek-ai/schemastery` | MIT | per its package manifest |
| `@earendil-works/pi-ai` | MIT | per its package manifest |
| `react` | MIT | (c) Meta Platforms |

The bundle contract, packaging layout and client-injection declarations follow
the public patterns of the following projects (pattern reference only; no code
is copied):

- `dsh-codex-connect` (Apache-2.0) — bundle manifest and client-injection shape.
- `pi-opencode-go-provider` (MIT, (c) 2025) — OpenCode Go provider and model
  metadata reconciliation approach used by later catalog work.

Model metadata reconciliation in later releases retains upstream MIT copyright
notice here. License texts of runtime peers are reproduced in their own package
manifests and in this repository's `LICENSE` where applicable.
