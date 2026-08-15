/**
 * Task 9 repository credential scan — re-exports the ONE shared implementation
 * in `scripts/scan-secrets.mjs` so the vitest harness and the CLI/CI gate can
 * never drift. The scanner enumerates every tracked + untracked non-ignored
 * repository file, iterates every regex match (not just RegExp.test),
 * allowlists known fixture-only fake literals by exact file-scoped SHA-256
 * digests, and emits only `relative-path category` pairs.
 */
export {
  ALLOWED_FIXTURES,
  SECRET_PATTERNS,
  enumerateRepoFiles,
  formatHit,
  safePath,
  scanContent,
  scanFileEntry,
  scanRepo,
  sha256Hex,
} from "../../scripts/scan-secrets.mjs";
export type { SecretPattern } from "../../scripts/scan-secrets.mjs";
