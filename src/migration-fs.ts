/**
 * Write-side filesystem operations for the legacy-config migration.
 *
 * The backup is created with `wx` + fsync (a timestamp collision fails
 * closed, never overwrites; a write/fsync/close failure closes and REMOVES
 * the partial backup) and the target is published atomically (same-directory
 * private temp, fsync, rename, original mode restored, temp cleaned on
 * failure). A same-directory `wx` lock serializes the mutation transaction,
 * is cleaned on lock-close failure, and is released on every outcome. All
 * failure paths throw fixed-category errors.
 */
import { randomBytes } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sanitizeFsErrorCode } from "./cache.ts";
import { fsErrorCode } from "./migration-fs-read.ts";

/**
 * An exclusive same-directory transaction lock; `wx` so a held lock refuses.
 * If the handle close fails after the lock file was created, the lock is
 * removed before the refusal so no stranded artifact blocks later migrations.
 * @param path - the settings file path the lock guards.
 * @param close - internal durability seam (tests inject close failures).
 * @returns the release disposer.
 */
export async function acquireLock(
  path: string,
  close: (handle: FileHandle) => Promise<void> = (handle) => handle.close(),
): Promise<() => Promise<void>> {
  const lockPath = `${path}.migration.lock`;
  let handle: FileHandle | undefined;
  let lockCreated = false;
  try {
    handle = await open(lockPath, "wx", 0o600);
    lockCreated = true;
    await close(handle);
    handle = undefined;
    return async () => {
      await rm(lockPath, { force: true }).catch(() => undefined);
    };
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (lockCreated) {
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
    throw new Error("another migration is in progress");
  }
}

/** Internal backup durability seam (tests inject fsync/close failures). */
export interface BackupDurability {
  readonly sync: (handle: FileHandle) => Promise<void>;
  readonly close: (handle: FileHandle) => Promise<void>;
}

const defaultDurability: BackupDurability = {
  sync: (handle) => handle.sync(),
  close: (handle) => handle.close(),
};

/**
 * Create the private timestamped backup with `wx` + fsync: a timestamp
 * collision fails closed (never overwrites an older backup) and the bytes are
 * durable before the original is replaced. A write/fsync/close failure closes
 * and REMOVES the partial backup, so no broken recovery artifact survives.
 * @param path - the settings file path being backed up.
 * @param original - the original bytes.
 * @param timestamp - deterministic backup name timestamp.
 * @param durability - internal seam (tests inject failures).
 * @returns the backup path.
 */
export async function writeBackup(
  path: string,
  original: string,
  timestamp: string,
  durability: BackupDurability = defaultDurability,
): Promise<string> {
  const backupPath = join(dirname(path), `${basename(path)}.migration-${timestamp}.bak`);
  let handle: FileHandle | undefined;
  let backupCreated = false;
  try {
    handle = await open(backupPath, "wx", 0o600);
    backupCreated = true;
    await handle.writeFile(original, "utf8");
    await durability.sync(handle);
    await durability.close(handle);
    handle = undefined;
    return backupPath;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (backupCreated) {
      await rm(backupPath, { force: true }).catch(() => undefined);
    }
    const code = fsErrorCode(error);
    throw new Error(`the recoverable backup could not be written (${sanitizeFsErrorCode(code)})`);
  }
}

/** Internal atomic-write rename seam (tests inject rename failures). */
export type AtomicRename = (from: string, to: string) => Promise<void>;

/** The live target changed after the attempt's reads; the rename is refused. */
export class PreRenameConflictError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super("the settings file changed before the rename");
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Publish the migrated text atomically: same-directory private temp, fsync,
 * the original mode restored, then rename. Any failure removes the temp and
 * throws a fixed-category error; the previous target bytes stay intact.
 * @param path - the settings file path to replace.
 * @param text - the migrated bytes.
 * @param mode - the original file mode to restore.
 * @param renameSeam - internal seam (tests inject rename failures).
 */
export async function writeTextAtomic(
  path: string,
  text: string,
  mode: number,
  renameSeam: AtomicRename = (from, to) => rename(from, to),
  verifyBeforeRename: () => Promise<void> = async () => undefined,
  beforeVerify: () => Promise<void> = async () => undefined,
): Promise<void> {
  const directory = dirname(path);
  const temp = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: FileHandle | undefined;
  let tempCreated = false;
  try {
    handle = await open(temp, "wx", 0o600);
    tempCreated = true;
    await handle.writeFile(text, "utf8");
    await handle.sync();
    if ((mode & 0o777) !== 0o600) {
      await chmod(temp, mode);
    }
    await handle.close();
    handle = undefined;
    // Final verification immediately before the rename: the live target must
    // still match the revision the attempt verified at commit time. The
    // beforeVerify seam lets tests edit the target after the temp is fully
    // prepared but before the check.
    await beforeVerify();
    await verifyBeforeRename();
    await renameSeam(temp, path);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (tempCreated) {
      await rm(temp, { force: true }).catch(() => undefined);
    }
    if (error instanceof PreRenameConflictError) throw error;
    const code = fsErrorCode(error);
    throw new Error(`the migrated settings could not be written (${sanitizeFsErrorCode(code)})`);
  }
}
