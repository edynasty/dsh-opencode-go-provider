/**
 * Task 7 standalone CLI honesty contract (red-first).
 *
 * The BUILT `lib/bin.js` (the real package bin) must never emit raw removed
 * lines, absolute backup paths, arbitrary revision input, error messages or
 * the stdin key: a raw secret sentinel placed in the fixture, the revision
 * argument and the stdin input must appear nowhere in stdout/stderr.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const BIN = join(REPO_ROOT, "lib", "bin.js");

const SECRET_SENTINEL = "RAW-SECRET-SENTINEL-123456789";
const PATH_SENTINEL = "/Users/evil/fake-settings.yaml";
const REVISION_SENTINEL = "RAW-REVISION-SENTINEL-987654321";

const cleanDirs: string[] = [];
beforeAll(() => {
  // The full gate builds lib before vitest; this spec only rebuilds when the
  // bin is entirely missing (mirroring pack-import's guard), so a parallel
  // worker never races the writer.
  if (!existsSync(BIN)) {
    const result = spawnSync("corepack", ["pnpm@11.7.0", "run", "build"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.status !== 0) {
      throw new Error(`test setup: build failed: ${(result.stderr ?? "").slice(0, 500)}`);
    }
  }
});
afterAll(() => {
  for (const dir of cleanDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureWithSentinel(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-opencode-go-bin-"));
  cleanDirs.push(dir);
  const path = join(dir, "settings.yaml");
  writeFileSync(
    path,
    [
      "llm-pi-ai:",
      "  providers:",
      "    opencode-go:",
      "      baseURL: https://opencode.ai/zen/go/v1",
      `      apiKey: ${SECRET_SENTINEL}`,
      "    keep:",
      "      baseURL: https://keep.example/v1",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

const PATH_LIKE_KEY = "/Users/evil/settings.yaml";
const CONTROL_LIKE_KEY = "key\nwith\tcontrol";
const KEY_SENTINEL = "sk-RAW-KEY-SENTINEL-0123456789abcdef";

function fixtureWithHostileKeys(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-opencode-go-bin-"));
  cleanDirs.push(dir);
  const path = join(dir, "settings.yaml");
  writeFileSync(
    path,
    [
      "llm-pi-ai:",
      "  providers:",
      "    opencode-go:",
      `      "${PATH_LIKE_KEY}": p1`,
      `      "${CONTROL_LIKE_KEY.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}": p2`,
      `      "${KEY_SENTINEL}": p3`,
      "    keep:",
      "      baseURL: https://keep.example/v1",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function runBin(args: readonly string[], input?: string): { readonly stdout: string; readonly stderr: string; readonly status: number | null } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    input,
    timeout: 20_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

describe("built lib/bin.js", () => {
  it("migration-dry-run never leaks the raw secret sentinel, removed lines or removed key names", () => {
    const path = fixtureWithSentinel();
    const { stdout, stderr, status } = runBin(["migration-dry-run", path]);
    expect(status).toBe(0);
    expect(stdout).toContain("would remove llm-pi-ai.providers.opencode-go");
    expect(stdout).toContain("removed key count: 2");
    expect(stdout).toContain("removed line count: 3");
    expect(stdout).not.toContain(SECRET_SENTINEL);
    expect(stdout).not.toContain("apiKey:");
    expect(stdout).not.toContain("apiKey");
    expect(stdout).not.toContain("baseURL:");
    expect(stdout).not.toContain("baseURL");
    expect(stderr).not.toContain(SECRET_SENTINEL);
  });

  it("migration-apply rejects a sentinel --revision with a fixed category", () => {
    const path = fixtureWithSentinel();
    const { stdout, stderr, status } = runBin(["migration-apply", path, "--revision", REVISION_SENTINEL]);
    expect(status).toBe(1);
    expect(stdout).toContain("invalid revision");
    expect(stdout).not.toContain(REVISION_SENTINEL);
    expect(stderr).not.toContain(REVISION_SENTINEL);
  });

  it("migration-apply conflict output never echoes either revision", () => {
    const path = fixtureWithSentinel();
    const dryRun = runBin(["migration-dry-run", path]);
    const revision = dryRun.stdout.match(/revision ([0-9a-f]{64})/)?.[1];
    if (revision === undefined) throw new Error("test: dry-run did not report a revision");
    // Concurrent edit after the dry-run revision was observed.
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `# late edit\n${original}`, "utf8");
    const { stdout, status } = runBin(["migration-apply", path, "--revision", revision]);
    expect(status).toBe(1);
    expect(stdout).toContain("conflict");
    expect(stdout).not.toContain(revision);
  });

  it("migration-dry-run never renders hostile path/control/secret key names from the built bin", () => {
    const path = fixtureWithHostileKeys();
    const { stdout, stderr, status } = runBin(["migration-dry-run", path]);
    expect(status).toBe(0);
    expect(stdout).toContain("would remove llm-pi-ai.providers.opencode-go");
    expect(stdout).toContain("removed key count: 3");
    expect(stdout).toContain("removed line count: 4");
    expect(stdout).not.toContain("evil");
    expect(stdout).not.toContain("settings.yaml");
    expect(stdout).not.toContain("with\tcontrol");
    expect(stdout).not.toContain("RAW-KEY-SENTINEL");
    expect(stderr).not.toContain("evil");
    expect(stderr).not.toContain("with\tcontrol");
    expect(stderr).not.toContain("RAW-KEY-SENTINEL");
  });

  it("migration-apply never renders hostile path/control/secret key names from the built bin", () => {
    const path = fixtureWithHostileKeys();
    const { stdout, stderr, status } = runBin(["migration-apply", path]);
    expect(status).toBe(0);
    expect(stdout).toContain("applied");
    expect(stdout).toContain("removed key count: 3");
    expect(stdout).not.toContain("evil");
    expect(stdout).not.toContain("settings.yaml");
    expect(stdout).not.toContain("with\tcontrol");
    expect(stdout).not.toContain("RAW-KEY-SENTINEL");
    expect(stderr).not.toContain("evil");
    expect(stderr).not.toContain("with\tcontrol");
    expect(stderr).not.toContain("RAW-KEY-SENTINEL");
  });

  it("doctor with no credential reports unconfigured and never leaks the sentinel", () => {
    const { stdout, stderr, status } = runBin(["doctor"]);
    expect(status).toBe(1);
    expect(stdout).toContain("not configured");
    expect(stdout).not.toContain(SECRET_SENTINEL);
    expect(stderr).not.toContain(SECRET_SENTINEL);
  });

  it("connect reads the key from stdin and never echoes it in standalone refusal", () => {
    const { stdout, stderr, status } = runBin(["connect"], `${SECRET_SENTINEL}\n`);
    expect(status).toBe(1);
    expect(stdout).toContain("not writable");
    expect(stdout).not.toContain(SECRET_SENTINEL);
    expect(stderr).not.toContain(SECRET_SENTINEL);
  });

  it("status reports allowlisted facts only", () => {
    const { stdout, status } = runBin(["status"]);
    expect(status).toBe(0);
    expect(stdout).toContain("source: embedded");
    expect(stdout).not.toContain(PATH_SENTINEL);
  });
});
