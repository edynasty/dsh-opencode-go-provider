/**
 * Deprecation-grace state machine specs (Plan Task 3).
 *
 * 14-day grace for known-but-missing models: first-transition timestamps,
 * preservation across reruns, the exact boundary, resurrection, quarantine
 * self-healing and timestamp preservation. Tiny inline providers keep each
 * transition isolated; clocks are injected, never read from the wall.
 */
import { describe, expect, it } from "vitest";
import { reconcile } from "../src/reconcile.ts";
import { parsePatchesFile } from "../src/state-file.ts";
import type { ReconcileResult } from "../src/types.ts";
import { makeModel, makePatches, makeProvider } from "./helpers/catalog-fixtures.ts";

const T0 = new Date("2026-08-14T00:00:00.000Z");
const DAY = 86_400_000;
const FOURTEEN_DAYS = 14 * DAY;

function alphaBetaProvider() {
  return makeProvider({ alpha: makeModel("alpha"), beta: makeModel("beta"), gamma: makeModel("gamma") });
}

function run(
  liveIds: readonly string[],
  previous: Pick<ReconcileResult, "deprecated" | "quarantine" | "catalog" | "generatedAt"> | undefined,
  now: Date,
): ReconcileResult {
  return reconcile({
    provider: alphaBetaProvider(),
    liveIds,
    patches: parsePatchesFile(makePatches()),
    previous:
      previous === undefined
        ? { deprecated: [], quarantine: [], models: [] }
        : {
            deprecated: previous.deprecated,
            quarantine: previous.quarantine,
            models: previous.catalog,
            generatedAt: previous.generatedAt,
          },
    now,
  });
}

const EMPTY_PREV = undefined;

describe("grace period entry", () => {
  it("keeps a known-but-missing model selectable with a fresh deprecatedAt", () => {
    // Given: alpha and beta are live, gamma is known to models.dev but absent.
    // When: reconciliation runs at T0.
    const result = run(["alpha", "beta"], EMPTY_PREV, T0);
    // Then: gamma enters grace with the first transition timestamp and stays
    // in the public catalog.
    expect(result.deprecated).toEqual([
      {
        id: "gamma",
        deprecatedAt: T0.toISOString(),
        model: expect.objectContaining({ id: "gamma", protocol: "openai-completions" }),
      },
    ]);
    expect(result.catalog.map((m) => m.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("preserves the first deprecatedAt across reruns without resetting the clock", () => {
    // Given: a first run deprecated gamma at T0.
    const first = run(["alpha", "beta"], EMPTY_PREV, T0);
    // When: reruns at T0 + 5 days keep the same inputs.
    const second = run(["alpha", "beta"], first, new Date(T0.getTime() + 5 * DAY));
    // Then: the deprecatedAt is still T0 (grace clock never restarts).
    expect(second.deprecated[0]?.deprecatedAt).toBe(T0.toISOString());
    expect(second.catalog.map((m) => m.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps the model selectable at exactly 14 days and evicts only after the boundary", () => {
    // Given: gamma deprecated at T0.
    const first = run(["alpha", "beta"], EMPTY_PREV, T0);
    // When: the clock sits exactly on the 14-day boundary, then 1ms past it.
    const atBoundary = run(["alpha", "beta"], first, new Date(T0.getTime() + FOURTEEN_DAYS));
    const pastBoundary = run(["alpha", "beta"], first, new Date(T0.getTime() + FOURTEEN_DAYS + 1));
    // Then: exactly 14 days keeps gamma selectable; beyond the boundary it is
    // evicted from the public catalog and stamped with an eviction tombstone.
    expect(atBoundary.catalog.map((m) => m.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(pastBoundary.catalog.map((m) => m.id)).toEqual(["alpha", "beta"]);
    expect(pastBoundary.deprecated).toEqual([
      {
        id: "gamma",
        deprecatedAt: T0.toISOString(),
        evictedAt: new Date(T0.getTime() + FOURTEEN_DAYS + 1).toISOString(),
        model: expect.objectContaining({ id: "gamma" }),
      },
    ]);
    expect(pastBoundary.stats.evicted).toBe(1);
  });

  it("keeps an evicted model absent on later missing-live runs without restarting grace", () => {
    // Given: gamma deprecated at T0 and evicted at T0 + 14d + 1ms.
    const first = run(["alpha", "beta"], EMPTY_PREV, T0);
    const evicted = run(["alpha", "beta"], first, new Date(T0.getTime() + FOURTEEN_DAYS + 1));
    // When: later runs stay missing-live and the clock keeps advancing.
    const later = run(["alpha", "beta"], evicted, new Date(T0.getTime() + 15 * DAY));
    // Then: gamma stays absent, the tombstone survives, eviction is counted
    // once, and the grace clock is not restarted.
    expect(later.catalog.some((m) => m.id === "gamma")).toBe(false);
    expect(later.deprecated).toEqual([
      {
        id: "gamma",
        deprecatedAt: T0.toISOString(),
        evictedAt: new Date(T0.getTime() + FOURTEEN_DAYS + 1).toISOString(),
        model: expect.objectContaining({ id: "gamma" }),
      },
    ]);
    expect(later.stats.evicted).toBe(0);
    expect(later.stats.deprecated).toBe(0);
    expect(later.transitioned).toBe(false);
  });

  it("resurrects an evicted model when it returns to live and clears the tombstone", () => {
    // Given: gamma deprecated at T0, evicted at T0 + 14d + 1ms.
    const first = run(["alpha", "beta"], EMPTY_PREV, T0);
    const evicted = run(["alpha", "beta"], first, new Date(T0.getTime() + FOURTEEN_DAYS + 1));
    // When: gamma comes back live at T0 + 20 days.
    const resurrected = run(["alpha", "beta", "gamma"], evicted, new Date(T0.getTime() + 20 * DAY));
    // Then: the tombstone clears, gamma is served from fresh metadata, and a
    // later absence starts a brand-new grace lifecycle.
    expect(resurrected.deprecated).toEqual([]);
    expect(resurrected.stats.resurrected).toBe(1);
    expect(resurrected.catalog.some((m) => m.id === "gamma")).toBe(true);
    const regraced = run(["alpha", "beta"], resurrected, new Date(T0.getTime() + 21 * DAY));
    expect(regraced.deprecated[0]).toEqual({
      id: "gamma",
      deprecatedAt: new Date(T0.getTime() + 21 * DAY).toISOString(),
      model: expect.objectContaining({ id: "gamma" }),
    });
  });

  it("resurrects a model when it returns to the live list", () => {
    // Given: gamma deprecated at T0.
    const first = run(["alpha", "beta"], EMPTY_PREV, T0);
    // When: gamma comes back live at T0 + 3 days.
    const result = run(["alpha", "beta", "gamma"], first, new Date(T0.getTime() + 3 * DAY));
    // Then: gamma leaves the deprecated state and is served from fresh metadata.
    expect(result.deprecated).toEqual([]);
    expect(result.catalog.some((m) => m.id === "gamma")).toBe(true);
  });
});

describe("quarantine timestamps", () => {
  function probeResult(now: Date, previous?: ReconcileResult): ReconcileResult {
    const provider = makeProvider({ alpha: makeModel("alpha") });
    return reconcile({
      provider,
      liveIds: ["alpha", "unknown-probe"],
      patches: parsePatchesFile(makePatches()),
      previous:
        previous === undefined
          ? { deprecated: [], quarantine: [], models: [] }
          : {
              deprecated: previous.deprecated,
              quarantine: previous.quarantine,
              models: previous.catalog,
              generatedAt: previous.generatedAt,
            },
      now,
    });
  }

  it("preserves the first detectedAt for an unchanged quarantine record", () => {
    // Given: a first run detecting unknown-probe at T0.
    const first = probeResult(T0);
    // When: reruns later with identical inputs.
    const second = probeResult(new Date(T0.getTime() + DAY), first);
    // Then: the record keeps its original detectedAt and stays byte-identical.
    expect(first.quarantine).toEqual([
      { id: "unknown-probe", detectedAt: T0.toISOString(), source: "live", reasonCode: "NO_MODELS_DEV_METADATA" },
    ]);
    expect(second.quarantine).toEqual(first.quarantine);
    expect(second.transitioned).toBe(false);
  });

  it("removes a quarantine entry when the id gains valid models.dev metadata", () => {
    // Given: unknown-probe quarantined at T0.
    const first = probeResult(T0);
    // When: models.dev now documents the probe as a valid model.
    const healed = reconcile({
      provider: makeProvider({ alpha: makeModel("alpha"), "unknown-probe": makeModel("unknown-probe") }),
      liveIds: ["alpha", "unknown-probe"],
      patches: parsePatchesFile(makePatches()),
      previous: {
        deprecated: first.deprecated,
        quarantine: first.quarantine,
        models: first.catalog,
        generatedAt: first.generatedAt,
      },
      now: new Date(T0.getTime() + DAY),
    });
    // Then: the quarantine heals and the model is served.
    expect(healed.quarantine).toEqual([]);
    expect(healed.catalog.map((m) => m.id)).toEqual(["alpha", "unknown-probe"]);
  });

  it("updates the reason code but keeps detectedAt when a quarantined id gains broken metadata", () => {
    // Given: unknown-probe quarantined at T0 with NO_MODELS_DEV_METADATA.
    const first = probeResult(T0);
    // When: models.dev gains a record for it that fails derivation (unknown SDK).
    const provider = makeProvider({
      alpha: makeModel("alpha"),
      "unknown-probe": makeModel("unknown-probe", { provider: { npm: "@ai-sdk/future" } }),
    });
    const second = reconcile({
      provider,
      liveIds: ["alpha", "unknown-probe"],
      patches: parsePatchesFile({}),
      previous: {
        deprecated: first.deprecated,
        quarantine: first.quarantine,
        models: first.catalog,
        generatedAt: first.generatedAt,
      },
      now: new Date(T0.getTime() + DAY),
    });
    // Then: the reason code is replaced while the first detection time stands.
    expect(second.quarantine).toEqual([
      { id: "unknown-probe", detectedAt: T0.toISOString(), source: "live", reasonCode: "UNKNOWN_SDK" },
    ]);
  });
});

describe("generatedAt transition rule", () => {
  it("preserves the first detectedAt even when the quarantine source changes", () => {
    // Given: "weird" quarantined at T0 from a models.dev metadata failure.
    const first = reconcile({
      provider: makeProvider({
        weird: makeModel("weird", { limit: { output: 4096 } }),
        alpha: makeModel("alpha"),
      }),
      liveIds: ["alpha"],
      patches: parsePatchesFile(makePatches()),
      previous: { deprecated: [], quarantine: [], models: [] },
      now: T0,
    });
    expect(first.quarantine).toEqual([
      { id: "weird", detectedAt: T0.toISOString(), source: "models.dev", reasonCode: "MISSING_CONTEXT" },
    ]);
    // When: the same id later appears live while its metadata is still broken.
    const second = reconcile({
      provider: makeProvider({ weird: makeModel("weird", { limit: { output: 4096 } }), alpha: makeModel("alpha") }),
      liveIds: ["alpha", "weird"],
      patches: parsePatchesFile(makePatches()),
      previous: {
        deprecated: first.deprecated,
        quarantine: first.quarantine,
        models: first.catalog,
        generatedAt: first.generatedAt,
      },
      now: new Date(T0.getTime() + DAY),
    });
    // Then: source and reason update while the earliest observation stands.
    expect(second.quarantine).toEqual([
      { id: "weird", detectedAt: T0.toISOString(), source: "live", reasonCode: "MISSING_CONTEXT" },
    ]);
  });

  it("keeps the previous generatedAt when no transition occurs", () => {
    // Given: a first run with all models live at T0.
    const first = run(["alpha", "beta", "gamma"], EMPTY_PREV, T0);
    // When: rerun with identical inputs and a later clock.
    const rerun = run(["alpha", "beta", "gamma"], first, new Date(T0.getTime() + 2 * DAY));
    // Then: generatedAt is untouched by the later clock.
    expect(rerun.generatedAt).toBe(first.generatedAt);
  });
});
