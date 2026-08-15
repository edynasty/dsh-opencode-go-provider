/**
 * Task 8 release-candidate harness: orchestrates build → pack → audit →
 * fresh temporary DSH web profile install/load/list/remove (twice), local
 * commit-pinned Git installability and pre-activation rejection of malformed
 * packages. The audit, contract gate and profile lifecycle live in focused
 * sibling helpers; this module owns the orchestration and the public API.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackManifest } from "./parse-output.ts";
import { assertAuditClean, auditTarball, type TarballAudit } from "./pack-audit.ts";
import {
  createProfileIn,
  disposeProfile,
  dumpConfig,
  installPackage,
  installedPatchPathOf,
  loadHostAndClient,
  mergePatchRows,
  removePackage,
  snapshotProfile,
  type DumpedConfig,
  type HostLoadResult,
  type Profile,
  type ProfileSnapshot,
} from "./packed-profile.ts";
import {
  API_KEY_ENV,
  BUNDLE_ROW_ID,
  FAKE_KEY,
  PACKAGE_NAME,
  PINNED_COMMIT,
  PROVIDER_ROUTE,
  REPO_ROOT,
  isolatedEnv,
  runSync,
  sha256Of,
  sha256OfBytes,
} from "./release-candidate-subprocess.ts";
import { isRecord } from "./type-guards.ts";

export {
  API_KEY_ENV,
  BUNDLE_ROW_ID,
  FAKE_KEY,
  PACKAGE_NAME,
  PINNED_COMMIT,
  PROVIDER_ROUTE,
  REPO_ROOT,
  assertAuditClean,
  disposeProfile,
  dumpConfig,
  installPackage,
  loadHostAndClient,
  removePackage,
  runSync,
  sha256Of,
  snapshotProfile,
};
export type {
  DumpedConfig,
  HostLoadResult,
  Profile,
  ProfileSnapshot,
  TarballAudit,
};

export interface PackedArtifact {
  readonly tempRoot: string;
  readonly tarball: string;
  readonly filename: string;
  readonly audit: TarballAudit;
}

export interface MalformedTarball {
  readonly tarball: string;
  readonly tempRoot: string;
}

/** Build (only when lib is absent, mirroring pack-import's serial guard) and pack. */
export async function buildAndPack(): Promise<PackedArtifact> {
  const tempRoot = await mkdtemp(join(tmpdir(), "dsh-opencode-go-provider-pack-"));
  try {
    if (!existsSync(join(REPO_ROOT, "lib", "index.js"))) {
      runSync("corepack", ["pnpm@11.7.0", "run", "build"], REPO_ROOT);
    }
    const packDir = join(tempRoot, "pack");
    await mkdir(packDir, { recursive: true });
    const packOutput = runSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
      REPO_ROOT,
    );
    const manifest = parsePackManifest(JSON.parse(packOutput));
    const tarball = join(packDir, manifest.filename);
    const audit = await auditTarball(tarball, tempRoot);
    return { tempRoot, tarball, filename: manifest.filename, audit };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Create a fresh profile inside the packed artifact's temp root. */
export async function createProfile(artifact: PackedArtifact, tag: string): Promise<Profile> {
  return createProfileIn(artifact.tempRoot, tag);
}

/** Remove the whole packed-artifact temp root. */
export async function disposeArtifact(artifact: PackedArtifact): Promise<void> {
  await rm(artifact.tempRoot, { recursive: true, force: true });
}

/** One malformed-package mutation variant. */
export type MalformedVariant =
  | "missing-client"
  | "broken-patch"
  | "broken-export"
  | "wrong-row"
  | "extra-row"
  | "partial-extra-row"
  | "invalid-client-js"
  | "missing-export-target"
  | "wrong-patch-pointer"
  | "env-symlink"
  | "unknown-path"
  | "private-import-secret"
  | "top-level-sibling"
  | "flat-unknown-lib";

/** Mutate a copied extracted package and repack it into a fresh temp root. */
export async function makeMalformedTarball(
  artifact: PackedArtifact,
  variant: MalformedVariant,
): Promise<MalformedTarball> {
  // The malformed root is a child of the artifact owner root, so
  // disposeArtifact() removes it even when extraction/mutation/repack throws.
  const tempRoot = join(artifact.tempRoot, `malformed-${variant}`);
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
  try {
    runSync("tar", ["-xzf", artifact.tarball, "-C", tempRoot], REPO_ROOT);
    const pkgDir = join(tempRoot, "package");
    const pkgPath = join(pkgDir, "package.json");
    const pkg: unknown = JSON.parse(await readFile(pkgPath, "utf8"));
    if (!isRecord(pkg)) throw new Error("test setup: packed package.json must be an object");
    if (variant === "missing-client") {
      await rm(join(pkgDir, "lib", "client.js"), { force: true });
    } else if (variant === "broken-patch") {
      await writeFile(join(pkgDir, "cordis.patch.yml"), "- insert:\n    - id: [unclosed\n");
    } else if (variant === "broken-export") {
      if (!isRecord(pkg.exports)) throw new Error("test setup: packed package.json has no exports map");
      delete pkg.exports["./client"];
    } else if (variant === "wrong-row") {
      await writeFile(
        join(pkgDir, "cordis.patch.yml"),
        "- insert:\n    - id: wrong-row\n      name: dsh-opencode-go-provider\n",
      );
    } else if (variant === "extra-row") {
      await writeFile(
        join(pkgDir, "cordis.patch.yml"),
        "- insert:\n    - id: llm-opencode-go\n      name: dsh-opencode-go-provider\n    - id: llm-extra\n      name: extra-provider\n",
      );
    } else if (variant === "partial-extra-row") {
      await writeFile(
        join(pkgDir, "cordis.patch.yml"),
        "- insert:\n    - id: llm-opencode-go\n      name: dsh-opencode-go-provider\n    - id: attacker-partial-row\n",
      );
    } else if (variant === "invalid-client-js") {
      await writeFile(join(pkgDir, "lib", "client.js"), "export const clientContract = {\n");
    } else if (variant === "missing-export-target") {
      if (!isRecord(pkg.exports) || !isRecord(pkg.exports["./client"])) {
        throw new Error("test setup: packed package.json has no ./client export");
      }
      pkg.exports["./client"] = { ...pkg.exports["./client"], default: "./lib/missing.js" };
    } else if (variant === "wrong-patch-pointer") {
      if (!isRecord(pkg.dsh) || !isRecord(pkg.dsh.bundle)) {
        throw new Error("test setup: packed package.json has no dsh.bundle");
      }
      pkg.dsh.bundle.patch = "./does-not-exist.yml";
    } else if (variant === "env-symlink") {
      await symlink("/etc/passwd", join(pkgDir, ".env.local"), "file");
    } else if (variant === "unknown-path") {
      await mkdir(join(pkgDir, "extra"), { recursive: true });
      await writeFile(join(pkgDir, "extra", "unknown.txt"), "stray\n");
    } else if (variant === "private-import-secret") {
      await writeFile(
        join(pkgDir, "lib", "index.js"),
        `${await readFile(join(pkgDir, "lib", "index.js"), "utf8")}\n`
          + `const mod = await import("@deepseek-ai/dsh-settings/src/index.js");\n`
          + `const key = "OPENCODE_GO_API_KEY=sk-live-1234567890abcdef";\n`
          + `const win = "C:\\\\Users\\\\evil\\\\settings.yaml";\n`,
      );
    } else if (variant === "flat-unknown-lib") {
      await writeFile(join(pkgDir, "lib", "evil.js"), "export const evil = true;\n");
    }
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const tarball = join(tempRoot, `${PACKAGE_NAME}-${variant}.tgz`);
    if (variant === "top-level-sibling") {
      // A sibling of the single package/ root: the tar member list must
      // reject it before extraction.
      await writeFile(join(tempRoot, "outside.txt"), "stray\n");
      runSync("tar", ["-czf", tarball, "-C", tempRoot, "package", "outside.txt"], REPO_ROOT);
    } else {
      runSync("tar", ["-czf", tarball, "-C", tempRoot, "package"], REPO_ROOT);
    }
    return { tarball, tempRoot };
  } catch (error) {
    throw error;
  }
}

/** Install from a local commit-pinned Git source into a fresh profile. */
export async function installFromGit(clone: string, commit: string, tag: string): Promise<Profile> {
  const tempRoot = await mkdtemp(join(tmpdir(), "dsh-opencode-go-provider-git-profile-"));
  const profile = await createProfileIn(tempRoot, tag, tempRoot);
  try {
    runSync(
      "corepack",
      [
        "pnpm@11.7.0",
        "add",
        `git+file://${clone}#${commit}`,
        "--offline",
        "--ignore-scripts",
        "--config.auto-install-peers=false",
      ],
      profile.root,
      isolatedEnv(profile.pnpmHome),
    );
    // The installed package's own manifest names the patch path; activation
    // copies from that validated path, never a hardcoded one.
    await mergePatchRows(profile, await installedPatchPathOf(profile));
    return profile;
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Full sorted lib manifest: "<sha256>  lib/<name>" per file. */
export async function libManifest(root: string): Promise<readonly string[]> {
  const libDir = join(root, "lib");
  const names = (await readdir(libDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const manifest: string[] = [];
  for (const name of names) {
    const bytes = await readFile(join(libDir, name));
    manifest.push(`${sha256OfBytes(bytes)}  lib/${name}`);
  }
  return manifest;
}
