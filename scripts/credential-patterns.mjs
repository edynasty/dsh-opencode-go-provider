/**
 * Shared credential-pattern source for the repository secret scan
 * (`scripts/scan-secrets.mjs`) and the packed-bytes audit
 * (`scripts/pack-audit.mjs`). One definition, consumed by both gates, so the
 * repository scan and the tarball audit can never drift on credential
 * classes.
 *
 * The `dsh-t8-test-sentinel-key` category is intentionally NOT here: its
 * literal appears in pack-audit.mjs itself, which the repository scanner must
 * not self-match. pack-audit adds it locally.
 */

/** Credential categories with bounded, assignment-aware patterns. The
 * api-key-assignment pattern accepts BOTH quoted field names (JSON/TOML
 * `"OPENCODE_GO_API_KEY" = ...`), unquoted assignments (`.env`, shell
 * `export`, JS `const`/`process.env` hardcoding) and bracket-notation
 * assignments (`process.env["OPENCODE_GO_API_KEY"] = ...` with paired
 * quotes), with a value of at least 8 characters that is not the field name
 * itself. Reads without an assignment (`process.env.OPENCODE_GO_API_KEY`,
 * `process.env["..." ]`), empty/short values and the field name used as a
 * plain string value never match. */
export const CREDENTIAL_PATTERNS = [
  {
    category: "openai-key",
    pattern: /sk-(?:proj-)?[a-z0-9_-]{16,}/iu,
  },
  {
    category: "go-live-key",
    pattern: /go_live_[a-z0-9]{16,}/iu,
  },
  {
    category: "api-key-assignment",
    pattern: /["']?OPENCODE_GO_API_KEY["']?\s*[:=]\s*(?!["']?OPENCODE_GO_API_KEY["']?(?:[;\n]|$))["']?[^"'\s]{8,}|["']OPENCODE_GO_API_KEY["']\]\s*=\s*(?!["']?OPENCODE_GO_API_KEY["']?(?:[;\n]|$))["']?[^"'\s]{8,}/iu,
  },
  {
    category: "github-pat",
    pattern: /ghp_[a-z0-9]{36,}/iu,
  },
  {
    category: "github-token",
    pattern: /github_pat_[a-z0-9_]{22,}/iu,
  },
  {
    category: "aws-key",
    pattern: /AKIA[0-9A-Z]{16}/iu,
  },
  {
    category: "google-key",
    pattern: /AIza[0-9A-Za-z_-]{35}/iu,
  },
  {
    category: "slack-token",
    pattern: /xox[baprs]-[0-9A-Za-z-]{10,}/iu,
  },
  {
    category: "bearer-header",
    pattern: /authorization\s*[:=]\s*bearer\s+\S+/iu,
  },
  {
    category: "bearer-token",
    pattern: /bearer\s+[a-z0-9._-]{16,}/iu,
  },
  {
    category: "jwt-token",
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/iu,
  },
  {
    category: "access-token",
    pattern: /(?:access|auth|refresh)[_-]?token\s*[:=]\s*["']?[a-z0-9._-]{16,}/iu,
  },
  {
    category: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  },
];
