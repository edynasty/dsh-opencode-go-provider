#!/usr/bin/env node
/**
 * pack:check — deterministic CI gate for the packed release candidate.
 *
 * Builds serially, packs the exact tarball into an OS temp dir, audits the
 * actual packed bytes through the ONE shared audit implementation
 * (`./pack-audit.mjs`, also consumed by the vitest harness), then runs the
 * packed-lifecycle spec which proves install/load/list/remove twice in fresh
 * temp DSH profiles, local commit-pinned Git installability and
 * pre-activation rejection of malformed packages. The whole temp root is
 * removed even on failure.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAuditClean, auditTarball } from "./pack-audit.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, cwd, timeoutMs = 300_000, inherit = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: inherit ? "inherit" : undefined,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

// 1. Deterministic build, serial before anything reads lib.
run("corepack", ["pnpm@11.7.0", "run", "build"], REPO_ROOT);

// 2. Pack the exact tarball into an OS temp dir and parse its filename.
const tempRoot = mkdtempSync(join(tmpdir(), "dsh-opencode-go-provider-pack-check-"));
try {
  const packDir = join(tempRoot, "pack");
  mkdirSync(packDir, { recursive: true });
  const packOutput = run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
    REPO_ROOT,
  );
  const [manifest] = JSON.parse(packOutput);
  const tarball = join(packDir, manifest.filename);

  // 3. Audit the bytes actually packed through the shared implementation.
  const audit = await auditTarball(tarball, tempRoot);
  assertAuditClean(audit);

  // 4. The packed-lifecycle spec proves the full install/load/list/remove
  //    contract twice, Git installability and malformed-package rejection.
  run(
    "corepack",
    ["pnpm@11.7.0", "exec", "vitest", "run", "tests/packed-lifecycle.spec.ts"],
    REPO_ROOT,
    300_000,
    true,
  );

  process.stdout.write(
    `pack:check ok — ${audit.packedPaths.length} packed paths (${manifest.size} bytes, ${manifest.unpackedSize} unpacked), audit clean, lifecycle spec green\n`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
