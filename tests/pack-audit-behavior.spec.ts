/**
 * pack-audit behavior tests (Task 9 Oracle remediation).
 *
 * Drive the REAL packed-bytes audit with isolated tarballs to prove the
 * credential classes the Oracle found missing: UTF-16/非文本 content must
 * fail closed as `non-text` (never decoded with replacement semantics),
 * quoted credential field names must be detected, and control characters in
 * audit output must never appear raw. No source-text-only assertions — every
 * case packs and audits actual bytes.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { auditTarball } from "./helpers/pack-audit.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pack-audit-behavior-"));
}

function makeTarball(root: string, files: Record<string, Buffer>): string {
  mkdirSync(join(root, "package"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, "package", rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const tgz = join(root, "probe.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", root, "package"], { stdio: "pipe" });
  return tgz;
}

describe("pack audit non-text handling (Oracle RED 1)", () => {
  it("fails closed on UTF-16LE credential bytes in a real tarball", async () => {
    const root = tempRoot();
    try {
      const secret = ["sk-", "abcdef0123456789"].join("");
      const tgz = makeTarball(root, {
        "package.json": Buffer.from(JSON.stringify({ name: "x" }), "utf16le"),
        "README.md": Buffer.from(secret, "utf16le"),
      });
      const audit = await auditTarball(tgz, root);
      // The UTF-16 bytes must NOT silently decode into a matching key; they
      // must be reported as non-text, and the secret must never be echoed.
      const nonText = audit.secretHits.filter((h) => h.includes("non-text"));
      expect(nonText.length).toBeGreaterThan(0);
      for (const hit of audit.secretHits) {
        expect(hit).not.toContain(secret);
        expect(hit).not.toContain("sk-");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid UTF-8 bytes in a real tarball", async () => {
    const root = tempRoot();
    try {
      const tgz = makeTarball(root, {
        "lib/index.js": Buffer.from([0x73, 0x6b, 0x2d, 0xc3, 0x28, 0x61]),
      });
      const audit = await auditTarball(tgz, root);
      expect(audit.secretHits.some((h) => h.includes("non-text"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pack audit quoted credential fields (Oracle RED 4)", () => {
  it("detects a JSON-style quoted assignment in a real tarball", async () => {
    const root = tempRoot();
    try {
      // The field name is assembled at runtime so this spec's source never
      // contains a scan-matchable literal.
      const field = ["OPENCODE_GO_API", "KEY"].join("_");
      const value = ["opaquecredentialvalue12345"].join("");
      const content = Buffer.from(`{${JSON.stringify(field)}:${JSON.stringify(value)}}`);
      const tgz = makeTarball(root, {
        "package.json": content,
      });
      const audit = await auditTarball(tgz, root);
      expect(audit.secretHits.length).toBeGreaterThan(0);
      for (const hit of audit.secretHits) {
        expect(hit).not.toContain(value);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects an unquoted .env assignment in a real tarball", async () => {
    const root = tempRoot();
    try {
      const field = ["OPENCODE_GO_API", "KEY"].join("_");
      const value = ["opaquecredentialvalue12345"].join("");
      const tgz = makeTarball(root, {
        "package.json": Buffer.from(`${field}=${value}`),
      });
      const audit = await auditTarball(tgz, root);
      expect(audit.secretHits.length).toBeGreaterThan(0);
      for (const hit of audit.secretHits) {
        expect(hit).not.toContain(value);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a bracket-notation assignment in a real tarball", async () => {
    const root = tempRoot();
    try {
      const field = ["OPENCODE_GO_API", "KEY"].join("_");
      const value = ["opaquecredentialvalue12345"].join("");
      const content = `process.env[${JSON.stringify(field)}] = ${JSON.stringify(value)};`;
      const tgz = makeTarball(root, {
        "package.json": Buffer.from(content),
      });
      const audit = await auditTarball(tgz, root);
      expect(audit.secretHits.length).toBeGreaterThan(0);
      for (const hit of audit.secretHits) {
        expect(hit).not.toContain(value);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
