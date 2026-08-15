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
import { CREDENTIAL_PATTERNS } from "./credential-patterns.mjs";

/** The six fixed lib files every packed artifact must ship. */
const FIXED_LIB = [
  "lib/index.js",
  "lib/index.d.ts",
  "lib/client.js",
  "lib/client.d.ts",
  "lib/bin.js",
  "lib/bin.d.ts",
];

/** Every required packed file (metadata, license, patch, catalog, fixed lib).
 * README.zh.md is included because npm pack automatically ships every
 * `README*` file regardless of the `files` allowlist (npm hardcoded
 * convention), so the audit must match the actual packed bytes. */
const REQUIRED = [
  "package.json",
  "README.md",
  "README.zh.md",
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
 * plus exactly one `control-<safe-hash>.js` shared chunk. README* variants
 * are allowlisted because npm pack ships every README* file automatically. */
export function isAllowedPath(path) {
  if (
    path === "package.json"
    || path === "README.md"
    || path === "README.zh.md"
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
 * Content patterns for real-looking secrets and credential sentinels. The
 * credential classes are the SHARED source (`scripts/credential-patterns.mjs`,
 * also consumed by the repository scanner), so the two gates cannot drift;
 * `dsh-t8-test-sentinel-key` is tarball-only because its literal lives in
 * this file.
 */
const SECRET_PATTERNS = [
  ...CREDENTIAL_PATTERNS.map((entry) => entry.pattern),
  /dsh-t8-test-sentinel-key/iu,
];

/**
 * Decode packed bytes with strict UTF-8 semantics; non-text content (NUL,
 * invalid UTF-8, UTF-16 BOM) is reported as a fixed `non-text` secret hit
 * instead of silently scanning replacement-character garbage.
 */
function decodePackedText(buffer, rel) {
  if (buffer.includes(0)) return { kind: "non-text" };
  if (
    (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    || (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff)
  ) {
    return { kind: "non-text" };
  }
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { kind: "non-text" };
  }
  return { kind: "text", content, rel };
}

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
      const decoded = decodePackedText(readFileSync(abs), rel);
      if (decoded.kind === "non-text") {
        secretHits.push(`${rel}: non-text`);
        continue;
      }
      const content = decoded.content;
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
