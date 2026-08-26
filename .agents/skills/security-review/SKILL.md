---
name: security-review
description: Review changes for credential leakage, unsafe network behavior, unsanitized errors, protocol mistakes, and supply-chain/packaging regressions.
---

# Security review

Check the changed surface for:

- real credentials, tokens, cookies, machine paths, or secret-like fixtures;
- direct credential reads that bypass the DSH credentials service;
- logging/rendering of keys, upstream bodies, URLs, local paths, or injected errors;
- new live-network behavior in tests or CI;
- protocol selection inferred from model names rather than catalog metadata;
- private `@deepseek-ai/*/src/*` imports or unverified dependencies;
- unsafe TypeScript escapes (`any`, unsafe casts, ignore directives);
- changes that weaken secret scanning, packaging checks, CI permissions, or live-smoke opt-in controls.

Run `pnpm run scan:secrets` when a shell is available. Prefer the `reviewer` agent for an independent read-only pass. Findings should include severity, evidence, and the smallest remediation.