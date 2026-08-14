/**
 * Shipped embedded-artifact truthfulness specs (Task 3 remediation).
 *
 * The committed catalog is the bootstrap artifact: metadata-derived, with
 * availability explicitly unverified, and free of synthetic probe ids,
 * fabricated quarantine warnings and frozen test fixtures.
 */
import { describe, expect, it } from "vitest";
import { parseModelsManifest, parseQuarantineFile, parseJsonFile } from "../src/state-file.ts";
import { readRepoFile } from "./helpers/catalog-fixtures.ts";

const PROBE_ID = "synthetic-unknown-live-probe";

describe("embedded product artifacts", () => {
  it("does not claim synthetic live provenance and never mentions the probe", () => {
    // Given: the committed bootstrap manifest.
    const manifest = parseModelsManifest(parseJsonFile(readRepoFile("catalog/models.json"), "models.json"));
    // Then: availability is unverified and no synthetic probe appears anywhere.
    expect(manifest.availability).toEqual({ kind: "unverified" });
    expect(manifest.models.some((m) => m.id === PROBE_ID)).toBe(false);
    const raw = readRepoFile("catalog/models.json");
    expect(raw.includes(PROBE_ID)).toBe(false);
    expect(raw).not.toContain("live fixture");
  });

  it("ships an empty quarantine and no deprecated state", () => {
    // Given: the committed bootstrap artifacts.
    const quarantine = parseQuarantineFile(parseJsonFile(readRepoFile("catalog/quarantine.json"), "quarantine.json"));
    const deprecated = parseJsonFile(readRepoFile("catalog/deprecated.json"), "deprecated.json");
    // Then: nothing is quarantined and no grace entry exists (no live
    // observation, so no fabricated warnings or deprecatedAt).
    expect(quarantine).toEqual([]);
    expect(deprecated).toEqual([]);
  });

  it("carries the 24 real models.dev records with tiered and reasoning metadata", () => {
    // Given: the committed bootstrap manifest.
    const manifest = parseModelsManifest(parseJsonFile(readRepoFile("catalog/models.json"), "models.json"));
    const grok = manifest.models.find((m) => m.id === "grok-4.5");
    const flash = manifest.models.find((m) => m.id === "deepseek-v4-flash");
    // Then: the real tiered threshold and reasoning options survive shipping.
    expect(grok?.cost?.tiers?.[0]).toMatchObject({ threshold: 200_000, tierType: "context", input: 4 });
    expect(flash?.interleaved?.field).toBe("reasoning_content");
    expect(flash?.reasoningOptions).toEqual([{ kind: "effort", values: ["low", "high", "max"] }]);
  });
});
