/**
 * Package-contract tests (Plan Task 2).
 *
 * Asserts machine-consumed package behavior only: the manifest identity, the
 * DSH bundle/client injection declarations, the public exports, the tarball
 * allowlist, the bundle patch layer and the malformed-manifest rejection path.
 * No prose assertions, no snapshots of natural language.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateBundleManifest } from "./helpers/manifest-contract.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("bundle manifest contract", () => {
  it("validates the real package manifest and required files without violations", () => {
    // Given: the repository root containing package.json, the bundle patch
    // layer, entrypoints, configs and the lockfile.
    // When: the manifest contract validator inspects the whole package.
    const violations = validateBundleManifest(REPO_ROOT);
    // Then: the manifest satisfies every field of the DSH rc.7 bundle contract.
    expect(violations).toEqual([]);
  });
});

describe("malformed manifest rejection", () => {
  it("names the missing dsh.bundle.patch and cordis.patch.yml fields", () => {
    // Given: a fixture package.json that omits the `dsh` manifest and the
    // bundle patch file entirely.
    const fixtureDir = join(REPO_ROOT, "tests", "fixtures", "broken-manifest");
    // When: the same validator runs against the fixture directory.
    const violations = validateBundleManifest(fixtureDir);
    // Then: validation fails and the report names both missing fields.
    const report = violations.join("\n");
    expect(report).toContain("dsh.bundle.patch");
    expect(report).toContain("cordis.patch.yml");
    expect(violations.length).toBeGreaterThan(0);
  });
});
