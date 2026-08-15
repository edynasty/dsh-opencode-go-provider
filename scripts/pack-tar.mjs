/**
 * Shared tar-member validation and safe extraction for the Task 8 release
 * candidate. Consumed by the shared audit (`pack-audit.mjs`), the vitest
 * harness and the `pack:check` CI gate.
 *
 * The tar MEMBER LIST is validated BEFORE extraction: absolute paths, `..`
 * traversal, backslash/drive-root escapes, empty/control names and any member
 * outside the single `package/` root are rejected, so no path traversal can
 * write outside the owned temp root. After extraction the root must hold
 * exactly one real `package` directory.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * List and validate every tar member BEFORE extraction: reject absolute
 * paths, `..` traversal, backslash/drive-root escapes, empty/control names
 * and any member outside the single `package/` root.
 * @param {string} tarball - the exact generated tarball path.
 */
export function validateTarMembers(tarball) {
  const result = spawnSync("tar", ["-tzf", tarball], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`tar listing failed: ${(result.stderr ?? "").trim().slice(0, 500)}`);
  }
  const members = result.stdout.split("\n").filter((line) => line !== "");
  for (const member of members) {
    if (member.startsWith("/") || /^[A-Za-z]:[\\/]/.test(member) || member.startsWith("\\")) {
      throw new Error(`tar member is an absolute/escaped path: ${member}`);
    }
    if (member.split("/").includes("..")) {
      throw new Error(`tar member contains .. traversal: ${member}`);
    }
    if (member === "" || /[\x00-\x1f]/.test(member)) {
      throw new Error(`tar member has an empty/control name`);
    }
    if (member !== "package" && !member.startsWith("package/")) {
      throw new Error(`tar member is outside the single package/ root: ${member}`);
    }
  }
}

/** Verify the extraction root holds exactly one real `package` directory. */
function validateExtractionRoot(extractDir) {
  const entries = readdirSync(extractDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  const others = entries.filter((entry) => !entry.isDirectory());
  if (dirs.length !== 1 || dirs[0]?.name !== "package" || others.length > 0) {
    throw new Error(`extraction root must contain exactly one directory "package" and nothing else`);
  }
}

/**
 * Validate the tar member list, extract into `destDir`, verify the extraction
 * root, and return the package dir. Every throw leaves no partial extraction
 * behind the caller's cleanup.
 * @param {string} tarball - the exact generated tarball path.
 * @param {string} destDir - a writable owned temp dir.
 * @returns {string} the extracted `package` directory.
 */
export function extractTarballSafe(tarball, destDir) {
  validateTarMembers(tarball);
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarball, "-C", destDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed: ${(result.stderr ?? "").trim().slice(0, 500)}`);
  }
  validateExtractionRoot(destDir);
  return join(destDir, "package");
}
