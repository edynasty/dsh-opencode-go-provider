/**
 * Versioned runtime cache envelope, rendering and atomic write.
 *
 * The cache (`$DSH_HOME/cache/dsh-opencode-go-provider/catalog.json`) carries
 * exactly the reconciliation state needed to continue the 14-day deprecation
 * semantics offline. Reading/validation lives in `cache-parse.ts`; this module
 * owns the envelope shape, the deterministic renderer and the atomic writer.
 * Writes are same-directory temp + fsync + rename with private permissions;
 * the writer honors optional cancellation at every phase boundary, removes the
 * temp file on any failure/abort, and never replaces the prior target after an
 * abort is observed.
 */
import { open, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { renderDeprecatedFile, renderModelsPayload, renderQuarantineFile } from "./catalog.ts";
import { isRecord } from "./guards.ts";
import type { CatalogModel, DeprecatedEntry, QuarantineRecord } from "./types.ts";

/** The only supported envelope version; anything else is refused. */
export const CACHE_ENVELOPE_VERSION = 1 as const;

/** Cache directory name under `$DSH_HOME/cache`. */
export const CACHE_DIR_NAME = "dsh-opencode-go-provider" as const;

/** Cache file name inside the provider cache directory. */
export const CACHE_FILE_NAME = "catalog.json" as const;

/** A persisted instant this far beyond the reading clock is rejected as future. */
export const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

/** Source-observation timestamps recorded by a single bounded attempt. */
export interface CacheSourceMetadata {
  readonly modelsDevAt: string;
  readonly liveAt: string;
}

/** The strict, versioned cache envelope. */
export interface CatalogCacheEnvelope {
  readonly version: typeof CACHE_ENVELOPE_VERSION;
  /** Clock instant the successful reconciliation observed the sources. */
  readonly refreshedAt: string;
  /** Reconcile `generatedAt`: moves only on real transitions. */
  readonly generatedAt: string;
  readonly sources: CacheSourceMetadata;
  readonly catalog: readonly CatalogModel[];
  readonly deprecated: readonly DeprecatedEntry[];
  readonly quarantine: readonly QuarantineRecord[];
}

/** Malformed cache: parse, version, timestamp, id or coherence failure. */
export class CacheError extends Error {
  readonly name = "CacheError";
  constructor(reason: string) {
    super(`runtime cache is malformed: ${reason}`);
  }
}

/**
 * The persistence outcome: "committed" means the rename published the new
 * file (disk now holds the new generation); "not-committed" means no
 * publication happened. The lifecycle adopts a committed generation even if
 * disposal races in after the rename, so disk and memory never diverge.
 */
export type CacheCommitResult =
  | { readonly kind: "committed" }
  | { readonly kind: "not-committed" };

/** The cache file path for one DSH home. */
export function resolveCachePath(dshHome: string): string {
  return join(dshHome, "cache", CACHE_DIR_NAME, CACHE_FILE_NAME);
}

/**
 * Deterministic cache bytes: fixed field order, sorted ids, two-space indent,
 * one trailing newline. Built on the Task 3 renderers so read and write never
 * drift from the committed-artifact serialization.
 */
export function renderCacheEnvelope(envelope: CatalogCacheEnvelope): string {
  const payload = {
    version: envelope.version,
    refreshedAt: envelope.refreshedAt,
    generatedAt: envelope.generatedAt,
    sources: { modelsDevAt: envelope.sources.modelsDevAt, liveAt: envelope.sources.liveAt },
    catalog: JSON.parse(renderModelsPayload(envelope.catalog)),
    deprecated: JSON.parse(renderDeprecatedFile(envelope.deprecated)),
    quarantine: JSON.parse(renderQuarantineFile(envelope.quarantine)),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Best-effort directory durability; a platform refusing it never fails the write. */
export type DirectoryDurability = (directory: string) => Promise<void>;

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // directory fsync is unsupported on some platforms; the file fsync+rename stand
  }
}

/**
 * Run detached best-effort work with every rejection path observed. The work
 * starts on a microtask so a synchronous throw becomes a rejection the
 * observer consumes — no unhandled rejection, no leaked throw escaping the
 * caller.
 */
function observeDurability(run: () => Promise<void>): void {
  Promise.resolve()
    .then(run)
    .catch(() => undefined);
}

/** Refuse to continue an aborted write; the failure message is fixed. */
function ensureNotAborted(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted) {
    throw new CacheError(`atomic write aborted before ${phase}`);
  }
}

/**
 * Validate a filesystem error code against a fixed safe pattern before any
 * interpolation: a code is a short uppercase identifier. Anything else —
 * attacker-controlled or malformed — becomes UNKNOWN, so arbitrary error.code
 * text can never reach CacheError messages.
 */
export function sanitizeFsErrorCode(code: unknown): string {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "UNKNOWN";
}

/**
 * Atomically write the cache: same-directory temp file with private
 * permissions, file fsync, then rename over the target. Cancellation is
 * honored at every phase up to and including the rename — the commit point.
 * The post-rename directory durability is DETACHED best-effort: it never
 * gates the commit fact or the lifecycle, never holds disposal open, and all
 * its rejection paths are internally observed. Pre-commit abort/failure
 * removes the temp file and leaves the previous target untouched; the error
 * is always a CacheError.
 */
export async function writeCacheAtomic(
  path: string,
  envelope: CatalogCacheEnvelope,
  signal?: AbortSignal,
  durability: DirectoryDurability = fsyncDirectory,
): Promise<CacheCommitResult> {
  ensureNotAborted(signal, "creating the cache directory");
  const directory = dirname(path);
  const temp = join(directory, `.${CACHE_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let tempCreated = false;
  try {
    await mkdir(directory, { recursive: true });
    ensureNotAborted(signal, "creating the temp file");
    handle = await open(temp, "wx", 0o600);
    tempCreated = true;
    ensureNotAborted(signal, "writing the cache");
    await handle.writeFile(renderCacheEnvelope(envelope), "utf8");
    ensureNotAborted(signal, "flushing the cache");
    await handle.sync();
    ensureNotAborted(signal, "closing the temp file");
    await handle.close();
    handle = undefined;
    ensureNotAborted(signal, "renaming over the target");
    await rename(temp, path);
    // Commit point: the rename published the new file. The directory
    // durability is detached (observed, never awaited) so the commit fact is
    // visible immediately and an unbounded durability seam cannot hold
    // disposal or the lifecycle open.
    observeDurability(() => durability(directory));
    return { kind: "committed" };
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (tempCreated) {
      await rm(temp, { force: true }).catch(() => undefined);
    }
    if (error instanceof CacheError) throw error;
    // A fixed code-fact message: the fs error text may carry absolute paths,
    // and the error.code itself is pattern-validated (never arbitrary text).
    throw new CacheError(`atomic write failed (${sanitizeFsErrorCode(isRecord(error) ? error.code : undefined)})`);
  }
}
