/**
 * Legacy-config migration: remove exactly `llm-pi-ai.providers.opencode-go`.
 *
 * The document is parsed structurally and the target block is removed by an
 * exact raw-text splice over validated CST ranges — every non-target byte
 * (comments, quoting, blank lines, CRLF, scalar formatting, key order)
 * survives verbatim. Dry-run is read-only and returns a deterministic exact
 * diff with secrets redacted. Apply verifies the dry-run revision, acquires a
 * same-directory `wx` lock, RE-READS and re-hashes the document immediately
 * before the backup/write (a late concurrent edit refuses with `conflict` and
 * creates nothing), creates a private timestamped `wx` backup, and publishes
 * atomically. A second apply is an idempotent no-change with no second write
 * or backup.
 */
import type { Clock } from "./sync.ts";
import { acquireLock, writeBackup, writeTextAtomic } from "./migration-fs.ts";
import { PreRenameConflictError } from "./migration-fs.ts";
import type { AtomicRename, BackupDurability } from "./migration-fs.ts";
import { readSettings, revisionOf } from "./migration-fs-read.ts";
import { rm } from "node:fs/promises";
import type { ReadAbortReason } from "./migration-fs-read.ts";
import { mappingKeys, parseSettings, redactSensitiveTokens, targetSplice } from "./migration-parse.ts";

export const MIGRATION_NAMESPACE = "llm-pi-ai" as const;
export const MIGRATION_PROVIDER = "opencode-go" as const;

export interface MigrationTarget {
  readonly namespace: typeof MIGRATION_NAMESPACE;
  readonly provider: typeof MIGRATION_PROVIDER;
}

/** Deterministic exact diff of the removal; lines are secret-redacted. */
export interface MigrationDiff {
  readonly removedKeys: readonly string[];
  readonly removedLines: readonly string[];
}

export type MigrationAbortReason = ReadAbortReason | "malformed" | "wrong-node-type" | "unsupported-shape" | "write-failed" | "locked";

export type MigrationDryRun =
  | { readonly kind: "no-target"; readonly revision: string; readonly target: MigrationTarget }
  | {
      readonly kind: "would-remove";
      readonly revision: string;
      readonly target: MigrationTarget;
      readonly diff: MigrationDiff;
    }
  | { readonly kind: "aborted"; readonly reason: MigrationAbortReason; readonly message: string };

export interface MigrationApplyOptions {
  /** The revision a dry-run observed; a moved document refuses the write. */
  readonly expectedRevision?: string;
  /** Injected clock for a deterministic backup timestamp. */
  readonly clock?: Clock;
  /** Deterministic race seam: runs after the revision checks, before the commit. */
  readonly beforeCommit?: () => Promise<void> | void;
  /** Internal backup durability seam (tests inject fsync/close failures). */
  readonly backupDurability?: BackupDurability;
  /** Internal atomic rename seam (tests inject rename failures). */
  readonly atomicRename?: AtomicRename;
}

export type MigrationApply =
  | { readonly kind: "no-change"; readonly revision: string }
  | {
      readonly kind: "applied";
      readonly revision: string;
      readonly backupPath: string;
      readonly removedKeys: readonly string[];
    }
  | { readonly kind: "conflict"; readonly expected: string; readonly actual: string }
  | { readonly kind: "aborted"; readonly reason: MigrationAbortReason; readonly message: string };

function migrationTarget(): MigrationTarget {
  return { namespace: MIGRATION_NAMESPACE, provider: MIGRATION_PROVIDER };
}

/** The exact migrated bytes: the raw text with the target span spliced out. */
function spliceOut(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(end);
}

/** The removed block's lines, redacted, from the splice span. */
function removedLinesOf(text: string, start: number, end: number): readonly string[] {
  return text
    .slice(start, end)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => redactSensitiveTokens(line));
}

/**
 * Dry-run: read-only. Returns the exact removed keys and lines plus the
 * content revision, and never writes, locks or backs up anything.
 */
export async function dryRunMigration(path: string): Promise<MigrationDryRun> {
  const read = await readSettings(path);
  if (read.kind !== "ok") {
    return { kind: "aborted", reason: read.reason, message: read.message };
  }
  const parsed = parseSettings(read.text);
  if (parsed.kind === "malformed") return { kind: "aborted", reason: "malformed", message: parsed.message };
  if (parsed.kind === "absent") return { kind: "no-target", revision: read.revision, target: migrationTarget() };
  if (parsed.kind === "wrong-type") {
    return { kind: "aborted", reason: "wrong-node-type", message: "the legacy opencode-go node is not a mapping" };
  }
  if (parsed.kind === "unsupported") {
    return { kind: "aborted", reason: "unsupported-shape", message: parsed.message };
  }
  const span = targetSplice(read.text, parsed.providers, parsed.targetNode);
  if (span.kind === "invalid") {
    return { kind: "aborted", reason: "malformed", message: "the target block could not be located in the document" };
  }
  return {
    kind: "would-remove",
    revision: read.revision,
    target: migrationTarget(),
    diff: {
      removedKeys: mappingKeys(parsed.targetNode),
      removedLines: removedLinesOf(read.text, span.start, span.end),
    },
  };
}

/**
 * Apply the migration under a same-directory lock. After the dry-run revision
 * check the document is RE-READ and re-hashed immediately before the
 * backup/write: a document that moved (or a seam that changed it) refuses
 * with `conflict` and creates no backup, temp or lock residue. Idempotent:
 * applying again to the already-migrated document is a no-change.
 */
export async function applyMigration(path: string, options: MigrationApplyOptions = {}): Promise<MigrationApply> {
  const read = await readSettings(path);
  if (read.kind !== "ok") {
    return { kind: "aborted", reason: read.reason, message: read.message };
  }
  const parsed = parseSettings(read.text);
  if (parsed.kind === "malformed") return { kind: "aborted", reason: "malformed", message: parsed.message };
  if (parsed.kind === "absent") return { kind: "no-change", revision: read.revision };
  if (parsed.kind === "wrong-type") {
    return { kind: "aborted", reason: "wrong-node-type", message: "the legacy opencode-go node is not a mapping" };
  }
  if (parsed.kind === "unsupported") {
    return { kind: "aborted", reason: "unsupported-shape", message: parsed.message };
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== read.revision) {
    return { kind: "conflict", expected: options.expectedRevision, actual: read.revision };
  }
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireLock(path);
  } catch {
    return { kind: "aborted", reason: "locked", message: "another migration is in progress" };
  }
  try {
    if (options.beforeCommit !== undefined) {
      await options.beforeCommit();
    }
    // Precommit verification: the document must be byte-identical to the read
    // the revision checks were based on. A concurrent edit (or the race seam)
    // is refused here — nothing has been written or backed up yet.
    const precommit = await readSettings(path);
    if (precommit.kind !== "ok") {
      return { kind: "aborted", reason: precommit.reason, message: precommit.message };
    }
    if (precommit.revision !== read.revision) {
      return { kind: "conflict", expected: read.revision, actual: precommit.revision };
    }
    const span = targetSplice(precommit.text, parsed.providers, parsed.targetNode);
    if (span.kind === "invalid") {
      return { kind: "aborted", reason: "malformed", message: "the target block could not be located in the document" };
    }
    const migrated = spliceOut(precommit.text, span.start, span.end);
    const timestamp = (options.clock?.now() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    let backupPath: string | undefined;
    try {
      backupPath = await writeBackup(
        path,
        precommit.text,
        timestamp,
        options.backupDurability,
      );
    } catch {
      return { kind: "aborted", reason: "write-failed", message: "the recoverable backup could not be written" };
    }
    try {
      // The final verification lives INSIDE the atomic writer, immediately
      // before the rename: every await-expanded window (backup write/fsync,
      // temp write/fsync/chmod) is covered by a fresh revision check, so a
      // late edit is refused instead of being overwritten.
      await writeTextAtomic(path, migrated, precommit.mode, options.atomicRename, async () => {
        const latest = await readSettings(path);
        if (latest.kind !== "ok") {
          throw new PreRenameConflictError(precommit.revision, "unreadable");
        }
        if (latest.revision !== precommit.revision) {
          throw new PreRenameConflictError(precommit.revision, latest.revision);
        }
      });
    } catch (error) {
      if (error instanceof PreRenameConflictError) {
        // Remove only the backup THIS attempt created (wx, therefore ours);
        // a pre-existing collision file or the concurrent target is untouched.
        if (backupPath !== undefined) {
          await rm(backupPath, { force: true }).catch(() => undefined);
        }
        return { kind: "conflict", expected: error.expected, actual: error.actual };
      }
      return { kind: "aborted", reason: "write-failed", message: "the migrated settings could not be written" };
    }
    return {
      kind: "applied",
      revision: revisionOf(migrated),
      backupPath,
      removedKeys: mappingKeys(parsed.targetNode),
    };
  } finally {
    if (release !== undefined) {
      await release();
    }
  }
}
