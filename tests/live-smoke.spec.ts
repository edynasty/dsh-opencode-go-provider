/**
 * live-smoke guard tests (Plan Task 9).
 *
 * Prove the opt-in contract WITHOUT ever running live mode or reading real
 * environment secrets: default execution exits 0 with the fixed `skipped`
 * output before touching any key or network; explicit opt-in without a key
 * fails with a fixed sanitized message. The live branch is never exercised.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "live-smoke.mjs");

/** A scrubbed environment: drops any real OPENCODE_GO_API_KEY from the parent
 * environment so tests can never read an actual secret. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENCODE_GO_API_KEY;
  delete env.RUN_OPENCODE_GO_LIVE;
  return env;
}

function runScript(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
}

describe("live-smoke guard", () => {
  it("default execution skips with exit 0 and fixed output, no key needed", () => {
    // Given: no opt-in flag and no key in the scrubbed environment.
    const result = runScript(scrubbedEnv());
    // Then: exit 0, fixed skipped line, nothing on stderr.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("live-smoke: skipped");
    expect(result.stdout).toContain("RUN_OPENCODE_GO_LIVE");
    expect(result.stderr).toBe("");
  });

  it("explicit opt-in without a key fails with a fixed sanitized message", () => {
    // Given: opt-in set but the scrubbed environment carries no key.
    const env = scrubbedEnv();
    env.RUN_OPENCODE_GO_LIVE = "1";
    const result = runScript(env);
    // Then: non-zero exit, fixed refusal, no key material in the output.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCODE_GO_API_KEY");
    expect(result.stderr).not.toMatch(/sk-[a-z0-9]+/i);
  });

  it("never performs live work in the default or no-key paths", () => {
    // The script's skip and refusal branches run before any fetch: both spawns
    // above completed within the timeout without network (no key, no flag), and
    // the script itself guards the live branch behind the opt-in check.
    const source = readScriptSource();
    const optInIndex = source.indexOf('process.env[LIVE_OPT_IN] !== "1"');
    const fetchIndex = source.indexOf("fetch(");
    expect(optInIndex).toBeGreaterThanOrEqual(0);
    // The fetch call must be textually AFTER the opt-in guard and the key check.
    expect(fetchIndex).toBeGreaterThan(optInIndex);
    const keyCheck = source.indexOf(KEY_REF_CHECK);
    expect(keyCheck).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeGreaterThan(keyCheck);
  });
});

const KEY_REF_CHECK = 'key === undefined || key === ""';

function readScriptSource(): string {
  return readFileSync(SCRIPT, "utf8");
}
