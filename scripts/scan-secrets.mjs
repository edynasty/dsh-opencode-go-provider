#!/usr/bin/env node
/**
 * scan-secrets — deterministic repository/package credential scan (Task 9).
 *
 * Enumerates EVERY tracked plus untracked non-ignored repository file via
 * `git ls-files --cached --others --exclude-standard` (the same surface CI
 * sees after commit), lstat-checks every entry (symlink/special/non-regular
 * entries are reported with a fixed category, never followed or silently
 * skipped), iterates EVERY regex match per file (never stopping at
 * RegExp.test), and reports any match whose value is not allowlisted for that
 * exact file by SHA-256 digest. A regular file that cannot be read is
 * reported as a fixed `read-error` category — reading failures never pass
 * silently.
 *
 * ALLOWLISTING: known fixture-only fake literals are allowed ONLY by exact
 * file-scoped SHA-256 digests of the matched substring — never by the word
 * "fake"/"sentinel", never by a tests/ path prefix, never by category alone,
 * and never as plaintext. A token copied from an approved fixture into
 * src/ has a different file scope and is rejected.
 *
 * SAFETY: output is `<relative-path> <fixed-category>` pairs ONLY. Matching
 * values, lines, byte offsets, digests and surrounding context are never
 * emitted — a pattern hit fails the scan with the file and category, and the
 * CI log can never contain a leaked secret.
 *
 * The scan covers tests/**, lib/**, scripts, docs, workflows, catalog,
 * configs, the lockfile and package metadata. Only infrastructure that cannot
 * be repository content is excluded: `.git` and `node_modules` (both ignored
 * by the enumeration itself) and the scanner's own allowlist digests.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_PATTERNS } from "./credential-patterns.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Fixed category labels — never the matched text. The pattern table is the
 * SHARED source (`scripts/credential-patterns.mjs`) consumed by both the
 * repository scanner and the tarball audit, so credential classes cannot
 * drift. The pack-audit `dsh-t8-test-sentinel-key` category stays tarball-only
 * (its literal appears in pack-audit.mjs itself, which this scanner must not
 * self-match). */
const SECRET_PATTERNS = CREDENTIAL_PATTERNS;

/**
 * Known fixture-only fake literals, keyed by exact repository-relative file.
 * Each entry is the SHA-256 hex digest of the matched substring, so the
 * plaintext is never stored in the scanner. Digests were recomputed
 * mechanically from the actual matched substrings under the expanded pattern
 * set; a new unallowlisted token in the same file fails because its digest is
 * not in the file's set.
 */
const ALLOWED_FIXTURES = {
  "tests/bin.spec.ts": ["7ae1a85bd23dc8610ae95834764773a43882de1606a9ed405d805278d3fc6c5f"],
  "tests/cache.spec.ts": [
    "028e610cec553fa68e45cfe7947505737cc65116209558d110975a98e4972de3",
    "0ea80b2bdff6b5725538b7d894555659014ff12c87b76d694b3a39b2dd2028c1",
    "399d1ba02f97d284a24bff939496dad4fcfc809a23c293bc82722d29be63e3a6",
    "5388636cd8c488d23c7dd8c4706a8f13e5563939ece4f4cdbb6dca76a4a21b11",
    "f98d6603d8da4890d06f26a0ecd077554ef658f9ddae55972c4959496be4e66b",
  ],
  "tests/commands.spec.ts": [
    "0ae25505c2ec0427a4836885d936e1aac2445491ce90e747daeb049fea0ba6be",
    "7ae1a85bd23dc8610ae95834764773a43882de1606a9ed405d805278d3fc6c5f",
    "834d630d5edf2d49f8abb192eb4470a3d92d6f8b86b34f1085d9dd3b4b8bca84",
    "8e71a5026a160a0b17da0ae278f300ddc1f1d7de4d1381b47adae959280f19af",
    "fabd03a2e4640023408fadf6de266a686fb98af47637dc8a43b91587b797cd72",
  ],
  "tests/config.spec.ts": [
    "4fa3742e573f3ed78c8f6ab471202946c299c5ba157ff35fba34b382e6500280",
    "f7b26024049dca128ee45a659cff97afb84c1e756f26cb92f3f55fd37916b5c6",
  ],
  "tests/connect-card.client.spec.tsx": ["8ab0da995829a330fc5502df11afa0b5c8cd1b65215b5f4c9f97f0c68b0d9c62"],
  "tests/connect-remote.client.spec.ts": [
    "62659f485516ff97a08dbdd1bd2fe492b69fa4dfa08c1d858c6f9e3b52bcb3c7",
    "e8432d76bbecbed25c450b2bbbfa9d6d0cb23d8584971795b7bf79079fc06015",
  ],
  "tests/control.spec.ts": [
    "4d80838acae7b545cf836faeabc7959521012935c9f4c98cc6043f8cb6b2d2f6",
    "95161b473c0e402f84f7bc7c5c7bef8018dcdbcee3b82f9285f250f5be165b71",
  ],
  "tests/credentials.spec.ts": [
    "3ac94e826264bd54d387ee6e2b2dce6cdf5192f7c2058f51abc9fad4f69fae27",
    "94892f07d596f5d587746c309588bc162ea4408f857f8f169df145603c7374f7",
    "c144a7dc430e266d80bf9d7c7448c2b9e1b52d829913d94e4591257f7e89ae8e",
  ],
  "tests/directory-catalog.spec.ts": [
    "3ac94e826264bd54d387ee6e2b2dce6cdf5192f7c2058f51abc9fad4f69fae27",
    "c144a7dc430e266d80bf9d7c7448c2b9e1b52d829913d94e4591257f7e89ae8e",
  ],
  "tests/disposal-duplicates.spec.ts": ["a354bda9337d0ef89b5392ebbf3cd95daff2260477e36bf03398f62bd612e074"],
  "tests/doctor.spec.ts": [
    "421b573e8e1603518d389c67688dc2cad9c72a28b497a3c0256c7ceb2377e377",
    "9c8e183fd4001477342cdab1b4a5033807f13cb15629dec701017cb39ec51982",
    "d37b83cd2edd3b406e92494b54b0ae2cd58026d73c4fd455e91c83ae90809a3e",
  ],
  "tests/helpers/adapter-fixtures.ts": ["275fcb6a44d6f90ac341008e97f865bb8ae6ba8a44f66d0f1d67cacb00eea6b6"],
  "tests/helpers/host-loader.ts": ["55495bfa12c4a81c6a2cb82477463a4f070055547f96bbd3cd0bc794470d6e02"],
  "tests/helpers/mock-server.ts": ["7e98f35b514b8467d8fd98e5615939e03aaf5e9e0fed01478d77d340777c9f62"],
  "tests/helpers/release-candidate-harness.ts": [
    "726a793d4c841dd48fb8fba34e227225dacf8735fa160995137769fb9a068a3d",
    "d1a2a3a6239b6e922118820f939f1735d2156f3faa82848b415d53a21fdf655b",
  ],
  "tests/lifecycle.spec.ts": ["93a6e4a4679b8fa4d3e72d57370fe62e09b1a20c5328c40d010b11b828afc3f2"],
  "tests/migration.spec.ts": ["1dfdb0a88994e60b1832131a2094b2de4e682d171736e0d48dee3492ec48492a"],
  "tests/service-lifecycle.spec.ts": [
    "95161b473c0e402f84f7bc7c5c7bef8018dcdbcee3b82f9285f250f5be165b71",
    "da488c1b816a08cdce664a274f30d29446af3c8350e7afed0489eac40a554a60",
  ],
  "tests/settings-lifecycle.spec.ts": ["77d3938d19684877e68fff4ca92f55c02cc793bca7512f4f26b902efe5bdf6ce"],
  "tests/sync.spec.ts": [
    "73475c84af49385872a1c93f58a3a8536352a0c6db19048165d0582ba2d428ea",
    "9c579b8a2638f9d811ae79ff5ec5f6ede7c0ae098426032da77b74947324abe5",
    "f98d6603d8da4890d06f26a0ecd077554ef658f9ddae55972c4959496be4e66b",
  ],
  "tests/web-routes.spec.ts": [
    "3fd6b95b6d1d02e12e33c3dd58ea975fdf58fecd79cdabe9e25da5d0a6efd60e",
    "98cfb0ec0f7f6776e555b716e852e9783607675aeeea8099e1f19d8ec2b0b90c",
  ],
};

/** SHA-256 hex digest of a value. */
function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Fixed `<relative-path> <category>` output; never contains the value. */
function formatHit(file, category) {
  return `${file} ${category}`;
}

const SAFE_PRINTABLE = /^[ -~]+$/u;

/**
 * Sanitize a path for deterministic, injection-safe output. A path that is
 * entirely printable ASCII and does not embed a workflow-command fragment is
 * checked against the SHARED credential patterns: a secret-shaped path
 * (e.g. a `sk-...` basename or an assignment-shaped filename) is replaced by
 * a fixed digest placeholder so the raw secret-shaped name is never emitted.
 * Any control character or non-printable byte is likewise replaced.
 */
function safePath(path) {
  if (!SAFE_PRINTABLE.test(path) || path.includes("::")) {
    return `<path:${sha256Hex(path).slice(0, 16)}>`;
  }
  for (const { pattern } of SECRET_PATTERNS) {
    if (pattern.test(path)) {
      return `<path:${sha256Hex(path).slice(0, 16)}>`;
    }
  }
  return path;
}

/**
 * Decode repository bytes with strict UTF-8 semantics. Any NUL byte, invalid
 * UTF-8 sequence, UTF-16 signature or otherwise non-text content returns
 * undefined — callers report a fixed `non-text` category instead of scanning
 * replacement-character garbage or silently passing binary.
 */
function decodeStrictUtf8(buffer) {
  if (buffer.includes(0)) return undefined;
  // UTF-16 BOM signatures (LE/BE).
  if (
    (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    || (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff)
  ) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

/**
 * Verify that `file` is a regular file INSIDE `root` with no symlink on any
 * path segment and no hard link. Returns `{ kind: "ok", stats }` or a
 * fail-closed `{ kind: "non-regular" | "outside-root" | "read-error" }`.
 */
function checkRegularInsideRoot(file, root) {
  let stats;
  try {
    stats = lstatSync(file);
  } catch {
    return { kind: "read-error" };
  }
  if (stats.isSymbolicLink()) {
    return { kind: "non-regular" };
  }
  if (!stats.isFile() || stats.nlink > 1) {
    return { kind: "non-regular" };
  }
  // The canonical target must stay inside the canonical root.
  let rootReal;
  let fileReal;
  try {
    rootReal = realpathSync(root);
    fileReal = realpathSync(file);
  } catch {
    return { kind: "read-error" };
  }
  if (!fileReal.startsWith(`${rootReal}/`) && fileReal !== rootReal) {
    return { kind: "outside-root" };
  }
  // Every ancestor segment must be a real directory; a symlink ancestor can
  // redirect outside root and is rejected.
  const rootResolved = resolve(root);
  let cursor = resolve(file);
  while (cursor !== rootResolved) {
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    let pstats;
    try {
      pstats = lstatSync(parent);
    } catch {
      return { kind: "read-error" };
    }
    if (pstats.isSymbolicLink()) {
      return { kind: "non-regular" };
    }
    if (!pstats.isDirectory()) {
      return { kind: "non-regular" };
    }
    cursor = parent;
  }
  return { kind: "ok", stats };
}

/**
 * Scan ONE repository entry with fail-closed semantics. Non-text content
 * (NUL, invalid UTF-8, UTF-16) is reported as a fixed `non-text` category.
 * A symlink on any path segment, a hard link, or a resolution outside the
 * root is reported as `non-regular` / `outside-root` — never followed and
 * never skipped. An unreadable regular file is a fixed `read-error`. Returns
 * formatted hits only (file + category), never content.
 */
function scanFileEntry(file, root, allowedFixtures = ALLOWED_FIXTURES) {
  const rel = safePath(relative(root, file));
  const checked = checkRegularInsideRoot(file, root);
  if (checked.kind !== "ok") {
    const category = checked.kind === "outside-root" ? "non-regular" : checked.kind;
    return [formatHit(rel, category)];
  }
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return [formatHit(rel, "read-error")];
  }
  const content = decodeStrictUtf8(buffer);
  if (content === undefined) {
    return [formatHit(rel, "non-text")];
  }
  const allowed = allowedFixtures[rel] ?? [];
  return scanContent(content, rel, allowed);
}

/**
 * Scan one file's content for every regex match. Returns formatted hits
 * (file + category only). A match is allowed only when its SHA-256 digest is
 * present in `allowedDigests` (the digest set scoped to THIS file).
 *
 * Each pattern is cloned with the `g` flag so exec() advances lastIndex
 * across matches; without `g`, exec() resets lastIndex and the loop would
 * re-report the first match forever.
 */
function scanContent(content, file, allowedDigests = [], patterns = SECRET_PATTERNS) {
  const hits = [];
  const allowed = new Set(allowedDigests);
  for (const { category, pattern } of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags.replaceAll("g", "")}g`);
    let match;
    while ((match = global.exec(content)) !== null) {
      if (!allowed.has(sha256Hex(match[0]))) {
        hits.push(formatHit(file, category));
      }
      if (match[0].length === 0) global.lastIndex += 1;
    }
  }
  return hits;
}

/** Enumerate every tracked + untracked non-ignored file under `root`. */
function enumerateRepoFiles(root) {
  const out = execFileSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\0")
    .filter((p) => p.length > 0)
    .map((p) => join(root, p));
}

/**
 * Scan the whole repository. Returns formatted hits (string array) and the
 * enumerated file count (number).
 */
function scanRepo(root) {
  const files = enumerateRepoFiles(root);
  const hits = [];
  for (const file of files) {
    hits.push(...scanFileEntry(file, root));
  }
  return { hits, files: files.length };
}

function isCliEntry() {
  if (process.argv[1] === undefined) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function main() {
  const { hits, files } = scanRepo(REPO_ROOT);
  if (hits.length > 0) {
    // Fixed file/category pairs only — never the matched content.
    for (const hit of hits) process.stderr.write(`secret scan hit: ${hit}\n`);
    process.stderr.write(`credential scan failed: ${hits.length} hit(s)\n`);
    process.exit(1);
  }
  process.stdout.write(`credential scan clean (${files} files)\n`);
  process.exit(0);
}

if (isCliEntry()) {
  main();
}

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
};
