/**
 * models.dev boundary parser specs (Task 3 remediation).
 *
 * Full-api-map extraction, provider-id and map-key enforcement, live-id
 * normalization/deduplication, and the entry-level id rejection that the
 * original false-positive test never exercised.
 */
import { describe, expect, it } from "vitest";
import {
  LiveModelsParseError,
  ModelsDevParseError,
  parseLiveIds,
  parseModelsDevApiJson,
  parseModelsDevProvider,
} from "../src/models-dev.ts";
import { makeModel, modelsDevFixture, readFixture } from "./helpers/catalog-fixtures.ts";

const opencodeGoRecord = {
  id: "opencode-go",
  name: "OpenCode Go",
  npm: "@ai-sdk/openai-compatible",
  api: "https://opencode.ai/zen/go/v1",
  models: {},
};

describe("full api.json provider map parsing", () => {
  it("selects only the opencode-go provider from the real provider map shape", () => {
    // Given: the real top-level shape — a map of many provider records.
    const map = {
      deepseek: { id: "deepseek", name: "DeepSeek", npm: "@ai-sdk/openai-compatible", api: "https://api.deepseek.com", models: {} },
      "opencode-go": {
        ...opencodeGoRecord,
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            limit: { context: 1_000_000, output: 384_000 },
          },
        },
      },
    };
    // When: the full-map parser consumes it.
    const provider = parseModelsDevApiJson(map);
    // Then: only the opencode-go record is selected and parsed.
    expect(provider.id).toBe("opencode-go");
    expect(provider.models.size).toBe(1);
    expect(provider.models.get("deepseek-v4-flash")?.contextWindow).toBe(1_000_000);
  });

  it("rejects a map without the opencode-go key", () => {
    // Given: a provider map that has no opencode-go entry.
    // When: the full-map parser consumes it.
    // Then: a typed error names the missing provider.
    expect(() => parseModelsDevApiJson({ deepseek: { ...opencodeGoRecord, id: "deepseek" } })).toThrow(
      ModelsDevParseError,
    );
  });

  it("rejects a map whose opencode-go record id does not match the key", () => {
    // Given: an opencode-go key whose record declares a foreign id.
    // When: the full-map parser consumes it.
    // Then: it fails closed instead of relabeling the foreign provider.
    expect(() => parseModelsDevApiJson({ "opencode-go": { ...opencodeGoRecord, id: "deepseek" } })).toThrow(
      ModelsDevParseError,
    );
  });

  it("rejects a non-map payload", () => {
    // Given: a payload that is not a provider map.
    expect(() => parseModelsDevApiJson([1, 2])).toThrow(ModelsDevParseError);
  });
});

describe("provider identity and map-key enforcement", () => {
  it("rejects a provider record whose id is not exactly opencode-go", () => {
    // Given: a foreign provider record (e.g. the real deepseek record).
    // When: the record parser consumes it.
    // Then: it fails closed instead of labeling foreign models as opencode-go.
    expect(() => parseModelsDevProvider({ id: "deepseek", name: "DeepSeek", models: {} })).toThrow(
      ModelsDevParseError,
    );
  });

  it("rejects a models map whose key differs from the record id", () => {
    // Given: a models map keyed "alpha" holding a record declaring id "beta".
    // When: the record parser consumes it.
    // Then: the mismatch is rejected rather than silently relabeled.
    expect(() =>
      parseModelsDevProvider({
        id: "opencode-go",
        name: "OpenCode Go",
        models: {
          alpha: { id: "beta", name: "Beta", reasoning: true, limit: { context: 1000, output: 100 } },
        },
      }),
    ).toThrow(ModelsDevParseError);
  });

  it("accepts the frozen 24-model fixture unchanged", () => {
    // Given: the frozen models.dev snapshot.
    const provider = modelsDevFixture();
    // Then: all 24 records parse with matching keys and ids.
    expect(provider.models.size).toBe(24);
    expect(provider.invalid.size).toBe(0);
  });
});

describe("live id normalization", () => {
  it("rejects live entries whose id is not a string (parsed object, not JSON text)", () => {
    // Given: a parsed live payload whose entry lacks a string id.
    // When: parseLiveIds consumes the actual object.
    // Then: the entry-level check rejects it (this is the check the old
    // string-passing test never reached).
    expect(() => parseLiveIds({ data: [{ object: "model" }] })).toThrow(LiveModelsParseError);
    expect(() => parseLiveIds({ data: [{ id: 42 }] })).toThrow(LiveModelsParseError);
  });

  it("rejects empty and whitespace-only ids", () => {
    // Given: live entries with empty or whitespace-only ids.
    // When: parseLiveIds consumes them.
    // Then: they are rejected as unnormalized.
    expect(() => parseLiveIds({ data: [{ id: "" }] })).toThrow(LiveModelsParseError);
    expect(() => parseLiveIds({ data: [{ id: "   " }] })).toThrow(LiveModelsParseError);
  });

  it("rejects ids containing control characters or internal whitespace", () => {
    // Given: ids with control characters or internal whitespace.
    expect(() => parseLiveIds({ data: [{ id: "a\u0000b" }] })).toThrow(LiveModelsParseError);
    expect(() => parseLiveIds({ data: [{ id: "a b" }] })).toThrow(LiveModelsParseError);
  });

  it("trims surrounding whitespace only when the result is a safe id", () => {
    // Given: an id padded with surrounding whitespace.
    const ids = parseLiveIds({ data: [{ id: "  deepseek-v4-flash  " }] });
    // Then: the safe trimmed form is used.
    expect(ids).toEqual(["deepseek-v4-flash"]);
  });

  it("deduplicates valid duplicate ids deterministically", () => {
    // Given: a live payload listing the same id twice.
    const ids = parseLiveIds({ data: [{ id: "alpha" }, { id: "beta" }, { id: "alpha" }] });
    // Then: duplicates collapse, preserving first-occurrence order.
    expect(ids).toEqual(["alpha", "beta"]);
  });

  it("still parses the frozen 25-id fixture", () => {
    // Given: the frozen live fixture with 25 entries.
    // When: parseLiveIds consumes the parsed fixture payload.
    const parsed: unknown = JSON.parse(readFixture("live-models.json"));
    const ids = parseLiveIds(parsed);
    // Then: normalization does not reject the real fixture ids (24 known + probe).
    expect(ids).toHaveLength(25);
    expect(ids).toContain("synthetic-unknown-live-probe");
  });
});

describe("map-key enforcement for invalid records", () => {
  it("rejects a key/id mismatch even when the record is otherwise invalid", () => {
    // Given: a map key "alpha" holding an invalid record (no context) that
    // declares a different id "beta".
    // When: the record parser consumes it.
    // Then: the key/id mismatch fails the whole provider instead of being
    // silently routed to the invalid map.
    expect(() =>
      parseModelsDevProvider({
        id: "opencode-go",
        name: "OpenCode Go",
        models: {
          alpha: { id: "beta", name: "Beta", reasoning: true, limit: { output: 100 } },
        },
      }),
    ).toThrow(ModelsDevParseError);
  });

  it("still quarantines invalid records whose key matches their id", () => {
    // Given: a map key "alpha" holding an invalid record that declares id "alpha".
    const provider = parseModelsDevProvider({
      id: "opencode-go",
      name: "OpenCode Go",
      models: {
        alpha: { id: "alpha", name: "Alpha", reasoning: true, limit: { output: 100 } },
      },
    });
    // Then: the invalid record is tracked with its reason code.
    expect(provider.invalid.get("alpha")).toBe("MISSING_CONTEXT");
  });
});

describe("models.dev map-key identity validation", () => {
  it("rejects an unsafe models map key at the provider boundary", () => {
    // Given: a map key "bad id" (whitespace) that is not a safe canonical id.
    // When: the provider parser consumes it.
    // Then: the provider fails closed — the unsafe key can never enter
    // provider.invalid, quarantine output or persisted state.
    expect(() =>
      parseModelsDevProvider({
        id: "opencode-go",
        name: "OpenCode Go",
        models: {
          "bad id": { id: "bad id", name: "X", reasoning: true, limit: { context: 1000, output: 100 } },
        },
      }),
    ).toThrow(ModelsDevParseError);
  });

  it("rejects unsafe map keys even when the record is otherwise invalid", () => {
    // Given: an unsafe key whose record is also invalid (no context).
    // Then: the unsafe key still fails the whole provider.
    expect(() =>
      parseModelsDevProvider({
        id: "opencode-go",
        name: "OpenCode Go",
        models: {
          "bad\u0000key": { id: "bad\u0000key", name: "X", reasoning: true, limit: { output: 100 } },
        },
      }),
    ).toThrow(ModelsDevParseError);
  });

  it("quarantines a safe-key record with a missing id without leaking an unsafe key", () => {
    // Given: a safe map key "alpha" whose record declares no id at all.
    const provider = parseModelsDevProvider({
      id: "opencode-go",
      name: "OpenCode Go",
      models: {
        alpha: { name: "NoId", reasoning: true, limit: { context: 1000, output: 100 } },
      },
    });
    // Then: the record is invalid under the safe key, never relabeled.
    expect(provider.invalid.get("alpha")).toBe("INVALID_MODEL_RECORD");
    expect(provider.models.get("alpha")).toBeUndefined();
  });

  it("quarantines a safe-key record with a non-string id", () => {
    // Given: a safe map key "alpha" whose record declares a numeric id.
    const provider = parseModelsDevProvider({
      id: "opencode-go",
      name: "OpenCode Go",
      models: {
        alpha: { id: 42, name: "Numeric", reasoning: true, limit: { context: 1000, output: 100 } },
      },
    });
    // Then: the record is invalid under the safe key.
    expect(provider.invalid.get("alpha")).toBe("INVALID_MODEL_RECORD");
  });
});

describe("models.dev numeric and id validation", () => {

  it("rejects non-positive-integer capacities and negative prices", () => {
    // Given: records with impossible numbers.
    const zeroContext = makeModel("zero", { limit: { context: 0, output: 100 } });
    const negativeCost = makeModel("neg", { cost: { input: -1, output: 2 } });
    const provider = parseModelsDevProvider({
      id: "opencode-go",
      name: "OpenCode Go",
      models: { zero: zeroContext, neg: negativeCost },
    });
    // Then: each is invalid rather than preserved.
    expect(provider.invalid.get("zero")).toBe("INVALID_MODEL_RECORD");
    expect(provider.invalid.get("neg")).toBe("INVALID_MODEL_RECORD");
  });

  it("rejects unknown tier types and non-positive thresholds", () => {
    // Given: records with broken tiers.
    const badType = makeModel("badtype", {
      cost: { input: 1, output: 2, tiers: [{ input: 1, output: 2, tier: { type: "characters", size: 1000 } }] },
    });
    const badSize = makeModel("badsize", {
      cost: { input: 1, output: 2, tiers: [{ input: 1, output: 2, tier: { type: "context", size: 0 } }] },
    });
    const provider = parseModelsDevProvider({
      id: "opencode-go",
      name: "OpenCode Go",
      models: { badtype: badType, badsize: badSize },
    });
    // Then: both are invalid.
    expect(provider.invalid.get("badtype")).toBe("INVALID_MODEL_RECORD");
    expect(provider.invalid.get("badsize")).toBe("INVALID_MODEL_RECORD");
  });

  it("rejects inverted reasoning budgets and duplicate effort values", () => {
    // Given: records with impossible reasoning metadata.
    const inverted = makeModel("inv", {
      reasoning_options: [{ type: "budget_tokens", min: 10, max: 5 }],
    });
    const duplicate = makeModel("dup", {
      reasoning_options: [{ type: "effort", values: ["high", "high"] }],
    });
    const provider = parseModelsDevProvider({
      id: "opencode-go",
      name: "OpenCode Go",
      models: { inv: inverted, dup: duplicate },
    });
    // Then: both are invalid.
    expect(provider.invalid.get("inv")).toBe("INVALID_MODEL_RECORD");
    expect(provider.invalid.get("dup")).toBe("INVALID_MODEL_RECORD");
  });
});
