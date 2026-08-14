import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, INVALID_CREDENTIAL_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, assertUsableApiKey, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError } from "@deepseek-ai/dsh-llm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, createProvider, getSupportedThinkingLevels, isContextOverflow } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import "@deepseek-ai/cordis";
import { deepEqualJson, settingsNamespace } from "@deepseek-ai/dsh-settings";
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
/** Display name served by the provider directory and selectors. */
const DISPLAY_NAME = "OpenCode Go";
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
/**
* True when `value` is a canonical API key: nonempty, already trimmed, and
* free of whitespace and control characters. Non-canonical keys are rejected,
* never silently trimmed or mutated.
*/
function isCanonicalApiKey(value) {
	if (typeof value !== "string" || value === "") return false;
	if (value !== value.trim()) return false;
	return !WHITESPACE_OR_CONTROL.test(value);
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
//#region src/config.ts
/**
* Configuration schema and per-operation snapshot for the OpenCode Go
* provider.
*
* The schema owns per-field validation (intervals are positive finite
* integers within the timer bound; `apiKeyEnv` is marked as a credential
* reference position so redaction covers it); `assertServiceable` owns the
* constraints the schema cannot express — the exact key set (a literal key
* or custom header is an unknown key and is refused), the cross-field
* invariants, and the POSIX reference shape; `resolveConfig` detaches and
* freezes the per-operation snapshot with the reference branded through the
* public `credentialRef` helper.
*/
/** Canonical defaults: 60-minute refresh, 5-minute freshness, 10s timeout, 14-day grace. */
const DEFAULTS = {
	apiKeyEnv: "OPENCODE_GO_API_KEY",
	refreshMs: 36e5,
	freshnessMs: 3e5,
	timeoutMs: 1e4,
	graceMs: 12096e5
};
/** The exact declared key set; anything else is refused by assertServiceable. */
const CONFIG_KEYS = [
	"apiKeyEnv",
	"refreshMs",
	"freshnessMs",
	"timeoutMs",
	"graceMs"
];
const interval = (defaultMs) => z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(defaultMs);
/**
* Schemastery schema resolving the section; defaults fill an empty section.
* The input shape is the section (all fields optional), the output shape is
* {@link Config} (defaults materialized). Unknown keys are preserved by
* schemastery's object merge and refused by {@link assertServiceable}.
*/
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULTS.apiKeyEnv),
	refreshMs: interval(DEFAULTS.refreshMs),
	freshnessMs: interval(DEFAULTS.freshnessMs),
	timeoutMs: interval(DEFAULTS.timeoutMs),
	graceMs: interval(DEFAULTS.graceMs)
});
/**
* Refuse a resolved section this provider could not act on. Registered as the
* settings namespace's validator, so an unserviceable section is refused where
* it is written instead of being stored and silently breaking the operation.
* The error message never echoes any value — only the offending key name.
* @param config - the schema-resolved section.
* @throws Error naming the offending key.
*/
function assertServiceable(config) {
	for (const key of Object.keys(config)) if (!CONFIG_KEYS.some((declared) => declared === key)) throw new Error(`${BUNDLE_ROW_ID}: configuration key "${key}" is not supported and was refused`);
	if (config.freshnessMs > config.refreshMs) throw new Error(`${BUNDLE_ROW_ID}: freshnessMs (${config.freshnessMs}) must not exceed refreshMs (${config.refreshMs})`);
	if (config.timeoutMs > config.refreshMs) throw new Error(`${BUNDLE_ROW_ID}: timeoutMs (${config.timeoutMs}) must not exceed refreshMs (${config.refreshMs})`);
	try {
		credentialRef(config.apiKeyEnv);
	} catch {
		throw new Error(`${BUNDLE_ROW_ID}: apiKeyEnv must be a credential reference (a POSIX shell identifier such as OPENCODE_GO_API_KEY)`);
	}
}
/**
* Detach a frozen per-operation snapshot from a schema-resolved section.
* Branding happens here, once per operation, through the public
* `credentialRef` helper — the section keeps a plain string so configuration
* surfaces render it as a text field.
* @param raw - the schema-resolved section.
* @returns a frozen, detached snapshot safe to hand across module boundaries.
*/
function resolveConfig(raw) {
	assertServiceable(raw);
	return Object.freeze({
		apiKeyEnv: credentialRef(raw.apiKeyEnv),
		refreshMs: raw.refreshMs,
		freshnessMs: raw.freshnessMs,
		timeoutMs: raw.timeoutMs,
		graceMs: raw.graceMs
	});
}
//#endregion
//#region src/credentials.ts
/** Stable machine code for an absent credential (string literal, per DSH convention). */
const MISSING_CREDENTIAL_CODE = "MISSING_CREDENTIAL";
function missingMessage(ref) {
	return `${BUNDLE_ROW_ID}: no credential for provider route "${PROVIDER_ROUTE}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the web Models page writes it) or export it in the launching environment`;
}
function nonCanonicalMessage(ref) {
	return `${BUNDLE_ROW_ID}: the API key resolved from ${ref} is not canonical (it carries whitespace or control characters); set ${ref} to the raw key alone — it is never trimmed or rewritten`;
}
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
async function resolveApiKey(ctx, ref) {
	const credentials = ctx.get("credentials");
	const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value : launchEnvironmentOf(ctx).get(ref)?.value;
	if (hit !== void 0 && hit.length > 0) {
		if (!isCanonicalApiKey(hit)) throw new LlmError(nonCanonicalMessage(ref), INVALID_CREDENTIAL_CODE);
		return assertUsableApiKey(hit, BUNDLE_ROW_ID, ref);
	}
	throw new LlmError(missingMessage(ref), MISSING_CREDENTIAL_CODE);
}
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
async function withResolvedKey(ctx, ref, run) {
	return run(await resolveApiKey(ctx, ref));
}
//#endregion
//#region src/catalog-loader.ts
/**
* Embedded catalog loader for the OpenCode Go provider.
*
* Reads the committed `catalog/models.json` artifact (Task 3) through the
* boundary parsers and memoizes the parsed model list. The loader is lazy and
* read-only: it performs no network, no writes, and no credential resolution,
* so catalog browsing works while the provider is fully disconnected. The
* catalog is public metadata — never a secret — so memoization is safe and
* required for deterministic builds and tests.
*/
const ARTIFACT = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog", "models.json");
let memoized;
/**
* Return the parsed embedded catalog models, ascending by id (the artifact is
* already sorted; the parsers preserve order).
* @returns the catalog models.
*/
function embeddedCatalogModels() {
	if (memoized === void 0) memoized = parseModelsManifest(parseJsonFile(readFileSync(ARTIFACT, "utf8"), "models.json")).models;
	return memoized;
}
//#endregion
//#region src/errors.ts
/**
* Stable error taxonomy for the OpenCode Go adapter.
*
* Every failure an operation can produce carries one machine-routable code.
* HTTP status classes, transport conditions, idle timeout and caller abort map
* deterministically; anything unrecognized keeps the catch-all `PI_AI_ERROR`
* so a terminal outcome always has a stable code and never fabricates success.
*/
/** Credential/authorization failures (HTTP 401/403). */
const AUTH = "AUTH";
/** Provider rate limiting (HTTP 429). */
const RATE_LIMIT = "RATE_LIMIT";
/** Provider-side server failures (HTTP 5xx). */
const SERVER = "SERVER";
/** Connection, DNS, socket or stream failures. */
const TRANSPORT = "TRANSPORT";
/** The configured per-operation idle deadline elapsed. */
const TIMEOUT = "TIMEOUT";
/** The caller cancelled the request. */
const ABORTED = "ABORTED";
/** HTTP 400 / invalid request wording. */
const INVALID_REQUEST = "INVALID_REQUEST";
/** Provider error text no stable class matches. */
const PI_AI_ERROR = "PI_AI_ERROR";
/** A model id the catalog does not describe. */
const UNKNOWN_MODEL = "UNKNOWN_MODEL";
/** A provider route this adapter does not own. */
const NO_ADAPTER = "NO_ADAPTER";
/** A request option the transports cannot express. */
const UNSUPPORTED_OPTION = "UNSUPPORTED_OPTION";
/** Media or message content the selected model cannot carry. */
const UNSUPPORTED_CONTENT = "UNSUPPORTED_CONTENT";
/** A reasoning effort the selected model does not offer. */
const UNSUPPORTED_REASONING_EFFORT = "UNSUPPORTED_REASONING_EFFORT";
/** Catalog metadata naming a wire protocol this bundle cannot serve. */
const UNSUPPORTED_PROTOCOL = "UNSUPPORTED_PROTOCOL";
/** A pi-ai event stream ended without a terminal event. */
const STREAM_CLOSED = "STREAM_CLOSED";
/** Durable replay metadata failed validation. */
const INVALID_REPLAY_STATE = "INVALID_REPLAY_STATE";
/** Construct one typed adapter failure with the stable code taxonomy. */
function llmError(message, code, options) {
	return new LlmError(message, code, options);
}
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
function classifyProviderFailure(detail) {
	if (/\b(?:401|403)\b/.test(detail)) return AUTH;
	if (/\b429\b|rate.?limit/i.test(detail)) return RATE_LIMIT;
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	if (/\b5\d\d\b/.test(detail)) return SERVER;
	if (/\b400\b|invalid.?request/i.test(detail)) return INVALID_REQUEST;
	if (/\btime(?:d)?\s*out\b|timeout/i.test(detail)) return TIMEOUT;
	if (/stream ended (?:before|without)\b/i.test(detail)) return TRANSPORT;
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(detail) || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(detail) || /\bterminated\b|premature close/i.test(detail)) return TRANSPORT;
	return PI_AI_ERROR;
}
//#endregion
//#region src/replay-state.ts
/**
* Parse durable tool-call argument JSON. Malformed JSON or a value that is not
* a plain object (array, null, primitive) is a broken durable history and
* fails with `INVALID_REPLAY_STATE` — never silently replaced by {}.
*/
function parseArguments(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return invalidReplay$1("tool-call arguments are not valid JSON");
	}
	if (!isRecord(parsed)) return invalidReplay$1("tool-call arguments must be a JSON object");
	return parsed;
}
/** The zero usage value required by historical pi-ai messages. */
function emptyPiUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
/**
* Project a successful pi-ai response into the minimal durable replay state.
* @param message - completed native pi-ai assistant response.
* @returns the versioned lossless-JSON replay projection.
*/
function toReplayState(message) {
	return {
		kind: "opencode-go",
		version: 1,
		api: message.api,
		provider: message.provider,
		model: message.model,
		...message.responseModel === void 0 ? {} : { responseModel: message.responseModel },
		...message.responseId === void 0 ? {} : { responseId: message.responseId },
		stopReason: message.stopReason,
		blocks: message.content.map((block) => {
			if (block.type === "text") return {
				type: "text",
				...block.textSignature === void 0 ? {} : { textSignature: block.textSignature }
			};
			if (block.type === "thinking") return {
				type: "reasoning",
				...block.thinkingSignature === void 0 ? {} : { thinkingSignature: block.thinkingSignature },
				...block.redacted === void 0 ? {} : { redacted: block.redacted }
			};
			return {
				type: "tool-call",
				...block.thoughtSignature === void 0 ? {} : { thoughtSignature: block.thoughtSignature }
			};
		})
	};
}
function invalidReplay$1(message) {
	throw new LlmError(`invalid opencode-go replay state: ${message}`, INVALID_REPLAY_STATE);
}
/** Narrow one optional string field, rejecting any non-string value. */
function optionalString(entry, key, index) {
	const value = entry[key];
	if (value === void 0) return void 0;
	if (typeof value !== "string") return invalidReplay$1(`block ${index} ${key} must be a string`);
	return value;
}
/** Narrow one optional boolean field, rejecting any non-boolean value. */
function optionalBoolean(entry, key, index) {
	const value = entry[key];
	if (value === void 0) return void 0;
	if (typeof value !== "boolean") return invalidReplay$1(`block ${index} ${key} must be boolean`);
	return value;
}
/** Wire protocols this bundle's replay projection may name. */
const SUPPORTED_REPLAY_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages"
];
/**
* Validate the adapter-private state before it reaches pi-ai. Every field is
* narrowed by inspection; no value is trusted as the declared type, and a
* replay naming a wire protocol this bundle cannot serve is refused.
*/
function readReplayState(value) {
	if (!isRecord(value)) return invalidReplay$1("expected an object");
	if (value["kind"] !== "opencode-go") return invalidReplay$1("unknown state kind");
	if (value["version"] !== 1) return invalidReplay$1(`unsupported version ${String(value["version"])}`);
	const api = value["api"];
	const supportedApi = SUPPORTED_REPLAY_APIS.find((candidate) => candidate === api);
	if (supportedApi === void 0) return invalidReplay$1("unsupported api; only the opencode-go transport protocols can be replayed");
	const provider = value["provider"];
	if (typeof provider !== "string" || provider.length === 0) return invalidReplay$1("provider must be a non-empty string");
	const model = value["model"];
	if (typeof model !== "string" || model.length === 0) return invalidReplay$1("model must be a non-empty string");
	const stopReason = [
		"stop",
		"length",
		"toolUse",
		"error",
		"aborted"
	].find((reason) => reason === value["stopReason"]);
	if (stopReason === void 0) return invalidReplay$1("unknown stopReason");
	const responseModel = value["responseModel"];
	if (responseModel !== void 0 && typeof responseModel !== "string") return invalidReplay$1("responseModel must be a string");
	const responseId = value["responseId"];
	if (responseId !== void 0 && typeof responseId !== "string") return invalidReplay$1("responseId must be a string");
	const rawBlocks = value["blocks"];
	if (!Array.isArray(rawBlocks)) return invalidReplay$1("blocks must be an array");
	const blocks = [];
	for (const [index, entry] of rawBlocks.entries()) {
		if (!isRecord(entry)) return invalidReplay$1(`block ${index} must be an object`);
		const kind = [
			"text",
			"reasoning",
			"tool-call"
		].find((candidate) => candidate === entry["type"]);
		if (kind === void 0) return invalidReplay$1(`block ${index} has an unknown type`);
		const textSignature = optionalString(entry, "textSignature", index);
		const thinkingSignature = optionalString(entry, "thinkingSignature", index);
		const thoughtSignature = optionalString(entry, "thoughtSignature", index);
		const redacted = optionalBoolean(entry, "redacted", index);
		if (kind === "text") blocks.push({
			type: "text",
			...textSignature === void 0 ? {} : { textSignature }
		});
		else if (kind === "reasoning") blocks.push({
			type: "reasoning",
			...thinkingSignature === void 0 ? {} : { thinkingSignature },
			...redacted === void 0 ? {} : { redacted }
		});
		else blocks.push({
			type: "tool-call",
			...thoughtSignature === void 0 ? {} : { thoughtSignature }
		});
	}
	return {
		kind: "opencode-go",
		version: 1,
		api: supportedApi,
		provider,
		model,
		...responseModel === void 0 ? {} : { responseModel },
		...responseId === void 0 ? {} : { responseId },
		stopReason,
		blocks
	};
}
//#endregion
//#region src/replay.ts
function invalidReplay(message) {
	throw new LlmError(`invalid opencode-go replay state: ${message}`, INVALID_REPLAY_STATE);
}
/** Convert provider-neutral blocks without trusting them as same-model replay. */
function foreignAssistant(message) {
	const source = message.source.kind === "model" ? message.source : void 0;
	const content = [];
	for (const block of message.content) if (block.type === "text") content.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "reasoning") content.push({
		type: "thinking",
		thinking: block.text
	});
	else if (block.type === "tool-call") content.push({
		type: "toolCall",
		id: block.id,
		name: block.name,
		arguments: parseArguments(block.arguments)
	});
	else if (block.type === "image") throw new LlmError("opencode-go chat history cannot represent structured assistant image output", "UNSUPPORTED_CONTENT");
	return {
		role: "assistant",
		content,
		api: "dsh-foreign",
		provider: source?.provider ?? "dsh-foreign",
		model: source?.model ?? "dsh-foreign",
		usage: emptyPiUsage(),
		stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0
	};
}
/** Recombine durable Harness content with validated replay metadata. */
function replayedAssistant(message, rawState) {
	const state = readReplayState(rawState);
	const source = message.source.kind === "model" ? message.source : void 0;
	if (state.provider !== source?.provider) return invalidReplay("provider does not match assistant source");
	if (state.model !== source.model) return invalidReplay("model does not match assistant source");
	if (state.blocks.length !== message.content.length) return invalidReplay("block count does not match assistant content");
	return {
		role: "assistant",
		content: message.content.map((block, index) => {
			const replay = state.blocks[index];
			if (replay === void 0 || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`);
			if (block.type === "text") return {
				type: "text",
				text: block.text,
				...replay.type === "text" && replay.textSignature !== void 0 ? { textSignature: replay.textSignature } : {}
			};
			if (block.type === "reasoning") return {
				type: "thinking",
				thinking: block.text,
				...replay.type === "reasoning" && replay.thinkingSignature !== void 0 ? { thinkingSignature: replay.thinkingSignature } : {},
				...replay.type === "reasoning" && replay.redacted !== void 0 ? { redacted: replay.redacted } : {}
			};
			return {
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: parseArguments(block.arguments),
				...replay.type === "tool-call" && replay.thoughtSignature !== void 0 ? { thoughtSignature: replay.thoughtSignature } : {}
			};
		}),
		api: state.api,
		provider: state.provider,
		model: state.model,
		...state.responseModel === void 0 ? {} : { responseModel: state.responseModel },
		...state.responseId === void 0 ? {} : { responseId: state.responseId },
		usage: emptyPiUsage(),
		stopReason: state.stopReason,
		timestamp: 0
	};
}
/**
* Convert one durable Harness assistant message into pi-ai history.
* @param message - assistant content with required source and optional adapter-owned replay metadata.
* @returns a native pi-ai assistant message reconstructed from durable content.
*/
function toPiAssistant(message) {
	const source = message.source;
	return source.kind !== "model" || source.replayState === void 0 ? foreignAssistant(message) : replayedAssistant(message, source.replayState);
}
//#endregion
//#region src/context.ts
/** Join the text blocks of one harness message. */
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Flatten text recursively inside one tool result's content. */
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : "").join("");
}
/**
* Resolve the tool name for one tool result. A result whose call id matches no
* assistant tool call in the request is a broken conversation and fails before
* network instead of fabricating a name.
*/
function toolNameOf(toolNames, result) {
	const toolName = toolNames.get(result.toolCallId);
	if (toolName === void 0) throw new LlmError(`opencode-go tool result for call "${result.toolCallId}" has no matching assistant tool call`, INVALID_REQUEST);
	return toolName;
}
/** Convert user-role blocks into pi-ai content, resolving images via the store. */
async function userContent(blocks, attachments) {
	const content = [];
	for (const block of blocks) {
		if (block.type === "text") {
			if (block.text.length > 0) content.push({
				type: "text",
				text: block.text
			});
			continue;
		}
		if (block.type === "image") {
			const stored = await attachments.readImage(block.attachment);
			content.push({
				type: "image",
				data: Buffer.from(stored.data).toString("base64"),
				mimeType: stored.ref.mediaType
			});
			continue;
		}
		if (block.type === "tool-result") {
			const nested = await userContent(block.content, attachments);
			if (typeof nested === "string") {
				if (nested.length > 0) content.push({
					type: "text",
					text: nested
				});
			} else content.push(...nested);
		}
	}
	if (content.every((piece) => piece.type === "text")) return content.map((piece) => piece.text).join("");
	return content;
}
/** Map harness tools into pi-ai tools (name/description/parameters). */
function toolsOf(options) {
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	return tools !== void 0 && tools.length > 0 ? tools : void 0;
}
/** Assemble the request-level pi-ai context envelope. */
function piContext(options, messages) {
	const tools = toolsOf(options);
	return {
		...options.system === void 0 ? {} : { systemPrompt: options.system },
		messages,
		...tools === void 0 ? {} : { tools }
	};
}
/**
* Convert a text-only request into pi-ai context. System messages become user
* role messages (pi-ai carries the system prompt separately), assistant
* messages replay through the projection, and tool results become
* `toolResult` messages correlated by call id.
*/
function textOnlyContext(options) {
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of options.messages) {
		if (contentHasImage(message.content)) throw new LlmError("opencode-go image input requires the durable attachment service", UNSUPPORTED_CONTENT);
		if (message.role === "system") {
			messages.push({
				role: "user",
				content: flattenText(message),
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
			messages.push(assistant);
			continue;
		}
		const text = flattenText(message);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (text.length > 0 || results.length === 0) messages.push({
			role: "user",
			content: text,
			timestamp: 0
		});
		for (const result of results) messages.push({
			role: "toolResult",
			toolCallId: result.toolCallId,
			toolName: toolNameOf(toolNames, result),
			content: [{
				type: "text",
				text: toolResultText(result.content) || "(no output)"
			}],
			isError: result.isError ?? false,
			timestamp: 0
		});
	}
	return piContext(options, messages);
}
/**
* Convert a request (with optional images) into pi-ai context. Without an
* attachment store the image-bearing path refuses before any read.
* @param options - the fully assembled request.
* @param attachments - the durable attachment service, when mounted.
* @returns the pi-ai context envelope.
*/
async function toPiContext(options, attachments) {
	if (attachments === void 0) return textOnlyContext(options);
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of options.messages) {
		if (message.role === "system") {
			if (contentHasImage(message.content)) throw new LlmError("opencode-go cannot represent an image in an in-history system message", UNSUPPORTED_CONTENT);
			messages.push({
				role: "user",
				content: flattenText(message),
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
			messages.push(assistant);
			continue;
		}
		const content = await userContent(message.content.filter((block) => block.type !== "tool-result"), attachments);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (content.length > 0 || results.length === 0) messages.push({
			role: "user",
			content,
			timestamp: 0
		});
		for (const result of results) {
			const resultContent = await userContent(result.content, attachments);
			messages.push({
				role: "toolResult",
				toolCallId: result.toolCallId,
				toolName: toolNameOf(toolNames, result),
				content: typeof resultContent === "string" ? [{
					type: "text",
					text: resultContent || "(no output)"
				}] : resultContent,
				isError: result.isError ?? false,
				timestamp: 0
			});
		}
	}
	return piContext(options, messages);
}
//#endregion
//#region src/provider.ts
/**
* Construction of the pi-ai `Provider` that backs the `opencode-go` route.
*
* The wire protocol is selected per model strictly from the catalog entry's
* `api` field: `createProvider` dispatches on `model.api` through the protocol
* table, so a model reaches exactly the transport its catalog metadata names —
* no id prefixes, no provider-name heuristics, no endpoint probing.
*
* Credentials never enter this module's storage. The harness resolves the
* route's key through its own seam and hands it over as a per-request stream
* option, which pi-ai treats as the highest-priority auth override.
*/
/** The one protocol table: catalog `api` values to pi-ai API implementations. */
const PROTOCOLS$1 = {
	"openai-completions": openAICompletionsApi(),
	"openai-responses": openAIResponsesApi(),
	"anthropic-messages": anthropicMessagesApi()
};
/** Zero rates for a catalog entry that carries no cost metadata. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Narrow catalog modalities to the pi-ai vocabulary, text as the floor. */
function toPiInput(input) {
	const narrowed = (input ?? []).filter((modality) => modality === "text" || modality === "image");
	return narrowed.length === 0 ? ["text"] : [...narrowed];
}
/** Map catalog pricing into the pi-ai cost shape (tiers translate threshold → inputTokensAbove). */
function toPiCost(cost) {
	if (cost === void 0) return { ...NO_COST };
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
		...cost.tiers === void 0 ? {} : { tiers: cost.tiers.map((tier) => ({
			input: tier.input,
			output: tier.output,
			cacheRead: tier.cacheRead ?? 0,
			cacheWrite: tier.cacheWrite ?? 0,
			inputTokensAbove: tier.threshold
		})) }
	};
}
/** Project one embedded catalog entry into the pi-ai model vocabulary. */
function toPiModel(model) {
	return {
		id: model.id,
		name: model.name,
		api: model.protocol,
		provider: PROVIDER_ROUTE,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		input: toPiInput(model.input),
		cost: toPiCost(model.cost),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens
	};
}
/**
* Api-key auth for a route the harness authenticates itself. pi-ai calls this
* after the adapter has already resolved the route's credential, so the key
* arrives in the per-request credential, never in provider storage.
*/
function harnessApiKeyAuth(name) {
	return {
		name,
		resolve: ({ credential }) => Promise.resolve({
			auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
			source: name
		})
	};
}
/**
* Build the single-route pi-ai provider from the embedded catalog. Protocol
* dispatch is entirely per-model `api`, so the catalog metadata is the sole
* transport selector; a catalog entry naming a protocol this bundle cannot
* serve fails at build time with a stable typed code.
* @param models - the embedded catalog entries.
* @returns the provider to register in the adapter's `Models` collection.
*/
function buildProvider(models) {
	for (const model of models) if (PROTOCOLS$1[model.protocol] === void 0) throw llmError(`opencode-go catalog entry "${model.id}" names protocol "${model.protocol}", which this bundle cannot serve`, UNSUPPORTED_PROTOCOL);
	return createProvider({
		id: PROVIDER_ROUTE,
		name: DISPLAY_NAME,
		auth: { apiKey: harnessApiKeyAuth(DISPLAY_NAME) },
		models: models.map(toPiModel),
		api: PROTOCOLS$1
	});
}
//#endregion
//#region src/options.ts
/** Every field of the current public `GenerateOptions` type, audited. */
const SUPPORTED_OPTION_KEYS = [
	"provider",
	"model",
	"reasoningEffort",
	"messages",
	"system",
	"tools",
	"temperature",
	"maxTokens",
	"stop",
	"signal",
	"sessionId",
	"purpose"
];
/** Reject any request option this adapter cannot express, before network. */
function assertSupportedOptions(options) {
	for (const key of Object.keys(options)) if (!SUPPORTED_OPTION_KEYS.some((known) => known === key)) throw llmError(`opencode-go does not support GenerateOptions.${key}`, UNSUPPORTED_OPTION);
	if (options.stop !== void 0) throw llmError("opencode-go does not support GenerateOptions.stop", UNSUPPORTED_OPTION);
	if (options.purpose !== void 0) throw llmError(`opencode-go does not support GenerateOptions.purpose "${options.purpose}"`, UNSUPPORTED_OPTION);
}
//#endregion
//#region src/stream.ts
/**
* pi-ai assistant event translation into the Harness streaming protocol.
*
* pi-ai tool-call arguments are parsed objects while the Harness keeps their
* raw JSON representation, so tool-call deltas are accumulated verbatim and
* published exactly as the wire delivered them — whitespace, numeric spelling,
* unicode escapes and key order included. pi-ai reports failures as terminal
* stream events, which this module maps into error/aborted finish chunks with
* stable codes.
*/
/**
* Map pi-ai usage into harness counts. Cache and reasoning fields appear only
* when present and non-zero; absent fields stay absent (deterministic).
* @param usage - cumulative usage from the terminal pi-ai event.
* @returns the harness token accounting.
*/
function mapUsage(usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
		...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
		...usage.reasoning !== void 0 && usage.reasoning > 0 ? { reasoningTokens: usage.reasoning } : {}
	};
}
/**
* Map a terminal pi-ai event to the harness finish reason. Recognized error
* text, `stop` usage above `contextWindow`, and zero-output `length` usage
* that fills the window map to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no
* content blocks maps to an `EMPTY_RESPONSE` error.
* @param message - the assistant message carried by the `done` or `error` event.
* @param contextWindow - resolved catalog capacity for usage-based overflow detection.
* @returns the mapped harness reason.
*/
function mapFinishReason(message, contextWindow) {
	const piOverflow = isContextOverflow(message, contextWindow);
	const harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);
	if (piOverflow || harnessOverflow) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED_CODE
		}
	};
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: EMPTY_RESPONSE_CODE
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "opencode-go stream aborted",
				code: ABORTED
			}
		};
		case "error": {
			const text = message.errorMessage ?? "opencode-go stream error";
			return {
				kind: "error",
				failure: {
					message: text,
					code: classifyProviderFailure(text)
				}
			};
		}
	}
}
/** True when `text` parses to a plain JSON object (not an array or primitive). */
function isJsonObject(text) {
	try {
		return isRecord(JSON.parse(text));
	} catch {
		return false;
	}
}
/**
* Translate the pi-ai event stream into StreamChunks. pi-ai never throws
* mid-stream — failures arrive as `error` events, which become error/aborted
* `finish` chunks (the harness protocol's other error-delivery style).
* @param events - one assistant turn's pi-ai event stream.
* @param contextWindow - resolved catalog capacity for usage-based overflow detection.
* @returns the harness chunks, ending with `usage` then `finish`; throws
*   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
*/
async function* toStreamChunks(events, contextWindow) {
	const toolIds = /* @__PURE__ */ new Map();
	const rawArguments = /* @__PURE__ */ new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id : "";
			const name = partial?.type === "toolCall" ? partial.name : "";
			toolIds.set(event.contentIndex, {
				id,
				name
			});
			rawArguments.set(event.contentIndex, "");
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			rawArguments.set(event.contentIndex, (rawArguments.get(event.contentIndex) ?? "") + event.delta);
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: CallId(known?.id ?? ""),
				...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
				argumentsDelta: event.delta
			};
			break;
		}
		case "toolcall_end": {
			const raw = rawArguments.get(event.contentIndex);
			rawArguments.delete(event.contentIndex);
			const call = event.toolCall;
			let argumentsText;
			if (raw !== void 0 && raw.length > 0) {
				if (!isJsonObject(raw)) throw llmError(`opencode-go tool call "${call.name}" produced arguments that are not a JSON object`, INVALID_REQUEST);
				argumentsText = raw;
			} else {
				if (!isRecord(call.arguments)) throw llmError(`opencode-go tool call "${call.name}" produced arguments that are not a JSON object`, INVALID_REQUEST);
				argumentsText = JSON.stringify(call.arguments);
			}
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: CallId(call.id),
					name: call.name,
					arguments: argumentsText
				}
			};
			break;
		}
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapFinishReason(event.message, contextWindow),
				replayState: toReplayState(event.message)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapFinishReason(event.error, contextWindow)
			};
			return;
	}
	throw new LlmError("pi-ai event stream ended without done/error", STREAM_CLOSED);
}
//#endregion
//#region src/adapter.ts
/** Watchdog code stamped onto the idle-timeout abort reason. */
const IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** Selectable reasoning levels for one model, or nothing for a non-reasoning model. */
function reasoningInfo(model) {
	if (!model.reasoning) return {};
	return { reasoning: { efforts: getSupportedThinkingLevels(model).map((level) => ({
		id: ReasoningEffortId(level),
		name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`
	})) } };
}
/**
* Validate an explicit reasoning effort against the model's supported levels
* without invoking pi-ai's clamping: an unsupported level fails before network.
*/
function resolveReasoningLevel(model, effort) {
	if (effort === void 0) return void 0;
	const level = getSupportedThinkingLevels(model).find((candidate) => String(candidate) === String(effort));
	if (level === void 0) throw llmError(`opencode-go provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`, UNSUPPORTED_REASONING_EFFORT);
	return level === "off" ? void 0 : level;
}
/**
* OpenCode Go single-route adapter. Each operation reads the current catalog
* and config, so a change reaches the next request without a restart.
*/
var OpenCodeGoAdapter = class extends LlmAdapter {
	deps;
	snapshot;
	constructor(deps) {
		super();
		this.deps = deps;
	}
	/** The snapshot for the current catalog; memoized by collection identity. */
	current() {
		const catalog = this.deps.catalog();
		if (this.snapshot?.catalog === catalog) return this.snapshot;
		const snapshot = {
			catalog,
			index: new Map(catalog.map((model) => [model.id, model])),
			models: createModels()
		};
		snapshot.models.setProvider(buildProvider(catalog));
		this.snapshot = snapshot;
		return snapshot;
	}
	/** Refuse a provider route this adapter does not own. */
	profileOf(provider) {
		if (provider !== "opencode-go") throw llmError(`opencode-go adapter does not own provider "${provider}"`, NO_ADAPTER);
	}
	/** The catalog entry for one exact route/model pair within one snapshot. */
	modelOf(snapshot, provider, model) {
		this.profileOf(provider);
		const entry = snapshot.index.get(model);
		if (entry === void 0) throw llmError(`opencode-go provider has no configured model "${model}"`, UNKNOWN_MODEL);
		return entry;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: DISPLAY_NAME
		};
	}
	async listModels(provider) {
		const snapshot = this.current();
		this.profileOf(provider);
		return snapshot.catalog.map((model) => {
			const modalities = toPiModel(model).input;
			return {
				provider,
				id: model.id,
				name: model.name,
				...modalities.length === 0 ? {} : { inputModalities: modalities }
			};
		});
	}
	async resolveModel(provider, model, _signal) {
		const snapshot = this.current();
		const entry = this.modelOf(snapshot, provider, model);
		const piModel = toPiModel(entry);
		const modalities = piModel.input;
		return {
			provider,
			id: entry.id,
			name: entry.name,
			...modalities.length === 0 ? {} : { inputModalities: modalities },
			context: { contextWindow: entry.contextWindow },
			...reasoningInfo(piModel)
		};
	}
	async *stream(options) {
		const resolved = resolveConfig(this.deps.currentConfig());
		const key = await this.deps.resolveKey(resolved.apiKeyEnv);
		const snapshot = this.current();
		const piModel = toPiModel(this.modelOf(snapshot, options.provider, options.model));
		assertSupportedOptions(options);
		const reasoning = resolveReasoningLevel(piModel, options.reasoningEffort);
		const consumer = new AbortController();
		const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
		const timeoutMs = resolved.timeoutMs;
		const watchdog = idleWatchdog(upstream, timeoutMs, IDLE_TIMEOUT_CODE);
		try {
			const containsImage = options.messages.some((message) => contentHasImage(message.content));
			if (containsImage && !piModel.input.includes("image")) throw llmError(`opencode-go model "${piModel.id}" does not support image input`, UNSUPPORTED_CONTENT);
			const attachments = containsImage ? this.deps.resolveAttachments?.() : void 0;
			if (containsImage && attachments === void 0) throw llmError("opencode-go image input requires the durable attachment service", UNSUPPORTED_CONTENT);
			const context = await toPiContext(options, attachments);
			const iterator = toStreamChunks(snapshot.models.streamSimple(piModel, context, {
				apiKey: key,
				...reasoning === void 0 ? {} : { reasoning },
				...options.temperature === void 0 ? {} : { temperature: options.temperature },
				...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
				...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },
				signal: watchdog.signal,
				timeoutMs,
				maxRetries: 0,
				headers: attributionHeaders()
			}), piModel.contextWindow)[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					const timeout = timeoutOf(watchdog.signal, IDLE_TIMEOUT_CODE);
					if (timeout !== void 0) throw timeout;
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} finally {
				if (!exhausted) {
					consumer.abort("opencode-go stream consumer stopped");
					try {
						await iterator.return(void 0);
					} catch {}
				}
			}
		} catch (error) {
			if (timeoutOf(watchdog.signal, IDLE_TIMEOUT_CODE) !== void 0) throw llmError(`opencode-go stream idle timeout after ${timeoutMs}ms`, TIMEOUT, { cause: error });
			if (options.signal?.aborted) throw llmError("opencode-go request aborted by caller", ABORTED, { cause: error });
			throw error;
		} finally {
			consumer.abort("opencode-go stream consumer stopped");
		}
	}
};
//#endregion
//#region src/service.ts
/**
* Settings namespace owned by this provider; the bundle row id. Annotated with
* the public `SettingsNamespace` brand type so the declaration rollup names the
* public type instead of inlining its underlying representation.
*/
const NS = settingsNamespace(BUNDLE_ROW_ID);
/** The one configurable-provider directory entry: the whole section is the profile. */
const DIRECTORY_ENTRY = {
	provider: PROVIDER_ROUTE,
	displayName: DISPLAY_NAME,
	settingsNs: NS,
	settingsPath: [],
	declared: false
};
/** Config-derived fingerprint gating atomic re-registration. Never throws. */
function registrationFacts(config) {
	return {
		routes: [PROVIDER_ROUTE],
		apiKeyEnv: config.apiKeyEnv,
		refreshMs: config.refreshMs,
		freshnessMs: config.freshnessMs,
		timeoutMs: config.timeoutMs,
		graceMs: config.graceMs
	};
}
/**
* Value mirror of the `FiberState` members compared below: a const enum has
* no runtime object to import, so the values are needed at runtime (same
* rationale as the settings package's own mirror).
*/
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;
/** The plugin fiber is unloading or already disposed: teardown is in progress. */
function isUnloading(ctx) {
	const state = ctx.fiber.state;
	return state === FIBER_UNLOADING || state === FIBER_DISPOSED;
}
/** Cordis plugin factory: mount the provider's reversible Host effects. */
function apply(ctx, rawConfig) {
	const entry = Config(rawConfig ?? {});
	assertServiceable(entry);
	let current = () => entry;
	const adapter = new OpenCodeGoAdapter({
		currentConfig: () => current(),
		resolveKey: (ref) => resolveApiKey(ctx, ref),
		catalog: () => embeddedCatalogModels(),
		resolveAttachments: () => ctx.get("attachments")
	});
	let directory;
	const ensureDirectory = () => {
		if (directory !== void 0) return;
		directory = ctx.llm.registerConfigurableProviders([DIRECTORY_ENTRY]);
	};
	let registration;
	let registeredFacts;
	const ensureRegistration = () => {
		const facts = registrationFacts(current());
		if (deepEqualJson(facts, registeredFacts)) return;
		if (registration === void 0) registration = ctx.llm.registerAdapter([PROVIDER_ROUTE], adapter);
		else registration.replace([PROVIDER_ROUTE]);
		registeredFacts = facts;
	};
	/**
	* Make one validated scope authoritative: point the source thunk at it,
	* register topology, and re-judge topology on committed changes. Called
	* only after a successful registration, so the source is always
	* serviceable — validation is the gate, never a post-hoc filter.
	*/
	const attachScope = (scope) => {
		current = () => scope.get();
		ensureDirectory();
		ensureRegistration();
		scope.watch(() => {
			if (isUnloading(ctx)) return;
			ensureDirectory();
			ensureRegistration();
		});
	};
	const settings = ctx.get("settings");
	if (settings !== void 0) attachScope(settings.register(NS, Config, {
		base: entry,
		validate: assertServiceable
	}));
	else {
		ensureDirectory();
		ensureRegistration();
	}
	ctx.inject(["settings"], (sctx) => {
		sctx.effect(() => () => {
			if (isUnloading(ctx)) return;
			current = () => entry;
			ensureDirectory();
			ensureRegistration();
		});
		if (sctx.settings.get(NS) === void 0) attachScope(sctx.settings.register(NS, Config, {
			base: entry,
			validate: assertServiceable
		}));
	});
}
/** Cordis service dependency: the plugin mounts only once `llm` is available. */
const inject = ["llm"];
//#endregion
//#region src/index.ts
/**
* DSH Host entrypoint for the OpenCode Go provider bundle.
*
* The bundle row `llm-opencode-go` (cordis.patch.yml) mounts this module as a
* Cordis plugin. The plugin factory wires the provider's reversible Host
* effects — settings namespace, per-operation credentials, the configurable-
* provider directory and the owned adapter route — while this entry keeps the
* stable contract values and the verified catalog machinery (reconciliation,
* boundary parsers, deterministic renderers) available to consumers and tests.
*/
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
//#endregion
export { ABORTED, AUTH, Config, DEFAULTS, DIRECTORY_ENTRY, DISPLAY_NAME, FOURTEEN_DAYS_MS, INVALID_REPLAY_STATE, INVALID_REQUEST, MISSING_CREDENTIAL_CODE, NO_ADAPTER, NS, OpenCodeGoAdapter, PI_AI_ERROR, PROTOCOLS, PROVIDER_ID, QUARANTINE_REASON_CODES, QUARANTINE_SOURCES, RATE_LIMIT, SERVER, STREAM_CLOSED, TIMEOUT, TRANSPORT, UNKNOWN_MODEL, UNSUPPORTED_CONTENT, UNSUPPORTED_OPTION, UNSUPPORTED_PROTOCOL, UNSUPPORTED_REASONING_EFFORT, apiKeyEnv, apply, assertServiceable, bundleRowId, classifyProviderFailure, compareIds, embeddedCatalogModels, inject, llmError, name, parseDeprecatedFile, parseJsonFile, parseLiveIds, parseModelsDevProvider, parseModelsManifest, parsePatchesFile, parseQuarantineFile, provider, providerRoute, reconcile, renderDeprecatedFile, renderModelsManifest, renderPatchesFile, renderQuarantineFile, resolveApiKey, resolveConfig, sdkToProtocol, withResolvedKey };
