/**
 * Task 7 legacy-config migration contract (red-first).
 *
 * The migration removes exactly the nested mapping `llm-pi-ai.providers
 * .opencode-go` by splicing the CST-validated span out of the RAW text — every
 * non-target byte (comments, quoting, blank lines, CRLF, scalar formatting,
 * key order) survives verbatim, proven by byte-for-byte equality against a
 * hard-coded expected document. Dry-run is read-only with a deterministic
 * exact diff. Apply verifies the dry-run revision, holds a same-directory
 * `wx` lock, re-reads/re-hashes immediately before the backup/write (a late
 * concurrent edit refuses with `conflict` and creates nothing), backs up with
 * `wx` (a timestamp collision fails closed), publishes atomically, and is
 * idempotent. Malformed YAML, wrong node types, symlinks (target or ancestor),
 * unsafe paths, permission failures and revision conflicts all abort before
 * the target is replaced.
 *
 * Every fixture lives in a fresh temp directory; the real DSH home is never
 * touched.
 */
import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigration, dryRunMigration } from "../src/migration.ts";
import { spliceSpanFromOffsets } from "../src/migration-parse.ts";
import { PreRenameConflictError, acquireLock, writeBackup, writeTextAtomic } from "../src/migration-fs.ts";
import { MIGRATION_NAMESPACE, MIGRATION_PROVIDER } from "../src/migration.ts";

/** A fake secret that must never reach any receipt or evidence. */
const FAKE_SECRET = "sk-migration-fake-secret-abcdef0123456789";

const HEX_RE = /^[0-9a-f]{64}$/;

/** A realistic legacy settings document carrying the manual opencode-go route. */
function settingsFixture(extra: string = ""): string {
  return [
    "# DSH settings — do not edit by hand",
    "agent-default-model: opencode-go/deepseek-v4-flash",
    "",
    "llm-pi-ai:",
    "  # manual provider profiles",
    "  providers:",
    "    deepseek:",
    "      baseURL: https://api.deepseek.com",
    "      api: openai-completions",
    "    opencode-go:",
    "      baseURL: https://opencode.ai/zen/go/v1",
    "      api: openai-completions",
    `      apiKeyEnv: OPENCODE_GO_API_KEY${extra}`,
    "    sentinel-provider:",
    "      baseURL: https://sentinel.example/v1",
    "      apiKeyEnv: SENTINEL_API_KEY",
    "",
  ].join("\n");
}

/** The byte-exact expected document after the migration of `settingsFixture`. */
function expectedAfterFixture(): string {
  return [
    "# DSH settings — do not edit by hand",
    "agent-default-model: opencode-go/deepseek-v4-flash",
    "",
    "llm-pi-ai:",
    "  # manual provider profiles",
    "  providers:",
    "    deepseek:",
    "      baseURL: https://api.deepseek.com",
    "      api: openai-completions",
    "    sentinel-provider:",
    "      baseURL: https://sentinel.example/v1",
    "      apiKeyEnv: SENTINEL_API_KEY",
    "",
  ].join("\n");
}

const cleanedDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanedDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-opencode-go-migration-"));
  cleanedDirs.push(dir);
  return dir;
}

async function writeSettings(dir: string, text: string): Promise<string> {
  const path = join(dir, "settings.yaml");
  await writeFile(path, text, { encoding: "utf8", mode: 0o640 });
  return path;
}

async function entriesOf(dir: string): Promise<readonly string[]> {
  return readdir(dir);
}

async function backupCount(dir: string): Promise<number> {
  return (await entriesOf(dir)).filter((name) => name.endsWith(".bak")).length;
}

describe("dryRunMigration", () => {
  it("is a byte-for-byte no-op and returns a deterministic exact diff", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const first = await dryRunMigration(path);
    expect(readFileSync(path, "utf8")).toBe(settingsFixture());
    expect(first.kind).toBe("would-remove");
    if (first.kind !== "would-remove") return;
    expect(first.target).toEqual({ namespace: MIGRATION_NAMESPACE, provider: MIGRATION_PROVIDER });
    expect(first.revision).toMatch(HEX_RE);
    expect(first.diff.removedLines).toEqual([
      "    opencode-go:",
      "      baseURL: https://opencode.ai/zen/go/v1",
      "      api: openai-completions",
      "      apiKeyEnv: OPENCODE_GO_API_KEY",
    ]);
    expect(first.diff.removedKeys).toEqual(["api", "apiKeyEnv", "baseURL"]);
    const second = await dryRunMigration(path);
    expect(second).toEqual(first);
  });

  it("returns no-target for a document without the legacy route", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, "agent-default-model: opencode-go/deepseek-v4-flash\n");
    const outcome = await dryRunMigration(path);
    expect(outcome.kind).toBe("no-target");
    if (outcome.kind === "no-target") {
      expect(outcome.revision).toMatch(HEX_RE);
      expect(outcome.target).toEqual({ namespace: MIGRATION_NAMESPACE, provider: MIGRATION_PROVIDER });
    }
  });

  it("never leaks a fake secret stored inside the target node", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture(`\n      apiKey: ${FAKE_SECRET}`));
    const outcome = await dryRunMigration(path);
    expect(JSON.stringify(outcome)).not.toContain(FAKE_SECRET);
    if (outcome.kind === "would-remove") {
      for (const line of outcome.diff.removedLines) {
        expect(line).not.toContain(FAKE_SECRET);
      }
    }
  });

  it("aborts on malformed YAML without touching the file", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, "llm-pi-ai: [unclosed\n");
    const outcome = await dryRunMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("malformed");
    expect(readFileSync(path, "utf8")).toBe("llm-pi-ai: [unclosed\n");
  });

  it("aborts when the target node is not a mapping", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, "llm-pi-ai:\n  providers:\n    opencode-go: just-a-string\n");
    const outcome = await dryRunMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("wrong-node-type");
  });

  it("aborts on a symlinked target before reading through it", async () => {
    const dir = tempDir();
    const real = join(dir, "real-settings.yaml");
    writeFileSync(real, settingsFixture(), "utf8");
    const link = join(dir, "settings.yaml");
    symlinkSync(real, link);
    const outcome = await dryRunMigration(link);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("unsafe-symlink");
  });

  it("aborts when a parent directory is a symlink", async () => {
    const dir = tempDir();
    const realDir = join(dir, "real");
    await mkdir(realDir);
    const linkDir = join(dir, "linked");
    symlinkSync(realDir, linkDir);
    const path = join(linkDir, "settings.yaml");
    writeFileSync(path, settingsFixture(), "utf8");
    const outcome = await dryRunMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("unsafe-symlink");
  });

  it("aborts when any path segment names credential/auth/cache material", async () => {
    const dir = tempDir();
    const nested = join(dir, "cache");
    await mkdir(nested);
    const path = join(nested, "settings.yaml");
    writeFileSync(path, settingsFixture(), "utf8");
    const outcome = await dryRunMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("unsafe-path");
  });

  it("aborts on a credential-shaped path", async () => {
    const dir = tempDir();
    const path = join(dir, ".credentials.yaml");
    writeFileSync(path, settingsFixture(), "utf8");
    const outcome = await dryRunMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("unsafe-path");
  });

  it("aborts when the path is not a regular file", async () => {
    const dir = tempDir();
    const path = join(dir, "missing-settings.yaml");
    const outcome = await dryRunMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("not-a-file");
  });
});

describe("applyMigration", () => {
  it("removes only the target node with byte-exact preservation of every non-target byte", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.removedKeys).toEqual(["api", "apiKeyEnv", "baseURL"]);
    const after = readFileSync(path, "utf8");
    // Byte-for-byte: comments, blank lines, order, scalars, refs all verbatim.
    expect(after).toBe(expectedAfterFixture());
    expect(after).not.toContain("opencode-go:");
    expect(after).toContain("agent-default-model: opencode-go/deepseek-v4-flash");
    expect(after).toContain("apiKeyEnv: SENTINEL_API_KEY");
  });

  it("preserves quoting style, internal/sibling comments and CRLF bytes exactly", async () => {
    const crlf = [
      "# DSH settings",
      "agent-default-model: opencode-go/deepseek-v4-flash",
      "",
      "llm-pi-ai:",
      "  # manual provider profiles",
      "  providers:",
      "    deepseek:",
      '      baseURL: "https://api.deepseek.com"',
      "    # a sibling comment above the manual route",
      "    opencode-go:",
      "      # an internal comment owned by the route",
      "      baseURL: https://opencode.ai/zen/go/v1",
      "      api: 'openai-completions'",
      "    sentinel-provider:",
      "      baseURL: https://sentinel.example/v1",
      "",
    ].join("\r\n");
    const expected = [
      "# DSH settings",
      "agent-default-model: opencode-go/deepseek-v4-flash",
      "",
      "llm-pi-ai:",
      "  # manual provider profiles",
      "  providers:",
      "    deepseek:",
      '      baseURL: "https://api.deepseek.com"',
      "    # a sibling comment above the manual route",
      "    sentinel-provider:",
      "      baseURL: https://sentinel.example/v1",
      "",
    ].join("\r\n");
    const dir = tempDir();
    const path = await writeSettings(dir, crlf);
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("applied");
    const after = readFileSync(path, "utf8");
    expect(after).toBe(expected);
    expect(after).not.toContain("# an internal comment owned by the route");
    expect(after).toContain("# a sibling comment above the manual route");
  });

  it("creates a private timestamped backup holding the original bytes only", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    const entries = await entriesOf(dir);
    const backups = entries.filter((name) => /^settings\.yaml\.migration-.*\.bak$/.test(name));
    expect(backups).toHaveLength(1);
    const backupName = backups[0];
    if (backupName === undefined) throw new Error("test: expected exactly one backup");
    const backupPath = join(dir, backupName);
    expect(readFileSync(backupPath, "utf8")).toBe(settingsFixture());
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect(outcome.backupPath).toBe(backupPath);
    expect(entries).not.toContain(".credentials.yaml");
    expect(entries).not.toContain("auth.json");
  });

  it("publishes atomically, preserving the original mode with no temp or lock residue", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("applied");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    const entries = await entriesOf(dir);
    expect(entries.some((name) => name.includes(".tmp"))).toBe(false);
    expect(entries.some((name) => name.endsWith(".migration.lock"))).toBe(false);
    expect(lstatSync(path).isFile()).toBe(true);
  });

  it("a second apply is an idempotent no-change with no second write or backup", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const first = await applyMigration(path);
    expect(first.kind).toBe("applied");
    const afterFirst = readFileSync(path, "utf8");
    const second = await applyMigration(path);
    expect(second.kind).toBe("no-change");
    if (second.kind === "no-change") expect(second.revision).toMatch(HEX_RE);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    const backups = (await entriesOf(dir)).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
  });

  it("fails on a revision conflict and preserves the prior bytes", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const dryRun = await dryRunMigration(path);
    expect(dryRun.kind).toBe("would-remove");
    if (dryRun.kind !== "would-remove") return;
    await writeFile(path, `${settingsFixture()}# someone edited the file\n`, "utf8");
    const outcome = await applyMigration(path, { expectedRevision: dryRun.revision });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") {
      expect(outcome.expected).toBe(dryRun.revision);
      expect(outcome.actual).not.toBe(dryRun.revision);
    }
    expect(readFileSync(path, "utf8")).toBe(`${settingsFixture()}# someone edited the file\n`);
    expect((await entriesOf(dir)).filter((name) => name.endsWith(".bak"))).toHaveLength(0);
  });

  it("closes the TOCTOU: a concurrent edit between read and precommit refuses with nothing written", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const dryRun = await dryRunMigration(path);
    expect(dryRun.kind).toBe("would-remove");
    if (dryRun.kind !== "would-remove") return;
    const outcome = await applyMigration(path, {
      expectedRevision: dryRun.revision,
      beforeCommit: async () => {
        await writeFile(path, `${settingsFixture()}# concurrent edit\n`, "utf8");
      },
    });
    expect(outcome.kind).toBe("conflict");
    // No backup, no temp, no lock residue; the concurrent edit's bytes survive.
    expect(readFileSync(path, "utf8")).toBe(`${settingsFixture()}# concurrent edit\n`);
    const entries = await entriesOf(dir);
    expect(entries.filter((name) => name.endsWith(".bak"))).toHaveLength(0);
    expect(entries.some((name) => name.includes(".tmp"))).toBe(false);
    expect(entries.some((name) => name.endsWith(".migration.lock"))).toBe(false);
  });

  it("refuses when another migration holds the same-directory lock", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    await writeFile(`${path}.migration.lock`, "", "utf8");
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("locked");
    expect(readFileSync(path, "utf8")).toBe(settingsFixture());
    expect((await entriesOf(dir)).filter((name) => name.endsWith(".bak"))).toHaveLength(0);
  });

  it("fails closed when the backup timestamp collides with an existing backup", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const fixedClock = { now: () => new Date("2026-08-14T00:00:00.000Z") };
    const existing = join(dir, "settings.yaml.migration-2026-08-14T00-00-00-000Z.bak");
    writeFileSync(existing, "older backup bytes", { mode: 0o600 });
    const outcome = await applyMigration(path, { clock: fixedClock });
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("write-failed");
    expect(readFileSync(existing, "utf8")).toBe("older backup bytes");
    expect(readFileSync(path, "utf8")).toBe(settingsFixture());
  });

  it("aborts on malformed YAML before any write, backup or lock residue", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, "llm-pi-ai: [unclosed\n");
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("malformed");
    expect(readFileSync(path, "utf8")).toBe("llm-pi-ai: [unclosed\n");
    expect(await entriesOf(dir)).toEqual(["settings.yaml"]);
  });

  it("preserves the credential reference in unrelated nodes after apply", async () => {
    const dir = tempDir();
    const text = [
      "llm-pi-ai:",
      "  providers:",
      "    opencode-go:",
      "      baseURL: https://opencode.ai/zen/go/v1",
      "    other:",
      "      baseURL: https://other.example/v1",
      "      apiKeyEnv: OPENCODE_GO_API_KEY",
      "",
    ].join("\n");
    const expected = [
      "llm-pi-ai:",
      "  providers:",
      "    other:",
      "      baseURL: https://other.example/v1",
      "      apiKeyEnv: OPENCODE_GO_API_KEY",
      "",
    ].join("\n");
    const path = await writeSettings(dir, text);
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe(expected);
  });
});

describe("splice and backup/lock failure boundaries", () => {
  it("spliceSpanFromOffsets refuses impossible offsets instead of splicing at zero", () => {
    const text = settingsFixture();
    expect(spliceSpanFromOffsets(text, -1, 10)).toBeUndefined();
    expect(spliceSpanFromOffsets(text, 0, text.length + 5)).toBeUndefined();
    expect(spliceSpanFromOffsets(text, 400, 10)).toBeUndefined();
    expect(spliceSpanFromOffsets(text, 0, 0)).toBeUndefined();
    const ok = spliceSpanFromOffsets(text, 0, 40);
    expect(ok).toBeDefined();
    if (ok !== undefined) {
      expect(ok.start).toBe(0);
      expect(ok.end).toBeGreaterThan(0);
    }
  });

  it("a backup fsync failure removes the partial backup and aborts", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const failingSync = async () => {
      throw new Error("injected fsync failure");
    };
    const outcome = await applyMigration(path, {
      backupDurability: { sync: failingSync, close: (handle) => handle.close() },
    });
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("write-failed");
    expect((await entriesOf(dir)).filter((name) => name.endsWith(".bak"))).toHaveLength(0);
    expect(readFileSync(path, "utf8")).toBe(settingsFixture());
  });

  it("a backup close failure removes the partial backup and aborts", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const failingClose = async () => {
      throw new Error("injected close failure");
    };
    const outcome = await applyMigration(path, {
      backupDurability: { sync: (handle) => handle.sync(), close: failingClose },
    });
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("write-failed");
    expect((await entriesOf(dir)).filter((name) => name.endsWith(".bak"))).toHaveLength(0);
  });

  it("a pre-existing backup collision file is preserved exactly", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const existing = join(dir, "settings.yaml.migration-collision.bak");
    writeFileSync(existing, "pre-existing bytes", { mode: 0o600 });
    await expect(writeBackup(path, settingsFixture(), "collision")).rejects.toThrow();
    expect(readFileSync(existing, "utf8")).toBe("pre-existing bytes");
  });

  it("a lock close failure removes the lock and refuses", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const failingClose = async () => {
      throw new Error("injected close failure");
    };
    await expect(acquireLock(path, failingClose)).rejects.toThrow("another migration is in progress");
    expect((await entriesOf(dir)).filter((name) => name.endsWith(".migration.lock"))).toHaveLength(0);
  });

  it("an atomic-write failure keeps the completed backup as recovery material", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const failingRename = async () => {
      throw new Error("injected rename failure");
    };
    const outcome = await applyMigration(path, { atomicRename: failingRename });
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("write-failed");
    // The backup holds the original bytes (recovery material) and the target
    // is untouched; no temp or lock residue remains.
    const backups = (await entriesOf(dir)).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backupName = backups[0];
    if (backupName === undefined) throw new Error("test: expected one backup");
    expect(readFileSync(join(dir, backupName), "utf8")).toBe(settingsFixture());
    expect(readFileSync(path, "utf8")).toBe(settingsFixture());
    expect((await entriesOf(dir)).some((name) => name.includes(".tmp"))).toBe(false);
    expect((await entriesOf(dir)).some((name) => name.endsWith(".migration.lock"))).toBe(false);
  });
});

describe("unsupported YAML shapes fail closed before any write", () => {
  async function expectAbortedUnsupported(path: string, original: string): Promise<void> {
    const dry = await dryRunMigration(path);
    expect(dry.kind).toBe("aborted");
    if (dry.kind === "aborted") expect(dry.reason).toBe("unsupported-shape");
    const applied = await applyMigration(path);
    expect(applied.kind).toBe("aborted");
    if (applied.kind === "aborted") expect(applied.reason).toBe("unsupported-shape");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(await backupCount(dirname(path))).toBe(0);
    expect((await entriesOf(dirname(path))).some((name) => name.includes(".tmp"))).toBe(false);
    expect((await entriesOf(dirname(path))).some((name) => name.endsWith(".migration.lock"))).toBe(false);
  }

  it("refuses a flow-style providers map", async () => {
    const dir = tempDir();
    const text = [
      "llm-pi-ai:",
      "  providers: { opencode-go: { baseURL: https://opencode.ai/zen/go/v1 } }",
      "  other: keep",
      "",
    ].join("\n");
    const path = await writeSettings(dir, text);
    await expectAbortedUnsupported(path, text);
  });

  it("refuses a flow-style namespace map", async () => {
    const dir = tempDir();
    const text = "llm-pi-ai: { providers: { opencode-go: { baseURL: x } } }\n";
    const path = await writeSettings(dir, text);
    await expectAbortedUnsupported(path, text);
  });

  it("refuses a target with an anchor referenced by a sibling alias", async () => {
    const dir = tempDir();
    const text = [
      "llm-pi-ai:",
      "  providers:",
      "    opencode-go: &manual",
      "      baseURL: https://opencode.ai/zen/go/v1",
      "    other: *manual",
      "",
    ].join("\n");
    const path = await writeSettings(dir, text);
    await expectAbortedUnsupported(path, text);
  });

  it("refuses a target that is the only provider instead of leaving providers: null", async () => {
    const dir = tempDir();
    const text = [
      "llm-pi-ai:",
      "  providers:",
      "    opencode-go:",
      "      baseURL: https://opencode.ai/zen/go/v1",
      "",
    ].join("\n");
    const path = await writeSettings(dir, text);
    await expectAbortedUnsupported(path, text);
  });

  it("supports the target as the first provider with byte-exact output", async () => {
    const dir = tempDir();
    const text = [
      "llm-pi-ai:",
      "  providers:",
      "    opencode-go:",
      "      baseURL: https://opencode.ai/zen/go/v1",
      "    sentinel:",
      "      baseURL: https://sentinel.example/v1",
      "",
    ].join("\n");
    const expected = [
      "llm-pi-ai:",
      "  providers:",
      "    sentinel:",
      "      baseURL: https://sentinel.example/v1",
      "",
    ].join("\n");
    const path = await writeSettings(dir, text);
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe(expected);
  });

  it("supports the target as the last provider with byte-exact output", async () => {
    const dir = tempDir();
    const text = [
      "llm-pi-ai:",
      "  providers:",
      "    deepseek:",
      "      baseURL: https://api.deepseek.com",
      "    opencode-go:",
      "      baseURL: https://opencode.ai/zen/go/v1",
      "",
    ].join("\n");
    const expected = [
      "llm-pi-ai:",
      "  providers:",
      "    deepseek:",
      "      baseURL: https://api.deepseek.com",
      "",
    ].join("\n");
    const path = await writeSettings(dir, text);
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe(expected);
  });
});

describe("nested anchors and aliases fail closed at any AST depth", () => {
  async function expectClosedUnsupported(text: string): Promise<void> {
    const dir = tempDir();
    const path = await writeSettings(dir, text);
    const dry = await dryRunMigration(path);
    expect(dry.kind).toBe("aborted");
    if (dry.kind === "aborted") expect(dry.reason).toBe("unsupported-shape");
    const applied = await applyMigration(path);
    expect(applied.kind).toBe("aborted");
    if (applied.kind === "aborted") expect(applied.reason).toBe("unsupported-shape");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(await backupCount(dir)).toBe(0);
    expect((await entriesOf(dir)).some((name) => name.includes(".tmp"))).toBe(false);
    expect((await entriesOf(dir)).some((name) => name.endsWith(".migration.lock"))).toBe(false);
  }

  it("refuses a target second-level anchor consumed by a sibling nested alias (Oracle case)", async () => {
    await expectClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers:",
        "    opencode-go:",
        "      nested:",
        "        deep: &deep",
        "          x: 1",
        "    keep:",
        "      nested:",
        "        ref: *deep",
        "",
      ].join("\n"),
    );
  });

  it("refuses a target-internal nested alias at depth 2", async () => {
    await expectClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers:",
        "    opencode-go:",
        "      nested:",
        "        deep: &deep",
        "          x: 1",
        "        ref: *deep",
        "    keep:",
        "      baseURL: y",
        "",
      ].join("\n"),
    );
  });

  it("refuses a sibling provider's nested anchor and alias", async () => {
    await expectClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers:",
        "    opencode-go:",
        "      baseURL: https://opencode.ai/zen/go/v1",
        "    keep:",
        "      nested:",
        "        deep: &deep",
        "          x: 1",
        "        ref: *deep",
        "",
      ].join("\n"),
    );
  });

  it("refuses an anchor on the namespace value itself", async () => {
    await expectClosedUnsupported(
      [
        "llm-pi-ai: &ns",
        "  providers:",
        "    opencode-go:",
        "      baseURL: x",
        "    keep:",
        "      baseURL: y",
        "",
      ].join("\n"),
    );
  });

  it("refuses an anchor on the providers value itself", async () => {
    await expectClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers: &p",
        "    opencode-go:",
        "      baseURL: x",
        "    keep:",
        "      baseURL: y",
        "",
      ].join("\n"),
    );
  });

  it("refuses a scalar anchor and alias at depth 2", async () => {
    await expectClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers:",
        "    opencode-go:",
        "      nested:",
        "        u: &u sk-abc",
        "        v: *u",
        "    keep:",
        "      baseURL: y",
        "",
      ].join("\n"),
    );
  });

  it("refuses anchors and aliases inside sequence descendants", async () => {
    await expectClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers:",
        "    opencode-go:",
        "      baseURL: x",
        "      tags:",
        "        - &t one",
        "        - *t",
        "    keep:",
        "      baseURL: y",
        "",
      ].join("\n"),
    );
  });

  it("refuses an anchor and alias at depth 3", async () => {
    await expectClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers:",
        "    opencode-go:",
        "      a:",
        "        b:",
        "          deep: &deep",
        "            x: 1",
        "          ref: *deep",
        "    keep:",
        "      baseURL: y",
        "",
      ].join("\n"),
    );
  });

  it("keeps ordinary nested block maps migrating byte-exactly (no over-rejection)", async () => {
    const dir = tempDir();
    const text = [
      "llm-pi-ai:",
      "  providers:",
      "    opencode-go:",
      "      nested:",
      "        deep:",
      "          x: 1",
      "    keep:",
      "      baseURL: y",
      "",
    ].join("\n");
    const expected = [
      "llm-pi-ai:",
      "  providers:",
      "    keep:",
      "      baseURL: y",
      "",
    ].join("\n");
    const path = await writeSettings(dir, text);
    const outcome = await applyMigration(path);
    expect(outcome.kind).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe(expected);
  });
});

describe("root-level alias nodes fail closed (parsing order)", () => {
  async function expectAliasClosedUnsupported(text: string): Promise<void> {
    const dir = tempDir();
    const path = await writeSettings(dir, text);
    const dry = await dryRunMigration(path);
    expect(dry.kind).toBe("aborted");
    if (dry.kind === "aborted") expect(dry.reason).toBe("unsupported-shape");
    const applied = await applyMigration(path);
    expect(applied.kind).toBe("aborted");
    if (applied.kind === "aborted") expect(applied.reason).toBe("unsupported-shape");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(await backupCount(dir)).toBe(0);
    expect((await entriesOf(dir)).some((name) => name.includes(".tmp"))).toBe(false);
    expect((await entriesOf(dir)).some((name) => name.endsWith(".migration.lock"))).toBe(false);
  }

  it("refuses a namespace-root alias: llm-pi-ai: *legacy", async () => {
    await expectAliasClosedUnsupported(
      [
        "legacy: &root",
        "  providers:",
        "    other:",
        "      baseURL: x",
        "llm-pi-ai: *legacy",
        "",
      ].join("\n"),
    );
  });

  it("refuses a providers-root alias: providers: *profiles", async () => {
    await expectAliasClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers: *profiles",
        "  other: keep",
        "profiles: &p",
        "  opencode-go:",
        "    baseURL: x",
        "",
      ].join("\n"),
    );
  });

  it("refuses a target alias: opencode-go: *target", async () => {
    await expectAliasClosedUnsupported(
      [
        "llm-pi-ai:",
        "  providers:",
        "    opencode-go: *target",
        "    keep:",
        "      baseURL: y",
        "target: &t",
        "  baseURL: x",
        "",
      ].join("\n"),
    );
  });
});

describe("absent and wrong-type taxonomy preserved across levels", () => {
  it("keeps no-target for a genuinely absent namespace", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, "agent-default-model: opencode-go/deepseek-v4-flash\n");
    const dry = await dryRunMigration(path);
    expect(dry.kind).toBe("no-target");
    const applied = await applyMigration(path);
    expect(applied.kind).toBe("no-change");
  });

  it("keeps no-target for a genuinely absent providers mapping", async () => {
    const dir = tempDir();
    const text = ["llm-pi-ai:", "  other: keep", ""].join("\n");
    const path = await writeSettings(dir, text);
    const dry = await dryRunMigration(path);
    expect(dry.kind).toBe("no-target");
    const applied = await applyMigration(path);
    expect(applied.kind).toBe("no-change");
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("keeps no-target for a genuinely absent target provider", async () => {
    const dir = tempDir();
    const text = ["llm-pi-ai:", "  providers:", "    other:", "      baseURL: x", ""].join("\n");
    const path = await writeSettings(dir, text);
    const dry = await dryRunMigration(path);
    expect(dry.kind).toBe("no-target");
    const applied = await applyMigration(path);
    expect(applied.kind).toBe("no-change");
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("classifies a scalar namespace as wrong-type, not no-target", async () => {
    const dir = tempDir();
    const text = "llm-pi-ai: just-a-string\n";
    const path = await writeSettings(dir, text);
    const dry = await dryRunMigration(path);
    expect(dry.kind).toBe("aborted");
    if (dry.kind === "aborted") expect(dry.reason).toBe("wrong-node-type");
  });

  it("classifies a scalar providers value as wrong-type, not no-target", async () => {
    const dir = tempDir();
    const text = ["llm-pi-ai:", "  providers: just-a-string", ""].join("\n");
    const path = await writeSettings(dir, text);
    const dry = await dryRunMigration(path);
    expect(dry.kind).toBe("aborted");
    if (dry.kind === "aborted") expect(dry.reason).toBe("wrong-node-type");
  });
});

describe("late-edit detection across the backup/temp window", () => {
  it("detects a concurrent edit during backup sync: conflict, bytes preserved, no residue", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const dryRun = await dryRunMigration(path);
    expect(dryRun.kind).toBe("would-remove");
    if (dryRun.kind !== "would-remove") return;
    let edited = false;
    const outcome = await applyMigration(path, {
      backupDurability: {
        sync: async (handle) => {
          await handle.sync();
          if (!edited) {
            edited = true;
            await writeFile(path, `${settingsFixture()}# late sentinel edit\n`, "utf8");
          }
        },
        close: (handle) => handle.close(),
      },
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") {
      expect(outcome.actual).not.toBe(outcome.expected);
    }
    // The concurrent edit's bytes survive untouched.
    expect(readFileSync(path, "utf8")).toBe(`${settingsFixture()}# late sentinel edit\n`);
    // The migration-created backup, temp and lock are all removed.
    const entries = await entriesOf(dir);
    expect(entries.filter((name) => name.endsWith(".bak"))).toHaveLength(0);
    expect(entries.some((name) => name.includes(".tmp"))).toBe(false);
    expect(entries.some((name) => name.endsWith(".migration.lock"))).toBe(false);
  });

  it("detects a concurrent edit after the temp is prepared but before the rename", async () => {
    const dir = tempDir();
    const path = await writeSettings(dir, settingsFixture());
    const edited = `${settingsFixture()}# temp-window edit\n`;
    // The temp is fully written/synced; an edit lands, then the verify runs
    // and refuses with the typed pre-rename conflict.
    await expect(
      writeTextAtomic(
        path,
        "migrated",
        0o640,
        undefined,
        async () => {
          const latest = readFileSync(path, "utf8");
          throw new PreRenameConflictError("expected", latest);
        },
        async () => {
          await writeFile(path, edited, "utf8");
        },
      ),
    ).rejects.toThrow(PreRenameConflictError);
    expect(readFileSync(path, "utf8")).toBe(edited);
    expect((await entriesOf(dir)).some((name) => name.includes(".tmp"))).toBe(false);
  });
});

describe("forbidden path segment matching", () => {
  it.each([
    ["Cache", "cache"],
    ["CACHE", "cache"],
    ["CaChE", "cache"],
  ])("refuses a %s segment case-insensitively", async (_segment, name) => {
    const dir = tempDir();
    const nested = join(dir, name);
    await mkdir(nested);
    const path = join(nested, "settings.yaml");
    writeFileSync(path, settingsFixture(), "utf8");
    const outcome = await dryRunMigration(path);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") expect(outcome.reason).toBe("unsafe-path");
  });
});
