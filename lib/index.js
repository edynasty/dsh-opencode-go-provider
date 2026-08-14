//#region src/contract.ts
/**
* Shared Host/Client contract values for the OpenCode Go provider bundle.
*
* Imported by both the Host entry (`src/index.ts`) and the Web client seam
* (`src/client/index.tsx`); each tsdown build bundles its own copy. Keeping
* the values in one module prevents the Host and Client programs from
* drifting apart on the route, row, and credential names.
*/
/** Stable bundle/plugin name; must match package.json and the patch row. */
const PLUGIN_NAME = "dsh-opencode-go-provider";
/** DSH credentials environment variable resolved at operation time. */
const API_KEY_ENV = "OPENCODE_GO_API_KEY";
/** Bundle row id inserted by cordis.patch.yml. */
const BUNDLE_ROW_ID = "llm-opencode-go";
/** Provider route registered on ctx.llm and addressed by the settings card. */
const PROVIDER_ROUTE = "opencode-go";
//#endregion
//#region src/constants.ts
/** Shared grace-period constant, free of module cycles. */
/** Exact grace boundary: entries are evicted strictly after 14 days. */
const FOURTEEN_DAYS_MS = 12096e5;
//#endregion
//#region src/guards.ts
/**
* Runtime type guards and the exhaustive-match sink.
*
* Guards narrow `unknown` values into typed values at trust boundaries (JSON
* payloads, state files). They are runtime checks, not casts. Production and
* test code share these; nothing else imports node builtins.
*/
/** True when `value` is a plain object (not null, not an array). */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** True when `value` is an array (element type preserved as `unknown`). */
function isUnknownArray(value) {
	return Array.isArray(value);
}
/** True when `value` is a string. */
function isString(value) {
	return typeof value === "string";
}
/** True when `value` is a boolean. */
function isBoolean(value) {
	return typeof value === "boolean";
}
/** True when `value` is a canonical finite ISO-8601 instant (toISOString form). */
function isCanonicalIsoInstant(value) {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) return false;
	return new Date(ms).toISOString() === value;
}
/** Whitespace and control characters no model id may contain. */
const WHITESPACE_OR_CONTROL = /[\u0000-\u001F\u007F\s]/u;
/**
* True when `value` is a safe canonical model id: nonempty, already trimmed,
* and free of whitespace and control characters. Shared by the models.dev,
* live and persisted-state boundaries.
*/
function isSafeModelId(value) {
	if (typeof value !== "string" || value === "") return false;
	if (value !== value.trim()) return false;
	return !WHITESPACE_OR_CONTROL.test(value);
}
/** True when `value` is a positive integer (capacities, limits, thresholds). */
function isPositiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
/** True when `value` is a finite nonnegative number (prices). */
function isNonnegativeFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
/** Control characters no persisted/external text may contain. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u;
/**
* True when `value` is safe text: a nonempty (after trim) string free of
* control characters. Internal whitespace is allowed (model names contain
* spaces); ids and keys use the stricter isSafeModelId.
*/
function isSafeText(value) {
	if (typeof value !== "string" || value.trim() === "") return false;
	return !CONTROL_CHARS.test(value);
}
/** Exhaustive-match sink for closed unions; never returns. */
function assertNever(value) {
	throw new Error(`unreachable union member: ${JSON.stringify(value)}`);
}
//#endregion
//#region src/types.ts
/**
* Domain types for the OpenCode Go catalog and reconciliation engine.
*
* These shapes are the typed contract between the models.dev/live boundary
* parsers, the deterministic renderers, the reconciliation state machine and
* the generator script. Everything is readonly; the committed catalog files
* are rendered from these types in a fixed field order.
*/
/** The three transport classes OpenCode Go exposes (models.dev SDK mapping). */
const PROTOCOLS = [
	"openai-responses",
	"openai-completions",
	"anthropic-messages"
];
/** Stable provider id used in every catalog entry and the DSH route. */
const PROVIDER_ID = "opencode-go";
/** Where a quarantine record was first observed. */
const QUARANTINE_SOURCES = ["live", "models.dev"];
/** Machine-readable quarantine reasons; no free-form prose is ever stored. */
const QUARANTINE_REASON_CODES = [
	"NO_MODELS_DEV_METADATA",
	"INVALID_MODEL_RECORD",
	"MISSING_CONTEXT",
	"MISSING_OUTPUT_LIMIT",
	"UNKNOWN_SDK",
	"ANTHROPIC_BASE_URL_MISSING",
	"MISSING_BASE_URL"
];
/** Modality literals accepted by the models.dev schema. */
const MODALITY_LITERALS = [
	"text",
	"audio",
	"image",
	"video",
	"pdf"
];
//#endregion
//#region src/urls.ts
/**
* OpenCode Go base URL boundary.
*
* Every base URL this route ever sends a request (or a credential) to must be
* HTTPS on exactly `opencode.ai` under the `/zen/go` endpoint family, with no
* userinfo, query or hash. Anything else — http, lookalike hosts, localhost,
* IPs, protocol-relative URLs, foreign paths — fails closed so a malicious
* metadata record can never become a request target.
*/
const ALLOWED_HOST = "opencode.ai";
/**
* Validate a base URL against the OpenCode Go endpoint boundary and return
* its canonical href; `undefined` means the value is not acceptable.
*/
function parseBaseUrl(value) {
	if (!isString(value)) return void 0;
	let url;
	try {
		url = new URL(value);
	} catch {
		return;
	}
	if (url.protocol !== "https:") return void 0;
	if (url.username !== "" || url.password !== "") return void 0;
	if (url.search !== "" || url.hash !== "") return void 0;
	if (url.hostname !== ALLOWED_HOST) return void 0;
	if (url.pathname !== "/zen/go" && !url.pathname.startsWith("/zen/go/")) return void 0;
	return url.href;
}
//#endregion
//#region src/model-record.ts
/**
* Per-record models.dev boundary parsing.
*
* One model record becomes typed metadata: capacities, tiered costs,
* reasoning options and the interleaved reasoning field. Everything outside
* the documented schema — unsafe ids, impossible numbers, unknown tier types,
* malformed reasoning metadata — yields a machine-readable invalid reason
* instead of being preserved. This module owns no provider-map concerns.
*/
/** String field reader: undefined = absent, null = present but malformed. */
function parseStringField$1(record, key) {
	const value = record[key];
	if (value === void 0) return void 0;
	return isString(value) ? value : null;
}
function parsePrice$1(value) {
	if (!isRecord(value)) return void 0;
	if (!isNonnegativeFiniteNumber(value.input) || !isNonnegativeFiniteNumber(value.output)) return;
	const cacheRead = value.cache_read === void 0 ? void 0 : isNonnegativeFiniteNumber(value.cache_read) ? value.cache_read : null;
	const cacheWrite = value.cache_write === void 0 ? void 0 : isNonnegativeFiniteNumber(value.cache_write) ? value.cache_write : null;
	if (cacheRead === null || cacheWrite === null) return;
	return {
		input: value.input,
		output: value.output,
		...cacheRead === void 0 ? {} : { cacheRead },
		...cacheWrite === void 0 ? {} : { cacheWrite }
	};
}
/** Only the documented "context" tier type is accepted. */
function parseTier$1(value) {
	if (!isRecord(value)) return void 0;
	const tier = isRecord(value.tier) ? value.tier : void 0;
	const threshold = tier === void 0 ? void 0 : isPositiveInteger(tier.size) ? tier.size : void 0;
	const tierType = tier === void 0 ? void 0 : parseStringField$1(tier, "type");
	if (threshold === void 0 || tierType === null || tierType === void 0 || tierType !== "context") return;
	const base = parsePrice$1(value);
	if (base === void 0) return void 0;
	return {
		...base,
		threshold,
		tierType
	};
}
function parseCost(value) {
	if (value === void 0) return void 0;
	if (!isRecord(value)) return void 0;
	const base = parsePrice$1(value);
	if (base === void 0) return void 0;
	let tiers;
	if (value.tiers !== void 0) {
		if (!Array.isArray(value.tiers)) return void 0;
		const parsed = [];
		for (const raw of value.tiers) {
			const tier = parseTier$1(raw);
			if (tier === void 0) return void 0;
			parsed.push(tier);
		}
		tiers = parsed;
	}
	let contextOver200k;
	if (value.context_over_200k !== void 0) {
		const over = parsePrice$1(value.context_over_200k);
		if (over === void 0) return void 0;
		contextOver200k = over;
	}
	return {
		...base,
		...tiers === void 0 ? {} : { tiers },
		...contextOver200k === void 0 ? {} : { contextOver200k }
	};
}
/** Effort values must be safe, nonempty and unique (nulls are schema-allowed). */
function parseEffortValues$1(value) {
	if (!Array.isArray(value)) return void 0;
	const seen = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (entry === null) continue;
		if (!isString(entry) || !isSafeModelId(entry) || seen.has(entry)) return void 0;
		seen.add(entry);
	}
	return value;
}
function parseReasoningOptions(value) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value)) return void 0;
	const options = [];
	for (const raw of value) {
		if (!isRecord(raw)) return void 0;
		if (raw.type === "toggle") {
			options.push({ kind: "toggle" });
			continue;
		}
		if (raw.type === "effort") {
			const values = parseEffortValues$1(raw.values);
			if (values === void 0) return void 0;
			options.push({
				kind: "effort",
				values
			});
			continue;
		}
		if (raw.type === "budget_tokens") {
			const min = raw.min === void 0 ? void 0 : isNonnegativeFiniteNumber(raw.min) && Number.isInteger(raw.min) ? raw.min : null;
			const max = raw.max === void 0 ? void 0 : isNonnegativeFiniteNumber(raw.max) && Number.isInteger(raw.max) ? raw.max : null;
			if (min === null || max === null) return void 0;
			if (min !== void 0 && max !== void 0 && min > max) return void 0;
			options.push({
				kind: "budgetTokens",
				...min === void 0 ? {} : { min },
				...max === void 0 ? {} : { max }
			});
			continue;
		}
		return;
	}
	return options;
}
function parseInterleaved$1(value) {
	if (value === void 0 || value === null) return void 0;
	if (!isRecord(value)) return void 0;
	const field = parseStringField$1(value, "field");
	if (field === null || field === void 0 || !isSafeText(field)) return void 0;
	return { field };
}
/** Input modalities must be documented literals, each listed once. */
function parseModalities(value) {
	if (value === void 0) return void 0;
	if (!isRecord(value)) return void 0;
	if (!Array.isArray(value.input)) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const entry of value.input) {
		if (!isString(entry)) return void 0;
		const literal = MODALITY_LITERALS.find((candidate) => candidate === entry);
		if (literal === void 0) return void 0;
		if (seen.has(literal)) return void 0;
		seen.add(literal);
		out.push(literal);
	}
	return out;
}
/**
* Parse one models.dev model record. Structural, identity and numeric
* problems yield a machine-readable reason; the caller decides placement.
*/
function parseModelRecord(value) {
	if (!isRecord(value)) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	const id = parseStringField$1(value, "id");
	const name = parseStringField$1(value, "name");
	const reasoning = isBoolean(value.reasoning) ? value.reasoning : void 0;
	const limit = isRecord(value.limit) ? value.limit : void 0;
	const contextWindow = limit === void 0 ? void 0 : isPositiveInteger(limit.context) ? limit.context : void 0;
	const maxTokens = limit === void 0 ? void 0 : isPositiveInteger(limit.output) ? limit.output : void 0;
	if (id === void 0 || name === void 0 || id === null || name === null || reasoning === void 0 || id !== null && !isSafeModelId(id) || name !== null && !isSafeText(name)) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	if (contextWindow === void 0 && (limit === void 0 || limit.context === void 0)) return {
		kind: "invalid",
		reasonCode: "MISSING_CONTEXT"
	};
	if (maxTokens === void 0 && (limit === void 0 || limit.output === void 0)) return {
		kind: "invalid",
		reasonCode: "MISSING_OUTPUT_LIMIT"
	};
	if (contextWindow === void 0 || maxTokens === void 0) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	const cost = parseCost(value.cost);
	if (value.cost !== void 0 && cost === void 0) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	const input = parseModalities(value.modalities);
	if (value.modalities !== void 0 && input === void 0) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	const reasoningOptions = parseReasoningOptions(value.reasoning_options);
	if (value.reasoning_options !== void 0 && reasoningOptions === void 0) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	const interleaved = parseInterleaved$1(value.interleaved);
	if (value.interleaved !== void 0 && value.interleaved !== null && interleaved === void 0) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	const provider = isRecord(value.provider) ? value.provider : void 0;
	const npm = provider === void 0 ? void 0 : parseStringField$1(provider, "npm");
	const api = provider === void 0 ? void 0 : parseStringField$1(provider, "api");
	if (npm === null || api === null) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	if (api !== void 0 && parseBaseUrl(api) === void 0) return {
		kind: "invalid",
		reasonCode: "INVALID_MODEL_RECORD"
	};
	return {
		kind: "parsed",
		metadata: {
			id,
			name,
			reasoning,
			contextWindow,
			maxTokens,
			...cost === void 0 ? {} : { cost },
			...input === void 0 ? {} : { input },
			...reasoningOptions === void 0 ? {} : { reasoningOptions },
			...interleaved === void 0 ? {} : { interleaved },
			...npm === void 0 ? {} : { npm },
			...api === void 0 ? {} : { api }
		}
	};
}
//#endregion
//#region src/models-dev.ts
/**
* models.dev provider and live /v1/models boundary parsers.
*
* External JSON crosses the trust boundary here: the provider record (and the
* full api.json provider map, from which only `opencode-go` is selected) is
* parsed from `unknown` into typed metadata, and live responses yield only
* normalized ids. Provider identity and map-key/record-id consistency are
* enforced; anything foreign fails closed instead of being relabeled.
*/
/** Provider-level parse failure (payload not a provider record). */
var ModelsDevParseError = class extends Error {
	name = "ModelsDevParseError";
	constructor(reason) {
		super(`models.dev provider parse failed: ${reason}`);
	}
};
/** Live /v1/models parse failure (payload shape, id shape or normalization). */
var LiveModelsParseError = class extends Error {
	name = "LiveModelsParseError";
	constructor(reason) {
		super(`live /v1/models parse failed: ${reason}`);
	}
};
/** String field reader: undefined = absent, null = present but malformed. */
function parseStringField(record, key) {
	const value = record[key];
	if (value === void 0) return void 0;
	return isString(value) ? value : null;
}
/** Whitespace and control characters no live model id may contain. */
function normalizeLiveId(raw) {
	const trimmed = raw.trim();
	if (!isSafeModelId(trimmed)) throw new LiveModelsParseError("entry id must be a nonempty trimmed id without whitespace or control characters");
	return trimmed;
}
/**
* Parse the models.dev provider record (the opencode-go entry of api.json).
* The record id must be exactly `opencode-go`; every models map key must equal
* its record's string id. Valid records populate `models`; invalid ones
* populate `invalid` with a machine-readable reason.
*/
function parseModelsDevProvider(value) {
	if (!isRecord(value)) throw new ModelsDevParseError("payload is not an object");
	const id = parseStringField(value, "id");
	const name = parseStringField(value, "name");
	const npm = parseStringField(value, "npm");
	const api = parseStringField(value, "api");
	if (id === void 0 || name === void 0 || id === null || name === null || !isRecord(value.models)) throw new ModelsDevParseError("provider must declare string id/name and a models object");
	if (id !== "opencode-go") throw new ModelsDevParseError(`expected provider id "${PROVIDER_ID}", got "${id}"`);
	if (npm === null || api === null) throw new ModelsDevParseError("provider npm/api must be strings when present");
	if (api !== void 0 && parseBaseUrl(api) === void 0) throw new ModelsDevParseError(`provider api "${api}" is not a valid OpenCode Go base URL`);
	const models = /* @__PURE__ */ new Map();
	const invalid = /* @__PURE__ */ new Map();
	for (const [key, raw] of Object.entries(value.models)) {
		if (!isSafeModelId(key)) throw new ModelsDevParseError(`models map key "${key}" is not a safe canonical model id`);
		const recordId = isRecord(raw) ? parseStringField(raw, "id") : void 0;
		if (recordId !== void 0 && recordId !== null && recordId !== key) throw new ModelsDevParseError(`models map key "${key}" does not match record id "${recordId}"`);
		const parsed = parseModelRecord(raw);
		switch (parsed.kind) {
			case "parsed":
				models.set(key, parsed.metadata);
				break;
			case "invalid":
				invalid.set(key, parsed.reasonCode);
				break;
			default: assertNever(parsed);
		}
	}
	return {
		id,
		name,
		...npm === void 0 ? {} : { npm },
		...api === void 0 ? {} : { api },
		models,
		invalid
	};
}
/** The sole SDK-to-protocol mapping; unknown packages map to undefined. */
function sdkToProtocol(npm) {
	switch (npm) {
		case "@ai-sdk/openai": return "openai-responses";
		case "@ai-sdk/openai-compatible": return "openai-completions";
		case "@ai-sdk/anthropic": return "anthropic-messages";
		default: return;
	}
}
/**
* Parse a live /v1/models response into normalized, deduplicated ids only.
* Accepts the OpenAI-style `{ data: [...] }` shape or a bare array; entries
* must carry a string id that survives normalization.
*/
function parseLiveIds(value) {
	const entries = isRecord(value) ? value.data : value;
	if (!isUnknownArray(entries)) throw new LiveModelsParseError("payload must be an object with a data array or a bare array");
	const ids = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (!isRecord(entry) || !isString(entry.id)) throw new LiveModelsParseError("every entry must declare a string id");
		const normalized = normalizeLiveId(entry.id);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			ids.push(normalized);
		}
	}
	return ids;
}
//#endregion
//#region src/catalog.ts
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
/** Code-unit lexicographic comparator; deterministic across environments. */
function compareIds(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
/** Sort a copy of the input by model id; never mutates the caller's array. */
function sortedById(entries) {
	return [...entries].sort((a, b) => compareIds(a.id, b.id));
}
/** Resolve the base URL from explicit metadata; the patch layer wins. */
function resolveBaseUrl(metadata, provider, patches, protocol) {
	const patch = patches.baseUrlByProtocol[protocol];
	if (patch !== void 0) return {
		ok: true,
		baseUrl: patch.baseUrl
	};
	if (metadata.api !== void 0) return {
		ok: true,
		baseUrl: metadata.api
	};
	if (protocol === "anthropic-messages") return {
		ok: false,
		reasonCode: "ANTHROPIC_BASE_URL_MISSING"
	};
	if (provider.api !== void 0) return {
		ok: true,
		baseUrl: provider.api
	};
	return {
		ok: false,
		reasonCode: "MISSING_BASE_URL"
	};
}
/**
* Assemble a public catalog entry from parsed metadata. Protocol and base URL
* come from explicit SDK/API metadata; nothing is inferred from the id.
*/
function deriveCatalogModel(metadata, provider, patches) {
	const protocol = sdkToProtocol(metadata.npm ?? provider.npm);
	if (protocol === void 0) return {
		kind: "underviable",
		reasonCode: "UNKNOWN_SDK"
	};
	const base = resolveBaseUrl(metadata, provider, patches, protocol);
	if (!base.ok) return {
		kind: "underviable",
		reasonCode: base.reasonCode
	};
	return {
		kind: "derived",
		model: {
			id: metadata.id,
			name: metadata.name,
			protocol,
			provider: PROVIDER_ID,
			baseUrl: base.baseUrl,
			...metadata.input === void 0 ? {} : { input: metadata.input },
			contextWindow: metadata.contextWindow,
			maxTokens: metadata.maxTokens,
			reasoning: metadata.reasoning,
			...metadata.reasoningOptions === void 0 ? {} : { reasoningOptions: metadata.reasoningOptions },
			...metadata.interleaved === void 0 ? {} : { interleaved: metadata.interleaved },
			...metadata.cost === void 0 ? {} : { cost: metadata.cost }
		}
	};
}
/** JSON with two-space indent plus one trailing newline. */
function renderJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}
/** Ordered JSON value for one price triple (input, output, caches). */
function renderPrice(price) {
	const out = {
		input: price.input,
		output: price.output
	};
	if (price.cacheRead !== void 0) out.cacheRead = price.cacheRead;
	if (price.cacheWrite !== void 0) out.cacheWrite = price.cacheWrite;
	return out;
}
/** Ordered JSON value for one cost tier (threshold and tierType last). */
function renderTier(tier) {
	const out = renderPrice(tier);
	out.threshold = tier.threshold;
	out.tierType = tier.tierType;
	return out;
}
/** Ordered JSON value for a full cost block (tiers and over-200k last). */
function renderCost(cost) {
	const out = renderPrice(cost);
	if (cost.tiers !== void 0) out.tiers = cost.tiers.map(renderTier);
	if (cost.contextOver200k !== void 0) out.contextOver200k = renderPrice(cost.contextOver200k);
	return out;
}
/** Ordered JSON value for one reasoning option. */
function renderReasoningOption(option) {
	switch (option.kind) {
		case "effort": return {
			kind: "effort",
			values: [...option.values]
		};
		case "budgetTokens": return {
			kind: "budgetTokens",
			...option.min === void 0 ? {} : { min: option.min },
			...option.max === void 0 ? {} : { max: option.max }
		};
		case "toggle": return { kind: "toggle" };
	}
}
/** Ordered JSON value for one catalog model (pins the public field order). */
function renderCatalogModel(model) {
	const out = {
		id: model.id,
		name: model.name,
		protocol: model.protocol,
		provider: model.provider,
		baseUrl: model.baseUrl
	};
	if (model.input !== void 0) out.input = [...model.input];
	out.contextWindow = model.contextWindow;
	out.maxTokens = model.maxTokens;
	out.reasoning = model.reasoning;
	if (model.reasoningOptions !== void 0) out.reasoningOptions = model.reasoningOptions.map(renderReasoningOption);
	if (model.interleaved !== void 0) out.interleaved = { field: model.interleaved.field };
	if (model.cost !== void 0) out.cost = renderCost(model.cost);
	return out;
}
/** Ordered JSON payload for a models array (pins field order and sorting). */
function renderModelsPayload(models) {
	return renderJson(sortedById(models).map(renderCatalogModel));
}
/** Render the public catalog manifest. */
function renderModelsManifest(manifest) {
	return renderJson({
		generatedAt: manifest.generatedAt,
		provenance: manifest.provenance,
		availability: manifest.availability,
		models: sortedById(manifest.models).map(renderCatalogModel)
	});
}
/** Render the sanitized quarantine artifact. */
function renderQuarantineFile(records) {
	return renderJson(sortedById(records).map((record) => ({
		id: record.id,
		detectedAt: record.detectedAt,
		source: record.source,
		reasonCode: record.reasonCode
	})));
}
/** Render the deprecated state artifact (internal; carries frozen models). */
function renderDeprecatedFile(entries) {
	return renderJson(sortedById(entries).map((entry) => ({
		id: entry.id,
		deprecatedAt: entry.deprecatedAt,
		...entry.evictedAt === void 0 ? {} : { evictedAt: entry.evictedAt },
		model: renderCatalogModel(entry.model)
	})));
}
/** Render the patches artifact back to its canonical bytes. */
function renderPatchesFile(patches) {
	const baseUrlByProtocol = {};
	for (const protocol of PROTOCOLS) {
		const patch = patches.baseUrlByProtocol[protocol];
		if (patch === void 0) continue;
		baseUrlByProtocol[protocol] = {
			baseUrl: patch.baseUrl,
			evidence: patch.evidence
		};
	}
	return renderJson({ baseUrlByProtocol });
}
//#endregion
//#region src/reconcile.ts
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
function sortByQuarantineId(records) {
	return [...records].sort((a, b) => compareIds(a.id, b.id));
}
function quarantineChanged(candidate, previous) {
	if (candidate.length !== previous.length) return true;
	for (let index = 0; index < candidate.length; index += 1) {
		const left = candidate[index];
		const right = previous[index];
		if (left === void 0 || right === void 0 || left.id !== right.id || left.source !== right.source || left.reasonCode !== right.reasonCode || left.detectedAt !== right.detectedAt) return true;
	}
	return false;
}
function reconcile(input) {
	const { provider, liveIds, patches, previous, now } = input;
	const nowIso = now.toISOString();
	const nowMs = now.getTime();
	const liveSet = new Set(liveIds);
	const catalog = [];
	const requiredQuarantine = /* @__PURE__ */ new Map();
	const quarantinePrevious = new Map(previous.quarantine.map((record) => [record.id, record]));
	const recordQuarantine = (id, source, reasonCode) => {
		const existing = quarantinePrevious.get(id);
		if (existing !== void 0) {
			requiredQuarantine.set(id, {
				id,
				detectedAt: existing.detectedAt,
				source,
				reasonCode
			});
			return;
		}
		requiredQuarantine.set(id, {
			id,
			detectedAt: nowIso,
			source,
			reasonCode
		});
	};
	for (const id of [...liveSet].sort()) {
		const metadata = provider.models.get(id);
		if (metadata === void 0) {
			recordQuarantine(id, "live", provider.invalid.get(id) ?? "NO_MODELS_DEV_METADATA");
			continue;
		}
		const derived = deriveCatalogModel(metadata, provider, patches);
		if (derived.kind !== "derived") {
			recordQuarantine(id, "live", derived.reasonCode);
			continue;
		}
		catalog.push(derived.model);
	}
	for (const [id, reasonCode] of provider.invalid) if (!liveSet.has(id)) recordQuarantine(id, "models.dev", reasonCode);
	const deprecatedMap = new Map(previous.deprecated.map((entry) => [entry.id, entry]));
	const resultDeprecated = [];
	let evicted = 0;
	let resurrected = 0;
	for (const [id, entry] of deprecatedMap) {
		if (liveSet.has(id)) {
			resurrected += 1;
			continue;
		}
		if (entry.evictedAt !== void 0) {
			resultDeprecated.push(entry);
			continue;
		}
		if (nowMs - Date.parse(entry.deprecatedAt) > 12096e5) {
			evicted += 1;
			resultDeprecated.push({
				...entry,
				evictedAt: nowIso
			});
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
		resultDeprecated.push({
			id,
			deprecatedAt: nowIso,
			model: derived.model
		});
	}
	for (const entry of resultDeprecated) if (entry.evictedAt === void 0) catalog.push(entry.model);
	const sortedCatalog = [...catalog].sort((a, b) => compareIds(a.id, b.id));
	const sortedQuarantine = sortByQuarantineId([...requiredQuarantine.values()]);
	const sortedDeprecated = [...resultDeprecated].sort((a, b) => compareIds(a.id, b.id));
	const modelsChanged = renderModelsPayload(previous.models) !== renderModelsPayload(sortedCatalog);
	const quarantineChangedFlag = quarantineChanged(sortedQuarantine, sortByQuarantineId(previous.quarantine));
	const deprecatedChanged = renderDeprecatedFile(previous.deprecated) !== renderDeprecatedFile(sortedDeprecated);
	const transitioned = modelsChanged || quarantineChangedFlag || deprecatedChanged;
	const stats = {
		known: provider.models.size,
		live: liveSet.size,
		quarantined: sortedQuarantine.length,
		deprecated: sortedDeprecated.filter((entry) => entry.evictedAt === void 0).length,
		evicted,
		resurrected
	};
	return {
		catalog: sortedCatalog,
		quarantine: sortedQuarantine,
		deprecated: sortedDeprecated,
		generatedAt: transitioned || previous.generatedAt === void 0 ? nowIso : previous.generatedAt,
		transitioned,
		stats
	};
}
//#endregion
//#region src/catalog-parse.ts
/**
* Committed catalog-entry parser (the models.json model shape).
*
* The committed artifact format is this toolchain's own: camelCase fields,
* flattened tiers (threshold/tierType) and normalized reasoning kinds. State
* files cross the boundary as `unknown`, so corruption or hand-editing —
* unsafe ids, duplicate modalities, impossible numbers — is caught here with
* a typed `undefined` result that the caller turns into a StateFileParseError.
*/
function parseProtocol$1(value) {
	if (!isString(value)) return void 0;
	return PROTOCOLS.find((protocol) => protocol === value);
}
function parsePrice(value) {
	if (!isRecord(value)) return void 0;
	if (!isNonnegativeFiniteNumber(value.input) || !isNonnegativeFiniteNumber(value.output)) return void 0;
	const cacheRead = value.cacheRead === void 0 ? void 0 : isNonnegativeFiniteNumber(value.cacheRead) ? value.cacheRead : null;
	const cacheWrite = value.cacheWrite === void 0 ? void 0 : isNonnegativeFiniteNumber(value.cacheWrite) ? value.cacheWrite : null;
	if (cacheRead === null || cacheWrite === null) return void 0;
	return {
		input: value.input,
		output: value.output,
		...cacheRead === void 0 ? {} : { cacheRead },
		...cacheWrite === void 0 ? {} : { cacheWrite }
	};
}
/** Only the documented "context" tier type is accepted. */
function parseTier(value) {
	const base = parsePrice(value);
	if (base === void 0 || !isRecord(value)) return void 0;
	const threshold = isPositiveInteger(value.threshold) ? value.threshold : void 0;
	const tierType = isString(value.tierType) && value.tierType === "context" ? value.tierType : void 0;
	if (threshold === void 0 || tierType === void 0) return void 0;
	return {
		...base,
		threshold,
		tierType
	};
}
/** Effort values must be safe, nonempty and unique (nulls are schema-allowed). */
function parseEffortValues(value) {
	if (!Array.isArray(value)) return void 0;
	const seen = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (entry === null) continue;
		if (!isString(entry) || !isSafeModelId(entry) || seen.has(entry)) return void 0;
		seen.add(entry);
	}
	return value;
}
function parseReasoningOption(value) {
	if (!isRecord(value)) return void 0;
	if (value.kind === "toggle") return { kind: "toggle" };
	if (value.kind === "effort") {
		const values = parseEffortValues(value.values);
		if (values === void 0) return void 0;
		return {
			kind: "effort",
			values
		};
	}
	if (value.kind === "budgetTokens") {
		const min = value.min === void 0 ? void 0 : isNonnegativeFiniteNumber(value.min) && Number.isInteger(value.min) ? value.min : null;
		const max = value.max === void 0 ? void 0 : isNonnegativeFiniteNumber(value.max) && Number.isInteger(value.max) ? value.max : null;
		if (min === null || max === null) return void 0;
		if (min !== void 0 && max !== void 0 && min > max) return void 0;
		return {
			kind: "budgetTokens",
			...min === void 0 ? {} : { min },
			...max === void 0 ? {} : { max }
		};
	}
}
function parseInterleaved(value) {
	if (!isRecord(value) || !isSafeText(value.field)) return void 0;
	return { field: value.field };
}
/** Input modalities must be documented literals, each listed once. */
function parseInputModalities(value) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value)) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const entry of value) {
		if (!isString(entry)) return void 0;
		const literal = MODALITY_LITERALS.find((candidate) => candidate === entry);
		if (literal === void 0) return void 0;
		if (seen.has(literal)) return void 0;
		seen.add(literal);
		out.push(literal);
	}
	return out;
}
/** Parse one committed catalog model; `undefined` means malformed. */
function parseCatalogModel(value) {
	if (!isRecord(value)) return void 0;
	const id = isSafeModelId(value.id) ? value.id : void 0;
	const name = isSafeText(value.name) ? value.name : void 0;
	const baseUrl = parseBaseUrl(value.baseUrl);
	const provider = isString(value.provider) ? value.provider : void 0;
	const protocol = parseProtocol$1(value.protocol);
	const contextWindow = isPositiveInteger(value.contextWindow) ? value.contextWindow : void 0;
	const maxTokens = isPositiveInteger(value.maxTokens) ? value.maxTokens : void 0;
	const reasoning = isBoolean(value.reasoning) ? value.reasoning : void 0;
	if (id === void 0 || name === void 0 || baseUrl === void 0 || provider !== "opencode-go" || protocol === void 0 || contextWindow === void 0 || maxTokens === void 0 || reasoning === void 0) return;
	const input = parseInputModalities(value.input);
	if (value.input !== void 0 && input === void 0) return void 0;
	let cost;
	if (value.cost !== void 0) {
		if (!isRecord(value.cost)) return void 0;
		const base = parsePrice(value.cost);
		if (base === void 0) return void 0;
		let tiers;
		if (value.cost.tiers !== void 0) {
			if (!Array.isArray(value.cost.tiers)) return void 0;
			const parsed = [];
			for (const raw of value.cost.tiers) {
				const tier = parseTier(raw);
				if (tier === void 0) return void 0;
				parsed.push(tier);
			}
			tiers = parsed;
		}
		let contextOver200k;
		if (value.cost.contextOver200k !== void 0) {
			const over = parsePrice(value.cost.contextOver200k);
			if (over === void 0) return void 0;
			contextOver200k = over;
		}
		cost = {
			...base,
			...tiers === void 0 ? {} : { tiers },
			...contextOver200k === void 0 ? {} : { contextOver200k }
		};
	}
	let reasoningOptions;
	if (value.reasoningOptions !== void 0) {
		if (!Array.isArray(value.reasoningOptions)) return void 0;
		const options = [];
		for (const raw of value.reasoningOptions) {
			const option = parseReasoningOption(raw);
			if (option === void 0) return void 0;
			options.push(option);
		}
		reasoningOptions = options;
	}
	const interleaved = value.interleaved === void 0 ? void 0 : parseInterleaved(value.interleaved);
	if (value.interleaved !== void 0 && interleaved === void 0) return void 0;
	return {
		id,
		name,
		protocol,
		provider: PROVIDER_ID,
		baseUrl,
		...input === void 0 ? {} : { input },
		contextWindow,
		maxTokens,
		reasoning,
		...reasoningOptions === void 0 ? {} : { reasoningOptions },
		...interleaved === void 0 ? {} : { interleaved },
		...cost === void 0 ? {} : { cost }
	};
}
//#endregion
//#region src/state-file.ts
/**
* Committed artifact parsers (models.json, quarantine.json, deprecated.json,
* patches.json).
*
* These files are generated by this toolchain, but they still cross the
* boundary as `unknown` so corruption or hand-editing is caught with an
* actionable typed error instead of leaking `any` into reconciliation. Every
* persisted timestamp must be a canonical finite ISO-8601 instant, every id
* must be a safe canonical model id, and duplicate ids are rejected.
*/
/** Malformed committed artifact (bad JSON or shape). */
var StateFileParseError = class extends Error {
	name = "StateFileParseError";
	constructor(what, reason) {
		super(`state artifact ${what} is malformed: ${reason}`);
	}
};
/** Parse JSON text and wrap syntax errors into StateFileParseError. */
function parseJsonFile(text, what) {
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw new StateFileParseError(what, "not valid JSON");
	}
}
function parseProtocol(value) {
	if (!isString(value)) return void 0;
	return PROTOCOLS.find((protocol) => protocol === value);
}
function parseQuarantineSource(value) {
	if (!isString(value)) return void 0;
	return QUARANTINE_SOURCES.find((source) => source === value);
}
function parseQuarantineReasonCode(value) {
	if (!isString(value)) return void 0;
	return QUARANTINE_REASON_CODES.find((code) => code === value);
}
function parseAvailability(value) {
	if (!isRecord(value)) return void 0;
	if (value.kind === "unverified") return { kind: "unverified" };
	if (value.kind === "verified" && (value.liveSource === "live" || value.liveSource === "fixture")) return {
		kind: "verified",
		liveSource: value.liveSource
	};
}
/** Provenance must be safe text (nonempty, control-free). */
function parseProvenance(value) {
	if (!isSafeText(value)) return void 0;
	return value;
}
/** Parse the models.json manifest into generatedAt, provenance, availability and models. */
function parseModelsManifest(value) {
	if (!isRecord(value) || !isCanonicalIsoInstant(value.generatedAt) || !isUnknownArray(value.models)) throw new StateFileParseError("models.json", "must be an object with a canonical generatedAt and a models array");
	const provenance = parseProvenance(value.provenance);
	if (provenance === void 0) throw new StateFileParseError("models.json", "must carry a nonempty provenance string");
	const availability = parseAvailability(value.availability);
	if (availability === void 0) throw new StateFileParseError("models.json", "must carry a valid availability marker");
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of value.models) {
		const model = parseCatalogModel(entry);
		if (model === void 0) throw new StateFileParseError("models.json", "model entry is not a valid catalog model");
		if (seen.has(model.id)) throw new StateFileParseError("models.json", `duplicate model id "${model.id}"`);
		seen.add(model.id);
		models.push(model);
	}
	return {
		generatedAt: value.generatedAt,
		provenance,
		availability,
		models
	};
}
/** Parse the quarantine.json artifact. */
function parseQuarantineFile(value) {
	if (!isUnknownArray(value)) throw new StateFileParseError("quarantine.json", "must be an array");
	const records = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (!isRecord(entry)) throw new StateFileParseError("quarantine.json", "entry must be an object");
		const id = isSafeModelId(entry.id) ? entry.id : void 0;
		const detectedAt = isCanonicalIsoInstant(entry.detectedAt) ? entry.detectedAt : void 0;
		const source = parseQuarantineSource(entry.source);
		const reasonCode = parseQuarantineReasonCode(entry.reasonCode);
		if (id === void 0 || detectedAt === void 0 || source === void 0 || reasonCode === void 0) throw new StateFileParseError("quarantine.json", "entry must carry a safe id, a canonical detectedAt, source and reasonCode");
		if (seen.has(id)) throw new StateFileParseError("quarantine.json", `duplicate quarantine id "${id}"`);
		seen.add(id);
		records.push({
			id,
			detectedAt,
			source,
			reasonCode
		});
	}
	return records;
}
/** Parse the deprecated.json artifact (grace entries plus eviction tombstones). */
function parseDeprecatedFile(value) {
	if (!isUnknownArray(value)) throw new StateFileParseError("deprecated.json", "must be an array");
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (!isRecord(entry)) throw new StateFileParseError("deprecated.json", "entry must be an object");
		const id = isSafeModelId(entry.id) ? entry.id : void 0;
		if (id === void 0 || !isCanonicalIsoInstant(entry.deprecatedAt)) throw new StateFileParseError("deprecated.json", "entry must carry a safe id and a canonical deprecatedAt");
		const evictedAt = entry.evictedAt === void 0 ? void 0 : isCanonicalIsoInstant(entry.evictedAt) ? entry.evictedAt : null;
		if (evictedAt === null) throw new StateFileParseError("deprecated.json", `entry ${id} has a non-canonical evictedAt`);
		if (evictedAt !== void 0 && Date.parse(evictedAt) <= Date.parse(entry.deprecatedAt) + 12096e5) throw new StateFileParseError("deprecated.json", `entry ${id} evictedAt must be strictly later than deprecatedAt + 14 days`);
		const model = parseCatalogModel(entry.model);
		if (model === void 0) throw new StateFileParseError("deprecated.json", `entry ${id} lacks a valid frozen model`);
		if (model.id !== id) throw new StateFileParseError("deprecated.json", `entry id "${id}" differs from frozen model id "${model.id}"`);
		if (seen.has(id)) throw new StateFileParseError("deprecated.json", `duplicate deprecated id "${id}"`);
		seen.add(id);
		entries.push({
			id,
			deprecatedAt: entry.deprecatedAt,
			...evictedAt === void 0 ? {} : { evictedAt },
			model
		});
	}
	return entries;
}
function parseBaseUrlPatch(value) {
	if (!isRecord(value)) return;
	const baseUrl = parseBaseUrl(value.baseUrl);
	if (baseUrl === void 0 || !isSafeText(value.evidence)) return;
	return {
		baseUrl,
		evidence: value.evidence
	};
}
/** Parse the patches.json artifact; an absent map means no patches. */
function parsePatchesFile(value) {
	if (!isRecord(value)) throw new StateFileParseError("patches.json", "must be an object");
	const raw = value.baseUrlByProtocol;
	if (raw !== void 0 && !isRecord(raw)) throw new StateFileParseError("patches.json", "baseUrlByProtocol must be an object when present");
	const baseUrlByProtocol = {};
	if (raw !== void 0) for (const [key, patchRaw] of Object.entries(raw)) {
		const protocol = parseProtocol(key);
		if (protocol === void 0) throw new StateFileParseError("patches.json", `unknown protocol key "${key}"`);
		const patch = parseBaseUrlPatch(patchRaw);
		if (patch === void 0) throw new StateFileParseError("patches.json", `patch for "${key}" must carry baseUrl and evidence strings`);
		baseUrlByProtocol[protocol] = patch;
	}
	return { baseUrlByProtocol };
}
//#endregion
//#region src/index.ts
/** Stable plugin name, must match the patch row and package.json. */
const name = PLUGIN_NAME;
const apiKeyEnv = API_KEY_ENV;
const bundleRowId = BUNDLE_ROW_ID;
const providerRoute = PROVIDER_ROUTE;
/** Machine-consumed provider contract surfaced by the Host entry. */
const provider = {
	name: PLUGIN_NAME,
	route: PROVIDER_ROUTE,
	bundleRow: BUNDLE_ROW_ID,
	apiKeyEnv: API_KEY_ENV
};
/**
* Cordis plugin factory. Later todos register the provider's reversible
* effects (settings namespace, credentials, adapter, catalog sync) on this
* context; the row stays mountable and typed in the meantime.
*/
function apply(ctx) {}
//#endregion
export { FOURTEEN_DAYS_MS, PROTOCOLS, PROVIDER_ID, QUARANTINE_REASON_CODES, QUARANTINE_SOURCES, apiKeyEnv, apply, bundleRowId, compareIds, name, parseDeprecatedFile, parseJsonFile, parseLiveIds, parseModelsDevProvider, parseModelsManifest, parsePatchesFile, parseQuarantineFile, provider, providerRoute, reconcile, renderDeprecatedFile, renderModelsManifest, renderPatchesFile, renderQuarantineFile, sdkToProtocol };
