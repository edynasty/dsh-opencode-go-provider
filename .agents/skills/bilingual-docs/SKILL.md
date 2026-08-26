---
name: bilingual-docs
description: Keep English and Simplified Chinese user documentation synchronized without breaking repository documentation contracts.
---

# Bilingual documentation

1. Determine whether the change affects installation, configuration, behavior, models/protocols, diagnostics, credentials, or limitations.
2. Update `README.md` and `README.zh.md` together with equivalent meaning.
3. Preserve contract-sensitive facts: npm-unpublished status, non-affiliation, credential boundary, supported protocols, and pinned-install semantics.
4. Do not invent provider capabilities or support claims.
5. Run `pnpm run docs-contract` when a shell is available.
6. Ask the `docs` agent for a consistency pass when multi-agent support is available.