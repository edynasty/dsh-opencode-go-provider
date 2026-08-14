/**
 * Catalog snapshot mapping: cache/embedded/refreshed → served snapshot.
 *
 * The lifecycle serves one immutable `CatalogSnapshot` at a time. This module
 * owns the small, pure mappings between snapshot and its durable envelope or
 * bootstrap form: cache envelope → cache-origin snapshot, reconcile result →
 * refreshed snapshot, committed manifest → embedded snapshot. Keeping them
 * here (instead of in the coordinator) keeps the lifecycle's scheduling and
 * single-flight logic under the module-size ceiling and gives the mappings a
 * single testable home.
 */
import { CACHE_ENVELOPE_VERSION } from "./cache.ts";
import { readCache } from "./cache-parse.ts";
import type { CacheSourceMetadata, CatalogCacheEnvelope } from "./cache.ts";
import { embeddedCatalogManifest } from "./catalog-loader.ts";
import type { Clock } from "./sync.ts";
import type { CatalogModel, DeprecatedEntry, QuarantineRecord, ReconcileResult } from "./types.ts";

/** Where the initial snapshot came from; "corrupt" means a bad cache fell back. */
export type SnapshotOrigin = "embedded" | "cache" | "refreshed" | "corrupt";

/** The immutable current state the lifecycle serves and schedules against. */
export interface CatalogSnapshot {
  readonly catalog: readonly CatalogModel[];
  readonly deprecated: readonly DeprecatedEntry[];
  readonly quarantine: readonly QuarantineRecord[];
  readonly generatedAt: string;
  /** Clock instant of the last successful observation; drives freshness. */
  readonly refreshedAt: string;
  readonly sources: CacheSourceMetadata;
  readonly origin: SnapshotOrigin;
}

const EPOCH_ISO = new Date(0).toISOString();

/** The bootstrap snapshot: committed manifest models, no observed timestamps. */
export function embeddedSnapshot(): CatalogSnapshot {
  const manifest = embeddedCatalogManifest();
  return {
    catalog: manifest.models,
    deprecated: [],
    quarantine: [],
    generatedAt: manifest.generatedAt,
    refreshedAt: EPOCH_ISO,
    sources: { modelsDevAt: EPOCH_ISO, liveAt: EPOCH_ISO },
    origin: "embedded",
  };
}

/** Wrap a validated cache envelope into a served snapshot. */
export function snapshotFromEnvelope(envelope: CatalogCacheEnvelope, origin: SnapshotOrigin): CatalogSnapshot {
  return {
    catalog: envelope.catalog,
    deprecated: envelope.deprecated,
    quarantine: envelope.quarantine,
    generatedAt: envelope.generatedAt,
    refreshedAt: envelope.refreshedAt,
    sources: envelope.sources,
    origin,
  };
}

/** The snapshot's durable envelope (origin is in-memory state, not persisted). */
export function envelopeOf(snapshot: CatalogSnapshot): CatalogCacheEnvelope {
  return {
    version: CACHE_ENVELOPE_VERSION,
    refreshedAt: snapshot.refreshedAt,
    generatedAt: snapshot.generatedAt,
    sources: snapshot.sources,
    catalog: snapshot.catalog,
    deprecated: snapshot.deprecated,
    quarantine: snapshot.quarantine,
  };
}

/** Build the post-reconcile snapshot: a fresh immutable catalog identity. */
export function buildSnapshot(result: ReconcileResult, sources: CacheSourceMetadata): CatalogSnapshot {
  return {
    catalog: result.catalog,
    deprecated: result.deprecated,
    quarantine: result.quarantine,
    generatedAt: result.generatedAt,
    refreshedAt: sources.liveAt,
    sources,
    origin: "refreshed",
  };
}

/** The minimal input `loadInitial` needs (structural, so no lifecycle cycle). */
export interface InitialLoadDeps {
  readonly cachePath: () => string;
  readonly clock: Clock;
}

/**
 * Read the initial snapshot synchronously: validated cache → embedded, in
 * that order. A missing cache yields the embedded bootstrap; a malformed one
 * falls back to embedded WITHOUT deleting the bad file (origin "corrupt").
 */
export function loadInitial(deps: InitialLoadDeps): { readonly snapshot: CatalogSnapshot; readonly origin: SnapshotOrigin } {
  try {
    const envelope = readCache(deps.cachePath(), deps.clock.now());
    if (envelope !== undefined) {
      return { snapshot: snapshotFromEnvelope(envelope, "cache"), origin: "cache" };
    }
  } catch {
    return { snapshot: embeddedSnapshot(), origin: "corrupt" };
  }
  return { snapshot: embeddedSnapshot(), origin: "embedded" };
}
