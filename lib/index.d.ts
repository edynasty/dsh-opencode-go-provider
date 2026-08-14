import z from "@deepseek-ai/schemastery";
import { CredentialRef, credentialRef } from "@deepseek-ai/dsh-credentials";
import { GenerateOptions, LlmAdapter, LlmConfigurableProvider, LlmError, LlmErrorOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
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
/** Display name served by the provider directory and selectors. */
declare const DISPLAY_NAME: "OpenCode Go";
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
//#region src/config.d.ts
/** Schema-surface configuration: the composition entry and settings section. */
interface Config {
  /** Credential reference (environment-variable name) resolved per operation. */
  apiKeyEnv: string;
  /** Catalog refresh interval in milliseconds. */
  refreshMs: number;
  /** Freshness window in milliseconds: within it a catalog is reused as-is. */
  freshnessMs: number;
  /** Per-operation network timeout in milliseconds. */
  timeoutMs: number;
  /** Grace period before a missing model is evicted, in milliseconds. */
  graceMs: number;
}
/**
 * Raw composition entry or settings section as a host hands it to the plugin:
 * any partial section, with arbitrary extra keys that the schema merges and
 * {@link assertServiceable} refuses. No `any`: unknown values stay `unknown`
 * until the schema call narrows them.
 */
type SectionInput = Partial<Config> & Record<string, unknown>;
/** Canonical defaults: 60-minute refresh, 5-minute freshness, 10s timeout, 14-day grace. */
declare const DEFAULTS: {
  readonly apiKeyEnv: "OPENCODE_GO_API_KEY";
  readonly refreshMs: 3600000;
  readonly freshnessMs: 300000;
  readonly timeoutMs: 10000;
  readonly graceMs: 1209600000;
};
/** Per-operation snapshot with a branded credential reference; frozen and detached. */
interface ResolvedConfig {
  readonly apiKeyEnv: ReturnType<typeof credentialRef>;
  readonly refreshMs: number;
  readonly freshnessMs: number;
  readonly timeoutMs: number;
  readonly graceMs: number;
}
/**
 * Schemastery schema resolving the section; defaults fill an empty section.
 * The input shape is the section (all fields optional), the output shape is
 * {@link Config} (defaults materialized). Unknown keys are preserved by
 * schemastery's object merge and refused by {@link assertServiceable}.
 */
declare const Config: z<Schemastery.ObjectS<{
  apiKeyEnv: z<string, string>;
  refreshMs: z<number, number>;
  freshnessMs: z<number, number>;
  timeoutMs: z<number, number>;
  graceMs: z<number, number>;
}>, Schemastery.ObjectT<{
  apiKeyEnv: z<string, string>;
  refreshMs: z<number, number>;
  freshnessMs: z<number, number>;
  timeoutMs: z<number, number>;
  graceMs: z<number, number>;
}>>;
/**
 * Refuse a resolved section this provider could not act on. Registered as the
 * settings namespace's validator, so an unserviceable section is refused where
 * it is written instead of being stored and silently breaking the operation.
 * The error message never echoes any value — only the offending key name.
 * @param config - the schema-resolved section.
 * @throws Error naming the offending key.
 */
declare function assertServiceable(config: Config): void;
/**
 * Detach a frozen per-operation snapshot from a schema-resolved section.
 * Branding happens here, once per operation, through the public
 * `credentialRef` helper — the section keeps a plain string so configuration
 * surfaces render it as a text field.
 * @param raw - the schema-resolved section.
 * @returns a frozen, detached snapshot safe to hand across module boundaries.
 */
declare function resolveConfig(raw: Config): ResolvedConfig;
//#endregion
//#region src/credentials.d.ts
/** Stable machine code for an absent credential (string literal, per DSH convention). */
declare const MISSING_CREDENTIAL_CODE = "MISSING_CREDENTIAL";
/**
 * Resolve the active credential for one reference, per operation. The
 * credentials service is read fresh on every call; an absent service falls
 * back to the launching environment. Empty stored values are absent.
 * @param ctx - the consuming plugin's context.
 * @param ref - the reference to resolve.
 * @returns the canonical, header-carryable key.
 * @throws LlmError with code `MISSING_CREDENTIAL` when unset, or
 *   `INVALID_CREDENTIAL` when the value is non-canonical or unheaderable.
 */
declare function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string>;
/**
 * Resolve the key, then invoke the operation with the snapshot. The key is
 * captured before the callback starts, so an in-flight operation keeps the key
 * it began with even if the credential rotates; a missing or invalid key
 * throws before the callback (and therefore before any network) runs.
 * @param ctx - the consuming plugin's context.
 * @param ref - the reference to resolve.
 * @param run - the operation body, handed the resolved key snapshot.
 * @returns the operation's result.
 */
declare function withResolvedKey<T>(ctx: Context, ref: CredentialRef, run: (key: string) => Promise<T>): Promise<T>;
//#endregion
//#region src/catalog-loader.d.ts
/**
 * Return the parsed embedded catalog models, ascending by id.
 * @returns the catalog models.
 */
declare function embeddedCatalogModels(): readonly CatalogModel[];
//#endregion
//#region src/errors.d.ts
/** Credential/authorization failures (HTTP 401/403). */
declare const AUTH = "AUTH";
/** Provider rate limiting (HTTP 429). */
declare const RATE_LIMIT = "RATE_LIMIT";
/** Provider-side server failures (HTTP 5xx). */
declare const SERVER = "SERVER";
/** Connection, DNS, socket or stream failures. */
declare const TRANSPORT = "TRANSPORT";
/** The configured per-operation idle deadline elapsed. */
declare const TIMEOUT = "TIMEOUT";
/** The caller cancelled the request. */
declare const ABORTED = "ABORTED";
/** HTTP 400 / invalid request wording. */
declare const INVALID_REQUEST = "INVALID_REQUEST";
/** Provider error text no stable class matches. */
declare const PI_AI_ERROR = "PI_AI_ERROR";
/** A model id the catalog does not describe. */
declare const UNKNOWN_MODEL = "UNKNOWN_MODEL";
/** A provider route this adapter does not own. */
declare const NO_ADAPTER = "NO_ADAPTER";
/** A request option the transports cannot express. */
declare const UNSUPPORTED_OPTION = "UNSUPPORTED_OPTION";
/** Media or message content the selected model cannot carry. */
declare const UNSUPPORTED_CONTENT = "UNSUPPORTED_CONTENT";
/** A reasoning effort the selected model does not offer. */
declare const UNSUPPORTED_REASONING_EFFORT = "UNSUPPORTED_REASONING_EFFORT";
/** Catalog metadata naming a wire protocol this bundle cannot serve. */
declare const UNSUPPORTED_PROTOCOL = "UNSUPPORTED_PROTOCOL";
/** A pi-ai event stream ended without a terminal event. */
declare const STREAM_CLOSED = "STREAM_CLOSED";
/** Durable replay metadata failed validation. */
declare const INVALID_REPLAY_STATE = "INVALID_REPLAY_STATE";
/** Construct one typed adapter failure with the stable code taxonomy. */
declare function llmError(message: string, code: string, options?: LlmErrorOptions): LlmError;
/**
 * Classify provider error text into the stable code taxonomy. The provider
 * message carries the HTTP status and transport details pi-ai formatted, so a
 * text classifier is the deterministic seam the same way the host's own
 * deepseek adapter classifies. An explicit HTTP 429 wins over quota wording:
 * the status is the authoritative signal, and the harness routes RATE_LIMIT
 * and QUOTA differently.
 * @param detail - provider error text (status, code and message joined).
 * @returns the stable machine-routable code.
 */
declare function classifyProviderFailure(detail: string): string;
//#endregion
//#region src/adapter.d.ts
/** Dependencies the service wires in; the catalog thunk lets Task 6 hot-swap snapshots. */
interface OpenCodeGoAdapterOptions {
  /** Live config source; re-read on every operation so settings hot-apply. */
  readonly currentConfig: () => Config;
  /** Per-operation credential resolver, gating every stream before network. */
  readonly resolveKey: (ref: CredentialRef) => Promise<string>;
  /** Embedded catalog source; advisory and credential-free. */
  readonly catalog: () => readonly CatalogModel[];
  /** Optional durable attachment service for image input. */
  readonly resolveAttachments?: () => AttachmentStore | undefined;
}
/**
 * OpenCode Go single-route adapter. Each operation reads the current catalog
 * and config, so a change reaches the next request without a restart.
 */
declare class OpenCodeGoAdapter extends LlmAdapter {
  private readonly deps;
  private snapshot;
  constructor(deps: OpenCodeGoAdapterOptions);
  /** The snapshot for the current catalog; memoized by collection identity. */
  private current;
  /** Refuse a provider route this adapter does not own. */
  private profileOf;
  /** The catalog entry for one exact route/model pair within one snapshot. */
  private modelOf;
  providerInfo(provider: string): LlmProviderInfo;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//#endregion
//#region src/service.d.ts
/**
 * Settings namespace owned by this provider; the bundle row id. Annotated with
 * the public `SettingsNamespace` brand type so the declaration rollup names the
 * public type instead of inlining its underlying representation.
 */
declare const NS: SettingsNamespace;
/** The one configurable-provider directory entry: the whole section is the profile. */
declare const DIRECTORY_ENTRY: LlmConfigurableProvider;
/** Cordis plugin factory: mount the provider's reversible Host effects. */
declare function apply(ctx: Context, rawConfig?: SectionInput): void;
/** Cordis service dependency: the plugin mounts only once `llm` is available. */
declare const inject: readonly ["llm"];
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
//#endregion
export { ABORTED, AUTH, type CatalogModel, Config, type Config as ConfigType, DEFAULTS, DIRECTORY_ENTRY, DISPLAY_NAME, type DeprecatedEntry, FOURTEEN_DAYS_MS, INVALID_REPLAY_STATE, INVALID_REQUEST, MISSING_CREDENTIAL_CODE, type ModelCost, type ModelsDevProvider, NO_ADAPTER, NS, OpenCodeGoAdapter, type OpenCodeGoAdapterOptions, PI_AI_ERROR, PROTOCOLS, PROVIDER_ID, type Patches, type PreviousState, type Protocol, ProviderDescriptor, QUARANTINE_REASON_CODES, QUARANTINE_SOURCES, type QuarantineReasonCode, type QuarantineRecord, type QuarantineSource, RATE_LIMIT, type ReconcileInput, type ReconcileResult, type ReconcileStats, type ResolvedConfig, SERVER, STREAM_CLOSED, TIMEOUT, TRANSPORT, UNKNOWN_MODEL, UNSUPPORTED_CONTENT, UNSUPPORTED_OPTION, UNSUPPORTED_PROTOCOL, UNSUPPORTED_REASONING_EFFORT, apiKeyEnv, apply, assertServiceable, bundleRowId, classifyProviderFailure, compareIds, embeddedCatalogModels, inject, llmError, name, parseDeprecatedFile, parseJsonFile, parseLiveIds, parseModelsDevProvider, parseModelsManifest, parsePatchesFile, parseQuarantineFile, provider, providerRoute, reconcile, renderDeprecatedFile, renderModelsManifest, renderPatchesFile, renderQuarantineFile, resolveApiKey, resolveConfig, sdkToProtocol, withResolvedKey };