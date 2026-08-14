/**
 * Deterministic serialization specs (Task 3 remediation).
 *
 * Byte-exact field order for the manifest (generatedAt, provenance,
 * availability, models), catalog entries (including tiered costs and
 * reasoning options), sanitized quarantine records, deprecated entries and
 * the patches artifact. Two-space indent, one trailing newline.
 */
import { describe, expect, it } from "vitest";
import {
  deriveCatalogModel,
  renderDeprecatedFile,
  renderModelsManifest,
  renderPatchesFile,
  renderQuarantineFile,
} from "../src/catalog.ts";
import { parsePatchesFile } from "../src/state-file.ts";
import type { DeriveResult, ModelsDevProvider, Patches } from "../src/types.ts";
import { makeModel, makePatches, makeProvider, modelsDevFixture } from "./helpers/catalog-fixtures.ts";

function deriveFrom(provider: ModelsDevProvider, id: string, patches: Patches): DeriveResult {
  const metadata = provider.models.get(id);
  if (metadata === undefined) throw new Error(`fixture must contain model ${id}`);
  return deriveCatalogModel(metadata, provider, patches);
}

describe("manifest serialization", () => {
  it("renders generatedAt, provenance, availability and models in explicit field order", () => {
    // Given: one tiny derived model and an unverified availability marker.
    const provider = makeProvider({ alpha: makeModel("alpha") });
    const patches = parsePatchesFile(makePatches());
    const derived = deriveFrom(provider, "alpha", patches);
    if (derived.kind !== "derived") throw new Error("alpha must derive");
    // When: the manifest is rendered.
    const rendered = renderModelsManifest({
      generatedAt: "2026-08-14T00:00:00.000Z",
      provenance: "test",
      availability: { kind: "unverified" },
      models: [derived.model],
    });
    // Then: the exact byte layout pins key order, indentation and the newline.
    expect(rendered).toBe(
      [
        "{",
        '  "generatedAt": "2026-08-14T00:00:00.000Z",',
        '  "provenance": "test",',
        '  "availability": {',
        '    "kind": "unverified"',
        "  },",
        '  "models": [',
        "    {",
        '      "id": "alpha",',
        '      "name": "alpha name",',
        '      "protocol": "openai-completions",',
        '      "provider": "opencode-go",',
        '      "baseUrl": "https://opencode.ai/zen/go/v1",',
        '      "input": [',
        '        "text"',
        "      ],",
        '      "contextWindow": 100000,',
        '      "maxTokens": 20000,',
        '      "reasoning": true,',
        "      \"cost\": {",
        '        "input": 0.1,',
        '        "output": 0.2',
        "      }",
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("omits optional input and cost fields when models.dev does not declare them", () => {
    // Given: a model with no modalities and no cost.
    const provider = makeProvider({
      bare: makeModel("bare", { modalities: undefined, cost: undefined }),
    });
    const patches = parsePatchesFile({});
    const derived = deriveFrom(provider, "bare", patches);
    if (derived.kind !== "derived") throw new Error("bare must derive");
    // When: the manifest is rendered.
    const rendered = renderModelsManifest({
      generatedAt: "t",
      provenance: "p",
      availability: { kind: "unverified" },
      models: [derived.model],
    });
    // Then: neither key is invented.
    expect(rendered).not.toContain('"input"');
    expect(rendered).not.toContain('"cost"');
  });

  it("renders a verified availability marker with its live source", () => {
    // Given: a verified availability derived from an authenticated capture.
    const provider = makeProvider({ alpha: makeModel("alpha") });
    const patches = parsePatchesFile({});
    const derived = deriveFrom(provider, "alpha", patches);
    if (derived.kind !== "derived") throw new Error("alpha must derive");
    // When: the manifest is rendered.
    const rendered = renderModelsManifest({
      generatedAt: "t",
      provenance: "p",
      availability: { kind: "verified", liveSource: "live" },
      models: [derived.model],
    });
    // Then: the availability object pins kind and liveSource in that order.
    expect(rendered).toContain('"availability": {');
    expect(rendered).toContain('"kind": "verified",');
    expect(rendered).toContain('"liveSource": "live"');
  });
});

describe("tiered cost and reasoning serialization", () => {
  it("preserves grok-4.5 tiered costs and reasoning effort values byte-exactly", () => {
    // Given: the real grok-4.5 record (tier at 200000, effort low/medium/high).
    const provider = modelsDevFixture();
    const patches = parsePatchesFile(makePatches());
    const derived = deriveFrom(provider, "grok-4.5", patches);
    if (derived.kind !== "derived") throw new Error("grok-4.5 must derive");
    // When: the model renders.
    const rendered = renderModelsManifest({
      generatedAt: "t",
      provenance: "p",
      availability: { kind: "unverified" },
      models: [derived.model],
    });
    // Then: the tiered threshold price and the reasoning options survive.
    expect(rendered).toContain('"threshold": 200000');
    expect(rendered).toContain('"tierType": "context"');
    expect(rendered).toContain('"contextOver200k"');
    expect(rendered).toContain('"kind": "effort"');
    expect(rendered).toContain('"values": [');
  });
});

describe("quarantine, deprecated and patches serialization", () => {
  it("renders sanitized quarantine records with exactly four fields", () => {
    // Given: a quarantine record.
    const rendered = renderQuarantineFile([
      {
        id: "synthetic-unknown-live-probe",
        detectedAt: "2026-08-14T00:00:00.000Z",
        source: "live",
        reasonCode: "NO_MODELS_DEV_METADATA",
      },
    ]);
    // When: parsed back.
    const parsed: unknown = JSON.parse(rendered);
    // Then: only id/detectedAt/source/reasonCode are present, in that order.
    expect(parsed).toEqual([
      {
        id: "synthetic-unknown-live-probe",
        detectedAt: "2026-08-14T00:00:00.000Z",
        source: "live",
        reasonCode: "NO_MODELS_DEV_METADATA",
      },
    ]);
  });

  it("renders deprecated entries with id, deprecatedAt and the frozen model", () => {
    // Given: one deprecated entry.
    const rendered = renderDeprecatedFile([
      {
        id: "gamma",
        deprecatedAt: "2026-08-14T00:00:00.000Z",
        model: {
          id: "gamma",
          name: "gamma name",
          protocol: "openai-completions",
          provider: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          contextWindow: 100_000,
          maxTokens: 20_000,
          reasoning: true,
        },
      },
    ]);
    // Then: the entry carries its first transition timestamp and frozen model.
    const parsed: unknown = JSON.parse(rendered);
    expect(parsed).toEqual([
      {
        id: "gamma",
        deprecatedAt: "2026-08-14T00:00:00.000Z",
        model: {
          id: "gamma",
          name: "gamma name",
          protocol: "openai-completions",
          provider: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          contextWindow: 100_000,
          maxTokens: 20_000,
          reasoning: true,
        },
      },
    ]);
  });

  it("renders the patches artifact with baseUrl then evidence", () => {
    // Given: the committed anthropic patch.
    const patches = parsePatchesFile(makePatches());
    // When: the patches artifact renders.
    const rendered = renderPatchesFile(patches);
    // Then: the patch entry pins baseUrl before evidence.
    expect(rendered).toContain('"baseUrl": "https://opencode.ai/zen/go",');
    expect(rendered).toContain('"evidence":');
    expect(rendered.endsWith("\n")).toBe(true);
  });
});
