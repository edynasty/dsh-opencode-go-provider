/**
 * Catalog derivation and deterministic rendering.
 *
 * `deriveCatalogModel` assembles a public catalog entry from parsed models.dev
 * metadata, resolving protocol and base URL from explicit metadata only (the
 * doc-evidenced patch layer is the sole source for the anthropic base URL).
 * Tiered costs and reasoning metadata pass through untouched. The renderers
 * emit the committed artifact bytes: explicit field order, lexicographic id
 * ordering, two-space indent, one trailing newline.
 */
import { sdkToProtocol } from "./models-dev.ts";
import { PROTOCOLS, PROVIDER_ID } from "./types.ts";
import type {
  Availability,
  CatalogModel,
  CostTier,
  DeriveResult,
  DeprecatedEntry,
  ModelCost,
  ModelsDevModelMetadata,
  ModelsDevProvider,
  Patches,
  QuarantineRecord,
  ReasoningOption,
} from "./types.ts";

/** Code-unit lexicographic comparator; deterministic across environments. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort a copy of the input by model id; never mutates the caller's array. */
export function sortedById<T extends { readonly id: string }>(entries: readonly T[]): readonly T[] {
  return [...entries].sort((a, b) => compareIds(a.id, b.id));
}

/** Resolve the base URL from explicit metadata; the patch layer wins. */
function resolveBaseUrl(
  metadata: ModelsDevModelMetadata,
  provider: ModelsDevProvider,
  patches: Patches,
  protocol: "openai-responses" | "openai-completions" | "anthropic-messages",
): { readonly ok: true; readonly baseUrl: string } | { readonly ok: false; readonly reasonCode: "ANTHROPIC_BASE_URL_MISSING" | "MISSING_BASE_URL" } {
  const patch = patches.baseUrlByProtocol[protocol];
  if (patch !== undefined) return { ok: true, baseUrl: patch.baseUrl };
  if (metadata.api !== undefined) return { ok: true, baseUrl: metadata.api };
  if (protocol === "anthropic-messages") {
    return { ok: false, reasonCode: "ANTHROPIC_BASE_URL_MISSING" };
  }
  if (provider.api !== undefined) return { ok: true, baseUrl: provider.api };
  return { ok: false, reasonCode: "MISSING_BASE_URL" };
}

/**
 * Assemble a public catalog entry from parsed metadata. Protocol and base URL
 * come from explicit SDK/API metadata; nothing is inferred from the id.
 */
export function deriveCatalogModel(
  metadata: ModelsDevModelMetadata,
  provider: ModelsDevProvider,
  patches: Patches,
): DeriveResult {
  const npm = metadata.npm ?? provider.npm;
  const protocol = sdkToProtocol(npm);
  if (protocol === undefined) {
    return { kind: "underviable", reasonCode: "UNKNOWN_SDK" };
  }
  const base = resolveBaseUrl(metadata, provider, patches, protocol);
  if (!base.ok) {
    return { kind: "underviable", reasonCode: base.reasonCode };
  }
  return {
    kind: "derived",
    model: {
      id: metadata.id,
      name: metadata.name,
      protocol,
      provider: PROVIDER_ID,
      baseUrl: base.baseUrl,
      ...(metadata.input === undefined ? {} : { input: metadata.input }),
      contextWindow: metadata.contextWindow,
      maxTokens: metadata.maxTokens,
      reasoning: metadata.reasoning,
      ...(metadata.reasoningOptions === undefined ? {} : { reasoningOptions: metadata.reasoningOptions }),
      ...(metadata.interleaved === undefined ? {} : { interleaved: metadata.interleaved }),
      ...(metadata.cost === undefined ? {} : { cost: metadata.cost }),
    },
  };
}

/** JSON with two-space indent plus one trailing newline. */
function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Ordered JSON value for one price triple (input, output, caches). */
function renderPrice(price: { readonly input: number; readonly output: number; readonly cacheRead?: number; readonly cacheWrite?: number }): Record<string, unknown> {
  const out: Record<string, unknown> = { input: price.input, output: price.output };
  if (price.cacheRead !== undefined) out.cacheRead = price.cacheRead;
  if (price.cacheWrite !== undefined) out.cacheWrite = price.cacheWrite;
  return out;
}

/** Ordered JSON value for one cost tier (threshold and tierType last). */
function renderTier(tier: CostTier): Record<string, unknown> {
  const out = renderPrice(tier);
  out.threshold = tier.threshold;
  out.tierType = tier.tierType;
  return out;
}

/** Ordered JSON value for a full cost block (tiers and over-200k last). */
function renderCost(cost: ModelCost): Record<string, unknown> {
  const out = renderPrice(cost);
  if (cost.tiers !== undefined) {
    out.tiers = cost.tiers.map(renderTier);
  }
  if (cost.contextOver200k !== undefined) {
    out.contextOver200k = renderPrice(cost.contextOver200k);
  }
  return out;
}

/** Ordered JSON value for one reasoning option. */
function renderReasoningOption(option: ReasoningOption): Record<string, unknown> {
  switch (option.kind) {
    case "effort":
      return { kind: "effort", values: [...option.values] };
    case "budgetTokens":
      return {
        kind: "budgetTokens",
        ...(option.min === undefined ? {} : { min: option.min }),
        ...(option.max === undefined ? {} : { max: option.max }),
      };
    case "toggle":
      return { kind: "toggle" };
  }
}

/** Ordered JSON value for one catalog model (pins the public field order). */
function renderCatalogModel(model: CatalogModel): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: model.id,
    name: model.name,
    protocol: model.protocol,
    provider: model.provider,
    baseUrl: model.baseUrl,
  };
  if (model.input !== undefined) {
    out.input = [...model.input];
  }
  out.contextWindow = model.contextWindow;
  out.maxTokens = model.maxTokens;
  out.reasoning = model.reasoning;
  if (model.reasoningOptions !== undefined) {
    out.reasoningOptions = model.reasoningOptions.map(renderReasoningOption);
  }
  if (model.interleaved !== undefined) {
    out.interleaved = { field: model.interleaved.field };
  }
  if (model.cost !== undefined) {
    out.cost = renderCost(model.cost);
  }
  return out;
}

export interface ModelsManifest {
  readonly generatedAt: string;
  readonly provenance: string;
  readonly availability: Availability;
  readonly models: readonly CatalogModel[];
}

/** Ordered JSON payload for a models array (pins field order and sorting). */
export function renderModelsPayload(models: readonly CatalogModel[]): string {
  return renderJson(sortedById(models).map(renderCatalogModel));
}

/** Render the public catalog manifest. */
export function renderModelsManifest(manifest: ModelsManifest): string {
  return renderJson({
    generatedAt: manifest.generatedAt,
    provenance: manifest.provenance,
    availability: manifest.availability,
    models: sortedById(manifest.models).map(renderCatalogModel),
  });
}

/** Render the sanitized quarantine artifact. */
export function renderQuarantineFile(records: readonly QuarantineRecord[]): string {
  const ordered = sortedById(records).map((record) => ({
    id: record.id,
    detectedAt: record.detectedAt,
    source: record.source,
    reasonCode: record.reasonCode,
  }));
  return renderJson(ordered);
}

/** Render the deprecated state artifact (internal; carries frozen models). */
export function renderDeprecatedFile(entries: readonly DeprecatedEntry[]): string {
  const ordered = sortedById(entries).map((entry) => ({
    id: entry.id,
    deprecatedAt: entry.deprecatedAt,
    ...(entry.evictedAt === undefined ? {} : { evictedAt: entry.evictedAt }),
    model: renderCatalogModel(entry.model),
  }));
  return renderJson(ordered);
}

/** Render the patches artifact back to its canonical bytes. */
export function renderPatchesFile(patches: Patches): string {
  const baseUrlByProtocol: Record<string, unknown> = {};
  for (const protocol of PROTOCOLS) {
    const patch = patches.baseUrlByProtocol[protocol];
    if (patch === undefined) continue;
    baseUrlByProtocol[protocol] = { baseUrl: patch.baseUrl, evidence: patch.evidence };
  }
  return renderJson({ baseUrlByProtocol });
}
