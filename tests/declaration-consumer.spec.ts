/**
 * Task 4 public declaration gate (red-first).
 *
 * The in-repo gate (`tsc -p tsconfig.json`) skips generated declaration
 * checking, so a rolled-up `lib/index.d.ts` referencing an undeclared symbol
 * (e.g. the inlined settings namespace brand) passes locally and breaks every
 * TypeScript consumer. This spec packs the artifact, links it into a fresh
 * consumer together with the host peer scope, and compiles a minimal strict
 * `.ts` import with `skipLibCheck: false` — the exact environment a real DSH
 * host typechecks — so any undeclared exported type fails the gate.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackManifest } from "./helpers/parse-output.ts";

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

/** Minimal strict consumer importing the packed root through its types export. */
const CONSUMER_TS = `
import { provider, NS, Config } from "dsh-opencode-go-provider";
import { settingsNamespace, type SettingsNamespace } from "@deepseek-ai/dsh-settings";

const ns: SettingsNamespace = NS;
const same: SettingsNamespace = settingsNamespace(provider.bundleRow);
const resolved = Config({ refreshMs: 1_800_000 });
void ns;
void same;
void resolved;
`;

const CONSUMER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      module: "esnext",
      moduleResolution: "bundler",
      target: "es2024",
      noEmit: true,
      skipLibCheck: false,
      types: [],
    },
    files: ["consumer.ts"],
  },
  null,
  2,
);

describe("packed public declarations", () => {
  it("compile in a fresh strict TypeScript consumer with host peers present", async () => {
    // Given: a built lib (built on demand through Corepack-pinned pnpm).
    if (!existsSync(join(REPO_ROOT, "lib", "index.js"))) {
      runSync("corepack", ["pnpm@11.7.0", "run", "build"], REPO_ROOT);
    }
    const tempRoot = await mkdtemp(join(tmpdir(), "dsh-opencode-go-provider-decl-"));
    try {
      // When: the exact tarball is packed, extracted, and linked into a fresh
      // consumer whose host peer scope mirrors a real DSH host.
      const packDir = join(tempRoot, "pack");
      const consumerDir = join(tempRoot, "consumer");
      await mkdir(packDir, { recursive: true });
      await mkdir(join(consumerDir, "node_modules"), { recursive: true });
      const packOutput = runSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
        REPO_ROOT,
      );
      const manifest: unknown = JSON.parse(packOutput);
      const parsed = parsePackManifest(manifest);
      runSync("tar", ["-xzf", join(packDir, parsed.filename), "-C", consumerDir], REPO_ROOT);
      await symlink(
        join(consumerDir, "package"),
        join(consumerDir, "node_modules", "dsh-opencode-go-provider"),
        "dir",
      );
      await symlink(
        join(REPO_ROOT, "node_modules", "@deepseek-ai"),
        join(consumerDir, "node_modules", "@deepseek-ai"),
        "dir",
      );
      await writeFile(join(consumerDir, "consumer.ts"), CONSUMER_TS);
      await writeFile(join(consumerDir, "tsconfig.json"), CONSUMER_TSCONFIG);
      // Then: the strict consumer compiles the packed declarations cleanly.
      const tsc = spawnSync(
        join(REPO_ROOT, "node_modules", ".bin", "tsc"),
        ["--noEmit", "-p", "tsconfig.json"],
        { cwd: consumerDir, encoding: "utf8" },
      );
      expect(tsc.status, tsc.stdout ?? tsc.stderr ?? "").toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
