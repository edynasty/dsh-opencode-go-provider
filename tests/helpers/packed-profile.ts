/**
 * Task 8 packed-profile lifecycle: a completely fresh temporary `DSH_HOME`
 * web profile, public package-manager install with `--offline`, config dump,
 * Host/client load from the installed bytes, `listModels` with injected
 * offline seams, and removal restoring the pre-install baseline.
 *
 * The snapshot is a COMPLETE recursive manifest — regular-file hashes,
 * directories, symlink paths+targets, package-manager metadata and `.pnpm`
 * contents — with NO normalization. Removal therefore physically removes
 * every generated package-manager artifact (the whole node_modules tree
 * including the `.pnpm` virtual store, and the lockfile) and recreates only
 * the exact baseline host peer symlinks, so the recursive manifest after
 * removal is byte-identical to the pre-install baseline.
 */
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { loadHostAndClient, type HostLoadResult } from "./host-loader.ts";
import { validateTarballContract } from "./pack-contract.ts";
import {
  API_KEY_ENV,
  FAKE_KEY,
  PACKAGE_NAME,
  REPO_ROOT,
  isolatedEnv,
  runSync,
  sha256OfBytes,
} from "./release-candidate-subprocess.ts";
import { isRecord, isString } from "./type-guards.ts";

export { loadHostAndClient };
export type { HostLoadResult };

export interface Profile {
  readonly root: string;
  /** The whole owned temp root disposal removes; the profile dir for artifact
   * profiles, the parent `dsh-opencode-go-provider-git-profile-*` root for
   * Git-installed profiles. */
  readonly disposalRoot: string;
  /** Dedicated temp HOME for package-manager subprocesses, a sibling of the
   * profile dir under the disposal root — pnpm cache state never lands in the
   * profile root where the snapshot would flag it. */
  readonly pnpmHome: string;
  readonly packageJson: string;
  readonly patchPath: string;
  readonly settingsPath: string;
  readonly credentialsPath: string;
}

export interface DumpedConfig {
  readonly bundleRows: readonly string[];
  readonly settingsSections: readonly string[];
  readonly dependencies: readonly string[];
}

export interface ProfileSnapshot {
  /** Complete recursive manifest: `F <rel> <sha256>` files, `D <rel>` dirs,
   * `L <rel> -> <target>` symlinks, `S <rel>` specials. Nothing is filtered. */
  readonly manifest: readonly string[];
}

/** The exact baseline host peer symlinks a fresh profile's node_modules holds. */
const BASELINE_PEERS: readonly { readonly name: string; readonly target: string }[] = [
  { name: "@deepseek-ai", target: join(REPO_ROOT, "node_modules", "@deepseek-ai") },
  { name: "@earendil-works", target: join(REPO_ROOT, "node_modules", "@earendil-works") },
  { name: "react", target: join(REPO_ROOT, "node_modules", "react") },
  { name: "react-dom", target: join(REPO_ROOT, "node_modules", "react-dom") },
  { name: "yaml", target: join(REPO_ROOT, "node_modules", "yaml") },
];

/** Recreate the exact baseline host peer symlinks under `nodeModulesDir`. */
async function createBaselineNodeModules(nodeModulesDir: string): Promise<void> {
  await mkdir(nodeModulesDir, { recursive: true });
  for (const peer of BASELINE_PEERS) {
    await symlink(peer.target, join(nodeModulesDir, peer.name), "dir");
  }
}

/** Create a completely fresh DSH_HOME web profile inside `tempRoot`. */
export async function createProfileIn(tempRoot: string, tag: string, disposalRoot?: string): Promise<Profile> {
  const root = join(tempRoot, `profile-${tag}`);
  const pnpmHome = join(tempRoot, `pnpm-home-${tag}`);
  await createBaselineNodeModules(join(root, "node_modules"));
  await mkdir(pnpmHome, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "dsh-opencode-go-web-profile", private: true, type: "module" }, null, 2)}\n`,
  );
  // Base profile patch: no bundle rows.
  await writeFile(join(root, "cordis.patch.yml"), "[]\n");
  // Settings document: one raw document of per-namespace sections; a fresh
  // profile has none. Install/remove never invent or touch user sections.
  await writeFile(join(root, "settings.yaml"), "{}\n");
  // Credentials document at the documented $DSH_HOME/.credentials.yaml path,
  // holding only the injected fake sentinel key.
  await writeFile(join(root, ".credentials.yaml"), `${API_KEY_ENV}: ${FAKE_KEY}\n`);
  return {
    root,
    disposalRoot: disposalRoot ?? root,
    pnpmHome,
    packageJson: join(root, "package.json"),
    patchPath: join(root, "cordis.patch.yml"),
    settingsPath: join(root, "settings.yaml"),
    credentialsPath: join(root, ".credentials.yaml"),
  };
}

/**
 * Validate the INSTALLED package identity and return its declared patch
 * relative path (TOCTOU guard: activation data is copied only from the
 * installed package whose manifest the gate validated).
 */
export async function installedPatchPathOf(profile: Profile): Promise<string> {
  const installedRoot = join(profile.root, "node_modules", PACKAGE_NAME);
  const pkg: unknown = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  if (!isRecord(pkg) || pkg.name !== PACKAGE_NAME) {
    throw new Error(`installed package identity mismatch: expected ${PACKAGE_NAME}`);
  }
  const dsh = isRecord(pkg.dsh) ? pkg.dsh : undefined;
  const bundle = isRecord(dsh?.bundle) ? dsh.bundle : undefined;
  if (bundle === undefined || !isString(bundle.patch) || !/^\.\/[^/]+\.ya?ml$/.test(bundle.patch)) {
    throw new Error(`installed package dsh.bundle.patch is not a valid relative path`);
  }
  return bundle.patch.slice(2);
}

/** Merge the installed package's bundle rows into the profile patch. */
export async function mergePatchRows(profile: Profile, patchPath: string): Promise<void> {
  const installedRoot = join(profile.root, "node_modules", PACKAGE_NAME);
  const pkg: unknown = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  if (!isRecord(pkg) || pkg.name !== PACKAGE_NAME) {
    throw new Error(`installed package identity mismatch: expected ${PACKAGE_NAME}`);
  }
  const dsh = isRecord(pkg.dsh) ? pkg.dsh : undefined;
  const bundle = isRecord(dsh?.bundle) ? dsh.bundle : undefined;
  if (bundle === undefined || !isString(bundle.patch) || bundle.patch !== `./${patchPath}`) {
    throw new Error(`installed package patch pointer mismatch: expected ./${patchPath}`);
  }
  const text = await readFile(join(installedRoot, patchPath), "utf8");
  await writeFile(profile.patchPath, text);
}

/** Install the exact tarball through the public package manager, offline. */
export async function installPackage(profile: Profile, tarball: string): Promise<void> {
  const patchPath = await validateTarballContract(tarball);
  runSync(
    "corepack",
    ["pnpm@11.7.0", "add", tarball, "--offline", "--ignore-scripts", "--config.auto-install-peers=false"],
    profile.root,
    isolatedEnv(profile.pnpmHome),
  );
  await mergePatchRows(profile, patchPath);
}

/** Dump the profile's config documents: patch rows, settings sections, deps. */
export async function dumpConfig(profile: Profile): Promise<DumpedConfig> {
  const patch = parse(await readFile(profile.patchPath, "utf8"));
  const bundleRows: string[] = [];
  if (Array.isArray(patch)) {
    for (const op of patch) {
      if (isRecord(op) && Array.isArray(op.insert)) {
        for (const row of op.insert) {
          if (isRecord(row) && isString(row.id)) bundleRows.push(row.id);
        }
      }
    }
  }
  const settings: unknown = parse(await readFile(profile.settingsPath, "utf8"));
  const settingsSections = isRecord(settings) ? Object.keys(settings) : [];
  const pkg: unknown = JSON.parse(await readFile(profile.packageJson, "utf8"));
  const dependencies = isRecord(pkg) && isRecord(pkg.dependencies) ? Object.keys(pkg.dependencies) : [];
  return { bundleRows, settingsSections, dependencies };
}

/** Complete recursive manifest of `root`: files, dirs, symlinks, specials. */
async function recursiveManifest(root: string): Promise<readonly string[]> {
  const lines: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) {
        lines.push(`L ${rel} -> ${await readlink(abs)}`);
      } else if (stats.isDirectory()) {
        lines.push(`D ${rel}`);
        await walk(abs, rel);
      } else if (stats.isFile()) {
        lines.push(`F ${rel} ${sha256OfBytes(await readFile(abs))}`);
      } else {
        lines.push(`S ${rel}`);
      }
    }
  };
  await walk(root, "");
  return lines;
}

/** Snapshot the profile's COMPLETE recursive state; nothing is filtered. */
export async function snapshotProfile(profile: Profile): Promise<ProfileSnapshot> {
  return { manifest: await recursiveManifest(profile.root) };
}

/** Remove the package and physically restore the exact baseline profile. */
export async function removePackage(profile: Profile): Promise<void> {
  runSync(
    "corepack",
    ["pnpm@11.7.0", "remove", PACKAGE_NAME],
    profile.root,
    isolatedEnv(profile.pnpmHome),
  );
  // Physical cleanup: drop the ENTIRE node_modules tree (including the .pnpm
  // virtual store that pnpm remove leaves behind) and the generated lockfile,
  // then recreate only the exact baseline host peer symlinks.
  await rm(join(profile.root, "node_modules"), { recursive: true, force: true });
  await rm(join(profile.root, "pnpm-lock.yaml"), { force: true });
  await createBaselineNodeModules(join(profile.root, "node_modules"));
  await writeFile(profile.patchPath, "[]\n");
}

/** Remove the whole owned profile temp root (the disposal root). */
export async function disposeProfile(profile: Profile): Promise<void> {
  await rm(profile.disposalRoot, { recursive: true, force: true });
}
