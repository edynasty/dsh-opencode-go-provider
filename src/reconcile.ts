/**
 * Reconciliation state machine.
 *
 * models.dev supplies every protocol/capacity/cost fact; live /v1/models
 * supplies availability only. Known-but-missing models enter a 14-day grace
 * period whose first `deprecatedAt` is preserved across reruns; models past
 * the boundary are evicted; models returning to live are resurrected; unknown
 * live ids are quarantined with a machine-readable reason. The clock is
 * injected, never wall-read, and `generatedAt` moves only on real transitions.
 */
import { compareIds, deriveCatalogModel, renderDeprecatedFile, renderModelsPayload } from "./catalog.ts";
import { FOURTEEN_DAYS_MS } from "./constants.ts";
import type { CatalogModel, DeprecatedEntry, QuarantineRecord, ReconcileInput, ReconcileResult, ReconcileStats } from "./types.ts";

function sortByQuarantineId(records: readonly QuarantineRecord[]): readonly QuarantineRecord[] {
  return [...records].sort((a, b) => compareIds(a.id, b.id));
}

function quarantineChanged(candidate: readonly QuarantineRecord[], previous: readonly QuarantineRecord[]): boolean {
  if (candidate.length !== previous.length) return true;
  for (let index = 0; index < candidate.length; index += 1) {
    const left = candidate[index];
    const right = previous[index];
    if (left === undefined || right === undefined || left.id !== right.id ||
        left.source !== right.source || left.reasonCode !== right.reasonCode || left.detectedAt !== right.detectedAt) {
      return true;
    }
  }
  return false;
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { provider, liveIds, patches, previous, now } = input;
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const liveSet = new Set(liveIds);

  const catalog: CatalogModel[] = [];
  const requiredQuarantine = new Map<string, QuarantineRecord>();
  const quarantinePrevious = new Map(previous.quarantine.map((record) => [record.id, record]));

  const recordQuarantine = (id: string, source: "live" | "models.dev", reasonCode: QuarantineRecord["reasonCode"]): void => {
    const existing = quarantinePrevious.get(id);
    if (existing !== undefined) {
      requiredQuarantine.set(id, { id, detectedAt: existing.detectedAt, source, reasonCode });
      return;
    }
    requiredQuarantine.set(id, { id, detectedAt: nowIso, source, reasonCode });
  };

  for (const id of [...liveSet].sort()) {
    const metadata = provider.models.get(id);
    if (metadata === undefined) {
      const invalid = provider.invalid.get(id);
      recordQuarantine(id, "live", invalid ?? "NO_MODELS_DEV_METADATA");
      continue;
    }
    const derived = deriveCatalogModel(metadata, provider, patches);
    if (derived.kind !== "derived") {
      recordQuarantine(id, "live", derived.reasonCode);
      continue;
    }
    catalog.push(derived.model);
  }

  for (const [id, reasonCode] of provider.invalid) {
    if (!liveSet.has(id)) {
      recordQuarantine(id, "models.dev", reasonCode);
    }
  }

  const deprecatedMap = new Map(previous.deprecated.map((entry) => [entry.id, entry]));
  const resultDeprecated: DeprecatedEntry[] = [];
  let evicted = 0;
  let resurrected = 0;
  for (const [id, entry] of deprecatedMap) {
    if (liveSet.has(id)) {
      resurrected += 1;
      continue;
    }
    if (entry.evictedAt !== undefined) {
      resultDeprecated.push(entry);
      continue;
    }
    const deprecatedAtMs = Date.parse(entry.deprecatedAt);
    if (nowMs - deprecatedAtMs > FOURTEEN_DAYS_MS) {
      evicted += 1;
      resultDeprecated.push({ ...entry, evictedAt: nowIso });
      continue;
    }
    resultDeprecated.push(entry);
  }
  for (const [id, metadata] of provider.models) {
    if (liveSet.has(id) || deprecatedMap.has(id)) continue;
    const derived = deriveCatalogModel(metadata, provider, patches);
    if (derived.kind !== "derived") {
      recordQuarantine(id, "models.dev", derived.reasonCode);
      continue;
    }
    resultDeprecated.push({ id, deprecatedAt: nowIso, model: derived.model });
  }
  for (const entry of resultDeprecated) {
    if (entry.evictedAt === undefined) {
      catalog.push(entry.model);
    }
  }

  const sortedCatalog = [...catalog].sort((a, b) => compareIds(a.id, b.id));
  const sortedQuarantine = sortByQuarantineId([...requiredQuarantine.values()]);
  const sortedDeprecated = [...resultDeprecated].sort((a, b) => compareIds(a.id, b.id));

  const modelsChanged = renderModelsPayload(previous.models) !== renderModelsPayload(sortedCatalog);
  const quarantineChangedFlag = quarantineChanged(sortedQuarantine, sortByQuarantineId(previous.quarantine));
  const deprecatedChanged = renderDeprecatedFile(previous.deprecated) !== renderDeprecatedFile(sortedDeprecated);
  const transitioned = modelsChanged || quarantineChangedFlag || deprecatedChanged;

  const stats: ReconcileStats = {
    known: provider.models.size,
    live: liveSet.size,
    quarantined: sortedQuarantine.length,
    deprecated: sortedDeprecated.filter((entry) => entry.evictedAt === undefined).length,
    evicted,
    resurrected,
  };

  return {
    catalog: sortedCatalog,
    quarantine: sortedQuarantine,
    deprecated: sortedDeprecated,
    generatedAt: transitioned || previous.generatedAt === undefined ? nowIso : previous.generatedAt,
    transitioned,
    stats,
  };
}
