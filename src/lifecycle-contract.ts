/**
 * SWR lifecycle public contract: outcomes, stats, events and dependencies.
 *
 * Kept separate from the coordinator so the injectable seam types stay a
 * single reviewable surface and the coordinator stays under the module-size
 * ceiling. `persistCache` is the strictly typed persistence seam: production
 * wires `writeCacheAtomic`, tests inject a gated/aborting writer.
 */
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import type { CacheCommitResult, CatalogCacheEnvelope } from "./cache.ts";
import type { Config } from "./config.ts";
import type { Clock, Scheduler, SyncFetch } from "./sync.ts";
import type { SyncFailureCode } from "./sync.ts";
import type { Patches, ReconcileResult } from "./types.ts";

/** Failure codes a refresh outcome can carry. */
export type RefreshFailureCode = SyncFailureCode | "CACHE_WRITE_FAILED";

/** Typed outcome every refresh caller observes; never rejects. */
export type RefreshOutcome =
  | { readonly kind: "fresh" }
  | { readonly kind: "disposed" }
  | { readonly kind: "ok"; readonly result: ReconcileResult; readonly refreshedAt: string }
  | { readonly kind: "failed"; readonly code: RefreshFailureCode; readonly message: string };

/** Machine-readable counters for tests and evidence; no secrets ever. */
export interface LifecycleStats {
  attemptsStarted: number;
  attemptsSucceeded: number;
  attemptsFailed: number;
  cacheWrites: number;
  cacheWriteFailures: number;
  swaps: number;
  freshnessHits: number;
  initialOrigin: "embedded" | "cache" | "refreshed" | "corrupt";
}

/** Sanitized observable events; codes and counts only, never URLs/keys/bodies. */
export type LifecycleEvent =
  | { readonly kind: "refresh-started" }
  | { readonly kind: "refresh-fresh" }
  | { readonly kind: "refresh-ok"; readonly modelCount: number; readonly transitioned: boolean }
  | { readonly kind: "refresh-failed"; readonly code: RefreshFailureCode; readonly message: string };

/** Everything the lifecycle needs; every dependency is injectable. */
export interface LifecycleDeps {
  readonly fetch: SyncFetch;
  readonly resolveKey: (ref: CredentialRef) => Promise<string>;
  /** Live validated config; re-read at every scheduling/refresh boundary. */
  readonly currentConfig: () => Config;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly cachePath: () => string;
  readonly patches: Patches;
  /** Atomic cache persistence; the result distinguishes a published commit. */
  readonly persistCache: (
    path: string,
    envelope: CatalogCacheEnvelope,
    signal: AbortSignal | undefined,
  ) => Promise<CacheCommitResult>;
  readonly observe?: (event: LifecycleEvent) => void;
}
