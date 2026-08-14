/**
 * Real tarball QA (Plan Task 2).
 *
 * Builds on demand, runs `npm pack --json` into a generated temp dir, extracts
 * the exact generated tarball into a fresh consumer, links the package into the
 * consumer's node_modules, and spawns a child Node process that imports the
 * root and `./client` entries through the package exports map. Asserts
 * machine-consumed package behavior: identity, dsh.bundle.patch path, the
 * bundle patch layer, and that no source/tests/local artifacts leaked into the
 * tarball. The whole temp root is removed even on failure.
 *
 * The missing-lib build fallback invokes the pinned toolchain through Corepack
 * (`corepack pnpm@11.7.0`) rather than ambient `pnpm`, which is not pinned to
 * the project's `packageManager` and rejects it when below 11.7.0.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConsumerResult, parsePackManifest, parsePackedPackageJson } from "./helpers/parse-output.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runSync(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${String(result.status)}): ${(result.stderr ?? "").trim().slice(0, 500)}`,
    );
  }
  return result.stdout ?? "";
}

const CONSUMER_SCRIPT = `
const results = {};
try {
  const root = await import("dsh-opencode-go-provider");
  const client = await import("dsh-opencode-go-provider/client");
  results.ok = true;
  results.root = {
    name: root.provider?.name ?? null,
    route: root.provider?.route ?? null,
    apiKeyEnv: root.provider?.apiKeyEnv ?? null,
  };
  results.client = {
    name: client.clientContract?.name ?? null,
    providerRoute: client.clientContract?.providerRoute ?? null,
    apiKeyEnv: client.clientContract?.apiKeyEnv ?? null,
  };
} catch (error) {
  results.ok = false;
  results.error = String(error);
}
process.stdout.write(JSON.stringify(results));
`;

describe("packed artifact", () => {
  it("loads root and ./client imports from the exact generated tarball without source files", async () => {
    // Given: built lib (built on demand through Corepack-pinned pnpm) and a
    // generated temp consumer.
    if (!existsSync(join(REPO_ROOT, "lib", "index.js"))) {
      runSync("corepack", ["pnpm@11.7.0", "run", "build"], REPO_ROOT);
    }
    const tempRoot = await mkdtemp(join(tmpdir(), "dsh-opencode-go-provider-pack-"));
    try {
      const packDir = join(tempRoot, "pack");
      const consumerDir = join(tempRoot, "consumer");
      await mkdir(packDir, { recursive: true });
      await mkdir(join(consumerDir, "node_modules"), { recursive: true });

      // When: the exact tarball is packed and extracted, then linked into the
      // consumer and imported through the package exports map in a child Node.
      const packOutput = runSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
        REPO_ROOT,
      );
      const packOutputParsed: unknown = JSON.parse(packOutput);
      const manifest = parsePackManifest(packOutputParsed);
      runSync("tar", ["-xzf", join(packDir, manifest.filename), "-C", consumerDir], REPO_ROOT);
      const pkgDir = join(consumerDir, "package");
      await symlink(
        pkgDir,
        join(consumerDir, "node_modules", "dsh-opencode-go-provider"),
        "dir",
      );
      // A DSH host provides the provider's peer packages; mirror that by
      // exposing the repo's installed @deepseek-ai scope so the packed root
      // (which wires the real service) can resolve its host peers.
      await symlink(
        join(REPO_ROOT, "node_modules", "@deepseek-ai"),
        join(consumerDir, "node_modules", "@deepseek-ai"),
        "dir",
      );
      // The Task 5 adapter imports the pi-ai runtime the host provides too.
      await symlink(
        join(REPO_ROOT, "node_modules", "@earendil-works"),
        join(consumerDir, "node_modules", "@earendil-works"),
        "dir",
      );
      // The Task 7 browser card externalizes react; a real DSH web host
      // provides it for browser plugins, so the consumer mirrors that too.
      await symlink(
        join(REPO_ROOT, "node_modules", "react"),
        join(consumerDir, "node_modules", "react"),
        "dir",
      );
      await writeFile(
        join(consumerDir, "package.json"),
        JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
      );
      await writeFile(join(consumerDir, "verify.mjs"), CONSUMER_SCRIPT);
      const child = spawnSync(process.execPath, ["verify.mjs"], {
        cwd: consumerDir,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(child.status, child.stderr ?? "").toBe(0);
      const consumerParsed: unknown = JSON.parse(child.stdout);
      const result = parseConsumerResult(consumerParsed);
      expect(result.ok).toBe(true);

      // Then: the packed manifest is the exact identity and declares the patch.
      const packedJson: unknown = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
      const packedPkg = parsePackedPackageJson(packedJson);
      expect(packedPkg.name).toBe("dsh-opencode-go-provider");
      expect(packedPkg.version).toBe("0.1.0");
      expect(packedPkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");

      // ...the root and ./client entries expose the provider/client contracts.
      expect(result.root).toEqual({
        name: "dsh-opencode-go-provider",
        route: "opencode-go",
        apiKeyEnv: "OPENCODE_GO_API_KEY",
      });
      expect(result.client).toEqual({
        name: "dsh-opencode-go-provider-client",
        providerRoute: "opencode-go",
        apiKeyEnv: "OPENCODE_GO_API_KEY",
      });

      // ...the bundle patch layer shipped in the tarball.
      const patch = await readFile(join(pkgDir, "cordis.patch.yml"), "utf8");
      expect(patch).toContain("id: llm-opencode-go");
      expect(patch).toContain("name: dsh-opencode-go-provider");

      // ...and no source/tests/local artifacts leaked into the tarball.
      const packedPaths = manifest.files.map((f) => f.path);
      expect(packedPaths).toContain("lib/index.js");
      expect(packedPaths).toContain("lib/client.js");
      expect(packedPaths).toContain("cordis.patch.yml");
      expect(
        packedPaths.some(
          (p) => p.startsWith("src/") || p.startsWith("tests/") || p.includes("node_modules") || p.endsWith(".tgz"),
        ),
      ).toBe(false);

      // ...the runtime catalog artifacts ship, but never the test fixtures.
      for (const artifact of ["catalog/models.json", "catalog/patches.json", "catalog/deprecated.json", "catalog/quarantine.json"]) {
        expect(packedPaths).toContain(artifact);
      }
      expect(packedPaths.some((p) => p.startsWith("catalog/fixtures/"))).toBe(false);

      // ...the shipped catalog never claims synthetic live provenance: its
      // availability is unverified, the probe is absent, quarantine is empty.
      const modelsText = await readFile(join(pkgDir, "catalog", "models.json"), "utf8");
      const shippedQuarantine: unknown = JSON.parse(await readFile(join(pkgDir, "catalog", "quarantine.json"), "utf8"));
      expect(modelsText).toContain('"kind": "unverified"');
      expect(modelsText).not.toContain("synthetic-unknown-live-probe");
      expect(shippedQuarantine).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
