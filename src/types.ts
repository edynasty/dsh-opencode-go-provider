/**
 * Domain types for the OpenCode Go catalog and reconciliation engine.
 *
 * These shapes are the typed contract between the models.dev/live boundary
 * parsers, the deterministic renderers, the reconciliation state machine and
 * the generator script. Everything is readonly; the committed catalog files
 * are rendered from these types in a fixed field order.
 */

/** The three transport classes OpenCode Go exposes (models.dev SDK mapping). */
export const PROTOCOLS = ["openai-responses", "openai-completions", "anthropic-messages"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** Stable provider id used in every catalog entry and the DSH route. */
export const PROVIDER_ID = "opencode-go" as const;

/** Where a quarantine record was first observed. */
export const QUARANTINE_SOURCES = ["live", "models.dev"] as const;
export type QuarantineSource = (typeof QUARANTINE_SOURCES)[number];

/** Machine-readable quarantine reasons; no free-form prose is ever stored. */
export const QUARANTINE_REASON_CODES = [
  "NO_MODELS_DEV_METADATA",
  "INVALID_MODEL_RECORD",
  "MISSING_CONTEXT",
  "MISSING_OUTPUT_LIMIT",
  "UNKNOWN_SDK",
  "ANTHROPIC_BASE_URL_MISSING",
  "MISSING_BASE_URL",
] as const;
export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];

/** Modality literals accepted by the models.dev schema. */
export const MODALITY_LITERALS = ["text", "audio", "image", "video", "pdf"] as const;
export type ModalityLiteral = (typeof MODALITY_LITERALS)[number];

/** Flat price triple from models.dev; tiers add threshold prices on top. */
export interface ModelCostBase {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** One context-threshold price tier (models.dev cost.tiers[].tier). */
export interface CostTier extends ModelCostBase {
  readonly threshold: number;
  readonly tierType: "context";
}

/** Pricing metadata; only ever sourced from models.dev, tiers preserved. */
export interface ModelCost extends ModelCostBase {
  readonly tiers?: readonly CostTier[];
  readonly contextOver200k?: ModelCostBase;
}

/** Normalized reasoning option kinds from models.dev reasoning_options. */
export type ReasoningOption =
  | { readonly kind: "effort"; readonly values: readonly (string | null)[] }
  | { readonly kind: "budgetTokens"; readonly min?: number; readonly max?: number }
  | { readonly kind: "toggle" };

/** Interleaved reasoning field name (openai-completions dialect). */
export interface InterleavedField {
  readonly field: string;
}

/** How (and whether) the catalog's availability was observed. */
export const AVAILABILITY_KINDS = ["unverified", "verified"] as const;
export const LIVE_SOURCES = ["live", "fixture"] as const;
export type LiveSource = (typeof LIVE_SOURCES)[number];
export type Availability =
  | { readonly kind: "unverified" }
  | { readonly kind: "verified"; readonly liveSource: LiveSource };

/** Public, sanitized catalog entry served to consumers (never carries state). */
export interface CatalogModel {
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
export interface QuarantineRecord {
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
export interface DeprecatedEntry {
  readonly id: string;
  readonly deprecatedAt: string;
  readonly evictedAt?: string;
  readonly model: CatalogModel;
}

/** One doc-evidenced dialect/compat base URL override. */
export interface BaseUrlPatch {
  readonly baseUrl: string;
  readonly evidence: string;
}

/** Curated patch layer; ships near-empty and grows only on evidenced need. */
export interface Patches {
  readonly baseUrlByProtocol: Readonly<Partial<Record<Protocol, BaseUrlPatch>>>;
}

/** Parsed models.dev model record (valid subset of the provider's models). */
export interface ModelsDevModelMetadata {
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
export interface ModelsDevProvider {
  readonly id: string;
  readonly name: string;
  readonly npm?: string;
  readonly api?: string;
  readonly models: ReadonlyMap<string, ModelsDevModelMetadata>;
  readonly invalid: ReadonlyMap<string, QuarantineReasonCode>;
}

/** Per-record parse outcome: structural validation happens at the boundary. */
export type ModelRecordParseResult =
  | { readonly kind: "parsed"; readonly metadata: ModelsDevModelMetadata }
  | {
      readonly kind: "invalid";
      readonly reasonCode: "INVALID_MODEL_RECORD" | "MISSING_CONTEXT" | "MISSING_OUTPUT_LIMIT";
    };

/** Catalog derivation outcome: protocol/baseUrl/capacity assembly or a reason. */
export type DeriveResult =
  | { readonly kind: "derived"; readonly model: CatalogModel }
  | {
      readonly kind: "underviable";
      readonly reasonCode: "UNKNOWN_SDK" | "ANTHROPIC_BASE_URL_MISSING" | "MISSING_BASE_URL";
    };

/** Previously committed state consumed by a reconciliation run. */
export interface PreviousState {
  readonly models: readonly CatalogModel[];
  readonly quarantine: readonly QuarantineRecord[];
  readonly deprecated: readonly DeprecatedEntry[];
  readonly generatedAt?: string;
}

/** Everything reconciliation needs; the clock is injected, never wall-read. */
export interface ReconcileInput {
  readonly provider: ModelsDevProvider;
  readonly liveIds: readonly string[];
  readonly patches: Patches;
  readonly previous: PreviousState;
  readonly now: Date;
}

/** Counters that let operators audit what a run actually changed. */
export interface ReconcileStats {
  readonly known: number;
  readonly live: number;
  readonly quarantined: number;
  readonly deprecated: number;
  readonly evicted: number;
  readonly resurrected: number;
}

export interface ReconcileResult {
  readonly catalog: readonly CatalogModel[];
  readonly quarantine: readonly QuarantineRecord[];
  readonly deprecated: readonly DeprecatedEntry[];
  readonly generatedAt: string;
  readonly transitioned: boolean;
  readonly stats: ReconcileStats;
}
