/**
 * Task 8 bundle-contract gate: validate a packed tarball's DSH bundle
 * contract and packed bytes BEFORE any profile mutation, and return the
 * validated manifest patch path for activation. Rejection names the exact
 * broken seam (wrong row, invalid client JS, missing export target, wrong
 * patch pointer, missing client, corrupted patch, audit violations).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assertAuditClean, auditTarball, extractTarballSafe } from "./pack-audit.ts";
import { PACKAGE_NAME, REPO_ROOT } from "./release-candidate-subprocess.ts";
import { isRecord, isString } from "./type-guards.ts";

/** The exact expected bundle row the patch must declare, and nothing else. */
const EXPECTED_ROW = { id: "llm-opencode-go", name: PACKAGE_NAME } as const;
/** The exact expected manifest patch pointer. */
const EXPECTED_PATCH = "./cordis.patch.yml";

/**
 * Non-authoritative row projection for dump display only. The activation
 * contract NEVER depends on this lossy projection — it uses
 * {@link validatePatchStructure}.
 */
export function bundleRowsOf(patch: unknown): readonly { readonly id: string; readonly name: string }[] {
  const rows: { readonly id: string; readonly name: string }[] = [];
  if (!Array.isArray(patch)) return rows;
  for (const op of patch) {
    if (!isRecord(op) || !Array.isArray(op.insert)) continue;
    for (const row of op.insert) {
      if (isRecord(row) && isString(row.id) && isString(row.name)) {
        rows.push({ id: row.id, name: row.name });
      }
    }
  }
  return rows;
}

/**
 * Strict full-structure patch validation for activation: top-level is an
 * array of exactly one operation; the operation has exactly one key `insert`;
 * `insert` is an array of exactly one row; the row has exactly two keys `id`
 * and `name`; both values exactly match the expected row. Unknown operation
 * fields, partial rows and ignored non-record entries are REJECTED, never
 * filtered away.
 */
export function validatePatchStructure(patch: unknown): void {
  if (!Array.isArray(patch) || patch.length !== 1) {
    throw new Error(`patch must be an array of exactly one operation`);
  }
  const op = patch[0];
  if (!isRecord(op)) throw new Error(`patch operation must be an object`);
  const opKeys = Object.keys(op);
  if (opKeys.length !== 1 || opKeys[0] !== "insert") {
    throw new Error(`patch operation must have exactly one key "insert"`);
  }
  const insert = op.insert;
  if (!Array.isArray(insert) || insert.length !== 1) {
    throw new Error(`patch insert must be an array of exactly one row`);
  }
  const row = insert[0];
  if (!isRecord(row)) throw new Error(`patch row must be an object`);
  const rowKeys = Object.keys(row).sort();
  if (rowKeys.length !== 2 || rowKeys[0] !== "id" || rowKeys[1] !== "name") {
    throw new Error(`patch row must have exactly two keys "id" and "name"`);
  }
  if (row.id !== EXPECTED_ROW.id || row.name !== EXPECTED_ROW.name) {
    throw new Error(`patch row must be ${JSON.stringify(EXPECTED_ROW)}`);
  }
}

/** The child script proving the packed root/client bytes load through exports. */
const VERIFY_SCRIPT = `
const results = {};
try {
  const rootUrl = import.meta.resolve("dsh-opencode-go-provider");
  const clientUrl = import.meta.resolve("dsh-opencode-go-provider/client");
  const root = await import("dsh-opencode-go-provider");
  const client = await import("dsh-opencode-go-provider/client");
  results.ok = root.provider?.name === "dsh-opencode-go-provider"
    && root.provider?.route === "opencode-go"
    && client.clientContract?.name === "dsh-opencode-go-provider-client"
    && client.clientContract?.providerRoute === "opencode-go";
  results.rootUrl = rootUrl;
  results.clientUrl = clientUrl;
  results.error = results.ok ? undefined : "contract mismatch";
} catch (error) {
  results.ok = false;
  results.error = String(error);
}
process.stdout.write(JSON.stringify(results));
`;

/**
 * Prove the extracted package's root/client entries load through the exports
 * map in a temporary consumer with local public peers, and that module
 * resolution points inside the extracted package.
 */
async function verifyPackedImports(pkgDir: string): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "dsh-opencode-go-provider-import-"));
  try {
    const consumer = join(tempRoot, "consumer");
    await mkdir(join(consumer, "node_modules"), { recursive: true });
    // The extracted package is COPIED into the consumer so Node's upward
    // resolution from the importing file reaches the consumer's node_modules
    // (a symlink would resolve from the extracted package's real path).
    await cp(pkgDir, join(consumer, "node_modules", PACKAGE_NAME), { recursive: true });
    for (const peer of ["@deepseek-ai", "@earendil-works", "react", "react-dom", "yaml"]) {
      await symlink(join(REPO_ROOT, "node_modules", peer), join(consumer, "node_modules", peer), "dir");
    }
    await writeFile(join(consumer, "verify.mjs"), VERIFY_SCRIPT);
    const result = spawnSync(process.execPath, ["verify.mjs"], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`packed imports failed to load: ${(result.stderr ?? "").trim().slice(0, 500)}`);
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed) || parsed.ok !== true) {
      throw new Error(`packed imports invalid: ${isRecord(parsed) && isString(parsed.error) ? parsed.error : "unknown"}`);
    }
    const rootUrl = isString(parsed.rootUrl) ? parsed.rootUrl : "";
    const clientUrl = isString(parsed.clientUrl) ? parsed.clientUrl : "";
    // Module resolution must point inside the consumer's copy of the package,
    // and the resolved bytes must hash identically to the packed files. The
    // prefix uses the REAL path: import.meta.resolve returns the resolved
    // path, while mkdtemp may return the /var/folders symlink spelling.
    const consumerPkgDir = await realpath(join(consumer, "node_modules", PACKAGE_NAME));
    const consumerPkgUrl = `file://${consumerPkgDir}/`;
    if (!rootUrl.startsWith(consumerPkgUrl) || !clientUrl.startsWith(consumerPkgUrl)) {
      throw new Error(`packed module resolution escaped the extracted package`);
    }
    const hashOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
    const packedRootHash = hashOf(join(pkgDir, "lib", "index.js"));
    const packedClientHash = hashOf(join(pkgDir, "lib", "client.js"));
    if (hashOf(fileURLToPath(rootUrl)) !== packedRootHash || hashOf(fileURLToPath(clientUrl)) !== packedClientHash) {
      throw new Error(`packed module bytes do not match the packed files`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Contract gate: validate the tarball's bundle contract and packed bytes
 * BEFORE any profile mutation. Returns the validated manifest patch relative
 * path (e.g. `cordis.patch.yml`) for activation.
 */
export async function validateTarballContract(tarball: string): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), "dsh-opencode-go-provider-contract-"));
  try {
    // Safe extraction: tar members are validated before extraction and the
    // extraction root must hold exactly one real `package` directory.
    const pkgDir = extractTarballSafe(tarball, tempRoot);
    const pkgPath = join(pkgDir, "package.json");
    if (!existsSync(pkgPath)) throw new Error("packed artifact is missing package.json");
    const pkg: unknown = JSON.parse(await readFile(pkgPath, "utf8"));
    if (!isRecord(pkg)) throw new Error("packed package.json must be an object");
    if (pkg.name !== PACKAGE_NAME) {
      throw new Error(`packed package name mismatch: expected ${PACKAGE_NAME}`);
    }
    const dsh = isRecord(pkg.dsh) ? pkg.dsh : undefined;
    const bundle = isRecord(dsh?.bundle) ? dsh.bundle : undefined;
    if (bundle === undefined || bundle.patch !== EXPECTED_PATCH) {
      throw new Error(`packed artifact dsh.bundle.patch must be ${EXPECTED_PATCH}`);
    }
    const exportsValue = isRecord(pkg.exports) ? pkg.exports : undefined;
    const rootExport = isRecord(exportsValue?.["."]) ? exportsValue["."] : undefined;
    const clientExport = isRecord(exportsValue?.["./client"]) ? exportsValue["./client"] : undefined;
    const rootTarget = isString(rootExport?.default) ? rootExport.default : undefined;
    const clientTarget = isString(clientExport?.default) ? clientExport.default : undefined;
    if (rootTarget === undefined || clientTarget === undefined) {
      throw new Error("packed artifact exports map is missing ./client");
    }
    for (const target of [rootTarget, clientTarget]) {
      if (!/^\.\/lib\/[^/]+\.js$/.test(target) || !existsSync(join(pkgDir, target))) {
        throw new Error(`packed artifact export target does not resolve to a file: ${target}`);
      }
    }
    const patchPath = EXPECTED_PATCH.slice(2);
    const patchAbs = join(pkgDir, patchPath);
    if (!existsSync(patchAbs)) throw new Error(`packed artifact is missing ${patchPath}`);
    let patch: unknown;
    try {
      patch = parse(await readFile(patchAbs, "utf8"));
    } catch {
      throw new Error(`packed artifact ${patchPath} is not valid YAML`);
    }
    validatePatchStructure(patch);
    assertAuditClean(await auditTarball(tarball, tempRoot));
    await verifyPackedImports(pkgDir);
    return patchPath;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
