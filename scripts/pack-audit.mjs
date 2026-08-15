/**
 * Shared packed-bytes audit for the Task 8 release candidate.
 *
 * One implementation consumed by BOTH the vitest harness
 * (`tests/helpers/pack-audit.ts` re-exports it) and the `pack:check` CI gate
 * (`scripts/check-pack.mjs` imports it directly), so the two can never drift.
 * Tar-member validation and safe extraction live in `pack-tar.mjs`.
 *
 * The audit walks the EXTRACTED TREE with `lstat`: every symlink, hardlink,
 * socket, FIFO or device entry is rejected (never silently skipped), the
 * strict allowlist applies to every extracted relative path, the six fixed
 * lib files and exactly one `control-<hash>.js` chunk are required, and all
 * allowed text bytes are scanned for private `/src` imports (any syntax),
 * provider-shaped secrets and machine paths.
 */
import { readFileSync, readdirSync, readlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { extractTarballSafe } from "./pack-tar.mjs";

/** The six fixed lib files every packed artifact must ship. */
const FIXED_LIB = [
  "lib/index.js",
  "lib/index.d.ts",
  "lib/client.js",
  "lib/client.d.ts",
  "lib/bin.js",
  "lib/bin.d.ts",
];

/** Every required packed file (metadata, license, patch, catalog, fixed lib). */
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "cordis.patch.yml",
  ...FIXED_LIB,
  "catalog/models.json",
  "catalog/patches.json",
  "catalog/deprecated.json",
  "catalog/quarantine.json",
];

/** Strict packed-file allowlist: metadata, license, patch, catalog, fixed lib
 * plus exactly one `control-<safe-hash>.js` shared chunk. */
export function isAllowedPath(path) {
  if (
    path === "package.json"
    || path === "README.md"
    || path === "LICENSE"
    || path === "THIRD_PARTY_NOTICES.md"
    || path === "cordis.patch.yml"
  ) {
    return true;
  }
  if (FIXED_LIB.includes(path)) return true;
  if (/^lib\/control-[A-Za-z0-9_-]+\.js$/.test(path)) return true;
  if (/^catalog\/(?:models|patches|deprecated|quarantine)\.json$/.test(path)) return true;
  return false;
}

/** The only directories that can contain allowlisted files. */
function isAllowedDir(path) {
  return path === "lib" || path === "catalog";
}

/** Filename patterns that must never appear in the packed artifact. */
const FORBIDDEN_PATH = /(^|\/)(?:\.env(?:\.|$)|\.git|node_modules|tests?|scripts?|src|fixtures|evidence|cache|auth)(?:\/|$)|auth\.json$|credential|token|synthetic-unknown-live-probe|\.tgz$/iu;

/**
 * Content patterns for real-looking secrets and credential sentinels.
 * Assignment-shaped only: a bare variable-name declaration without a value
 * (e.g. `const apiKeyEnv = "OPENCODE_GO_API_KEY"`) never matches.
 */
const SECRET_PATTERNS = [
  /sk-[a-z0-9]{16,}/iu,
  /go_live_[a-z0-9]{16,}/iu,
  /OPENCODE_GO_API_KEY\s*[:=]\s*["']?[^"'\s]{8,}/iu,
  /authorization\s*[:=]\s*bearer\s+\S+/iu,
  /bearer\s+[a-z0-9._-]{16,}/iu,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/iu,
  /(?:access[_-]?token|auth[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[a-z0-9._-]{16,}/iu,
  /dsh-t8-test-sentinel-key/iu,
];

/** Machine/DSH-state paths; calibrated to skip documented relative paths. */
const PATH_PATTERNS = [
  /\/Users\/[^"'\s]*/iu,
  /\/home\/[^"'\s]*/iu,
  /\/private\/[^"'\s]+\/[^"'\s]+/iu,
  /\.dsh\/[^"'\s]*/iu,
  /C:\\Users\\[^"'\s]*/iu,
  /\/var\/folders\/[^"'\s]*/iu,
  /\/tmp\/[^"'\s]*/iu,
];

/** Any literal private package `/src` path, regardless of import syntax. */
const PRIVATE_IMPORT = /@deepseek-ai\/[^"'\s]*\/src\//iu;

/**
 * @typedef {Object} TarballAudit
 * @property {string[]} packedPaths - every extracted relative path.
 * @property {string[]} allowlistViolations - paths outside the strict allowlist.
 * @property {string[]} archiveViolations - tar member / extraction-root violations.
 * @property {string[]} missingRequired - required packed files that are absent.
 * @property {string[]} controlChunkViolations - control-chunk count != 1.
 * @property {string[]} secretHits - content matching a secret pattern.
 * @property {string[]} pathHits - content matching a machine-path pattern.
 * @property {string[]} privateImportHits - content with a private `/src` path.
 * @property {string[]} specialEntries - symlink/hardlink/special entries.
 */

/**
 * Audit the exact packed bytes: strict allowlist plus secret/path/import
 * scans over the extracted tree, rejecting every non-regular entry and
 * requiring the fixed lib set plus one control chunk.
 * @param {string} tarball - the exact generated tarball path.
 * @param {string} workDir - a writable temp dir for extraction.
 * @returns {Promise<TarballAudit>}
 */
export async function auditTarball(tarball, workDir) {
  const extractDir = join(workDir, "audit-extract");
  const pkgDir = extractTarballSafe(tarball, extractDir);
  const packedPaths = [];
  const allowlistViolations = [];
  const secretHits = [];
  const pathHits = [];
  const privateImportHits = [];
  const specialEntries = [];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      const stats = lstatSync(abs);
      if (stats.isSymbolicLink()) {
        packedPaths.push(rel);
        specialEntries.push(`${rel}: symlink -> ${readlinkSync(abs)}`);
        if (!isAllowedPath(rel) || FORBIDDEN_PATH.test(rel)) allowlistViolations.push(rel);
        continue;
      }
      if (stats.isDirectory()) {
        packedPaths.push(`${rel}/`);
        if (!isAllowedDir(rel) || FORBIDDEN_PATH.test(rel)) allowlistViolations.push(rel);
        walk(abs, rel);
        continue;
      }
      if (!stats.isFile()) {
        packedPaths.push(rel);
        specialEntries.push(`${rel}: special`);
        if (!isAllowedPath(rel) || FORBIDDEN_PATH.test(rel)) allowlistViolations.push(rel);
        continue;
      }
      if (stats.nlink > 1) {
        packedPaths.push(rel);
        specialEntries.push(`${rel}: hardlink`);
        if (!isAllowedPath(rel) || FORBIDDEN_PATH.test(rel)) allowlistViolations.push(rel);
        continue;
      }
      packedPaths.push(rel);
      if (!isAllowedPath(rel) || FORBIDDEN_PATH.test(rel)) allowlistViolations.push(rel);
      const content = readFileSync(abs).toString("utf8");
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) secretHits.push(`${rel}: ${String(pattern)}`);
      }
      for (const pattern of PATH_PATTERNS) {
        if (pattern.test(content)) pathHits.push(`${rel}: ${String(pattern)}`);
      }
      if (PRIVATE_IMPORT.test(content)) privateImportHits.push(rel);
    }
  };
  walk(pkgDir, "");
  const missingRequired = REQUIRED.filter((path) => !packedPaths.includes(path));
  const controlChunks = packedPaths.filter((path) => /^lib\/control-[A-Za-z0-9_-]+\.js$/.test(path));
  const controlChunkViolations = controlChunks.length === 1
    ? []
    : [`expected exactly one lib/control-<hash>.js chunk, found ${controlChunks.length}`];
  return {
    packedPaths,
    allowlistViolations,
    archiveViolations: [],
    missingRequired,
    controlChunkViolations,
    secretHits,
    pathHits,
    privateImportHits,
    specialEntries,
  };
}

/** Fail the release candidate unless the packed bytes pass every audit gate. */
export function assertAuditClean(audit) {
  const problems = [];
  if (audit.archiveViolations.length > 0) {
    problems.push(`archive violations: ${audit.archiveViolations.join(", ")}`);
  }
  if (audit.allowlistViolations.length > 0) {
    problems.push(`allowlist violations: ${audit.allowlistViolations.join(", ")}`);
  }
  if (audit.specialEntries.length > 0) {
    problems.push(`special entries: ${audit.specialEntries.join(", ")}`);
  }
  if (audit.missingRequired.length > 0) {
    problems.push(`missing required files: ${audit.missingRequired.join(", ")}`);
  }
  if (audit.controlChunkViolations.length > 0) {
    problems.push(`control chunk: ${audit.controlChunkViolations.join(", ")}`);
  }
  if (audit.secretHits.length > 0) problems.push(`secret hits: ${audit.secretHits.join(", ")}`);
  if (audit.pathHits.length > 0) problems.push(`path hits: ${audit.pathHits.join(", ")}`);
  if (audit.privateImportHits.length > 0) {
    problems.push(`private /src imports: ${audit.privateImportHits.join(", ")}`);
  }
  if (problems.length > 0) throw new Error(`packed artifact audit failed: ${problems.join("; ")}`);
}
