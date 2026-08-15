/**
 * scan-secrets unit tests (Task 9 remediation).
 *
 * Prove the strengthened repository credential scan: detection in ANY
 * repository path (including tests/), fixture allowlisting ONLY by exact
 * file-scoped SHA-256 digests (never by word/path/category), rejection of the
 * same token copied into src/, iteration over EVERY regex match in a file
 * (one allowed fixture cannot hide a second unallowed token), and output that
 * contains only relative path + fixed category — never the matched value,
 * line or surrounding context.
 *
 * Token literals in this spec are deliberately SPLICED through join() so the
 * spec itself never contains a scan-matchable literal.
 */
import { describe, expect, it } from "vitest";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALLOWED_FIXTURES,
  SECRET_PATTERNS,
  enumerateRepoFiles,
  formatHit,
  safePath,
  scanContent,
  scanFileEntry,
  scanRepo,
  sha256Hex,
} from "./helpers/scan-secrets.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Spliced so no full literal exists in this file (the scanner must not match
// its own test fixture).
const OPENAI_KEY = ["sk-", "abcdef0123456789"].join("");
const OPENAI_KEY_2 = ["sk-", "fedcba9876543210"].join("");
const OPENAI_KEY_3 = ["sk-", "0011223344556677"].join("");
const REALISTIC_ASSIGNMENT = ["OPENCODE_GO_API_KEY", "=", "sk-live-", "1234567890abcdef"].join("");
const BEARER_DOC = ["Authorization", ": Bearer header"].join("");
const BOGUS_BEARER = ["authorization", "=Bearer bogus-token"].join("");
const FAKE_KEY_ASSIGNMENT = ["OPENCODE_GO_API_KEY", ": FAKE_KEY"].join("");
const SK_PROJ = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz123456"].join("");
const GITHUB_PAT = ["github_pat_", "abcdefghijklmnopqrstuvwxyz123"].join("");
const GITHUB_TOKEN = ["ghp_", "abcdefghijklmnopqrstuvwxyz1234567890"].join("");
const AWS_KEY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const GOOGLE_KEY = ["AIza", "abcdefghijklmnopqrstuvwxyz0123456789ABCDE"].join("");
const SLACK_TOKEN = ["xoxb-", "123456789012-abcdefghijklm"].join("");
const PRIVATE_KEY = ["-----BEGIN ", "RSA PRIVATE KEY-----"].join("");
const GO_LIVE = ["go_live_", "abcdefghijklmnopqrstuvwxyz123456"].join("");

describe("scanContent detection", () => {
  it("detects a real-looking token in a test path", () => {
    // Given: content with a realistic key under a tests/ path.
    const content = `const k = "${OPENAI_KEY}";`;
    // When: the pure scanner inspects it with no allowlist.
    const hits = scanContent(content, "tests/evil.spec.ts", []);
    // Then: the hit names file + category, never the value.
    expect(hits).toEqual(["tests/evil.spec.ts openai-key"]);
  });

  it("detects assignment-shaped secrets in any path including src", () => {
    const value = ["opaquecredentialvalue12345"].join("");
    const hits = scanContent(
      `const env = { ${JSON.stringify(["OPENCODE_GO_API_KEY"].join(""))}: ${JSON.stringify(value)} };`,
      "src/evil.ts",
      [],
    );
    expect(hits).toContain("src/evil.ts api-key-assignment");
  });

  it("keeps sk/go/JWT/Bearer/access-token categories", () => {
    const categories = SECRET_PATTERNS.map((p) => p.category);
    for (const expected of [
      "openai-key",
      "go-live-key",
      "api-key-assignment",
      "bearer-header",
      "bearer-token",
      "jwt-token",
      "access-token",
    ]) {
      expect(categories).toContain(expected);
    }
  });
});

describe("file-scoped digest allowlist", () => {
  it("allows a known fixture only in its exact approved file", () => {
    // Given: a token that exists in the approved fixture file. The hardcoded
    // assignment now produces TWO matches: the inner sk-live token
    // (openai-key) and the quoted assignment (api-key-assignment, whose
    // matched substring includes the opening quote); both digests are
    // file-scoped to the approved file.
    const approved = "tests/helpers/release-candidate-harness.ts";
    const allowedDigests = [
      sha256Hex(["sk-live-", "1234567890abcdef"].join("")),
      sha256Hex(`"${REALISTIC_ASSIGNMENT}`),
    ];
    // When: the same content is scanned with those digests allowlisted for
    // that exact file.
    const allowedInFile = scanContent(
      `const key = "${REALISTIC_ASSIGNMENT}";`,
      approved,
      allowedDigests,
    );
    // Then: no hit in the approved file...
    expect(allowedInFile).toEqual([]);
    // ...but the same token in src/ is rejected: the digests are scoped to
    // the approved file, so src/ has no matching allowlist entry.
    const copiedToSrc = scanContent(
      `const key = "${REALISTIC_ASSIGNMENT}";`,
      "src/evil.ts",
      [],
    );
    expect(copiedToSrc).toEqual([
      "src/evil.ts openai-key",
      "src/evil.ts api-key-assignment",
    ]);
  });

  it("rejects a second unallowlisted token in the same file", () => {
    // Given: content with TWO tokens, only one of which is allowlisted.
    const content = `const a = "${OPENAI_KEY}"; const b = "${OPENAI_KEY_2}";`;
    const digest = sha256Hex(OPENAI_KEY);
    // When: scanned with only the first token's digest allowed.
    const hits = scanContent(content, "tests/mixed.spec.ts", [digest]);
    // Then: the unallowlisted second token still fails the file.
    expect(hits).toEqual(["tests/mixed.spec.ts openai-key"]);
  });

  it("iterates every regex match, not just RegExp.test", () => {
    // Given: a file with an allowed token followed by a forbidden token.
    const digest = sha256Hex(OPENAI_KEY);
    const content = `"${OPENAI_KEY}" then "${OPENAI_KEY_3}";`;
    const hits = scanContent(content, "tests/pair.spec.ts", [digest]);
    // RegExp.test would have returned true on the first (allowed) match and
    // stopped; the iterator must continue and report the second.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe("tests/pair.spec.ts openai-key");
  });
});

describe("output sanitization", () => {
  it("formatted output contains only relative path + fixed category", () => {
    const hit = formatHit("tests/x.spec.ts", "api-key-assignment");
    expect(hit).toBe("tests/x.spec.ts api-key-assignment");
    expect(hit).not.toContain(REALISTIC_ASSIGNMENT);
    expect(hit).not.toContain("sk-");
    expect(hit).not.toContain(":");
  });

  it("never emits the matched value, line or context", () => {
    const content = `line one\nconst k = "${REALISTIC_ASSIGNMENT}";\nline three`;
    const hits = scanContent(content, "tests/leak.spec.ts", []);
    const report = hits.join("\n");
    expect(report).not.toContain(REALISTIC_ASSIGNMENT);
    expect(report).not.toContain("line one");
    expect(report).not.toContain("line three");
    expect(report).not.toContain("const k");
    expect(report).not.toContain("sk-live");
    expect(report).not.toContain("sk-");
  });

  it("real repository fixtures are allowed only by their exact digests", () => {
    // Every fixture that currently exists must be covered by the shipped
    // allowlist at its exact path — the scanner over the real repo passes
    // green in the CLI test, and each of the known intentional matches is
    // present in ALLOWED_FIXTURES with its real file's digest.
    const harness = readFileSync(
      join(REPO_ROOT, "tests/helpers/release-candidate-harness.ts"),
      "utf8",
    );
    const digest = sha256Hex(["sk-live-", "1234567890abcdef"].join(""));
    const hits = scanContent(
      harness,
      "tests/helpers/release-candidate-harness.ts",
      ALLOWED_FIXTURES["tests/helpers/release-candidate-harness.ts"] ?? [],
    );
    expect(hits).toEqual([]);
    expect(ALLOWED_FIXTURES["tests/helpers/release-candidate-harness.ts"]).toContain(digest);
  });
});

describe("known intentional fixture matches", () => {
  it("covers every current intentional match with its exact file digest", () => {
    // The shipped allowlist keys must exactly cover the real fixture files
    // that contain intentional fake literals.
    for (const key of Object.keys(ALLOWED_FIXTURES)) {
      expect(key.startsWith("tests/")).toBe(true);
    }
    expect(ALLOWED_FIXTURES["tests/config.spec.ts"]).toBeDefined();
    expect(ALLOWED_FIXTURES["tests/connect-remote.client.spec.ts"]).toBeDefined();
    expect(ALLOWED_FIXTURES["tests/control.spec.ts"]).toBeDefined();
    expect(ALLOWED_FIXTURES["tests/credentials.spec.ts"]).toBeDefined();
    expect(ALLOWED_FIXTURES["tests/helpers/host-loader.ts"]).toBeDefined();
    expect(ALLOWED_FIXTURES["tests/helpers/mock-server.ts"]).toBeDefined();
    expect(ALLOWED_FIXTURES["tests/helpers/release-candidate-harness.ts"]).toBeDefined();
    expect(ALLOWED_FIXTURES["tests/service-lifecycle.spec.ts"]).toBeDefined();
    expect(ALLOWED_FIXTURES["tests/sync.spec.ts"]).toBeDefined();
  });

  it("digests never equal the plaintext fixture values", () => {
    for (const digests of Object.values(ALLOWED_FIXTURES)) {
      for (const digest of digests) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    // A digest is not the value itself.
    expect(Object.values(ALLOWED_FIXTURES).flat()).not.toContain(OPENAI_KEY);
    expect(Object.values(ALLOWED_FIXTURES).flat()).not.toContain(REALISTIC_ASSIGNMENT);
    expect(Object.values(ALLOWED_FIXTURES).flat()).not.toContain(BEARER_DOC);
    expect(Object.values(ALLOWED_FIXTURES).flat()).not.toContain(BOGUS_BEARER);
    expect(Object.values(ALLOWED_FIXTURES).flat()).not.toContain(FAKE_KEY_ASSIGNMENT);
  });
});

describe("expanded credential categories", () => {
  it("detects sk-proj and hyphenated provider keys", () => {
    const hits = scanContent(`key = "${SK_PROJ}"`, "src/evil.ts", []);
    expect(hits).toEqual(["src/evil.ts openai-key"]);
  });

  it("detects GitHub PAT and fine-grained tokens", () => {
    const content = `a = "${GITHUB_PAT}"; b = "${GITHUB_TOKEN}";`;
    const hits = scanContent(content, "src/evil.ts", []);
    expect(hits).toEqual([
      "src/evil.ts github-pat",
      "src/evil.ts github-token",
    ]);
  });

  it("detects AWS and Google keys", () => {
    const content = `a = "${AWS_KEY}"; b = "${GOOGLE_KEY}";`;
    const hits = scanContent(content, "src/evil.ts", []);
    expect(hits).toEqual([
      "src/evil.ts aws-key",
      "src/evil.ts google-key",
    ]);
  });

  it("detects Slack tokens", () => {
    const hits = scanContent(`t = "${SLACK_TOKEN}"`, "src/evil.ts", []);
    expect(hits).toEqual(["src/evil.ts slack-token"]);
  });

  it("detects private key markers", () => {
    const hits = scanContent(PRIVATE_KEY, "src/evil.ts", []);
    expect(hits).toEqual(["src/evil.ts private-key"]);
  });

  it("detects go_live provider keys", () => {
    const hits = scanContent(`k = "${GO_LIVE}"`, "src/evil.ts", []);
    expect(hits).toEqual(["src/evil.ts go-live-key"]);
  });

  it("keeps all expanded categories in the pattern table", () => {
    const categories = SECRET_PATTERNS.map((p) => p.category);
    for (const expected of [
      "openai-key",
      "go-live-key",
      "api-key-assignment",
      "bearer-header",
      "bearer-token",
      "jwt-token",
      "access-token",
      "github-pat",
      "github-token",
      "aws-key",
      "google-key",
      "slack-token",
      "private-key",
    ]) {
      expect(categories).toContain(expected);
    }
  });
});

describe("fail-closed file entry processing", () => {
  it("reports a non-regular entry as file/category only, never follows it", () => {
    const root = mkdtemp();
    const target = join(root, "target.txt");
    writeFileSync(target, "hello");
    const link = join(root, "link.txt");
    symlinkSync(target, link);
    // When: the symlink is scanned as a repository entry.
    const hits = scanFileEntry(link, root, {});
    // Then: fixed non-regular category, no content, no follow.
    expect(hits).toEqual(["link.txt non-regular"]);
    cleanup(root);
  });

  it("reports an unreadable regular file as read-error, never silent", () => {
    const root = mkdtemp();
    const file = join(root, "locked.txt");
    writeFileSync(file, "content");
    // Make the file unreadable on POSIX.
    if (process.platform !== "win32") {
      chmodSync(file, 0o000);
      try {
        const hits = scanFileEntry(file, root, {});
        expect(hits).toEqual(["locked.txt read-error"]);
      } finally {
        chmodSync(file, 0o644);
      }
    }
    cleanup(root);
  });
});

describe("scanRepo runtime shape matches declaration contract", () => {
  it("returns a string-array hits and a numeric file count", () => {
    const result = scanRepo(REPO_ROOT);
    expect(Array.isArray(result.hits)).toBe(true);
    expect(typeof result.files).toBe("number");
    for (const hit of result.hits) {
      expect(typeof hit).toBe("string");
      expect(hit).toMatch(/^[^\s]+ [a-z-]+$/);
    }
    expect(result.files).toBeGreaterThan(0);
    expect(result.files).toBe(enumerateRepoFiles(REPO_ROOT).length);
  });
});

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "scan-secrets-spec-"));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe("non-text content fails closed (Oracle RED 1)", () => {
  it("reports UTF-16LE content as non-text, never scanning it as text", () => {
    const root = mkdtemp();
    const file = join(root, "utf16le.txt");
    const secret = ["sk-", "abcdef0123456789"].join("");
    writeFileSync(file, Buffer.from(secret, "utf16le"));
    const hits = scanFileEntry(file, root, {});
    expect(hits).toEqual(["utf16le.txt non-text"]);
    cleanup(root);
  });

  it("reports UTF-16BE content as non-text", () => {
    const root = mkdtemp();
    const file = join(root, "utf16be.txt");
    const secret = ["sk-", "abcdef0123456789"].join("");
    writeFileSync(file, Buffer.from(secret, "utf16le").swap16());
    const hits = scanFileEntry(file, root, {});
    expect(hits).toEqual(["utf16be.txt non-text"]);
    cleanup(root);
  });

  it("reports NUL-containing content as non-text", () => {
    const root = mkdtemp();
    const file = join(root, "nul.txt");
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from(["sk-", "abcdef"].join("")),
        Buffer.from([0x00]),
        Buffer.from("0123456789"),
      ]),
    );
    const hits = scanFileEntry(file, root, {});
    expect(hits).toEqual(["nul.txt non-text"]);
    cleanup(root);
  });

  it("reports invalid UTF-8 bytes as non-text, never replacement chars", () => {
    const root = mkdtemp();
    const file = join(root, "bad.txt");
    // 0xC3 0x28 is an invalid UTF-8 sequence; Buffer.toString would emit U+FFFD.
    writeFileSync(file, Buffer.from([0x73, 0x6b, 0x2d, 0xc3, 0x28, 0x61]));
    const hits = scanFileEntry(file, root, {});
    expect(hits).toEqual(["bad.txt non-text"]);
    cleanup(root);
  });
});

describe("unsafe path output (Oracle RED 2)", () => {
  it("replaces control characters in a path with a fixed placeholder", () => {
    const evil = [
      "tests/evil",
      String.fromCharCode(10),
      "::error file=README.md::pwned",
      String.fromCharCode(27),
      "[31m.spec.ts",
    ].join("");
    const safe = safePath(evil);
    expect(safe).not.toContain(String.fromCharCode(10));
    expect(safe).not.toContain(String.fromCharCode(27));
    expect(safe).not.toContain("::error");
    expect(safe).toMatch(/^[ -~]+$/);
  });

  it("keeps safe printable paths unchanged", () => {
    expect(safePath("tests/foo.spec.ts")).toBe("tests/foo.spec.ts");
    expect(safePath("src/evil.ts")).toBe("src/evil.ts");
  });

  it("never emits a control-character path in scan hits", () => {
    const root = mkdtemp();
    const evil = ["evil", String.fromCharCode(10), "x.spec.ts"].join("");
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", evil), `const k = "${["sk-", "abcdef0123456789"].join("")}";`);
    const hits = scanFileEntry(join(root, "tests", evil), root, {});
    expect(hits).toHaveLength(1);
    for (const hit of hits) {
      expect(hit).toMatch(/^[ -~]+ [a-z-]+$/);
      expect(hit).not.toContain(String.fromCharCode(10));
    }
    cleanup(root);
  });
});

describe("ancestor symlink and hardlink fail closed (Oracle RED 3)", () => {
  it("rejects a symlinked ancestor directory, never following outside root", () => {
    const root = mkdtemp();
    const outside = mkdtemp();
    try {
      writeFileSync(join(outside, "leak.ts"), `const k = "${["sk-", "ancestorsymlink12345678"].join("")}";`);
      mkdirSync(join(root, "tracked"), { recursive: true });
      // The tracked/ directory is a symlink pointing OUTSIDE the root; the
      // leaf file under it is a plain regular file.
      rmSync(join(root, "tracked"), { recursive: true, force: true });
      symlinkSync(outside, join(root, "tracked"));
      writeFileSync(join(root, "tracked", "file.spec.ts"), "x");
      const hits = scanFileEntry(join(root, "tracked", "file.spec.ts"), root, {});
      expect(hits).toEqual(["tracked/file.spec.ts non-regular"]);
      // The outside leak must never be read or reported as a secret.
      for (const hit of hits) {
        expect(hit).not.toContain("leak.ts");
      }
    } finally {
      cleanup(root);
      cleanup(outside);
    }
  });

  it("rejects a hardlinked file", () => {
    const root = mkdtemp();
    const file = join(root, "a.txt");
    const link = join(root, "b.txt");
    writeFileSync(file, `const k = "${["sk-", "abcdef0123456789"].join("")}";`);
    linkSync(file, link);
    try {
      const hits = scanFileEntry(link, root, {});
      expect(hits).toEqual(["b.txt non-regular"]);
    } finally {
      cleanup(root);
    }
  });

  it("rejects a path that resolves outside the root", () => {
    const root = mkdtemp();
    try {
      // A lexical escape through .. never reads outside the root: the path
      // fails closed with a fixed category and no content is reported.
      const escaped = join(root, "..", "..", "..", "..", "tmp", "escape-probe.txt");
      const hits = scanFileEntry(escaped, root, {});
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatch(/ (non-regular|read-error)$/);
    } finally {
      cleanup(root);
    }
  });
});

describe("quoted credential field names (Oracle RED 4)", () => {
  // The field name is assembled at runtime so the spec source itself never
  // contains a scan-matchable literal.
  const FIELD = ["OPENCODE_GO_API", "KEY"].join("_");
  const VALUE = ["opaquecredentialvalue12345"].join("");

  it("detects JSON-style quoted assignment", () => {
    const content = `{${JSON.stringify(FIELD)}:${JSON.stringify(VALUE)}}`;
    const hits = scanContent(content, "src/evil.json", []);
    expect(hits).toEqual(["src/evil.json api-key-assignment"]);
  });

  it("detects TOML-style quoted assignment", () => {
    const content = `${JSON.stringify(FIELD)} = ${JSON.stringify(VALUE)}`;
    const hits = scanContent(content, "src/evil.toml", []);
    expect(hits).toEqual(["src/evil.toml api-key-assignment"]);
  });

  it("keeps YAML unquoted assignment detection", () => {
    const content = `${FIELD}: ${JSON.stringify(VALUE)}`;
    const hits = scanContent(content, "src/evil.yaml", []);
    expect(hits).toEqual(["src/evil.yaml api-key-assignment"]);
  });

  it("detects .env unquoted assignment", () => {
    const content = `${FIELD}=${VALUE}`;
    const hits = scanContent(content, ".env", []);
    expect(hits).toEqual([".env api-key-assignment"]);
  });

  it("detects JS const hardcoded assignment", () => {
    const content = `const ${FIELD} = ${JSON.stringify(VALUE)};`;
    const hits = scanContent(content, "src/evil.ts", []);
    expect(hits).toEqual(["src/evil.ts api-key-assignment"]);
  });

  it("detects process.env assignment", () => {
    const content = `process.env.${FIELD} = ${JSON.stringify(VALUE)};`;
    const hits = scanContent(content, "src/evil.ts", []);
    expect(hits).toEqual(["src/evil.ts api-key-assignment"]);
  });

  it("detects double-quoted bracket assignment", () => {
    const content = `process.env[${JSON.stringify(FIELD)}] = ${JSON.stringify(VALUE)};`;
    const hits = scanContent(content, "src/evil.ts", []);
    expect(hits).toEqual(["src/evil.ts api-key-assignment"]);
  });

  it("detects single-quoted bracket assignment", () => {
    const content = `process.env['${FIELD}'] = '${VALUE}';`;
    const hits = scanContent(content, "src/evil.ts", []);
    expect(hits).toEqual(["src/evil.ts api-key-assignment"]);
  });

  it("does not flag a double-quoted bracket read", () => {
    const content = `const key = process.env[${JSON.stringify(FIELD)}];`;
    const hits = scanContent(content, "src/ok.ts", []);
    expect(hits).toEqual([]);
  });

  it("does not flag a single-quoted bracket read", () => {
    const content = `const key = process.env['${FIELD}'];`;
    const hits = scanContent(content, "src/ok.ts", []);
    expect(hits).toEqual([]);
  });

  it("detects shell export assignment", () => {
    const content = `export ${FIELD}=${VALUE}`;
    const hits = scanContent(content, "scripts/evil.sh", []);
    expect(hits).toEqual(["scripts/evil.sh api-key-assignment"]);
  });

  it("does not flag a bare identifier with no value", () => {
    const content = `const keyName = ${JSON.stringify(FIELD)};`;
    const hits = scanContent(content, "src/ok.ts", []);
    expect(hits).toEqual([]);
  });

  it("does not flag an environment variable read", () => {
    const content = `const key = process.env.${FIELD};`;
    const hits = scanContent(content, "src/ok.ts", []);
    expect(hits).toEqual([]);
  });

  it("does not flag an empty or short placeholder value", () => {
    for (const value of ["", "x"]) {
      const content = `${FIELD}=${value}`;
      const hits = scanContent(content, "src/ok.ts", []);
      expect(hits).toEqual([]);
    }
  });
});

describe("secret-shaped printable paths (Atlas Phase 1)", () => {
  it("replaces a printable secret-shaped basename with a digest placeholder", () => {
    const path = ["tests/", "sk-", "abcdef0123456789", ".txt"].join("");
    const safe = safePath(path);
    expect(safe).not.toContain("sk-");
    expect(safe).toMatch(/^<path:[0-9a-f]{16}>$/);
  });

  it("keeps a benign printable path unchanged", () => {
    expect(safePath("tests/foo.spec.ts")).toBe("tests/foo.spec.ts");
    expect(safePath("src/index.ts")).toBe("src/index.ts");
  });

  it("replaces a path embedding an assignment-shaped secret", () => {
    const path = ["tests/", "OPENCODE_GO_API_KEY", "=", "opaquevalue12345678", ".ts"].join("");
    const safe = safePath(path);
    expect(safe).not.toContain("OPENCODE_GO_API_KEY");
    expect(safe).not.toContain("opaquevalue12345678");
    expect(safe).toMatch(/^<path:[0-9a-f]{16}>$/);
  });

  it("never emits a secret-shaped path in scan hits", () => {
    const root = mkdtemp();
    const name = ["sk-", "abcdef0123456789", ".txt"].join("");
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", name),
      `const k = "${["sk-", "fedcba9876543210"].join("")}";`,
    );
    const hits = scanFileEntry(join(root, "tests", name), root, {});
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toContain("sk-");
    expect(hits[0]).toMatch(/^<path:[0-9a-f]{16}> openai-key$/);
    cleanup(root);
  });
});
