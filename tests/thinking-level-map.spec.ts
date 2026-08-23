/**
 * thinkingLevelMap projection: the catalog declares effort values (including
 * 'max' on deepseek-v4-flash*) but pi-ai's getSupportedThinkingLevels only
 * advertises the top tiers ('max'/'xhigh') when the projected Model maps them
 * explicitly. These tests pin the toPiModel mapping so the UI keeps offering
 * every effort tier the catalog declares.
 */
import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { catalogModelFor } from "./helpers/adapter-fixtures.ts";
import { toPiModel } from "../src/provider.ts";
import type { CatalogModel } from "../src/types.ts";

function makeCatalogModel(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    id: "test-model",
    name: "Test Model",
    protocol: "openai-completions",
    provider: "opencode-go" as CatalogModel["provider"],
    baseUrl: "https://opencode.ai/zen/go/v1",
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    ...overrides,
  };
}

describe("toPiModel thinkingLevelMap projection", () => {
  it("maps deepseek-v4-flash effort values so 'max' is offered by pi-ai", () => {
    // Given: the real shipped deepseek-v4-flash catalog entry declares
    // effort values ['low','high','max'].
    const entry = catalogModelFor("openai-completions", "https://mock.local", "deepseek-v4-flash");
    // When: projected into the pi-ai model vocabulary.
    const pi = toPiModel(entry);
    // Then: the top tier is advertised (it was silently dropped before the
    // thinkingLevelMap projection existed).
    expect(pi.thinkingLevelMap?.max).toBe("max");
    expect(getSupportedThinkingLevels(pi)).toContain("max");
  });

  it("preserves effort levels as verbatim values (openai-compat reasoning_effort)", () => {
    const entry = catalogModelFor("openai-completions", "https://mock.local", "deepseek-v4-flash");
    const pi = toPiModel(entry);
    expect(pi.thinkingLevelMap).toEqual({
      low: "low",
      high: "high",
      max: "max",
    });
  });

  it("ignores non-effort options (toggle / budgetTokens)", () => {
    // Given: qwen3.7-plus declares toggle + budgetTokens, no effort values.
    const entry = catalogModelFor("openai-completions", "https://mock.local", "qwen3.7-plus");
    const pi = toPiModel(entry);
    // Then: no thinkingLevelMap is invented — pi-ai uses provider defaults.
    expect(pi.thinkingLevelMap).toBeUndefined();
  });

  it("omits thinkingLevelMap for a model with no effort option at all", () => {
    const pi = toPiModel(makeCatalogModel({ reasoning: true }));
    expect(pi.thinkingLevelMap).toBeUndefined();
    // And a non-reasoning model stays untouched too.
    const plain = toPiModel(makeCatalogModel({ reasoning: false }));
    expect(plain.thinkingLevelMap).toBeUndefined();
  });

  it("skips null effort values instead of mapping them to invalid keys", () => {
    const pi = toPiModel(
      makeCatalogModel({
        reasoningOptions: [{ kind: "effort", values: ["low", null, "max"] }],
        reasoning: true,
      }),
    );
    expect(pi.thinkingLevelMap).toEqual({ low: "low", max: "max" });
  });
});
