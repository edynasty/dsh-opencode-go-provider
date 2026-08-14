/**
 * Task 6 SWR catalog-lifecycle specs (red-first).
 *
 * The lifecycle owns the current immutable catalog snapshot and its
 * scheduling: cold startup serves validated cache→embedded immediately and
 * never waits for network; fresh snapshots suppress redundant refresh for
 * `freshnessMs`; stale reads return immediately and schedule one background
 * refresh; the periodic timer re-arms with the live validated config. All
 * refresh work is single-flight (one promise, one source pair), persisted
 * atomically BEFORE the in-memory snapshot swaps, and any failure retains
 * both memory and disk. Disposal clears timers, aborts the active pair and
 * settles idempotently. The clock, scheduler, fetch and home are injected —
 * no wall clock, no real network, no real DSH_HOME.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogLifecycle } from "../src/lifecycle.ts";
import type { LifecycleDeps, LifecycleEvent } from "../src/lifecycle.ts";
import { Config } from "../src/config.ts";
import { OpenCodeGoAdapter } from "../src/adapter.ts";
import { resolveCachePath, writeCacheAtomic } from "../src/cache.ts";
import { readCache } from "../src/cache-parse.ts";
import type { CatalogCacheEnvelope } from "../src/cache.ts";
import { CACHE_ENVELOPE_VERSION } from "../src/cache.ts";
import { embeddedCatalogModels } from "../src/catalog-loader.ts";
import { FOURTEEN_DAYS_MS } from "../src/constants.ts";
import { isRecord, isUnknownArray } from "../src/guards.ts";
import { parseJsonFile, parseModelsManifest, parsePatchesFile } from "../src/state-file.ts";
import type { CatalogModel } from "../src/types.ts";
import { makePatches, readRepoFile } from "./helpers/catalog-fixtures.ts";
import { FakeClock, FakeScheduler } from "./helpers/fake-clock.ts";
import { failClosedFetch, makeFetch } from "./helpers/fake-network.ts";
import {
  FIXTURE_MODELS,
  catalogModelFor,
  collect,
  finishKind,
  makeAdapter,
  optionsFor,
  userMessage,
} from "./helpers/adapter-fixtures.ts";
import { SSE_DONE, expectedPath, sseHeaders, startMock } from "./helpers/mock-server.ts";
import { USAGE, completionsChunk, completionsTextStream } from "./helpers/sse-payloads.ts";

const T0 = new Date("2026-08-14T00:00:00.000Z");
const FAKE_KEY = "sk-lifecycle-fake-key-0123456789";
const FRESHNESS_MS = 300_000;
const REFRESH_MS = 3_600_000;

function catalogModels(): readonly CatalogModel[] {
  return parseModelsManifest(parseJsonFile(readRepoFile("catalog/models.json"), "models.json")).models;
}

function modelsDevMap(): unknown {
  return { "opencode-go": JSON.parse(readRepoFile("catalog/fixtures/models-dev-opencode-go.json")) };
}

function livePayload(): unknown {
  return JSON.parse(readRepoFile("catalog/fixtures/live-models.json"));
}

function liveWithout(id: string): unknown {
  const parsed: unknown = JSON.parse(readRepoFile("catalog/fixtures/live-models.json"));
  if (!isRecord(parsed) || !isUnknownArray(parsed.data)) {
    throw new Error("test setup: live fixture must be { data: [...] }");
  }
  const kept: unknown[] = [];
  for (const entry of parsed.data) {
    if (isRecord(entry) && entry.id !== id) kept.push(entry);
  }
  return { data: kept };
}

/** A structurally valid cache envelope for the tests to seed. */
function makeEnvelope(overrides: Partial<Omit<CatalogCacheEnvelope, "version">> = {}): CatalogCacheEnvelope {
  return {
    version: CACHE_ENVELOPE_VERSION,
    refreshedAt: T0.toISOString(),
    generatedAt: T0.toISOString(),
    sources: { modelsDevAt: T0.toISOString(), liveAt: T0.toISOString() },
    catalog: catalogModels(),
    deprecated: [],
    quarantine: [],
    ...overrides,
  };
}

interface Rig {
  readonly clock: FakeClock;
  readonly scheduler: FakeScheduler;
  readonly home: string;
  make(overrides?: Partial<LifecycleDeps>): CatalogLifecycle;
}

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function rig(): Rig {
  const clock = new FakeClock(T0.getTime());
  const scheduler = new FakeScheduler(clock);
  const home = mkdtempSync(join(tmpdir(), "dsh-opencode-go-provider-lifecycle-"));
  homes.push(home);
  return {
    clock,
    scheduler,
    home,
    make: (overrides = {}) =>
      new CatalogLifecycle({
        fetch: failClosedFetch(),
        resolveKey: () => Promise.resolve(FAKE_KEY),
        currentConfig: () => Config({}),
        clock: { now: () => clock.now() },
        scheduler,
        cachePath: () => resolveCachePath(home),
        patches: parsePatchesFile(makePatches()),
        persistCache: (path, envelope) => writeCacheAtomic(path, envelope),
        ...overrides,
      }),
  };
}

/** After settlement, every started attempt is either succeeded or failed. */
function expectAccounting(lc: CatalogLifecycle): void {
  expect(lc.stats.attemptsStarted).toBe(lc.stats.attemptsSucceeded + lc.stats.attemptsFailed);
}

/** Observer + terminal-event waiter: resolves when a NEW ok/failed event fires. */
function eventCapture(): { readonly observe: (event: LifecycleEvent) => void; readonly nextTerminal: () => Promise<void> } {
  const events: LifecycleEvent[] = [];
  let terminalCount = 0;
  const pending: Array<() => void> = [];
  const observe = (event: LifecycleEvent): void => {
    events.push(event);
    if (event.kind === "refresh-ok" || event.kind === "refresh-failed") {
      terminalCount += 1;
      for (const resolve of pending.splice(0)) resolve();
    }
  };
  const nextTerminal = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("test: no refresh event arrived within the bound"));
      }, 2_000);
      pending.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  return { observe, nextTerminal };
}

describe("cold startup", () => {
  it("serves the embedded catalog synchronously with a fail-closed network", async () => {
    // Given: no cache file and a fetch that throws on any URL.
    const r = rig();
    const lc = r.make();
    // When: the catalog is read before any async step or clock advance.
    const ids = lc.catalog().map((model) => model.id);
    // Then: the embedded snapshot is served immediately, origin embedded.
    expect(ids).toEqual(embeddedCatalogModels().map((model) => model.id));
    expect(lc.current().origin).toBe("embedded");
    expect(lc.stats.swaps).toBe(0);
    // And the scheduled background refresh fails without disturbing memory.
    lc.start();
    r.scheduler.advance(0);
    const outcome = await lc.refresh();
    expect(outcome.kind).toBe("failed");
    expect(lc.catalog().map((model) => model.id)).toEqual(embeddedCatalogModels().map((model) => model.id));
    expect(lc.stats.attemptsFailed).toBe(1);
  });

  it("prefers a validated cache over the embedded snapshot", async () => {
    // Given: a valid cache naming a single model, freshly written.
    const r = rig();
    const first = catalogModels()[0];
    if (first === undefined) throw new Error("test setup: catalog has no models");
    await writeCacheAtomic(resolveCachePath(r.home), makeEnvelope({ catalog: [first] }));
    // When: the lifecycle boots.
    const lc = r.make();
    // Then: the cache snapshot is served, not the embedded one.
    expect(lc.current().origin).toBe("cache");
    expect(lc.catalog().map((model) => model.id)).toEqual([first.id]);
    // And a fresh cache arms no immediate refresh, only the periodic timer.
    lc.start();
    expect(r.scheduler.pendingCount()).toBe(1);
  });

  it("serves a fresh cache immediately and schedules no network on read", async () => {
    const r = rig();
    await writeCacheAtomic(resolveCachePath(r.home), makeEnvelope());
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch });
    expect(lc.catalog().length).toBeGreaterThan(0);
    expect(spy.calls).toEqual([]);
  });
});

describe("freshness and staleness", () => {
  it("reuses a fresh snapshot without any network", async () => {
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch });
    const first = await lc.refresh();
    expect(first.kind).toBe("ok");
    expect(spy.calls.length).toBe(2);
    // The clock has not moved: the snapshot is still within freshnessMs.
    const second = await lc.refresh();
    expect(second).toEqual({ kind: "fresh" });
    expect(spy.calls.length).toBe(2);
    expect(lc.stats.freshnessHits).toBe(1);
  });

  it("returns immediately from a stale read and schedules exactly one background refresh", async () => {
    const r = rig();
    const capture = eventCapture();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch, observe: capture.observe });
    await lc.refresh();
    expect(lc.stats.attemptsStarted).toBe(1);
    // Move past freshness without touching the periodic timer (60 min).
    r.scheduler.advance(FRESHNESS_MS + 1);
    const before = lc.catalog();
    // When: a stale read happens — it returns the old snapshot immediately.
    expect(lc.catalog()).toBe(before);
    expect(spy.calls.length).toBe(2);
    // Then: the read scheduled a background refresh; fire and await it.
    r.scheduler.advance(0);
    await capture.nextTerminal();
    expect(spy.calls.length).toBe(4);
    expect(lc.catalog()).not.toBe(before);
    expect(lc.stats.attemptsStarted).toBe(2);
  });

  it("runs the periodic refresh every refreshMs even without reads", async () => {
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch });
    lc.start();
    r.scheduler.advance(0);
    await lc.refresh();
    expect(spy.calls.length).toBe(2);
    // Advance the full periodic interval: the timer fires and refreshes.
    r.scheduler.advance(REFRESH_MS);
    const outcome = await lc.refresh();
    expect(outcome.kind).toBe("ok");
    expect(spy.calls.length).toBe(4);
  });
});

describe("single-flight", () => {
  it("shares one promise and one source pair across concurrent refresh calls", async () => {
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch });
    const first = lc.refresh();
    const second = lc.refresh();
    const third = lc.refresh();
    // Identity: all three callers observe the very same promise.
    expect(first).toBe(second);
    expect(second).toBe(third);
    const outcomes = await Promise.all([first, second, third]);
    expect(outcomes.every((outcome) => outcome.kind === "ok")).toBe(true);
    expect(spy.calls.length).toBe(2);
    expect(lc.stats.attemptsStarted).toBe(1);
  });
});

describe("failure retention", () => {
  it.each([
    { name: "models.dev 503", modelsDev: { status: 503, body: { error: "x" } }, live: { status: 200, body: livePayload() } },
    { name: "models.dev malformed", modelsDev: { status: 200, rawText: "{ broken" }, live: { status: 200, body: livePayload() } },
    { name: "live 401", modelsDev: { status: 200, body: modelsDevMap() }, live: { status: 401, body: { error: "x" } } },
    { name: "live 503", modelsDev: { status: 200, body: modelsDevMap() }, live: { status: 503, body: { error: "x" } } },
  ])("a $name refresh never overwrites cache or memory", async ({ modelsDev, live }) => {
    const r = rig();
    const path = resolveCachePath(r.home);
    await writeCacheAtomic(path, makeEnvelope());
    const bytesBefore = readFileSync(path, "utf8");
    const spy = makeFetch({ modelsDev, live });
    const lc = r.make({ fetch: spy.fetch });
    const before = lc.catalog();
    r.scheduler.advance(FRESHNESS_MS + 1);
    const outcome = await lc.refresh();
    expect(outcome.kind).toBe("failed");
    expect(lc.catalog()).toBe(before);
    expect(readFileSync(path, "utf8")).toBe(bytesBefore);
    expect(lc.stats.swaps).toBe(0);
    expectAccounting(lc);
  });

  it("a timeout refresh never overwrites cache or memory", async () => {
    const r = rig();
    const path = resolveCachePath(r.home);
    await writeCacheAtomic(path, makeEnvelope());
    const bytesBefore = readFileSync(path, "utf8");
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload(), hang: true },
    });
    const lc = r.make({ fetch: spy.fetch });
    const before = lc.catalog();
    r.scheduler.advance(FRESHNESS_MS + 1);
    const promise = lc.refresh();
    // Let the deadline timer arm before advancing the fake clock.
    await Promise.resolve();
    r.scheduler.advance(10_000);
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    expect(lc.catalog()).toBe(before);
    expect(readFileSync(path, "utf8")).toBe(bytesBefore);
  });

  it("a cache write failure retains the previous memory snapshot", async () => {
    const r = rig();
    const blocker = join(r.home, "blocker");
    writeFileSync(blocker, "x");
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch, cachePath: () => join(blocker, "catalog.json") });
    const before = lc.catalog();
    const outcome = await lc.refresh();
    expect(outcome).toMatchObject({ kind: "failed", code: "CACHE_WRITE_FAILED" });
    expect(lc.catalog()).toBe(before);
    expect(lc.stats.cacheWriteFailures).toBe(1);
    expect(lc.stats.swaps).toBe(0);
    // The failed write counts as a failed attempt exactly once.
    expect(lc.stats.attemptsFailed).toBe(1);
    expectAccounting(lc);
  });
});

describe("atomic swap", () => {
  it("persists the new snapshot before publishing a new catalog identity", async () => {
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch });
    const before = lc.catalog();
    const outcome = await lc.refresh();
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(lc.catalog()).not.toBe(before);
    expect(lc.stats.swaps).toBe(1);
    expect(lc.stats.cacheWrites).toBe(1);
    // The cache on disk round-trips to the published snapshot.
    const path = resolveCachePath(r.home);
    expect(existsSync(path)).toBe(true);
    const parsed = readCache(path, new Date(T0.getTime() + 60_000));
    expect(parsed?.catalog).toEqual(lc.current().catalog);
    expect(parsed?.deprecated).toEqual(lc.current().deprecated);
    expect(parsed?.quarantine).toEqual(lc.current().quarantine);
    expect(lc.current().origin).toBe("refreshed");
    expectAccounting(lc);
  });

  it("the written cache carries no secret or header material", async () => {
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch });
    await lc.refresh();
    const text = readFileSync(resolveCachePath(r.home), "utf8");
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/bearer/i);
    expect(text).not.toMatch(/sk-[a-z0-9]/i);
  });
});

describe("14-day deprecation grace", () => {
  it("keeps a missing model selectable, evicts after grace, and resurrects on reappearance", async () => {
    const r = rig();
    const removed = catalogModels()[0]?.id;
    if (removed === undefined) throw new Error("test setup: catalog has no models");
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({ fetch: spy.fetch });
    // All live: the full catalog is served.
    await lc.refresh();
    expect(lc.catalog().some((model) => model.id === removed)).toBe(true);
    // The model disappears from live: it stays selectable with a deprecatedAt.
    spy.setLive({ status: 200, body: liveWithout(removed) });
    r.scheduler.advance(FRESHNESS_MS + 1);
    await lc.refresh();
    expect(lc.catalog().some((model) => model.id === removed)).toBe(true);
    const firstDep = lc.current().deprecated.find((entry) => entry.id === removed);
    expect(firstDep?.evictedAt).toBeUndefined();
    if (firstDep === undefined) throw new Error("test setup: deprecated entry missing");
    // Repeated absence keeps the same deprecatedAt (the grace clock never restarts).
    r.scheduler.advance(FRESHNESS_MS + 1);
    await lc.refresh();
    const secondDep = lc.current().deprecated.find((entry) => entry.id === removed);
    expect(secondDep?.deprecatedAt).toBe(firstDep.deprecatedAt);
    // Past the grace boundary the model is evicted from the public catalog.
    r.scheduler.advance(FOURTEEN_DAYS_MS + 1);
    await lc.refresh();
    expect(lc.catalog().some((model) => model.id === removed)).toBe(false);
    expect(lc.current().deprecated.find((entry) => entry.id === removed)?.evictedAt).toBeDefined();
    // Reappearing on live resurrects it and clears the tombstone.
    spy.setLive({ status: 200, body: livePayload() });
    r.scheduler.advance(FRESHNESS_MS + 1);
    await lc.refresh();
    expect(lc.catalog().some((model) => model.id === removed)).toBe(true);
    expect(lc.current().deprecated.some((entry) => entry.id === removed)).toBe(false);
  });
});

describe("config changes", () => {
  it("re-arms the periodic schedule with the live validated config", async () => {
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    let config = Config({});
    const lc = r.make({ fetch: spy.fetch, currentConfig: () => config });
    lc.start();
    r.scheduler.advance(0);
    await lc.refresh();
    expect(spy.calls.length).toBe(2);
    // Shrink the periodic interval and notify the lifecycle.
    config = Config({ refreshMs: 120_000, freshnessMs: 60_000 });
    lc.notifyConfigChanged();
    // The old 60-minute schedule would not fire here; the re-armed 120s does.
    r.scheduler.advance(120_000);
    const outcome = await lc.refresh();
    expect(outcome.kind).toBe("ok");
    expect(spy.calls.length).toBe(4);
  });
});

describe("disposal", () => {
  it("clears timers, aborts and settles an in-flight refresh, and is idempotent", async () => {
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap(), hang: true },
      live: { status: 200, body: livePayload(), hang: true },
    });
    const lc = r.make({ fetch: spy.fetch });
    lc.start();
    r.scheduler.advance(0);
    // The immediate refresh is now hanging; the periodic and its deadline
    // timer are still armed.
    expect(r.scheduler.pendingCount()).toBeGreaterThan(0);
    await lc.dispose();
    expect(r.scheduler.pendingCount()).toBe(0);
    expect(spy.calls.every((call) => call.aborted)).toBe(true);
    expect(lc.stats.swaps).toBe(0);
    // A second dispose is a no-op.
    await lc.dispose();
    expect(lc.stats.attemptsStarted).toBe(1);
  });

  it("leaves zero timers after an idle disposal", async () => {
    const r = rig();
    await writeCacheAtomic(resolveCachePath(r.home), makeEnvelope());
    const lc = r.make();
    lc.start();
    expect(r.scheduler.pendingCount()).toBe(1);
    await lc.dispose();
    expect(r.scheduler.pendingCount()).toBe(0);
  });

  it("returns a disposed outcome for refresh calls after disposal", async () => {
    const r = rig();
    const lc = r.make();
    await lc.dispose();
    expect(await lc.refresh()).toEqual({ kind: "disposed" });
  });
});

describe("dispose during persistence", () => {
  it("a non-committing writer that resolves after disposal never publishes; concurrent disposers share one cleanup", async () => {
    // Given: a lifecycle whose cache writer is gated until the test releases it.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const startedWrites: string[] = [];
    const lc = r.make({
      fetch: spy.fetch,
      persistCache: async (path) => {
        startedWrites.push(path);
        await gate;
        return { kind: "not-committed" };
      },
    });
    const before = lc.catalog();
    // When: the refresh's network succeeds and its persist starts.
    const refresh = lc.refresh();
    await waitUntil(() => startedWrites.length === 1);
    // And disposal begins while the persist is still pending — two concurrent
    // callers must share the very same cleanup promise.
    const first = lc.dispose();
    const second = lc.dispose();
    expect(first).toBe(second);
    // The writer completes without committing (it ignored the abort signal).
    release?.();
    const outcome = await refresh;
    await Promise.all([first, second]);
    // Then: the attempt never publishes, never swaps, and the write is not
    // counted as a successful cache write.
    expect(outcome.kind).not.toBe("ok");
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(lc.catalog()).toBe(before);
    expect(lc.stats.swaps).toBe(0);
    expect(lc.stats.cacheWrites).toBe(0);
    expect(r.scheduler.pendingCount()).toBe(0);
    expectAccounting(lc);
  });

  it("a committed writer adopts the committed generation even if disposal fires after commit", async () => {
    // Given: a lifecycle whose writer commits (returns committed) only after a gate.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const startedWrites: string[] = [];
    const lc = r.make({
      fetch: spy.fetch,
      persistCache: async (path) => {
        startedWrites.push(path);
        await gate;
        return { kind: "committed" };
      },
    });
    const before = lc.catalog();
    const refresh = lc.refresh();
    await waitUntil(() => startedWrites.length === 1);
    const first = lc.dispose();
    const second = lc.dispose();
    expect(first).toBe(second);
    // The writer reports the commit AFTER disposal began.
    release?.();
    const outcome = await refresh;
    await Promise.all([first, second]);
    // Then: disk and memory must stay on the SAME generation — the committed one.
    expect(outcome.kind).toBe("ok");
    expect(lc.catalog()).not.toBe(before);
    expect(lc.stats.swaps).toBe(1);
    expect(lc.stats.cacheWrites).toBe(1);
    expect(lc.stats.attemptsSucceeded).toBe(1);
    expect(r.scheduler.pendingCount()).toBe(0);
    expectAccounting(lc);
  });

  it("an aborted writer that rejects leaves the snapshot unchanged", async () => {
    const r = rig();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({
      fetch: spy.fetch,
      persistCache: () => Promise.reject(new Error("disk full")),
    });
    const before = lc.catalog();
    const outcome = await lc.refresh();
    expect(outcome).toMatchObject({ kind: "failed", code: "CACHE_WRITE_FAILED" });
    expect(lc.catalog()).toBe(before);
    expect(lc.stats.cacheWriteFailures).toBe(1);
    expect(lc.stats.attemptsFailed).toBe(1);
    expectAccounting(lc);
  });

  it("commits at rename without waiting for the detached post-rename durability gate", async () => {
    // Given: a stale one-model cache and a directory-durability gate that
    // never resolves until the test releases it.
    const r = rig();
    const models = catalogModels();
    const first = models[0];
    if (first === undefined) throw new Error("test setup: catalog has no models");
    const stale = new Date(T0.getTime() - 600_000).toISOString();
    const path = resolveCachePath(r.home);
    await writeCacheAtomic(
      path,
      makeEnvelope({ catalog: [first], refreshedAt: stale, generatedAt: stale, sources: { modelsDevAt: stale, liveAt: stale } }),
    );
    let releaseDurability: (() => void) | undefined;
    const durabilityGate = new Promise<void>((resolve) => {
      releaseDurability = resolve;
    });
    const gatedDurability = (directory: string): Promise<void> => {
      void directory;
      return durabilityGate;
    };
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({
      fetch: spy.fetch,
      persistCache: (cachePath, envelope, signal) => writeCacheAtomic(cachePath, envelope, signal, gatedDurability),
    });
    const before = lc.catalog();
    expect(before.length).toBe(1);
    // When: a refresh commits — the rename publishes the new file while the
    // durability gate is still unresolved.
    const refresh = lc.refresh();
    await waitUntil(() => {
      const disk = readCache(path, new Date(T0.getTime() + 60_000));
      return disk !== undefined && disk.catalog.length > 1;
    });
    // Then: disk is NEW while the gate is pending...
    const diskMid = readCache(path, new Date(T0.getTime() + 60_000));
    expect(diskMid?.catalog.length).toBeGreaterThan(1);
    // And disposal starts while the gate is pending — it must not hang on it.
    const disposePromise = lc.dispose();
    const outcome = await refresh;
    await disposePromise;
    // Memory adopted the committed generation and matches disk.
    expect(outcome.kind).toBe("ok");
    expect(lc.catalog()).not.toBe(before);
    expect(lc.stats.swaps).toBe(1);
    expect(lc.stats.cacheWrites).toBe(1);
    expect(lc.stats.attemptsSucceeded).toBe(1);
    const diskFinal = readCache(path, new Date(T0.getTime() + 60_000));
    expect(diskFinal?.catalog).toEqual(lc.current().catalog);
    expect(r.scheduler.pendingCount()).toBe(0);
    expectAccounting(lc);
    // Cleanup: release the gate; the detached durability must not surface as
    // an unhandled rejection or leave a temp file behind.
    releaseDurability?.();
    await Promise.resolve();
    const names = await readdir(join(r.home, "cache", "dsh-opencode-go-provider"));
    expect(names).toEqual(["catalog.json"]);
  }, 10_000);

  it("a real atomic writer committed before disposal leaves disk and memory on the same generation", async () => {
    // Given: a stale old cache with one model on disk, and a lifecycle whose
    // writer is the real writeCacheAtomic.
    const r = rig();
    const models = catalogModels();
    const first = models[0];
    if (first === undefined) throw new Error("test setup: catalog has no models");
    const stale = new Date(T0.getTime() - 600_000).toISOString();
    const path = resolveCachePath(r.home);
    await writeCacheAtomic(
      path,
      makeEnvelope({ catalog: [first], refreshedAt: stale, generatedAt: stale, sources: { modelsDevAt: stale, liveAt: stale } }),
    );
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const lc = r.make({
      fetch: spy.fetch,
      persistCache: async (cachePath, envelope, signal) => {
        const result = await writeCacheAtomic(cachePath, envelope, signal);
        void lc.dispose();
        return result;
      },
    });
    const before = lc.catalog();
    expect(before.length).toBe(1);
    // When: a refresh commits the 24-model generation and disposal races in
    // right after the rename.
    const outcome = await lc.refresh();
    // Then: memory adopted the committed generation and disk matches memory.
    expect(outcome.kind).toBe("ok");
    expect(lc.catalog()).not.toBe(before);
    expect(lc.catalog().length).toBeGreaterThan(1);
    expect(lc.stats.swaps).toBe(1);
    expect(lc.stats.cacheWrites).toBe(1);
    const disk = readCache(path, new Date(T0.getTime() + 60_000));
    expect(disk?.catalog.length).toBe(lc.catalog().length);
    expect(disk?.catalog).toEqual(lc.current().catalog);
    expect(r.scheduler.pendingCount()).toBe(0);
    expectAccounting(lc);
  });
});

describe("in-flight adapter snapshot retention", () => {
  it("captures the catalog snapshot at invocation, before the credential await", async () => {
    // Given: mock A and mock B, a catalog that starts on A.
    let releaseKey: (() => void) | undefined;
    const keyGate = new Promise<void>((resolve) => {
      releaseKey = resolve;
    });
    const responderA = (request: IncomingMessage, response: ServerResponse): void => {
      sseHeaders(response);
      if (request.url !== expectedPath("openai-completions")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.write(completionsTextStream(USAGE));
      response.end();
    };
    const responderB = (_request: IncomingMessage, response: ServerResponse): void => {
      sseHeaders(response);
      response.write(completionsTextStream(USAGE));
      response.end();
    };
    const serverA = await startMock(undefined, responderA);
    const serverB = await startMock(undefined, responderB);
    try {
      let catalog: readonly CatalogModel[] = [catalogModelFor("openai-completions", serverA.baseUrl)];
      const adapter = new OpenCodeGoAdapter({
        currentConfig: () => Config({}),
        resolveKey: () => keyGate.then(() => FAKE_KEY),
        catalog: () => catalog,
      });
      // When: a request starts while the credential resolution is gated.
      const stream = collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS["openai-completions"]), messages: [userMessage("hi")] }),
      );
      // And the catalog is replaced while the key waits.
      catalog = [catalogModelFor("openai-completions", serverB.baseUrl)];
      releaseKey?.();
      const collected = await stream;
      // Then: the invocation-time snapshot (A) served the request, not B.
      expect(finishKind(collected)).toBe("stop");
      expect(serverA.requests.length).toBe(1);
      expect(serverB.requests.length).toBe(0);
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });

  it("keeps an in-flight stream on the old catalog/baseUrl while the next request uses the new identity", async () => {
    // Mock A holds the stream mid-flight until the test releases it.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responderA = (request: IncomingMessage, response: ServerResponse): void => {
      sseHeaders(response);
      if (request.url !== expectedPath("openai-completions")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.write(completionsChunk({ content: "Hello " }));
      void gate.then(() => {
        response.write(completionsChunk({ content: "world" }));
        response.write(completionsChunk({}, { finishReason: "stop" }));
        response.end(SSE_DONE);
      });
    };
    const responderB = (_request: IncomingMessage, response: ServerResponse): void => {
      sseHeaders(response);
      response.write(completionsTextStream(USAGE));
      response.end();
    };
    const serverA = await startMock(undefined, responderA);
    const serverB = await startMock(undefined, responderB);
    try {
      let catalog: readonly CatalogModel[] = [catalogModelFor("openai-completions", serverA.baseUrl)];
      const adapter = makeAdapter(() => catalog);
      // When: the first request starts against catalog A (mock A).
      const first = collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS["openai-completions"]), messages: [userMessage("hi")] }),
      );
      await waitUntil(() => serverA.requests.length === 1);
      // And the catalog swaps to a new identity while the stream is in flight.
      catalog = [catalogModelFor("openai-completions", serverB.baseUrl)];
      release?.();
      const collectedA = await first;
      // Then: the in-flight stream completed on mock A's old snapshot.
      expect(finishKind(collectedA)).toBe("stop");
      expect(serverA.requests.length).toBe(1);
      expect(serverB.requests.length).toBe(0);
      // And the next request uses the new catalog identity (mock B).
      const collectedB = await collect(
        adapter.stream({ ...optionsFor(FIXTURE_MODELS["openai-completions"]), messages: [userMessage("hi")] }),
      );
      expect(finishKind(collectedB)).toBe("stop");
      expect(serverB.requests.length).toBe(1);
      expect(serverA.requests.length).toBe(1);
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });
});

/** Wait (bounded) until a real-socket condition holds. */
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("test: socket condition not met within the bound");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
