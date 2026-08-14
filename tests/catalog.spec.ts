/**
 * Catalog derivation specs (Plan Task 3).
 *
 * SDK-only protocol mapping, the doc-evidenced anthropic base URL, record
 * validation, and preservation of tiered costs and reasoning metadata from
 * real models.dev records. Serialization and live-id normalization live in
 * their own specs.
 */
import { describe, expect, it } from "vitest";
import { ModelsDevParseError, parseModelsDevProvider } from "../src/models-dev.ts";
import { deriveCatalogModel } from "../src/catalog.ts";
import { parsePatchesFile } from "../src/state-file.ts";
import type { DeriveResult, ModelsDevProvider, Patches } from "../src/types.ts";
import {
  liveFixtureIds,
  makeModel,
  makePatches,
  makeProvider,
  modelsDevFixture,
} from "./helpers/catalog-fixtures.ts";

/** Derive a fixture model by id, failing loudly when the fixture drifts. */
function deriveFrom(provider: ModelsDevProvider, id: string, patches: Patches): DeriveResult {
  const metadata = provider.models.get(id);
  if (metadata === undefined) throw new Error(`fixture must contain model ${id}`);
  return deriveCatalogModel(metadata, provider, patches);
}

function deriveWith(patches: Patches): {
  readonly provider: ModelsDevProvider;
  readonly luna: DeriveResult;
  readonly flash: DeriveResult;
  readonly qwen: DeriveResult;
} {
  const provider = modelsDevFixture();
  return {
    provider,
    luna: deriveFrom(provider, "gpt-5.6-luna", patches),
    flash: deriveFrom(provider, "deepseek-v4-flash", patches),
    qwen: deriveFrom(provider, "qwen3.7-plus", patches),
  };
}

describe("models.dev fixture parsing", () => {
  it("parses the frozen 24-model opencode-go provider snapshot", () => {
    // Given: the frozen models.dev provider fixture.
    // When: the boundary parser consumes the parsed JSON.
    const provider = modelsDevFixture();
    // Then: provider identity, SDK default and base API are preserved.
    expect(provider.id).toBe("opencode-go");
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.api).toBe("https://opencode.ai/zen/go/v1");
    expect(provider.models.size).toBe(24);
    expect(provider.invalid.size).toBe(0);
    expect(provider.models.get("deepseek-v4-flash")?.contextWindow).toBe(1_000_000);
  });

  it("rejects a non-record payload with a typed parse error", () => {
    // Given: a malformed models.dev payload that is not an object.
    // When: the boundary parser consumes it.
    // Then: a typed ModelsDevParseError names the failing path.
    expect(() => parseModelsDevProvider("[1,2]")).toThrow(ModelsDevParseError);
  });
});

describe("protocol and baseUrl derivation", () => {
  it("maps each AI SDK package to its protocol class", () => {
    // Given: the frozen provider with all three SDK classes.
    const { luna, flash, qwen } = deriveWith(parsePatchesFile(makePatches()));
    // Then: @ai-sdk/openai -> openai-responses, default -> openai-completions,
    // @ai-sdk/anthropic -> anthropic-messages.
    expect(luna.kind === "derived" && luna.model.protocol).toBe("openai-responses");
    expect(flash.kind === "derived" && flash.model.protocol).toBe("openai-completions");
    expect(qwen.kind === "derived" && qwen.model.protocol).toBe("anthropic-messages");
  });

  it("uses the doc-evidenced anthropic base URL and the provider API otherwise", () => {
    // Given: the frozen provider and the committed anthropic base URL patch.
    const { luna, flash, qwen } = deriveWith(parsePatchesFile(makePatches()));
    // Then: anthropic-messages uses https://opencode.ai/zen/go (no /v1) while
    // openai-completions uses the provider-level API.
    expect(qwen.kind === "derived" && qwen.model.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(flash.kind === "derived" && flash.model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(luna.kind === "derived" && luna.model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
  });

  it("quarantines anthropic models when the explicit base URL patch is absent", () => {
    // Given: an anthropic model with no per-model api and no patch.
    const provider = makeProvider({
      "claude-ish": makeModel("claude-ish", { provider: { npm: "@ai-sdk/anthropic" } }),
    });
    const patches = parsePatchesFile({});
    // When: the model is derived without any explicit base URL.
    const result = deriveFrom(provider, "claude-ish", patches);
    // Then: it fails with ANTHROPIC_BASE_URL_MISSING instead of falling back
    // to the /v1 provider API.
    expect(result).toEqual({ kind: "underviable", reasonCode: "ANTHROPIC_BASE_URL_MISSING" });
  });

  it("quarantines unknown SDK packages instead of guessing a protocol", () => {
    // Given: a model whose npm resolves to an unknown package.
    const provider = makeProvider({
      weird: makeModel("weird", { provider: { npm: "@ai-sdk/future" } }),
    });
    const patches = parsePatchesFile({});
    // When: the model is derived.
    const result = deriveFrom(provider, "weird", patches);
    // Then: derivation fails with UNKNOWN_SDK.
    expect(result).toEqual({ kind: "underviable", reasonCode: "UNKNOWN_SDK" });
  });
});

describe("model record validation", () => {
  it("rejects records without a context window (MISSING_CONTEXT)", () => {
    // Given: a structurally valid record whose limit lacks context.
    const provider = makeProvider({
      nocontext: makeModel("nocontext", { limit: { output: 4096 } }),
    });
    // When: the boundary parser consumes the record.
    // Then: the record is rejected with MISSING_CONTEXT rather than defaulted.
    expect(provider.models.get("nocontext")).toBeUndefined();
    expect(provider.invalid.get("nocontext")).toBe("MISSING_CONTEXT");
  });

  it("rejects records whose limit.output is absent (MISSING_OUTPUT_LIMIT)", () => {
    // Given: a record whose limit lacks output.
    const provider = makeProvider({
      nooutput: makeModel("nooutput", { limit: { context: 4096 } }),
    });
    // Then: the record is tracked as invalid, not exposed.
    expect(provider.models.get("nooutput")).toBeUndefined();
    expect(provider.invalid.get("nooutput")).toBe("MISSING_OUTPUT_LIMIT");
  });
});

describe("tiered cost preservation", () => {
  it("keeps grok-4.5 threshold pricing with its 200k tier", () => {
    // Given: the real grok-4.5 record with a 200000-context tier.
    const provider = modelsDevFixture();
    const result = deriveFrom(provider, "grok-4.5", parsePatchesFile(makePatches()));
    // When: the model is derived.
    if (result.kind !== "derived") throw new Error("grok-4.5 must derive");
    // Then: base price, tier threshold and over-200k price all survive.
    expect(result.model.cost).toEqual({
      input: 2,
      output: 6,
      cacheRead: 0.5,
      tiers: [{ input: 4, output: 12, cacheRead: 1, threshold: 200_000, tierType: "context" }],
      contextOver200k: { input: 4, output: 12, cacheRead: 1 },
    });
  });

  it("keeps gpt-5.6-luna 272k tier and qwen3.7-plus 256k tier", () => {
    // Given: the real tiered records.
    const provider = modelsDevFixture();
    const patches = parsePatchesFile(makePatches());
    const luna = deriveFrom(provider, "gpt-5.6-luna", patches);
    const qwen = deriveFrom(provider, "qwen3.7-plus", patches);
    // Then: both thresholds and their full prices survive.
    expect(luna.kind === "derived" && luna.model.cost?.tiers?.[0]).toEqual({
      input: 0.2,
      output: 0.9,
      cacheRead: 0.02,
      cacheWrite: 0.25,
      threshold: 272_000,
      tierType: "context",
    });
    expect(qwen.kind === "derived" && qwen.model.cost?.tiers?.[0]).toEqual({
      input: 1.2,
      output: 4.8,
      cacheRead: 0.12,
      cacheWrite: 1.5,
      threshold: 256_000,
      tierType: "context",
    });
  });

  it("leaves costs without tiers untouched", () => {
    // Given: deepseek-v4-flash which has no tiered pricing.
    const provider = modelsDevFixture();
    const result = deriveFrom(provider, "deepseek-v4-flash", parsePatchesFile(makePatches()));
    // Then: the plain price survives without invented tier fields.
    expect(result.kind === "derived" && result.model.cost).toEqual({
      input: 0.07,
      output: 0.14,
      cacheRead: 0.0014,
    });
  });
});

describe("reasoning metadata preservation", () => {
  it("keeps deepseek-v4-flash effort values and interleaved reasoning field", () => {
    // Given: the real deepseek-v4-flash reasoning declaration.
    const provider = modelsDevFixture();
    const result = deriveFrom(provider, "deepseek-v4-flash", parsePatchesFile(makePatches()));
    // Then: effort values and the interleaved field survive derivation.
    expect(result.kind === "derived" && result.model.reasoningOptions).toEqual([
      { kind: "effort", values: ["low", "high", "max"] },
    ]);
    expect(result.kind === "derived" && result.model.interleaved).toEqual({
      field: "reasoning_content",
    });
  });

  it("keeps qwen3.7-plus toggle and budget_tokens options in declared order", () => {
    // Given: the real qwen3.7-plus reasoning declaration.
    const provider = modelsDevFixture();
    const result = deriveFrom(provider, "qwen3.7-plus", parsePatchesFile(makePatches()));
    // Then: both option kinds survive with their budget cap.
    expect(result.kind === "derived" && result.model.reasoningOptions).toEqual([
      { kind: "toggle" },
      { kind: "budgetTokens", max: 262_144 },
    ]);
  });

  it("rejects records with an unknown reasoning option kind", () => {
    // Given: a record declaring a made-up reasoning option kind.
    const provider = makeProvider({
      future: makeModel("future", { reasoning_options: [{ type: "telepathy" }] }),
    });
    // Then: the record is invalid rather than guessed or passed through.
    expect(provider.models.get("future")).toBeUndefined();
    expect(provider.invalid.get("future")).toBe("INVALID_MODEL_RECORD");
  });
});

describe("live fixture shape", () => {
  it("exposes 25 ids: 24 models.dev ids plus the labeled synthetic probe", () => {
    // Given: the frozen live fixture.
    const ids = liveFixtureIds();
    // Then: 24 known ids plus one clearly labeled synthetic probe.
    expect(ids).toHaveLength(25);
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).toContain("synthetic-unknown-live-probe");
  });
});
