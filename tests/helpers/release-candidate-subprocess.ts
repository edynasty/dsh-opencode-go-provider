/**
 * Task 8 subprocess + isolation primitives shared by the release-candidate
 * helpers: bounded subprocess runs, a sanitized environment (temp HOME, no
 * DSH/XDG/proxy/credential state, pinned COREPACK_HOME) and SHA-256 helpers.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PINNED_COMMIT = "45d28bea23b9e0f06b7450b1fe107d579372611f";
export const PACKAGE_NAME = "dsh-opencode-go-provider";
export const BUNDLE_ROW_ID = "llm-opencode-go";
export const PROVIDER_ROUTE = "opencode-go";
export const API_KEY_ENV = "OPENCODE_GO_API_KEY";
/** Injected fake credential; a test sentinel, never a real-looking key. */
export const FAKE_KEY = "dsh-t8-test-sentinel-key-0123456789abcdef";

/** The real corepack cache, resolved portably; survives a HOME override. */
const COREPACK_HOME = process.env.COREPACK_HOME ?? join(homedir(), ".cache", "node", "corepack");

/** Run one bounded subprocess; throws with the tail of stderr on failure. */
export function runSync(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs = 180_000,
): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, timeout: timeoutMs });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${String(result.status)}): ${(result.stderr ?? "").trim().slice(0, 500)}`,
    );
  }
  return result.stdout ?? "";
}

/** Environment for every subprocess: temp HOME, no DSH/XDG/proxy/credential state. */
export function isolatedEnv(home: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "HOME",
    "DSH_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "OPENCODE_GO_API_KEY",
    "COREPACK_HOME",
  ]) {
    delete env[key];
  }
  return { ...env, HOME: home, COREPACK_HOME, ...extra };
}

/** SHA-256 hex of a UTF-8 string. */
export function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** SHA-256 hex of raw bytes. */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
