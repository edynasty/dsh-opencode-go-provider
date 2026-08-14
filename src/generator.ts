/**
 * Pure catalog generation core (no fs, no network, no wall clock).
 *
 * JSON texts in, byte-stable artifact texts out. Bootstrap mode (no live
 * input) derives the embedded catalog from public models.dev metadata only —
 * availability stays unverified and no quarantine/deprecated state is
 * fabricated. Live mode runs the full reconciliation with an explicit live ids
 * payload and marks availability verified. The CLI feeds this core with
 * fixture/network payloads and committed state; tests exercise the exact same
 * entrypoint the script uses.
 */
import { deriveCatalogModel } from "./catalog.ts";
import { parseLiveIds, parseModelsDevProvider } from "./models-dev.ts";
import { reconcile } from "./reconcile.ts";
import {
  renderDeprecatedFile,
  renderModelsManifest,
  renderPatchesFile,
  renderQuarantineFile,
} from "./catalog.ts";
import {
  parseDeprecatedFile,
  parseJsonFile,
  parseModelsManifest,
  parsePatchesFile,
  parseQuarantineFile,
} from "./state-file.ts";
import type { Availability, CatalogModel, LiveSource, QuarantineRecord, ReconcileStats } from "./types.ts";

export interface LiveInput {
  readonly liveJson: string;
  readonly source: LiveSource;
}

export interface GenerateInput {
  readonly modelsDevJson: string;
  readonly patchesJson: string;
  readonly live: LiveInput | undefined;
  readonly previousModelsJson: string | undefined;
  readonly previousQuarantineJson: string | undefined;
  readonly previousDeprecatedJson: string | undefined;
  readonly now: Date;
  readonly provenance: string;
}

export interface GenerateOutput {
  readonly files: Readonly<Record<"models.json" | "quarantine.json" | "deprecated.json" | "patches.json", string>>;
  readonly stats: ReconcileStats;
  readonly transitioned: boolean;
  readonly generatedAt: string;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortByQuarantineId(records: readonly QuarantineRecord[]): readonly QuarantineRecord[] {
  return [...records].sort((a, b) => compareIds(a.id, b.id));
}

/** Bootstrap quarantine: real metadata failures only, first detection kept. */
function bootstrapQuarantine(
  provider: ReturnType<typeof parseModelsDevProvider>,
  patches: ReturnType<typeof parsePatchesFile>,
  previous: ReadonlyMap<string, QuarantineRecord>,
  nowIso: string,
): readonly QuarantineRecord[] {
  const entries: QuarantineRecord[] = [];
  for (const [id, reasonCode] of provider.invalid) {
    entries.push({
      id,
      detectedAt: previous.get(id)?.detectedAt ?? nowIso,
      source: "models.dev",
      reasonCode,
    });
  }
  for (const [id, metadata] of provider.models) {
    const derived = deriveCatalogModel(metadata, provider, patches);
    if (derived.kind === "derived") continue;
    entries.push({
      id,
      detectedAt: previous.get(id)?.detectedAt ?? nowIso,
      source: "models.dev",
      reasonCode: derived.reasonCode,
    });
  }
  return sortByQuarantineId(entries);
}

export function generateCatalogFiles(input: GenerateInput): GenerateOutput {
  const provider = parseModelsDevProvider(parseJsonFile(input.modelsDevJson, "models.dev"));
  const patches = parsePatchesFile(parseJsonFile(input.patchesJson, "patches.json"));
  const previousManifest = input.previousModelsJson === undefined
    ? undefined
    : parseModelsManifest(parseJsonFile(input.previousModelsJson, "models.json"));
  const previousQuarantine = input.previousQuarantineJson === undefined
    ? []
    : parseQuarantineFile(parseJsonFile(input.previousQuarantineJson, "quarantine.json"));
  const previousDeprecated = input.previousDeprecatedJson === undefined
    ? []
    : parseDeprecatedFile(parseJsonFile(input.previousDeprecatedJson, "deprecated.json"));
  const nowIso = input.now.toISOString();

  let catalog: ReturnType<typeof reconcile>["catalog"];
  let quarantine: readonly QuarantineRecord[];
  let deprecated: ReturnType<typeof reconcile>["deprecated"];
  let availability: Availability;
  let stats: ReconcileStats;
  if (input.live === undefined) {
    const models: CatalogModel[] = [];
    for (const metadata of provider.models.values()) {
      const derived = deriveCatalogModel(metadata, provider, patches);
      if (derived.kind === "derived") models.push(derived.model);
    }
    catalog = [...models].sort((a, b) => compareIds(a.id, b.id));
    quarantine = bootstrapQuarantine(provider, patches, new Map(previousQuarantine.map((r) => [r.id, r])), nowIso);
    deprecated = [];
    availability = { kind: "unverified" };
    stats = {
      known: provider.models.size,
      live: 0,
      quarantined: quarantine.length,
      deprecated: 0,
      evicted: 0,
      resurrected: 0,
    };
  } else {
    const liveIds = parseLiveIds(parseJsonFile(input.live.liveJson, "live /models"));
    const result = reconcile({
      provider,
      liveIds,
      patches,
      previous: {
        models: previousManifest?.models ?? [],
        quarantine: previousQuarantine,
        deprecated: previousDeprecated,
        ...(previousManifest === undefined ? {} : { generatedAt: previousManifest.generatedAt }),
      },
      now: input.now,
    });
    catalog = result.catalog;
    quarantine = result.quarantine;
    deprecated = result.deprecated;
    availability = { kind: "verified", liveSource: input.live.source };
    stats = result.stats;
  }

  const previousSignature =
    previousManifest === undefined
      ? undefined
      : [
          renderModelsManifest({ generatedAt: "", provenance: previousManifest.provenance, availability: previousManifest.availability, models: previousManifest.models }),
          renderQuarantineFile(previousQuarantine),
          renderDeprecatedFile(previousDeprecated),
        ].join("\u0000");
  const nextSignature = [
    renderModelsManifest({ generatedAt: "", provenance: input.provenance, availability, models: catalog }),
    renderQuarantineFile(quarantine),
    renderDeprecatedFile(deprecated),
  ].join("\u0000");
  const transitioned = previousSignature === undefined || previousSignature !== nextSignature;
  const generatedAt = transitioned || previousManifest === undefined ? nowIso : previousManifest.generatedAt;

  return {
    files: {
      "models.json": renderModelsManifest({ generatedAt, provenance: input.provenance, availability, models: catalog }),
      "quarantine.json": renderQuarantineFile(quarantine),
      "deprecated.json": renderDeprecatedFile(deprecated),
      "patches.json": renderPatchesFile(patches),
    },
    stats,
    transitioned,
    generatedAt,
  };
}
