/**
 * Task 8 packed-bytes audit — re-exports the ONE shared implementation in
 * `scripts/pack-audit.mjs` (plus the tar validation in `scripts/pack-tar.mjs`)
 * so the vitest harness and the `pack:check` CI gate can never drift. The
 * audit validates the tar member list before extraction, walks the extracted
 * tree with `lstat` (symlinks/hardlinks/special entries rejected, strict
 * allowlist on every path, fixed lib set + one control chunk required) and
 * scans all allowed text bytes for private `/src` imports, provider-shaped
 * secrets and machine paths.
 */
export { assertAuditClean, auditTarball, isAllowedPath } from "../../scripts/pack-audit.mjs";
export { extractTarballSafe, validateTarMembers } from "../../scripts/pack-tar.mjs";
export type { TarballAudit } from "../../scripts/pack-audit.mjs";
