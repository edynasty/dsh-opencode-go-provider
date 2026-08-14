/**
 * SWR catalog lifecycle: current snapshot, scheduling, single-flight, disposal.
 *
 * Cold startup synchronously chooses validated cache → embedded snapshot and
 * publishes it before any background work; reads never await network. A fresh
 * snapshot suppresses redundant refresh; a stale read returns immediately and
 * schedules ONE background refresh; the periodic timer re-arms with the live
 * validated config. All refresh work is single-flight, persisted atomically
 * BEFORE the in-memory snapshot swaps, and an abort observed at any point —
 * including mid-persistence — prevents publication. Concurrent disposers
 * share one cleanup promise; every dependency is injected.
 */
import { DEFAULTS, resolveConfig } from "./config.ts";
import type { ResolvedConfig } from "./config.ts";
import { attemptReconcile } from "./sync.ts";
import type { TimerHandle } from "./sync.ts";
import { buildSnapshot, envelopeOf, loadInitial } from "./snapshot.ts";
import type { CatalogSnapshot } from "./snapshot.ts";
import { failureMessage } from "./failure.ts";
export type { CatalogSnapshot, SnapshotOrigin } from "./snapshot.ts";
export type { LifecycleDeps, LifecycleEvent, LifecycleStats, RefreshFailureCode, RefreshOutcome } from "./lifecycle-contract.ts";
import type { LifecycleDeps, LifecycleEvent, LifecycleStats, RefreshOutcome } from "./lifecycle-contract.ts";
import type { CatalogModel, PreviousState } from "./types.ts";
import type { CacheCommitResult } from "./cache.ts";

/**
 * Owns the current catalog snapshot, its freshness/scheduling, single-flight
 * refresh and disposal. `catalog()` is the adapter seam: it always returns the
 * current immutable array and never awaits network.
 */
export class CatalogLifecycle {
  private snapshot: CatalogSnapshot;
  private inFlight: Promise<RefreshOutcome> | undefined;
  private periodicHandle: TimerHandle | undefined;
  private immediateHandle: TimerHandle | undefined;
  private abort: AbortController | undefined;
  private disposePromise: Promise<void> | undefined;
  private started = false;
  private disposed = false;
  readonly stats: LifecycleStats;

  constructor(private readonly deps: LifecycleDeps) {
    const initial = loadInitial(deps);
    this.snapshot = initial.snapshot;
    this.stats = {
      attemptsStarted: 0,
      attemptsSucceeded: 0,
      attemptsFailed: 0,
      cacheWrites: 0,
      cacheWriteFailures: 0,
      swaps: 0,
      freshnessHits: 0,
      initialOrigin: initial.origin,
    };
  }

  /** The current immutable catalog; a stale read also schedules one refresh. */
  catalog(): readonly CatalogModel[] {
    if (!this.disposed && this.tryResolveConfig() !== undefined && !this.isFreshNow()) {
      this.kickRefresh();
    }
    return this.snapshot.catalog;
  }

  current(): CatalogSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    if (!this.isFreshNow()) this.kickRefresh();
    this.armPeriodic();
  }

  /** Re-judge scheduling after a config commit: re-arm periodic, maybe refresh. */
  notifyConfigChanged(): void {
    if (this.disposed || !this.started) return;
    this.armPeriodic();
    if (!this.isFreshNow()) this.kickRefresh();
  }

  /**
   * Request a refresh: fresh resolves immediately with zero network; stale
   * starts (or joins) the single-flight attempt. Never rejects.
   */
  refresh(): Promise<RefreshOutcome> {
    if (this.disposed) return Promise.resolve({ kind: "disposed" });
    if (this.inFlight !== undefined) return this.inFlight;
    const config = this.tryResolveConfig();
    if (config === undefined) {
      return Promise.resolve({ kind: "failed", code: "INTERNAL", message: failureMessage("INTERNAL") });
    }
    if (this.isFresh(config)) {
      this.stats.freshnessHits += 1;
      this.observe({ kind: "refresh-fresh" });
      return Promise.resolve({ kind: "fresh" });
    }
    this.stats.attemptsStarted += 1;
    this.observe({ kind: "refresh-started" });
    this.abort = new AbortController();
    const attempt = this.performAttempt(config);
    this.inFlight = attempt;
    void attempt.finally(() => {
      if (this.inFlight === attempt) {
        this.inFlight = undefined;
        this.abort = undefined;
      }
    });
    return attempt;
  }

  /**
   * Stop scheduling, abort and settle the active pair. Every caller — even
   * concurrent ones — awaits the SAME cleanup promise; later calls are
   * await-equivalent and the cleanup itself is idempotent.
   */
  dispose(): Promise<void> {
    if (this.disposePromise === undefined) {
      this.disposePromise = this.runDispose();
    }
    return this.disposePromise;
  }

  private async runDispose(): Promise<void> {
    this.disposed = true;
    if (this.immediateHandle !== undefined) {
      this.deps.scheduler.clearTimer(this.immediateHandle);
      this.immediateHandle = undefined;
    }
    if (this.periodicHandle !== undefined) {
      this.deps.scheduler.clearTimer(this.periodicHandle);
      this.periodicHandle = undefined;
    }
    this.abort?.abort();
    const pending = this.inFlight;
    if (pending !== undefined) {
      await pending;
    }
  }

  private observe(event: LifecycleEvent): void {
    this.deps.observe?.(event);
  }

  private previousState(): PreviousState {
    return {
      models: this.snapshot.catalog,
      quarantine: this.snapshot.quarantine,
      deprecated: this.snapshot.deprecated,
      generatedAt: this.snapshot.generatedAt,
    };
  }

  private tryResolveConfig(): ResolvedConfig | undefined {
    try {
      return resolveConfig(this.deps.currentConfig());
    } catch {
      return undefined;
    }
  }

  private isFresh(config: ResolvedConfig): boolean {
    const elapsed = this.deps.clock.now().getTime() - Date.parse(this.snapshot.refreshedAt);
    return elapsed < config.freshnessMs;
  }

  private isFreshNow(): boolean {
    const config = this.tryResolveConfig();
    return config !== undefined && this.isFresh(config);
  }

  /** Arm (or re-arm) a 0-delay refresh timer; deduplicated while pending. */
  private kickRefresh(): void {
    if (this.disposed || this.immediateHandle !== undefined) return;
    this.immediateHandle = this.deps.scheduler.setTimer(() => {
      this.immediateHandle = undefined;
      void this.refresh();
    }, 0);
  }

  /** Re-arm the periodic timer with the live validated refreshMs. */
  private armPeriodic(): void {
    if (this.disposed || !this.started) return;
    if (this.periodicHandle !== undefined) {
      this.deps.scheduler.clearTimer(this.periodicHandle);
      this.periodicHandle = undefined;
    }
    const refreshMs = this.tryResolveConfig()?.refreshMs ?? DEFAULTS.refreshMs;
    this.periodicHandle = this.deps.scheduler.setTimer(() => {
      this.periodicHandle = undefined;
      void this.refresh();
      this.armPeriodic();
    }, refreshMs);
  }

  /** An abort observed anywhere (sync failure, persist, or post-write) settles the attempt as failed. */
  private abortedOutcome(): RefreshOutcome {
    this.stats.attemptsFailed += 1;
    this.observe({ kind: "refresh-failed", code: "ABORTED", message: failureMessage("ABORTED") });
    return { kind: "failed", code: "ABORTED", message: failureMessage("ABORTED") };
  }

  /**
   * Run the bounded attempt, persist atomically, then swap around an explicit
   * commit point. A writer that reports COMMITTED (its rename published the
   * new file) is adopted even if disposal races in after the rename — disk
   * and memory must stay on the same generation. A writer that did NOT commit
   * (abort or failure before rename) never publishes: the disposed/aborted
   * guard retains old memory+disk; a genuine non-abort write failure counts
   * CACHE_WRITE_FAILED. Accounting after settlement: started = succeeded +
   * failed (+ 0 active).
   */
  private async performAttempt(config: ResolvedConfig): Promise<RefreshOutcome> {
    try {
      const outcome = await attemptReconcile({
        fetch: this.deps.fetch,
        resolveKey: this.deps.resolveKey,
        config,
        previous: this.previousState(),
        patches: this.deps.patches,
        clock: this.deps.clock,
        scheduler: this.deps.scheduler,
        signal: this.abort?.signal,
      });
      if (outcome.kind === "failed") {
        this.stats.attemptsFailed += 1;
        this.observe({ kind: "refresh-failed", code: outcome.code, message: outcome.message });
        return { kind: "failed", code: outcome.code, message: outcome.message };
      }
      const next = buildSnapshot(outcome.result, outcome.sources);
      let commit: CacheCommitResult;
      try {
        commit = await this.deps.persistCache(this.deps.cachePath(), envelopeOf(next), this.abort?.signal);
      } catch {
        commit = { kind: "not-committed" };
      }
      if (commit.kind === "committed") {
        this.snapshot = next;
        this.stats.cacheWrites += 1;
        this.stats.swaps += 1;
        this.stats.attemptsSucceeded += 1;
        this.observe({ kind: "refresh-ok", modelCount: next.catalog.length, transitioned: outcome.result.transitioned });
        return { kind: "ok", result: outcome.result, refreshedAt: next.refreshedAt };
      }
      if (this.disposed || this.abort?.signal.aborted) return this.abortedOutcome();
      this.stats.cacheWriteFailures += 1;
      this.stats.attemptsFailed += 1;
      this.observe({ kind: "refresh-failed", code: "CACHE_WRITE_FAILED", message: failureMessage("CACHE_WRITE_FAILED") });
      return { kind: "failed", code: "CACHE_WRITE_FAILED", message: failureMessage("CACHE_WRITE_FAILED") };
    } catch {
      this.stats.attemptsFailed += 1;
      this.observe({ kind: "refresh-failed", code: "INTERNAL", message: failureMessage("INTERNAL") });
      return { kind: "failed", code: "INTERNAL", message: failureMessage("INTERNAL") };
    }
  }
}
