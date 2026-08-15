/**
 * Task 8 packed release-candidate lifecycle specs (red-first).
 *
 * Proves the build → pack → audit → fresh temporary DSH web profile
 * install/load/list/remove contract twice in independent temp roots, plus
 * local commit-pinned Git installability and pre-activation rejection of
 * malformed packages. Every profile is a completely fresh temporary
 * `DSH_HOME` + web profile: no HOME/DSH_HOME/profile state is inherited, the
 * exact generated tarball is installed through a public package-manager
 * invocation with `--offline`, the Host and client load from the installed
 * package bytes, `listModels` runs against the embedded catalog with a
 * fail-closed network and an injected fake credential, and removal restores
 * the pre-install baseline byte-for-byte. All temp roots, child processes and
 * generated tarballs are removed in `finally` paths.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_KEY_ENV,
  BUNDLE_ROW_ID,
  PACKAGE_NAME,
  PINNED_COMMIT,
  PROVIDER_ROUTE,
  REPO_ROOT,
  assertAuditClean,
  buildAndPack,
  createProfile,
  disposeArtifact,
  disposeProfile,
  dumpConfig,
  installFromGit,
  installPackage,
  libManifest,
  loadHostAndClient,
  makeMalformedTarball,
  removePackage,
  runSync,
  snapshotProfile,
} from "./helpers/release-candidate-harness.ts";

describe("packed release-candidate lifecycle", () => {
  it(
    "installs the exact tarball into a fresh DSH web profile, loads Host+client, lists models, and removes with zero residue — twice",
    async () => {
      // Given: the repository built and packed into a generated temp dir, and
      // the packed bytes passing the strict allowlist/secret/path audit.
      const artifact = await buildAndPack();
      try {
        assertAuditClean(artifact.audit);
        for (let round = 1; round <= 2; round += 1) {
          // When: a completely fresh profile is created and the exact tarball
          // installed through pnpm --offline.
          const profile = await createProfile(artifact, `round-${round}`);
          try {
            const baseline = await snapshotProfile(profile);
            await installPackage(profile, artifact.tarball);
            // Then: the dumped config names exactly one bundle row, no settings
            // sections were invented, and the profile declares the dependency.
            const config = await dumpConfig(profile);
            expect(config.bundleRows).toEqual([BUNDLE_ROW_ID]);
            expect(config.settingsSections).toEqual([]);
            expect(config.dependencies).toEqual([PACKAGE_NAME]);
            // ...the Host loads exactly one bundle row and one provider route,
            // the client contract loads from the packed bytes, and listModels
            // succeeds against the embedded catalog with zero network.
            const loaded = await loadHostAndClient(profile);
            expect(loaded.bundleRows).toEqual([BUNDLE_ROW_ID]);
            expect(loaded.providers).toEqual([PROVIDER_ROUTE]);
            expect(loaded.configurableProviders).toEqual([PROVIDER_ROUTE]);
            expect(loaded.modelCount).toBeGreaterThan(0);
            expect(loaded.firstModelId).toBeDefined();
            expect(loaded.client).toEqual({
              name: `${PACKAGE_NAME}-client`,
              providerRoute: PROVIDER_ROUTE,
              apiKeyEnv: API_KEY_ENV,
              inject: ["slots", "locale"],
              remoteRoutes: ["status", "connect", "disconnect", "doctor"],
            });
            // ...removal restores the pre-install baseline with no residue:
            // the COMPLETE recursive manifest (including .pnpm contents) is
            // byte-identical to the pre-install baseline.
            await removePackage(profile);
            const after = await snapshotProfile(profile);
            expect(after).toEqual(baseline);
            // ...and no path/file/content matching the provider name remains
            // anywhere under the profile beyond the deliberate baseline host
            // peer symlink targets (which point into the repository).
            const baselineProviderLines = baseline.manifest.filter((line) => line.includes(PACKAGE_NAME));
            const afterProviderLines = after.manifest.filter((line) => line.includes(PACKAGE_NAME));
            expect(afterProviderLines).toEqual(baselineProviderLines);
          } finally {
            await disposeProfile(profile);
          }
          // ...and disposal removes the whole owned profile root.
          expect(existsSync(profile.disposalRoot)).toBe(false);
        }
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it(
    "removes the generated Host script from the profile after load",
    async () => {
      const artifact = await buildAndPack();
      try {
        const profile = await createProfile(artifact, "host-cleanup");
        try {
          await installPackage(profile, artifact.tarball);
          // When: the Host loads from the installed bytes.
          const loaded = await loadHostAndClient(profile);
          expect(loaded.bundleRows).toEqual([BUNDLE_ROW_ID]);
          // Then: the generated child script never remains in the profile.
          expect(existsSync(join(profile.root, "host-load.mjs"))).toBe(false);
        } finally {
          await disposeProfile(profile);
        }
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it(
    "detects unexpected root files such as the Host script in the profile snapshot",
    async () => {
      const artifact = await buildAndPack();
      try {
        const profile = await createProfile(artifact, "root-residue");
        try {
          const baseline = await snapshotProfile(profile);
          // When: an arbitrary file appears at the profile root.
          await writeFile(join(profile.root, "host-load.mjs"), "stray");
          const after = await snapshotProfile(profile);
          // Then: the complete recursive manifest names it and the snapshots
          // differ — nothing is normalized away.
          expect(after.manifest.some((line) => line.includes("host-load.mjs"))).toBe(true);
          expect(after.manifest).not.toEqual(baseline.manifest);
        } finally {
          await disposeProfile(profile);
        }
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it(
    "cleans the malformed tarball temp root through the artifact owner",
    async () => {
      const artifact = await buildAndPack();
      try {
        const malformed = await makeMalformedTarball(artifact, "missing-client");
        const malformedRoot = malformed.tempRoot;
        expect(existsSync(malformedRoot)).toBe(true);
        // When: the artifact owner is disposed, the malformed child root goes
        // with it — even though the malformed tarball was never installed.
        await disposeArtifact(artifact);
        expect(existsSync(malformedRoot)).toBe(false);
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it(
    "rejects a tarball missing lib/client.js before profile activation, leaving base hashes unchanged",
    async () => {
      const artifact = await buildAndPack();
      try {
        const profile = await createProfile(artifact, "missing-client");
        try {
          const baseline = await snapshotProfile(profile);
          const malformed = await makeMalformedTarball(artifact, "missing-client");
          // When: the malformed tarball is installed, the contract gate refuses
          // it before any profile mutation.
          await expect(installPackage(profile, malformed.tarball)).rejects.toThrow(/lib\/client\.js/);
          // Then: the profile is byte-identical to the pre-install baseline.
          const after = await snapshotProfile(profile);
          expect(after).toEqual(baseline);
        } finally {
          await disposeProfile(profile);
        }
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it(
    "rejects a tarball with a corrupted patch before profile activation, leaving base hashes unchanged",
    async () => {
      const artifact = await buildAndPack();
      try {
        const profile = await createProfile(artifact, "broken-patch");
        try {
          const baseline = await snapshotProfile(profile);
          const malformed = await makeMalformedTarball(artifact, "broken-patch");
          await expect(installPackage(profile, malformed.tarball)).rejects.toThrow(/cordis\.patch\.yml/);
          const after = await snapshotProfile(profile);
          expect(after).toEqual(baseline);
        } finally {
          await disposeProfile(profile);
        }
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it(
    "rejects a tarball with a missing ./client export before profile activation, leaving base hashes unchanged",
    async () => {
      const artifact = await buildAndPack();
      try {
        const profile = await createProfile(artifact, "broken-export");
        try {
          const baseline = await snapshotProfile(profile);
          const malformed = await makeMalformedTarball(artifact, "broken-export");
          await expect(installPackage(profile, malformed.tarball)).rejects.toThrow(/exports/);
          const after = await snapshotProfile(profile);
          expect(after).toEqual(baseline);
        } finally {
          await disposeProfile(profile);
        }
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it.each([
    { variant: "wrong-row", pattern: /patch row must be/ },
    { variant: "extra-row", pattern: /exactly one row/ },
    { variant: "partial-extra-row", pattern: /exactly one row/ },
    { variant: "invalid-client-js", pattern: /packed imports/ },
    { variant: "missing-export-target", pattern: /export target/ },
    { variant: "wrong-patch-pointer", pattern: /dsh\.bundle\.patch/ },
  ] as const)(
    "rejects a $variant tarball before profile activation, leaving base hashes unchanged",
    async ({ variant, pattern }) => {
      const artifact = await buildAndPack();
      try {
        const profile = await createProfile(artifact, variant);
        try {
          const baseline = await snapshotProfile(profile);
          const malformed = await makeMalformedTarball(artifact, variant);
          // When: the malformed tarball is installed, the strengthened contract
          // gate refuses it before any profile mutation.
          await expect(installPackage(profile, malformed.tarball)).rejects.toThrow(pattern);
          // Then: the profile is byte-identical to the pre-install baseline.
          const after = await snapshotProfile(profile);
          expect(after).toEqual(baseline);
        } finally {
          await disposeProfile(profile);
        }
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it.each([
    { variant: "env-symlink", pattern: /special entries/ },
    { variant: "unknown-path", pattern: /allowlist violations/ },
    { variant: "private-import-secret", pattern: /private \/src imports/ },
    { variant: "top-level-sibling", pattern: /outside the single package\/ root/ },
    { variant: "flat-unknown-lib", pattern: /allowlist violations/ },
  ] as const)(
    "rejects a $variant tarball through the extracted-tree audit before profile activation",
    async ({ variant, pattern }) => {
      const artifact = await buildAndPack();
      try {
        const profile = await createProfile(artifact, variant);
        try {
          const baseline = await snapshotProfile(profile);
          const malformed = await makeMalformedTarball(artifact, variant);
          // When: the malformed tarball is installed, the audit of the EXTRACTED
          // tree (lstat, allowlist on every path, content scans) refuses it.
          await expect(installPackage(profile, malformed.tarball)).rejects.toThrow(pattern);
          const after = await snapshotProfile(profile);
          expect(after).toEqual(baseline);
        } finally {
          await disposeProfile(profile);
        }
      } finally {
        await disposeArtifact(artifact);
      }
    },
    120_000,
  );

  it(
    "installs from a local commit-pinned Git source and rebuilds lib byte-identically",
    async () => {
      // Given: the exact source-repository status, and a disposable local
      // clone of the repository at the pinned commit.
      const statusBefore = runSync("git", ["status", "--porcelain=v1"], REPO_ROOT);
      const tempRoot = await mkdtemp(join(tmpdir(), "dsh-opencode-go-provider-git-"));
      try {
        const clone = join(tempRoot, "clone");
        runSync("git", ["clone", "--no-checkout", `file://${REPO_ROOT}`, clone], tempRoot);
        runSync("git", ["-C", clone, "checkout", PINNED_COMMIT], tempRoot);
        const committed = await libManifest(clone);
        // When: the commit-pinned source installs into a fresh profile without
        // any network, using the committed lib.
        const profile = await installFromGit(clone, PINNED_COMMIT, "git-install");
        const gitProfileRoot = dirname(profile.root);
        try {
          const loaded = await loadHostAndClient(profile);
          expect(loaded.bundleRows).toEqual([BUNDLE_ROW_ID]);
          expect(loaded.providers).toEqual([PROVIDER_ROUTE]);
          expect(loaded.modelCount).toBeGreaterThan(0);
        } finally {
          await disposeProfile(profile);
        }
        // Then: disposal removed the whole Git-install parent temp root, not
        // only the nested profile directory.
        expect(existsSync(gitProfileRoot)).toBe(false);
        // ...a rebuild in the disposable clone reproduces the committed lib
        // byte-for-byte (a mismatch would fail here, never filtered away)...
        runSync("corepack", ["pnpm@11.7.0", "install", "--offline", "--frozen-lockfile"], clone);
        runSync("corepack", ["pnpm@11.7.0", "run", "build"], clone);
        const rebuilt = await libManifest(clone);
        expect(rebuilt).toEqual(committed);
        // ...and the source repository status is byte-for-byte identical to
        // the pre-operation capture — no hardcoded file set, no blanket
        // untracked filtering.
        const statusAfter = runSync("git", ["status", "--porcelain=v1"], REPO_ROOT);
        expect(statusAfter).toBe(statusBefore);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
