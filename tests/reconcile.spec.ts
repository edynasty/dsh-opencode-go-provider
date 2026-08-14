/**
 * Reconciliation integration specs (Plan Task 3).
 *
 * The frozen 25-id live fixture against the frozen 24-model models.dev
 * snapshot: quarantine, protocol coverage, ordering, and byte-determinism of
 * the generated artifacts across identical reruns.
 */
import { describe, expect, it } from "vitest";
import { reconcile } from "../src/reconcile.ts";
import { parsePatchesFile } from "../src/state-file.ts";
import { renderDeprecatedFile, renderModelsManifest, renderQuarantineFile } from "../src/catalog.ts";
import {
  liveFixtureIds,
  makePatches,
  makeProvider,
  makeModel,
  modelsDevFixture,
} from "./helpers/catalog-fixtures.ts";

const T0 = new Date("2026-08-14T00:00:00.000Z");
const PROVENANCE = "test";

function runFixture(now: Date = T0) {
  const provider = modelsDevFixture();
  const patches = parsePatchesFile(makePatches());
  return reconcile({
    provider,
    liveIds: liveFixtureIds(),
    patches,
    previous: { deprecated: [], quarantine: [], models: [] },
    now,
  });
}

describe("frozen fixture reconciliation", () => {
  it("keeps 24 known live models in the catalog and quarantines only the synthetic probe", () => {
    // Given: the frozen 25-id live fixture and 24-model models.dev snapshot.
    // When: reconciliation runs.
    const result = runFixture();
    // Then: every models.dev id is served and the unknown probe is absent from
    // the public catalog, present only in the sanitized quarantine.
    expect(result.catalog).toHaveLength(24);
    expect(result.catalog.some((m) => m.id === "synthetic-unknown-live-probe")).toBe(false);
    expect(result.quarantine).toEqual([
      {
        id: "synthetic-unknown-live-probe",
        detectedAt: T0.toISOString(),
        source: "live",
        reasonCode: "NO_MODELS_DEV_METADATA",
      },
    ]);
    expect(result.deprecated).toEqual([]);
  });

  it("covers all three protocol classes", () => {
    // Given: the reconciled catalog.
    const result = runFixture();
    const protocols = new Set(result.catalog.map((m) => m.protocol));
    // Then: openai-responses, openai-completions and anthropic-messages all exist.
    expect(protocols).toEqual(new Set(["openai-responses", "openai-completions", "anthropic-messages"]));
  });

  it("keeps models.dev-deprecated models selectable while they are live", () => {
    // Given: glm-5 is marked deprecated in models.dev but still live.
    const result = runFixture();
    const glm5 = result.catalog.find((m) => m.id === "glm-5");
    // Then: the live-absence grace transition, not models.dev status, governs
    // availability, so glm-5 remains in the catalog.
    expect(glm5?.protocol).toBe("openai-completions");
    expect(glm5?.contextWindow).toBe(202_752);
  });

  it("sorts catalog, quarantine and deprecated deterministically by id", () => {
    // Given: the reconciled result.
    const result = runFixture();
    const ids = result.catalog.map((m) => m.id);
    const sorted = [...ids].sort();
    // Then: catalog ids are lexicographically ordered.
    expect(ids).toEqual(sorted);
    expect(result.quarantine.map((q) => q.id)).toEqual(
      [...result.quarantine.map((q) => q.id)].sort(),
    );
    expect(result.deprecated.map((d) => d.id)).toEqual(
      [...result.deprecated.map((d) => d.id)].sort(),
    );
  });

  it("uses models.dev metadata for capacities and never lets live data override it", () => {
    // Given: the live fixture carries no capacity data at all.
    const result = runFixture();
    const flash = result.catalog.find((m) => m.id === "deepseek-v4-flash");
    // Then: capacities come from the models.dev record only.
    expect(flash?.contextWindow).toBe(1_000_000);
    expect(flash?.maxTokens).toBe(384_000);
    expect(flash?.cost).toEqual({ input: 0.07, output: 0.14, cacheRead: 0.0014 });
  });
});

describe("deterministic regeneration", () => {
  function render(result: ReturnType<typeof reconcile>): string {
    return [
      renderModelsManifest({ generatedAt: result.generatedAt, provenance: PROVENANCE, availability: { kind: "unverified" }, models: result.catalog }),
      renderQuarantineFile(result.quarantine),
      renderDeprecatedFile(result.deprecated),
    ].join("\u0000");
  }

  it("produces byte-identical artifacts when inputs and state are unchanged", () => {
    // Given: a first reconciliation at T0.
    const first = runFixture(T0);
    // When: reconciliation reruns with the same inputs, the first result as
    // state, and the wall clock advanced without any state transition.
    const second = reconcile({
      provider: modelsDevFixture(),
      liveIds: liveFixtureIds(),
      patches: parsePatchesFile(makePatches()),
      previous: {
        deprecated: first.deprecated,
        quarantine: first.quarantine,
        models: first.catalog,
        generatedAt: first.generatedAt,
      },
      now: new Date(T0.getTime() + 3 * 86_400_000),
    });
    // Then: every artifact is byte-identical and generatedAt is preserved.
    expect(render(second)).toBe(render(first));
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.transitioned).toBe(false);
  });

  it("reports a transition and stamps a fresh generatedAt when quarantine changes", () => {
    // Given: a first run whose quarantine is empty because no probe is live.
    const provider = modelsDevFixture();
    const patches = parsePatchesFile(makePatches());
    const first = reconcile({
      provider,
      liveIds: liveFixtureIds().filter((id) => id !== "synthetic-unknown-live-probe"),
      patches,
      previous: { deprecated: [], quarantine: [], models: [] },
      now: T0,
    });
    // When: the synthetic probe becomes live on the next run.
    const second = reconcile({
      provider,
      liveIds: liveFixtureIds(),
      patches,
      previous: {
        deprecated: first.deprecated,
        quarantine: first.quarantine,
        models: first.catalog,
        generatedAt: first.generatedAt,
      },
      now: new Date(T0.getTime() + 86_400_000),
    });
    // Then: a new quarantine entry appears and generatedAt moves to the clock.
    expect(second.quarantine).toHaveLength(1);
    expect(second.transitioned).toBe(true);
    expect(second.generatedAt).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("failure path: metadata absence", () => {
  it("quarantines a live id whose models.dev record lacks context instead of inventing a default", () => {
    // Given: a live model whose models.dev record omits limit.context.
    const provider = makeProvider({
      broken: makeModel("broken", { limit: { output: 4096 } }),
      healthy: makeModel("healthy"),
    });
    const patches = parsePatchesFile(makePatches());
    // When: reconciliation runs with both ids live.
    const result = reconcile({
      provider,
      liveIds: ["broken", "healthy"],
      patches,
      previous: { deprecated: [], quarantine: [], models: [] },
      now: T0,
    });
    // Then: broken is quarantined with MISSING_CONTEXT, healthy is served, and
    // no entry carries an invented context window.
    expect(result.catalog.map((m) => m.id)).toEqual(["healthy"]);
    expect(result.quarantine).toEqual([
      { id: "broken", detectedAt: T0.toISOString(), source: "live", reasonCode: "MISSING_CONTEXT" },
    ]);
  });

  it("quarantines a live id with an unknown SDK package instead of guessing a protocol", () => {
    // Given: a live model whose SDK package is unknown.
    const provider = makeProvider({
      future: makeModel("future", { provider: { npm: "@ai-sdk/future" } }),
    });
    const patches = parsePatchesFile({});
    // When: reconciliation runs with the id live.
    const result = reconcile({
      provider,
      liveIds: ["future"],
      patches,
      previous: { deprecated: [], quarantine: [], models: [] },
      now: T0,
    });
    // Then: the model is quarantined and the catalog has no protocol guess.
    expect(result.catalog).toEqual([]);
    expect(result.quarantine).toEqual([
      { id: "future", detectedAt: T0.toISOString(), source: "live", reasonCode: "UNKNOWN_SDK" },
    ]);
  });
});
