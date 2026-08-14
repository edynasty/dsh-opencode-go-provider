import { Context } from "@deepseek-ai/cordis";
//#region src/contract.d.ts
/**
 * Shared Host/Client contract values for the OpenCode Go provider bundle.
 *
 * Imported by both the Host entry (`src/index.ts`) and the Web client seam
 * (`src/client/index.tsx`); each tsdown build bundles its own copy. Keeping
 * the values in one module prevents the Host and Client programs from
 * drifting apart on the route, row, and credential names.
 */
/** Stable bundle/plugin name; must match package.json and the patch row. */
declare const PLUGIN_NAME: "dsh-opencode-go-provider";
/** DSH credentials environment variable resolved at operation time. */
declare const API_KEY_ENV: "OPENCODE_GO_API_KEY";
/** Bundle row id inserted by cordis.patch.yml. */
declare const BUNDLE_ROW_ID: "llm-opencode-go";
/** Provider route registered on ctx.llm and addressed by the settings card. */
declare const PROVIDER_ROUTE: "opencode-go";
//#endregion
//#region src/constants.d.ts
/** Shared grace-period constant, free of module cycles. */
/** Exact grace boundary: entries are evicted strictly after 14 days. */
declare const FOURTEEN_DAYS_MS: number;
//#endregion
//#region src/types.d.ts
/**
 * Domain types for the OpenCode Go catalog and reconciliation engine.
 *
 * These shapes are the typed contract between the models.dev/live boundary
 * parsers, the deterministic renderers, the reconciliation state machine and
 * the generator script. Everything is readonly; the committed catalog files
 * are rendered from these types in a fixed field order.
 */
/** The three transport classes OpenCode Go exposes (models.dev SDK mapping). */
declare const PROTOCOLS: readonly ["openai-responses", "openai-completions", "anthropic-messages"];
type Protocol = (typeof PROTOCOLS)[number];
/** Stable provider id used in every catalog entry and the DSH route. */
declare const PROVIDER_ID: "opencode-go";
/** Where a quarantine record was first observed. */
declare const QUARANTINE_SOURCES: readonly ["live", "models.dev"];
type QuarantineSource = (typeof QUARANTINE_SOURCES)[number];
/** Machine-readable quarantine reasons; no free-form prose is ever stored. */
declare const QUARANTINE_REASON_CODES: readonly ["NO_MODELS_DEV_METADATA", "INVALID_MODEL_RECORD", "MISSING_CONTEXT", "MISSING_OUTPUT_LIMIT", "UNKNOWN_SDK", "ANTHROPIC_BASE_URL_MISSING", "MISSING_BASE_URL"];
type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];
/** Modality literals accepted by the models.dev schema. */
declare const MODALITY_LITERALS: readonly ["text", "audio", "image", "video", "pdf"];
type ModalityLiteral = (typeof MODALITY_LITERALS)[number];
/** Flat price triple from models.dev; tiers add threshold prices on top. */
interface ModelCostBase {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}
/** One context-threshold price tier (models.dev cost.tiers[].tier). */
interface CostTier extends ModelCostBase {
  readonly threshold: number;
  readonly tierType: "context";
}
/** Pricing metadata; only ever sourced from models.dev, tiers preserved. */
interface ModelCost extends ModelCostBase {
  readonly tiers?: readonly CostTier[];
  readonly contextOver200k?: ModelCostBase;
}
/** Normalized reasoning option kinds from models.dev reasoning_options. */
type ReasoningOption = {
  readonly kind: "effort";
  readonly values: readonly (string | null)[];
} | {
  readonly kind: "budgetTokens";
  readonly min?: number;
  readonly max?: number;
} | {
  readonly kind: "toggle";
};
/** Interleaved reasoning field name (openai-completions dialect). */
interface InterleavedField {
  readonly field: string;
}
declare const LIVE_SOURCES: readonly ["live", "fixture"];
type LiveSource = (typeof LIVE_SOURCES)[number];
type Availability = {
  readonly kind: "unverified";
} | {
  readonly kind: "verified";
  readonly liveSource: LiveSource;
};
/** Public, sanitized catalog entry served to consumers (never carries state). */
interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly protocol: Protocol;
  readonly provider: typeof PROVIDER_ID;
  readonly baseUrl: string;
  readonly input?: readonly ModalityLiteral[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly reasoningOptions?: readonly ReasoningOption[];
  readonly interleaved?: InterleavedField;
  readonly cost?: ModelCost;
}
/** Sanitized quarantine record: id, first detection, source, reason only. */
interface QuarantineRecord {
  readonly id: string;
  readonly detectedAt: string;
  readonly source: QuarantineSource;
  readonly reasonCode: QuarantineReasonCode;
}
/**
 * Internal grace-period entry: first transition timestamp plus a frozen model.
 * `evictedAt` is the one-shot eviction tombstone — once set, the model stays
 * absent from the public catalog until it resurrects on live.
 */
interface DeprecatedEntry {
  readonly id: string;
  readonly deprecatedAt: string;
  readonly evictedAt?: string;
  readonly model: CatalogModel;
}
/** One doc-evidenced dialect/compat base URL override. */
interface BaseUrlPatch {
  readonly baseUrl: string;
  readonly evidence: string;
}
/** Curated patch layer; ships near-empty and grows only on evidenced need. */
interface Patches {
  readonly baseUrlByProtocol: Readonly<Partial<Record<Protocol, BaseUrlPatch>>>;
}
/** Parsed models.dev model record (valid subset of the provider's models). */
interface ModelsDevModelMetadata {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost?: ModelCost;
  readonly input?: readonly ModalityLiteral[];
  readonly reasoningOptions?: readonly ReasoningOption[];
  readonly interleaved?: InterleavedField;
  readonly npm?: string;
  readonly api?: string;
}
/** Parsed models.dev provider; invalid records are tracked, never guessed. */
interface ModelsDevProvider {
  readonly id: string;
  readonly name: string;
  readonly npm?: string;
  readonly api?: string;
  readonly models: ReadonlyMap<string, ModelsDevModelMetadata>;
  readonly invalid: ReadonlyMap<string, QuarantineReasonCode>;
}
/** Previously committed state consumed by a reconciliation run. */
interface PreviousState {
  readonly models: readonly CatalogModel[];
  readonly quarantine: readonly QuarantineRecord[];
  readonly deprecated: readonly DeprecatedEntry[];
  readonly generatedAt?: string;
}
/** Everything reconciliation needs; the clock is injected, never wall-read. */
interface ReconcileInput {
  readonly provider: ModelsDevProvider;
  readonly liveIds: readonly string[];
  readonly patches: Patches;
  readonly previous: PreviousState;
  readonly now: Date;
}
/** Counters that let operators audit what a run actually changed. */
interface ReconcileStats {
  readonly known: number;
  readonly live: number;
  readonly quarantined: number;
  readonly deprecated: number;
  readonly evicted: number;
  readonly resurrected: number;
}
interface ReconcileResult {
  readonly catalog: readonly CatalogModel[];
  readonly quarantine: readonly QuarantineRecord[];
  readonly deprecated: readonly DeprecatedEntry[];
  readonly generatedAt: string;
  readonly transitioned: boolean;
  readonly stats: ReconcileStats;
}
//#endregion
//#region src/reconcile.d.ts
declare function reconcile(input: ReconcileInput): ReconcileResult;
//#endregion
//#region src/models-dev.d.ts
/**
 * Parse the models.dev provider record (the opencode-go entry of api.json).
 * The record id must be exactly `opencode-go`; every models map key must equal
 * its record's string id. Valid records populate `models`; invalid ones
 * populate `invalid` with a machine-readable reason.
 */
declare function parseModelsDevProvider(value: unknown): ModelsDevProvider;
/** The sole SDK-to-protocol mapping; unknown packages map to undefined. */
declare function sdkToProtocol(npm: string | undefined): Protocol | undefined;
/**
 * Parse a live /v1/models response into normalized, deduplicated ids only.
 * Accepts the OpenAI-style `{ data: [...] }` shape or a bare array; entries
 * must carry a string id that survives normalization.
 */
declare function parseLiveIds(value: unknown): readonly string[];
//#endregion
//#region src/catalog.d.ts
/** Code-unit lexicographic comparator; deterministic across environments. */
declare function compareIds(a: string, b: string): number;
interface ModelsManifest {
  readonly generatedAt: string;
  readonly provenance: string;
  readonly availability: Availability;
  readonly models: readonly CatalogModel[];
}
/** Render the public catalog manifest. */
declare function renderModelsManifest(manifest: ModelsManifest): string;
/** Render the sanitized quarantine artifact. */
declare function renderQuarantineFile(records: readonly QuarantineRecord[]): string;
/** Render the deprecated state artifact (internal; carries frozen models). */
declare function renderDeprecatedFile(entries: readonly DeprecatedEntry[]): string;
/** Render the patches artifact back to its canonical bytes. */
declare function renderPatchesFile(patches: Patches): string;
//#endregion
//#region src/state-file.d.ts
/** Parse JSON text and wrap syntax errors into StateFileParseError. */
declare function parseJsonFile(text: string, what: string): unknown;
/** Parse the models.json manifest into generatedAt, provenance, availability and models. */
declare function parseModelsManifest(value: unknown): {
  readonly generatedAt: string;
  readonly provenance: string;
  readonly availability: Availability;
  readonly models: readonly CatalogModel[];
};
/** Parse the quarantine.json artifact. */
declare function parseQuarantineFile(value: unknown): readonly QuarantineRecord[];
/** Parse the deprecated.json artifact (grace entries plus eviction tombstones). */
declare function parseDeprecatedFile(value: unknown): readonly DeprecatedEntry[];
/** Parse the patches.json artifact; an absent map means no patches. */
declare function parsePatchesFile(value: unknown): Patches;
//#endregion
//#region src/index.d.ts
/** Stable plugin name, must match the patch row and package.json. */
declare const name: "dsh-opencode-go-provider";
declare const apiKeyEnv: "OPENCODE_GO_API_KEY";
declare const bundleRowId: "llm-opencode-go";
declare const providerRoute: "opencode-go";
interface ProviderDescriptor {
  readonly name: typeof PLUGIN_NAME;
  readonly route: typeof PROVIDER_ROUTE;
  readonly bundleRow: typeof BUNDLE_ROW_ID;
  readonly apiKeyEnv: typeof API_KEY_ENV;
}
/** Machine-consumed provider contract surfaced by the Host entry. */
declare const provider: ProviderDescriptor;
/**
 * Cordis plugin factory. Later todos register the provider's reversible
 * effects (settings namespace, credentials, adapter, catalog sync) on this
 * context; the row stays mountable and typed in the meantime.
 */
declare function apply(ctx: Context): void;
//#endregion
export { type CatalogModel, type DeprecatedEntry, FOURTEEN_DAYS_MS, type ModelCost, type ModelsDevProvider, PROTOCOLS, PROVIDER_ID, type Patches, type PreviousState, type Protocol, ProviderDescriptor, QUARANTINE_REASON_CODES, QUARANTINE_SOURCES, type QuarantineReasonCode, type QuarantineRecord, type QuarantineSource, type ReconcileInput, type ReconcileResult, type ReconcileStats, apiKeyEnv, apply, bundleRowId, compareIds, name, parseDeprecatedFile, parseJsonFile, parseLiveIds, parseModelsDevProvider, parseModelsManifest, parsePatchesFile, parseQuarantineFile, provider, providerRoute, reconcile, renderDeprecatedFile, renderModelsManifest, renderPatchesFile, renderQuarantineFile, sdkToProtocol };