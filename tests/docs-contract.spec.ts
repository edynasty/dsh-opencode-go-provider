/**
 * Docs-contract tests (Plan Task 9).
 *
 * Machine-check the bilingual README pair, SECURITY.md, CONTRIBUTING.md and
 * THIRD_PARTY_NOTICES.md for the safety-critical contract tokens: the exact
 * pinned Git install spec, the absence of any npm-install availability claim
 * (including a negative fixture that must FAIL), the credential boundary, the
 * three protocols, cache/grace facts, the non-affiliation statement and the
 * npm-unpublished status.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateDocsContract } from "./helpers/docs-contract.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("bilingual docs contract", () => {
  it("accepts the real repository docs without violations", () => {
    const violations = validateDocsContract(REPO_ROOT);
    expect(violations).toEqual([]);
  });

  it("rejects a fixture claiming npm install availability", () => {
    // Given: a docs fixture that claims `npm install dsh-opencode-go-provider`.
    const fixtureDir = join(REPO_ROOT, "tests", "fixtures", "docs-npm-claim");
    // When: the same validator runs against the fixture directory.
    const violations = validateDocsContract(fixtureDir);
    // Then: validation fails and names the npm-install availability claim.
    const report = violations.join("\n");
    expect(report).toContain("npm-install availability");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("pins the exact verified SHA in the Git install spec", () => {
    const violations = validateDocsContract(REPO_ROOT);
    expect(violations).toEqual([]);
    const readme = readRoot("README.md");
    const readmeZh = readRoot("README.zh.md");
    const spec = "github:edynasty/dsh-opencode-go-provider#d2a447610a5dff4006ac966525effd9669342a78";
    expect(readme).toContain(spec);
    expect(readmeZh).toContain(spec);
  });

  it("never presents an npm install path in the real README pair", () => {
    const readme = readRoot("README.md");
    const readmeZh = readRoot("README.zh.md");
    expect(readme).not.toMatch(/npm\s+(?:i|install)\s+dsh-opencode-go-provider/);
    expect(readmeZh).not.toMatch(/npm\s+(?:i|install)\s+dsh-opencode-go-provider/);
  });

  it("states the npm-unpublished status in both languages", () => {
    const readme = readRoot("README.md");
    const readmeZh = readRoot("README.zh.md");
    expect(readme).toMatch(/not published/i);
    expect(readmeZh).toMatch(/未发布/);
  });

  it("states non-affiliation with DeepSeek and OpenCode in both languages", () => {
    const readme = readRoot("README.md");
    const readmeZh = readRoot("README.zh.md");
    expect(readme).toMatch(/not affiliated/i);
    expect(readmeZh).toMatch(/不隶属/);
  });

  it("documents the credential boundary in both languages", () => {
    const readme = readRoot("README.md");
    const readmeZh = readRoot("README.zh.md");
    expect(readme).toContain("OPENCODE_GO_API_KEY");
    expect(readme).toMatch(/operation time/i);
    expect(readmeZh).toContain("OPENCODE_GO_API_KEY");
    expect(readmeZh).toMatch(/操作时/);
  });

  it("documents all three protocols and the no-prefix-guessing rule", () => {
    const readme = readRoot("README.md");
    const readmeZh = readRoot("README.zh.md");
    for (const protocol of [
      "openai-responses",
      "openai-completions",
      "anthropic-messages",
    ]) {
      expect(readme).toContain(protocol);
      expect(readmeZh).toContain(protocol);
    }
    expect(readme).toMatch(/prefix/i);
    expect(readmeZh).toMatch(/前缀/);
  });

  it("documents cache/SWR facts and the 14-day grace in both languages", () => {
    const readme = readRoot("README.md");
    const readmeZh = readRoot("README.zh.md");
    for (const token of [
      "stale-while-revalidate",
      "atomic",
      "offline",
      "quarantine",
      "14-day",
    ]) {
      expect(readme.toLowerCase()).toContain(token);
    }
    expect(readme).toMatch(/5[- ]?minute/i);
    expect(readme).toMatch(/60[- ]?minute/i);
    expect(readme).toMatch(/10[- ]?second/i);
    for (const token of [
      "stale-while-revalidate",
      "原子",
      "离线",
      "隔离",
      "14 天",
    ]) {
      expect(readmeZh).toContain(token);
    }
    expect(readmeZh).toMatch(/5[- ]?分钟/);
    expect(readmeZh).toMatch(/60[- ]?分钟/);
    expect(readmeZh).toMatch(/10[- ]?秒/);
  });

  it("documents the command surface in both languages", () => {
    const readme = readRoot("README.md");
    const readmeZh = readRoot("README.zh.md");
    for (const token of [
      "dsh plugin --profile web add",
      "dsh plugin --profile web remove",
      "migration",
      "dry-run",
    ]) {
      expect(readme).toContain(token);
      expect(readmeZh).toContain(token);
    }
    expect(readme).toMatch(/disconnect/i);
    expect(readmeZh).toMatch(/断开/);
    expect(readme).toMatch(/default model/i);
    expect(readmeZh).toMatch(/默认模型/);
  });

  it("retains upstream license/notice attribution", () => {
    const notices = readRoot("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("MIT");
    expect(notices).toContain("2025");
    expect(notices).toContain("pi-opencode-go-provider");
    expect(notices).toMatch(/independent implementation/i);
  });

  it("points readers at each dependency's own license, not this LICENSE", () => {
    const notices = readRoot("THIRD_PARTY_NOTICES.md");
    expect(notices).toMatch(/dependency/i);
    expect(notices).not.toMatch(/reproduced.*(?:this repository|LICENSE)/i);
    expect(notices).not.toMatch(/LICENSE.*where applicable/i);
  });

  it("lists only actually available private reporting routes in SECURITY", () => {
    const security = readRoot("SECURITY.md");
    // The single supported route: GitHub private vulnerability reporting.
    expect(security).toMatch(/vulnerability reporting/i);
    expect(security).toMatch(/private/i);
    // No email or direct-message route (the GitHub profile publishes no
    // public email and GitHub provides no direct-message route).
    expect(security).not.toMatch(/email/i);
    expect(security).not.toMatch(/direct message|direct-message/i);
  });

  it("uses the commit-pinned spelling consistently", () => {
    const security = readRoot("SECURITY.md");
    expect(security).not.toContain("committed-pinned");
    expect(security).toMatch(/commit-pinned/i);
  });
});

function readRoot(name: string): string {
  return readFileSync(join(REPO_ROOT, name), "utf8");
}
