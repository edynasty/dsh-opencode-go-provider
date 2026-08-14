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

License texts of runtime peers are reproduced in their own package manifests
and in this repository's `LICENSE` where applicable.

## pi-opencode-go-provider (MIT)

The catalog and reconciliation machinery in this repository
(`src/catalog.ts`, `src/reconcile.ts`, `scripts/update-models.ts`) is an
independent implementation. Its algorithm design — stale-while-revalidate
sourcing (committed catalog + live ids), the 14-day deprecation grace period
with first-transition timestamps, quarantine of unknown ids, and the
patch-on-top override layer — is inspired by the upstream project
`pi-opencode-go-provider` (https://github.com/monotykamary/pi-opencode-go-provider).
No upstream source code is copied; the MIT license is reproduced below as
required by its terms:

```
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Model metadata is sourced from OpenCode's models.dev
(`https://models.opencode.ai/api.json`); only the `opencode-go` provider record
is retained, as a frozen fixture, and the full API payload is not redistributed.
