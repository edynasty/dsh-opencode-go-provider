/**
 * Committed-state boundary specs (Task 3 remediation).
 *
 * Every persisted timestamp must be a canonical finite ISO-8601 instant;
 * malformed generatedAt/deprecatedAt/detectedAt fail the state boundary
 * instead of surviving forever in the grace period. The manifest must carry a
 * typed availability marker.
 */
import { describe, expect, it } from "vitest";
import {
  StateFileParseError,
  parseDeprecatedFile,
  parseModelsManifest,
  parsePatchesFile,
  parseQuarantineFile,
} from "../src/state-file.ts";

const VALID_MODEL = {
  id: "gamma",
  name: "gamma name",
  protocol: "openai-completions",
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  contextWindow: 100_000,
  maxTokens: 20_000,
  reasoning: true,
};

describe("canonical ISO timestamp validation", () => {
  it("accepts canonical finite ISO-8601 instants", () => {
    // Given: a state file using the exact toISOString() form.
    const manifest = {
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models: [VALID_MODEL],
    };
    // When: the boundary parser consumes it.
    const parsed = parseModelsManifest(manifest);
    // Then: it round-trips.
    expect(parsed.generatedAt).toBe("2026-08-14T00:00:00.000Z");
    expect(parsed.models).toHaveLength(1);
  });

  it("rejects a non-date deprecatedAt instead of letting the grace entry live forever", () => {
    // Given: a deprecated state whose deprecatedAt is not a date at all.
    const state = [
      { id: "gamma", deprecatedAt: "not-a-date", model: VALID_MODEL },
    ];
    // When: the boundary parser consumes it.
    // Then: the state boundary fails with a typed error (the old behavior
    // kept gamma selectable forever because Date.parse returned NaN).
    expect(() => parseDeprecatedFile(state)).toThrow(StateFileParseError);
  });

  it("rejects numeric-epoch strings that Date.parse would accept", () => {
    // Given: deprecatedAt "42", which Date.parse silently treats as epoch ms.
    const state = [{ id: "gamma", deprecatedAt: "42", model: VALID_MODEL }];
    // Then: the boundary rejects the non-canonical instant.
    expect(() => parseDeprecatedFile(state)).toThrow(StateFileParseError);
  });

  it("rejects non-canonical ISO strings such as a missing milliseconds field", () => {
    // Given: deprecatedAt without the .000Z milliseconds.
    const state = [{ id: "gamma", deprecatedAt: "2026-08-14T00:00:00Z", model: VALID_MODEL }];
    // Then: the boundary requires the canonical form.
    expect(() => parseDeprecatedFile(state)).toThrow(StateFileParseError);
  });

  it("rejects malformed generatedAt in the manifest", () => {
    // Given: a manifest with a malformed generatedAt.
    const manifest = {
      generatedAt: "yesterday",
      provenance: "p",
      availability: { kind: "unverified" },
      models: [],
    };
    // Then: the boundary fails.
    expect(() => parseModelsManifest(manifest)).toThrow(StateFileParseError);
  });

  it("rejects malformed detectedAt in quarantine records", () => {
    // Given: a quarantine record with a malformed detectedAt.
    const records = [
      { id: "x", detectedAt: "later", source: "live", reasonCode: "NO_MODELS_DEV_METADATA" },
    ];
    // Then: the boundary fails.
    expect(() => parseQuarantineFile(records)).toThrow(StateFileParseError);
  });
});

describe("availability marker validation", () => {
  it("accepts unverified and verified manifests", () => {
    // Given: both availability shapes.
    const unverified = { generatedAt: "2026-08-14T00:00:00.000Z", provenance: "p", availability: { kind: "unverified" }, models: [] };
    const verified = { generatedAt: "2026-08-14T00:00:00.000Z", provenance: "p", availability: { kind: "verified", liveSource: "live" }, models: [] };
    // When: the boundary parser consumes them.
    const a = parseModelsManifest(unverified);
    const b = parseModelsManifest(verified);
    // Then: both round-trip with their typed availability.
    expect(a.availability).toEqual({ kind: "unverified" });
    expect(b.availability).toEqual({ kind: "verified", liveSource: "live" });
  });

  it("rejects a manifest without availability or with an unknown kind", () => {
    // Given: manifests missing or corrupting the availability marker.
    const missing = { generatedAt: "2026-08-14T00:00:00.000Z", provenance: "p", models: [] };
    const unknown = { generatedAt: "2026-08-14T00:00:00.000Z", provenance: "p", availability: { kind: "maybe" }, models: [] };
    // Then: the boundary fails closed.
    expect(() => parseModelsManifest(missing)).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(unknown)).toThrow(StateFileParseError);
  });
});

describe("patches boundary", () => {
  it("accepts an empty patch map and rejects unknown protocol keys", () => {
    // Given: empty patches and a patch under an unknown protocol.
    expect(parsePatchesFile({})).toEqual({ baseUrlByProtocol: {} });
    expect(() => parsePatchesFile({ baseUrlByProtocol: { "future-protocol": { baseUrl: "x", evidence: "y" } } })).toThrow(
      StateFileParseError,
    );
  });
});

describe("duplicate and mismatched identity enforcement", () => {
  it("rejects duplicate model ids in a manifest", () => {
    // Given: a manifest listing the same model id twice.
    const manifest = {
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models: [VALID_MODEL, { ...VALID_MODEL, name: "duplicate" }],
    };
    // Then: the boundary rejects the duplicate instead of collapsing it.
    expect(() => parseModelsManifest(manifest)).toThrow(StateFileParseError);
  });

  it("rejects duplicate quarantine ids", () => {
    // Given: a quarantine file with the same id twice.
    const records = [
      { id: "x", detectedAt: "2026-08-14T00:00:00.000Z", source: "live", reasonCode: "NO_MODELS_DEV_METADATA" },
      { id: "x", detectedAt: "2026-08-14T00:00:00.001Z", source: "live", reasonCode: "NO_MODELS_DEV_METADATA" },
    ];
    // Then: the boundary rejects the duplicate.
    expect(() => parseQuarantineFile(records)).toThrow(StateFileParseError);
  });

  it("rejects duplicate deprecated ids", () => {
    // Given: a deprecated file with the same id twice.
    const state = [
      { id: "gamma", deprecatedAt: "2026-08-14T00:00:00.000Z", model: VALID_MODEL },
      { id: "gamma", deprecatedAt: "2026-08-14T00:00:00.001Z", model: VALID_MODEL },
    ];
    // Then: the boundary rejects the duplicate.
    expect(() => parseDeprecatedFile(state)).toThrow(StateFileParseError);
  });

  it("rejects deprecated entries whose id differs from the frozen model id", () => {
    // Given: a deprecated entry whose entry id is "gamma" but model id is "beta".
    const state = [{ id: "gamma", deprecatedAt: "2026-08-14T00:00:00.000Z", model: { ...VALID_MODEL, id: "beta" } }];
    // Then: the mismatch is rejected.
    expect(() => parseDeprecatedFile(state)).toThrow(StateFileParseError);
  });

  it("rejects unsafe ids in manifests, quarantine and deprecated state", () => {
    // Given: ids with whitespace, control characters or empty strings.
    const manifest = {
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models: [{ ...VALID_MODEL, id: "bad id" }],
    };
    const quarantine = [{ id: "bad\u0000id", detectedAt: "2026-08-14T00:00:00.000Z", source: "live", reasonCode: "NO_MODELS_DEV_METADATA" }];
    const deprecated = [{ id: " ", deprecatedAt: "2026-08-14T00:00:00.000Z", model: VALID_MODEL }];
    // Then: every boundary rejects the unsafe id.
    expect(() => parseModelsManifest(manifest)).toThrow(StateFileParseError);
    expect(() => parseQuarantineFile(quarantine)).toThrow(StateFileParseError);
    expect(() => parseDeprecatedFile(deprecated)).toThrow(StateFileParseError);
  });
});

describe("numeric and modality state validation", () => {
  it("rejects non-positive-integer capacities and output limits", () => {
    // Given: models with zero, negative or fractional capacities.
    const zero = { ...VALID_MODEL, contextWindow: 0 };
    const negative = { ...VALID_MODEL, maxTokens: -1 };
    const fractional = { ...VALID_MODEL, contextWindow: 1.5 };
    const manifest = (models: unknown[]) => ({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models,
    });
    // Then: each is rejected rather than preserved as impossible data.
    expect(() => parseModelsManifest(manifest([zero]))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest([negative]))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest([fractional]))).toThrow(StateFileParseError);
  });

  it("rejects negative prices and impossible tier thresholds", () => {
    // Given: a model with a negative price and one with a broken tier.
    const negativePrice = {
      ...VALID_MODEL,
      cost: { input: -0.1, output: 0.2 },
    };
    const badThreshold = {
      ...VALID_MODEL,
      cost: { input: 1, output: 2, tiers: [{ input: 1, output: 2, threshold: 0, tierType: "context" }] },
    };
    const badTierType = {
      ...VALID_MODEL,
      cost: { input: 1, output: 2, tiers: [{ input: 1, output: 2, threshold: 1000, tierType: "characters" }] },
    };
    const manifest = (models: unknown[]) => ({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models,
    });
    // Then: each is rejected.
    expect(() => parseModelsManifest(manifest([negativePrice]))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest([badThreshold]))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest([badTierType]))).toThrow(StateFileParseError);
  });

  it("rejects invalid and duplicate modalities", () => {
    // Given: a model with an unknown modality and one with duplicates.
    const unknownModality = { ...VALID_MODEL, input: ["text", "telepathy"] };
    const duplicated = { ...VALID_MODEL, input: ["text", "text"] };
    const manifest = (models: unknown[]) => ({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models,
    });
    // Then: both are rejected.
    expect(() => parseModelsManifest(manifest([unknownModality]))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest([duplicated]))).toThrow(StateFileParseError);
  });

  it("rejects impossible reasoning budgets and unsafe effort values", () => {
    // Given: a budget with min > max and an effort with duplicate/blank values.
    const invertedBudget = {
      ...VALID_MODEL,
      reasoningOptions: [{ kind: "budgetTokens", min: 10, max: 5 }],
    };
    const blankEffort = {
      ...VALID_MODEL,
      reasoningOptions: [{ kind: "effort", values: ["high", "high"] }],
    };
    const manifest = (models: unknown[]) => ({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models,
    });
    // Then: each is rejected.
    expect(() => parseModelsManifest(manifest([invertedBudget]))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest([blankEffort]))).toThrow(StateFileParseError);
  });
});

describe("provenance and eviction tombstone", () => {
  it("requires a nonempty provenance string and returns it", () => {
    // Given: manifests with missing or empty provenance.
    const missing = { generatedAt: "2026-08-14T00:00:00.000Z", availability: { kind: "unverified" }, models: [] };
    const empty = { generatedAt: "2026-08-14T00:00:00.000Z", provenance: "  ", availability: { kind: "unverified" }, models: [] };
    // Then: the boundary rejects both and returns the provenance when valid.
    expect(() => parseModelsManifest(missing)).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(empty)).toThrow(StateFileParseError);
    const parsed = parseModelsManifest({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "metadata snapshot 2026-08-14",
      availability: { kind: "unverified" },
      models: [],
    });
    expect(parsed.provenance).toBe("metadata snapshot 2026-08-14");
  });

  it("accepts an optional canonical evictedAt tombstone", () => {
    // Given: a deprecated entry with a canonical evictedAt.
    const state = [
      {
        id: "gamma",
        deprecatedAt: "2026-08-14T00:00:00.000Z",
        evictedAt: "2026-08-28T00:00:00.001Z",
        model: VALID_MODEL,
      },
    ];
    // When: the boundary parser consumes it.
    const parsed = parseDeprecatedFile(state);
    // Then: the tombstone round-trips.
    expect(parsed[0]?.evictedAt).toBe("2026-08-28T00:00:00.001Z");
  });

  it("rejects a malformed evictedAt tombstone", () => {
    // Given: a deprecated entry with a non-canonical evictedAt.
    const state = [{ id: "gamma", deprecatedAt: "2026-08-14T00:00:00.000Z", evictedAt: "someday", model: VALID_MODEL }];
    // Then: the boundary rejects it.
    expect(() => parseDeprecatedFile(state)).toThrow(StateFileParseError);
  });
});

describe("eviction tombstone chronology", () => {
  const BASE = "2026-08-14T00:00:00.000Z";
  const AFTER_14D_PLUS_1MS = "2026-08-28T00:00:00.001Z";

  it("rejects an evictedAt before deprecatedAt", () => {
    // Given: a tombstone earlier than the grace entry itself.
    const state = [{ id: "gamma", deprecatedAt: BASE, evictedAt: "2026-08-13T00:00:00.000Z", model: VALID_MODEL }];
    // Then: the state boundary fails closed.
    expect(() => parseDeprecatedFile(state)).toThrow(StateFileParseError);
  });

  it("rejects an evictedAt exactly at the 14-day boundary", () => {
    // Given: a tombstone at exactly deprecatedAt + 14 days (reconciliation
    // evicts only strictly after the boundary).
    const state = [{ id: "gamma", deprecatedAt: BASE, evictedAt: "2026-08-28T00:00:00.000Z", model: VALID_MODEL }];
    // Then: the boundary tombstone is rejected.
    expect(() => parseDeprecatedFile(state)).toThrow(StateFileParseError);
  });

  it("accepts only an evictedAt strictly after the 14-day boundary", () => {
    // Given: a tombstone 1ms past the boundary, matching the `> 14 days` rule.
    const state = [{ id: "gamma", deprecatedAt: BASE, evictedAt: AFTER_14D_PLUS_1MS, model: VALID_MODEL }];
    // When: the state boundary parses it.
    const parsed = parseDeprecatedFile(state);
    // Then: the tombstone round-trips.
    expect(parsed[0]?.evictedAt).toBe(AFTER_14D_PLUS_1MS);
  });
});

describe("URL and text boundary validation", () => {
  it("rejects non-OpenCode-Go base URLs in manifest models", () => {
    // Given: models whose baseUrl violates the endpoint boundary.
    const manifest = (baseUrl: string) => ({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models: [{ ...VALID_MODEL, baseUrl }],
    });
    // Then: http, lookalike hosts and unrelated paths are all rejected.
    expect(() => parseModelsManifest(manifest("http://opencode.ai/zen/go"))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest("https://opencode.ai.evil.com/zen/go"))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest("https://opencode.ai/other"))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest("https://user:pass@opencode.ai/zen/go"))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest("https://opencode.ai/zen/go?x=1"))).toThrow(StateFileParseError);
  });

  it("rejects non-OpenCode-Go patches base URLs", () => {
    // Given: a patch whose baseUrl is not the /zen/go family.
    expect(() =>
      parsePatchesFile({ baseUrlByProtocol: { "anthropic-messages": { baseUrl: "http://opencode.ai/zen/go", evidence: "docs" } } }),
    ).toThrow(StateFileParseError);
  });

  it("rejects empty or control-character provenance and names", () => {
    // Given: provenance and model names carrying control characters.
    const manifest = (provenance: string, name?: string) => ({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance,
      availability: { kind: "unverified" },
      models: name === undefined ? [] : [{ ...VALID_MODEL, name }],
    });
    // Then: control-bearing text is rejected at the boundary.
    expect(() => parseModelsManifest(manifest("meta\u0000data"))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest("p", "GPT\u0001"))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest("p", "   "))).toThrow(StateFileParseError);
  });

  it("rejects empty or control-character interleaved fields", () => {
    // Given: a model with an empty or control-bearing interleaved field.
    const manifest = (field: string) => ({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "p",
      availability: { kind: "unverified" },
      models: [{ ...VALID_MODEL, interleaved: { field } }],
    });
    // Then: both are rejected.
    expect(() => parseModelsManifest(manifest(""))).toThrow(StateFileParseError);
    expect(() => parseModelsManifest(manifest("reasoning\u0001"))).toThrow(StateFileParseError);
  });

  it("rejects control-character patch evidence", () => {
    // Given: a patch whose evidence contains a control character.
    expect(() =>
      parsePatchesFile({ baseUrlByProtocol: { "anthropic-messages": { baseUrl: "https://opencode.ai/zen/go", evidence: "doc\u0000s" } } }),
    ).toThrow(StateFileParseError);
  });
});
