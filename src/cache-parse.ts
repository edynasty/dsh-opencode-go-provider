/**
 * Strict runtime cache envelope parser.
 *
 * The cache crosses the boundary as `unknown`, so parse-don't-validate
 * applies recursively: unsupported versions, unknown top-level AND nested
 * `sources` fields, truncation, non-canonical or future timestamps (every
 * persisted instant, not just refreshedAt), impossible transition ordering,
 * duplicate/unsorted ids, unsafe URLs and inconsistent deprecation state are
 * all rejected — a bad cache is never trusted and never deleted. The
 * transition invariant: reconcile never stamps an observation or transition
 * later than the attempt's clock instant, so every persisted timestamp
 * (generatedAt, sources, deprecatedAt/evictedAt, detectedAt) must be at or
 * before the refreshedAt that produced or preserved it.
 */
import { readFileSync } from "node:fs";
import { compareIds, renderModelsPayload } from "./catalog.ts";
import { parseCatalogModel } from "./catalog-parse.ts";
import { isCanonicalIsoInstant, isRecord, isUnknownArray } from "./guards.ts";
import { parseDeprecatedFile, parseJsonFile, parseQuarantineFile } from "./state-file.ts";
import { assertStrictCatalogEntry, assertStrictDeprecatedEntry, assertStrictQuarantineEntry } from "./cache-schema.ts";
import { CACHE_ENVELOPE_VERSION, CACHE_FILE_NAME, FUTURE_TIMESTAMP_TOLERANCE_MS, CacheError } from "./cache.ts";
import type { CatalogCacheEnvelope } from "./cache.ts";
import type { CatalogModel } from "./types.ts";

const ENVELOPE_KEYS = [
  "version",
  "refreshedAt",
  "generatedAt",
  "sources",
  "catalog",
  "deprecated",
  "quarantine",
] as const;

const SOURCES_KEYS = ["modelsDevAt", "liveAt"] as const;

/** Wrap the state-file parsers' failures into a fixed-category cache error. */
function parseStateOrThrow<T>(what: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    // Fixed message: the parsers may name persisted ids inside their text.
    throw new CacheError(`${what} state is malformed`);
  }
}

/** Reject a persisted instant that lies beyond the future-tolerance window. */
function assertNotFuture(what: string, iso: string, nowMs: number): void {
  if (Date.parse(iso) - nowMs > FUTURE_TIMESTAMP_TOLERANCE_MS) {
    throw new CacheError(`${what} lies beyond the future-timestamp tolerance`);
  }
}

/** Reject a persisted instant that claims to be later than refreshedAt. */
function assertNotAfter(what: string, iso: string, refreshedAtMs: number): void {
  if (Date.parse(iso) > refreshedAtMs) {
    throw new CacheError(`${what} is later than the refresh that produced it`);
  }
}

/** Require strictly ascending unique ids, matching the deterministic writer. */
function assertAscendingIds(what: string, entries: readonly { readonly id: string }[]): void {
  let previous: string | undefined;
  for (const entry of entries) {
    if (previous !== undefined && compareIds(previous, entry.id) >= 0) {
      // Fixed category: persisted ids are attacker-controlled, never echoed.
      throw new CacheError(`${what} ids must be strictly ascending`);
    }
    previous = entry.id;
  }
}

/** Reject a record object carrying keys outside the declared set. */
function assertExactKeys(what: string, record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!keys.some((declared) => declared === key)) {
      // Fixed category: field names may be attacker-controlled, never echoed.
      throw new CacheError(`${what} carries an unknown field`);
    }
  }
}

/**
 * Read and strictly validate the cache envelope. `undefined` means no cache
 * file exists (a legitimate cold start); any other defect throws CacheError
 * and the caller falls back to the embedded snapshot WITHOUT deleting the
 * file. `now` is the injected clock instant for the future-timestamp window.
 */
export function readCache(path: string, now: Date): CatalogCacheEnvelope | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    // A fixed message: the fs error text may carry the absolute cache path.
    throw new CacheError("cannot read the cache file");
  }
  let parsed: unknown;
  try {
    parsed = parseJsonFile(text, CACHE_FILE_NAME);
  } catch {
    throw new CacheError("the cache is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new CacheError("payload is not an object");
  }
  assertExactKeys("cache", parsed, ENVELOPE_KEYS);
  if (parsed.version !== CACHE_ENVELOPE_VERSION) {
    throw new CacheError("unsupported envelope version");
  }
  const refreshedAt = isCanonicalIsoInstant(parsed.refreshedAt) ? parsed.refreshedAt : undefined;
  const generatedAt = isCanonicalIsoInstant(parsed.generatedAt) ? parsed.generatedAt : undefined;
  if (refreshedAt === undefined || generatedAt === undefined) {
    throw new CacheError("refreshedAt and generatedAt must be canonical ISO-8601 instants");
  }
  const nowMs = now.getTime();
  const refreshedAtMs = Date.parse(refreshedAt);
  assertNotFuture("refreshedAt", refreshedAt, nowMs);
  assertNotFuture("generatedAt", generatedAt, nowMs);
  assertNotAfter("generatedAt", generatedAt, refreshedAtMs);
  if (!isRecord(parsed.sources)) {
    throw new CacheError("sources must be an object");
  }
  assertExactKeys("sources", parsed.sources, SOURCES_KEYS);
  const modelsDevAt = isCanonicalIsoInstant(parsed.sources.modelsDevAt) ? parsed.sources.modelsDevAt : undefined;
  const liveAt = isCanonicalIsoInstant(parsed.sources.liveAt) ? parsed.sources.liveAt : undefined;
  if (modelsDevAt === undefined || liveAt === undefined) {
    throw new CacheError("sources must carry canonical modelsDevAt and liveAt instants");
  }
  // Production stamps ONE observation instant for both sources and refreshedAt;
  // anything else is freshness forgery (a stale observation presented fresh).
  if (modelsDevAt !== refreshedAt || liveAt !== refreshedAt) {
    throw new CacheError("sources timestamps must equal refreshedAt (one observation instant)");
  }
  if (!isUnknownArray(parsed.catalog)) {
    throw new CacheError("catalog must be an array");
  }
  parsed.catalog.forEach((raw, index) => assertStrictCatalogEntry(raw, `catalog model ${index}`));
  if (!isUnknownArray(parsed.deprecated)) {
    throw new CacheError("deprecated must be an array");
  }
  parsed.deprecated.forEach((raw, index) => assertStrictDeprecatedEntry(raw, `deprecated ${index}`));
  if (!isUnknownArray(parsed.quarantine)) {
    throw new CacheError("quarantine must be an array");
  }
  parsed.quarantine.forEach((raw, index) => assertStrictQuarantineEntry(raw, `quarantine ${index}`));
  const catalog: CatalogModel[] = [];
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const raw of parsed.catalog) {
    const model = parseCatalogModel(raw);
    if (model === undefined) {
      throw new CacheError("catalog entry is not a valid catalog model");
    }
    if (seen.has(model.id)) {
      throw new CacheError("duplicate catalog id");
    }
    if (previous !== undefined && compareIds(previous, model.id) >= 0) {
      throw new CacheError("catalog ids must be strictly ascending");
    }
    seen.add(model.id);
    previous = model.id;
    catalog.push(model);
  }
  const deprecated = parseStateOrThrow("deprecated", () => parseDeprecatedFile(parsed.deprecated));
  const quarantine = parseStateOrThrow("quarantine", () => parseQuarantineFile(parsed.quarantine));
  assertAscendingIds("deprecated", deprecated);
  assertAscendingIds("quarantine", quarantine);
  for (const entry of deprecated) {
    assertNotFuture("deprecated deprecatedAt", entry.deprecatedAt, nowMs);
    assertNotAfter("deprecated deprecatedAt", entry.deprecatedAt, refreshedAtMs);
    if (entry.evictedAt !== undefined) {
      assertNotFuture("deprecated evictedAt", entry.evictedAt, nowMs);
      assertNotAfter("deprecated evictedAt", entry.evictedAt, refreshedAtMs);
    }
  }
  for (const record of quarantine) {
    assertNotFuture("quarantine detectedAt", record.detectedAt, nowMs);
    assertNotAfter("quarantine detectedAt", record.detectedAt, refreshedAtMs);
  }
  const byId = new Map(catalog.map((model) => [model.id, model]));
  for (const entry of deprecated) {
    const present = byId.get(entry.id);
    if (entry.evictedAt === undefined) {
      if (present === undefined) {
        throw new CacheError("non-evicted deprecated id is missing from the catalog");
      }
      if (renderModelsPayload([entry.model]) !== renderModelsPayload([present])) {
        throw new CacheError("deprecated entry has a frozen model differing from its catalog entry");
      }
    } else if (present !== undefined) {
      throw new CacheError("evicted deprecated id is still present in the catalog");
    }
  }
  for (const record of quarantine) {
    if (byId.has(record.id)) {
      throw new CacheError("quarantine id also appears in the catalog");
    }
  }
  return {
    version: CACHE_ENVELOPE_VERSION,
    refreshedAt,
    generatedAt,
    sources: { modelsDevAt, liveAt },
    catalog,
    deprecated,
    quarantine,
  };
}
