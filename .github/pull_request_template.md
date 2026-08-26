## Summary

<!-- What changed and why? -->

## Verification

- [ ] Focused tests added/updated where behavior changed
- [ ] `pnpm run typecheck`
- [ ] `pnpm run check`
- [ ] `git diff --exit-code -- lib` after rebuild, or generated-output change explained
- [ ] `pnpm run scan:secrets` for security/package-sensitive changes
- [ ] GitHub Actions green

## Contract review

- [ ] No real credentials, machine paths, private imports, or live-network CI behavior
- [ ] Errors remain sanitized and stable
- [ ] Protocol selection remains catalog-driven
- [ ] Production modules remain below the repository LOC ceiling
- [ ] README.md and README.zh.md updated together if user-facing behavior changed
- [ ] Third-party attribution remains correct

## Agent evidence

<!-- If an agent performed the work, list skills/agents used, CI iterations, and anything not verified. -->