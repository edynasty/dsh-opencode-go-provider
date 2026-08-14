/**
 * Read-side filesystem gates for the legacy-config migration.
 *
 * Every path is gated before any read: credential/auth/cache-shaped material
 * is refused anywhere in the path, the target and every ancestor must be a
 * real (non-symlink) file/directory, and the read verifies file identity
 * (dev+ino) between the lstat gate and the handle so a swap in that window
 * is detected.
 */
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeFsErrorCode } from "./cache.ts";

export type ReadAbortReason = "not-a-file" | "unsafe-symlink" | "unsafe-path" | "read-failed";

export interface ReadSettingsResult {
  readonly kind: "ok";
  readonly text: string;
  readonly revision: string;
  readonly mode: number;
}

export interface ReadSettingsFailure {
  readonly kind: "aborted";
  readonly reason: ReadAbortReason;
  readonly message: string;
}

function fail(reason: ReadAbortReason, message: string): ReadSettingsFailure {
  return { kind: "aborted", reason, message };
}

/** Credential/auth/cache-shaped segments are refused anywhere in a path. */
function isForbiddenSegment(segment: string): boolean {
  return (
    /^\.credentials(?:\..*)?$/i.test(segment)
    || /(?:^|\.)credentials(?:\..*)?$/i.test(segment)
    || /^auth\.json$/i.test(segment)
    || /^.*auth.*\.json$/i.test(segment)
    || /^cache$/i.test(segment)
  );
}

/** Refuse when any path segment (or the whole path) names forbidden material. */
export function isForbiddenPath(path: string): boolean {
  if (isForbiddenSegment(path)) return true;
  return path.split(/[/\\]/u).some((segment) => isForbiddenSegment(segment));
}

/**
 * The target's parent chain must be real directories: a symlink anywhere in
 * the chain is refused unless it is the platform's own leading redirect
 * (macOS maps `/var` and `/tmp` onto `/private/var` and `/private/tmp` — the
 * only shape accepted). An attacker-controlled redirect is therefore never
 * read through or written into.
 */
async function assertRealAncestors(path: string): Promise<void> {
  let current = dirname(path);
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      const target = await realpath(current);
      if (target !== `/private${current}`) {
        throw new Error("unsafe-symlink");
      }
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
}

/** Stable content revision: the raw document bytes, SHA-256 hex. */
export function revisionOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Extract an fs error code, or undefined, without any cast. */
export function fsErrorCode(value: unknown): unknown {
  return typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
}

/**
 * Read the settings file through its gates: forbidden-path check, symlink
 * check on the target and every ancestor, regular-file check, then an
 * identity-verified handle read (the handle's dev+ino must match the lstat
 * gate, so a swap between gate and read is detected, not followed).
 */
export async function readSettings(path: string): Promise<ReadSettingsResult | ReadSettingsFailure> {
  if (isForbiddenPath(path)) {
    return fail("unsafe-path", "the settings path names credential/auth/cache material");
  }
  let info;
  try {
    info = await lstat(path);
  } catch {
    return fail("not-a-file", "the settings path does not exist");
  }
  if (info.isSymbolicLink()) {
    return fail("unsafe-symlink", "the settings path must not be a symbolic link");
  }
  if (!info.isFile()) {
    return fail("not-a-file", "the settings path is not a regular file");
  }
  try {
    await assertRealAncestors(path);
  } catch {
    return fail("unsafe-symlink", "a settings directory must not be a symbolic link");
  }
  let handle;
  try {
    handle = await open(path, "r");
    const identity = await handle.stat();
    if (identity.dev !== info.dev || identity.ino !== info.ino) {
      await handle.close();
      return fail("read-failed", "the settings file changed while it was being read");
    }
    const text = await handle.readFile("utf8");
    await handle.close();
    return {
      kind: "ok",
      text,
      revision: revisionOf(text),
      mode: identity.mode & 0o777,
    };
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    const code = fsErrorCode(error);
    return fail("read-failed", `the settings file could not be read (${sanitizeFsErrorCode(code)})`);
  }
}
