import { A as renderDeprecatedFile, B as QUARANTINE_REASON_CODES, C as parseJsonFile, D as parseCatalogModel, E as parseQuarantineFile, F as parseLiveIds, G as isUnknownArray, I as parseModelsDevProvider, J as BUNDLE_ROW_ID, K as FOURTEEN_DAYS_MS, L as sdkToProtocol, M as renderModelsPayload, N as renderPatchesFile, O as reconcile, P as renderQuarantineFile, Q as SETTINGS_NS, R as PROTOCOLS, S as parseDeprecatedFile, T as parsePatchesFile, U as isCanonicalIsoInstant, V as QUARANTINE_SOURCES, W as isRecord, X as PLUGIN_NAME, Y as DISPLAY_NAME, Z as PROVIDER_ROUTE, _ as withResolvedKey, a as defaultScheduler, b as assertServiceable, c as CacheError, d as writeCacheAtomic, f as embeddedCatalogManifest, g as resolveApiKey, h as MISSING_CREDENTIAL_CODE, i as nodeFetch, j as renderModelsManifest, k as compareIds, m as embeddedPatches, o as failureMessage, p as embeddedCatalogModels, q as API_KEY_ENV, r as attemptReconcile, s as CACHE_FILE_NAME, t as ProviderControl, u as resolveCachePath, v as Config, w as parseModelsManifest, x as resolveConfig, y as DEFAULTS, z as PROVIDER_ID } from "./control-BDDLl-3Y.js";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError } from "@deepseek-ai/dsh-llm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, createProvider, getSupportedThinkingLevels, isContextOverflow } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import "@deepseek-ai/cordis";
import { deepEqualJson, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { homedir } from "node:os";
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
	if (isRecord(value) && value["kind"] !== "opencode-go" && "response" in value) value = value["response"];
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
		const parsed = JSON.parse(text);
		return isRecord(parsed);
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
				replayState: { response: toReplayState(event.message) }
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
		const snapshot = this.current();
		const resolved = resolveConfig(this.deps.currentConfig());
		const key = await this.deps.resolveKey(resolved.apiKeyEnv);
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
//#region src/control-wiring.ts
/** Observe the lifecycle's sanitized events and recall the last attempt fact. */
function trackLifecycleEvents() {
	let last = { kind: "none" };
	return {
		observe: (event) => {
			if (event.kind === "refresh-ok") last = { kind: "ok" };
			else if (event.kind === "refresh-failed") last = {
				kind: "failed",
				code: event.code
			};
		},
		lastAttempt: () => last
	};
}
/** Read the lifecycle's current sanitized facts into a detached snapshot input. */
function lifecycleFactsOf(lifecycle, lastAttempt) {
	return {
		origin: lifecycle.current().origin,
		modelCount: lifecycle.current().catalog.length,
		refreshedAt: lifecycle.current().refreshedAt,
		lastAttempt,
		attemptsSucceeded: lifecycle.stats.attemptsSucceeded,
		attemptsFailed: lifecycle.stats.attemptsFailed
	};
}
/**
* Build the control seam and provide it on the current (plugin) fiber. The
* credentials store is context-derived: an absent service refuses writes and
* reports unconfigured, mirroring the per-operation credential policy.
*/
function mountControl(ctx, deps) {
	const credentials = ctx.get("credentials");
	const control = new ProviderControl({
		credentials: {
			describe: (ref) => credentials !== void 0 ? credentials.describe(ref) : Promise.resolve({
				configured: false,
				writable: false
			}),
			set: (ref, value) => credentials !== void 0 ? credentials.set(ref, value) : Promise.reject(/* @__PURE__ */ new Error("the credentials service is not mounted")),
			unset: (ref) => credentials !== void 0 ? credentials.unset(ref) : Promise.reject(/* @__PURE__ */ new Error("the credentials service is not mounted"))
		},
		resolveKey: deps.resolveKey,
		currentConfig: deps.current,
		catalog: () => deps.lifecycle.catalog(),
		lifecycleFacts: () => lifecycleFactsOf(deps.lifecycle, deps.tracker.lastAttempt()),
		fetch: deps.fetch,
		clock: { now: () => /* @__PURE__ */ new Date() },
		scheduler: deps.scheduler
	});
	ctx.provide("opencodeGoControl", control);
	return control;
}
//#endregion
//#region src/web-routes.ts
const CONTROL_ROUTES = {
	status: "/plugins/dsh-opencode-go/status",
	connect: "/plugins/dsh-opencode-go/connect",
	disconnect: "/plugins/dsh-opencode-go/disconnect",
	doctor: "/plugins/dsh-opencode-go/doctor"
};
const MAX_BODY_BYTES = 65536;
/** Fatal UTF-8 decoder: any malformed byte throws instead of becoming U+FFFD. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
/** The largest end <= `end` that does not split a UTF-8 sequence. */
function utf8Boundary(buffer, end) {
	let continuations = 0;
	let cut = end;
	while (cut > 0 && (buffer[cut - 1] & 192) === 128) {
		cut -= 1;
		continuations += 1;
	}
	if (cut === 0) return 0;
	const lead = buffer[cut - 1];
	if (lead < 128) return end;
	return continuations >= (lead >= 240 ? 3 : lead >= 224 ? 2 : 1) ? end : cut - 1;
}
function createBodyAccumulator(limit) {
	const chunks = [];
	let total = 0;
	let overflowed = false;
	let decoded;
	return {
		get overflowed() {
			return overflowed;
		},
		accept: (chunk) => {
			if (overflowed) return;
			const room = limit - total;
			if (room <= 0 || chunk.byteLength > room) {
				if (room > 0) {
					const kept = utf8Boundary(chunk, room);
					if (kept > 0) {
						chunks.push(chunk.subarray(0, kept));
						total += kept;
					}
				}
				overflowed = true;
				decoded = void 0;
				return;
			}
			chunks.push(chunk);
			total += chunk.byteLength;
			decoded = void 0;
		},
		decode: () => {
			if (decoded === void 0) decoded = utf8Decoder.decode(Buffer.concat(chunks));
			return decoded;
		}
	};
}
/** A typed refusal with its fixed HTTP status and error category. */
var RouteError = class extends Error {
	status;
	category;
	constructor(status, category) {
		super(`route refused (${category})`);
		this.status = status;
		this.category = category;
	}
};
function json(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(value));
}
/** Only loopback-origin same-page requests may reach the control plane. */
function trustedRequest(req) {
	const remote = req.socket.remoteAddress;
	if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
	const host = req.headers.host;
	if (typeof host !== "string" || host.length === 0) return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	return origin === `http://${host}` || origin === `https://${host}`;
}
function methodOf(req) {
	return typeof req.method === "string" ? req.method.toUpperCase() : "";
}
/** Read the request body up to a fixed bound; larger bodies fail closed. */
function readBoundedBody(req) {
	return new Promise((resolve, reject) => {
		const accumulator = createBodyAccumulator(MAX_BODY_BYTES);
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		req.on("data", (chunk) => {
			accumulator.accept(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			if (accumulator.overflowed) reject(new RouteError(413, "body too large"));
			else try {
				resolve(accumulator.decode());
			} catch {
				reject(new RouteError(400, "invalid UTF-8 request body"));
			}
		});
		req.on("error", () => fail(new RouteError(400, "body unreadable")));
	});
}
/** Refuse any nonempty body before a side-effect-free POST action runs. */
function rejectNonemptyBody(body) {
	if (body.length > 0) throw new RouteError(400, "expected an empty body");
}
/** Extract the request's key payload; a malformed body is refused before control. */
function parseKeyBody(body) {
	let value;
	try {
		value = JSON.parse(body);
	} catch {
		return;
	}
	if (!isRecord(value) || typeof value.key !== "string") return void 0;
	return value.key;
}
/** Route handler template: method gate, trust gate, control call, JSON reply. */
function controlHandler(method, run) {
	return async (req, res) => {
		if (methodOf(req) !== method) {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!trustedRequest(req)) {
			json(res, 403, { error: "forbidden" });
			return;
		}
		try {
			json(res, 200, await run(req, res));
		} catch (error) {
			if (error instanceof RouteError) json(res, error.status, { error: error.category });
			else json(res, 500, { error: "request failed" });
		}
	};
}
/** Register the four control routes; each registration rides the plugin fiber. */
function registerControlRoutes(ctx, control) {
	ctx.effect(() => {
		const disposers = [
			ctx.webServer.register({
				kind: "exact",
				path: CONTROL_ROUTES.status,
				handler: controlHandler("GET", async () => control.status())
			}),
			ctx.webServer.register({
				kind: "exact",
				path: CONTROL_ROUTES.connect,
				handler: controlHandler("POST", async (req) => {
					const key = parseKeyBody(await readBoundedBody(req));
					if (key === void 0) throw new RouteError(400, "invalid request");
					return control.connect(key);
				})
			}),
			ctx.webServer.register({
				kind: "exact",
				path: CONTROL_ROUTES.disconnect,
				handler: controlHandler("POST", async (req) => {
					rejectNonemptyBody(await readBoundedBody(req));
					return control.disconnect();
				})
			}),
			ctx.webServer.register({
				kind: "exact",
				path: CONTROL_ROUTES.doctor,
				handler: controlHandler("POST", async (req) => {
					rejectNonemptyBody(await readBoundedBody(req));
					return control.doctor();
				})
			})
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-opencode-go-provider: control routes");
}
//#endregion
//#region src/cache-schema.ts
/**
* Recursive strictness for the runtime cache envelope (cache boundary only).
*
* The standalone models.dev/state parsers stay permissive where the source
* format allows drift; the runtime cache is this toolchain's own artifact, so
* its boundary demands exact key sets at every nested depth. Unknown fields —
* including key-shaped `authorization` at any depth — are rejected with a
* generic non-echoing CacheError (field names only, never values). The
* committed artifacts are written through the same renderers, so these key
* sets are stable and the writer's output always passes.
*/
const CATALOG_MODEL_KEYS = [
	"id",
	"name",
	"protocol",
	"provider",
	"baseUrl",
	"input",
	"contextWindow",
	"maxTokens",
	"reasoning",
	"reasoningOptions",
	"interleaved",
	"cost"
];
const PRICE_KEYS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite"
];
const TIER_KEYS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"threshold",
	"tierType"
];
const COST_KEYS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"tiers",
	"contextOver200k"
];
const EFFORT_KEYS = ["kind", "values"];
const BUDGET_KEYS = [
	"kind",
	"min",
	"max"
];
const TOGGLE_KEYS = ["kind"];
const INTERLEAVED_KEYS = ["field"];
const DEPRECATED_KEYS = [
	"id",
	"deprecatedAt",
	"evictedAt",
	"model"
];
const QUARANTINE_KEYS = [
	"id",
	"detectedAt",
	"source",
	"reasonCode"
];
/**
* Reject any key outside the declared set with a fixed category. Field names
* are attacker-controlled persisted strings and are NEVER echoed; only the
* static `what` label (tool-generated) appears.
*/
function assertExact(what, record, keys) {
	for (const key of Object.keys(record)) if (!keys.some((declared) => declared === key)) throw new CacheError(`${what} carries an unknown field`);
}
/** Validate one raw catalog model and its nested structures recursively. */
function assertStrictCatalogEntry(raw, what) {
	if (!isRecord(raw)) throw new CacheError(`${what} is not an object`);
	assertExact(what, raw, CATALOG_MODEL_KEYS);
	if (raw.cost !== void 0) {
		if (!isRecord(raw.cost)) throw new CacheError(`${what} cost is not an object`);
		assertExact(`${what} cost`, raw.cost, COST_KEYS);
		if (raw.cost.tiers !== void 0) {
			if (!isUnknownArray(raw.cost.tiers)) throw new CacheError(`${what} cost tiers is not an array`);
			raw.cost.tiers.forEach((tier, index) => {
				if (!isRecord(tier)) throw new CacheError(`${what} cost tier is not an object`);
				assertExact(`${what} cost tier ${index}`, tier, TIER_KEYS);
			});
		}
		if (raw.cost.contextOver200k !== void 0) {
			if (!isRecord(raw.cost.contextOver200k)) throw new CacheError(`${what} cost contextOver200k is not an object`);
			assertExact(`${what} cost contextOver200k`, raw.cost.contextOver200k, PRICE_KEYS);
		}
	}
	if (raw.reasoningOptions !== void 0) {
		if (!isUnknownArray(raw.reasoningOptions)) throw new CacheError(`${what} reasoningOptions is not an array`);
		raw.reasoningOptions.forEach((option, index) => {
			if (!isRecord(option)) throw new CacheError(`${what} reasoningOptions entry is not an object`);
			const label = `${what} reasoningOptions ${index}`;
			switch (option.kind) {
				case "effort":
					assertExact(label, option, EFFORT_KEYS);
					return;
				case "budgetTokens":
					assertExact(label, option, BUDGET_KEYS);
					return;
				case "toggle":
					assertExact(label, option, TOGGLE_KEYS);
					return;
				default: throw new CacheError(`${label} has an unrecognized kind`);
			}
		});
	}
	if (raw.interleaved !== void 0) {
		if (!isRecord(raw.interleaved)) throw new CacheError(`${what} interleaved is not an object`);
		assertExact(`${what} interleaved`, raw.interleaved, INTERLEAVED_KEYS);
	}
}
/** Validate one raw deprecated entry and its frozen model recursively. */
function assertStrictDeprecatedEntry(raw, what) {
	if (!isRecord(raw)) throw new CacheError(`${what} is not an object`);
	assertExact(what, raw, DEPRECATED_KEYS);
	assertStrictCatalogEntry(raw.model, `${what} model`);
}
/** Validate one raw quarantine entry. */
function assertStrictQuarantineEntry(raw, what) {
	if (!isRecord(raw)) throw new CacheError(`${what} is not an object`);
	assertExact(what, raw, QUARANTINE_KEYS);
}
//#endregion
//#region src/cache-parse.ts
/**
* Strict runtime cache envelope parser.
*
* The cache crosses the boundary as `unknown`, so parse-don't-validate
* applies recursively: unsupported versions, unknown top-level AND nested
* `sources` fields, truncation, non-canonical or future timestamps (every
* persisted instant, not just refreshedAt), impossible transition ordering,
* duplicate/unsorted ids, unsafe URLs and inconsistent deprecation state are
* all rejected — a bad cache is never trusted and never deleted. The
* transition invariant: reconcile never stamps an observation or transition
* later than the attempt's clock instant, so every persisted timestamp
* (generatedAt, sources, deprecatedAt/evictedAt, detectedAt) must be at or
* before the refreshedAt that produced or preserved it.
*/
const ENVELOPE_KEYS = [
	"version",
	"refreshedAt",
	"generatedAt",
	"sources",
	"catalog",
	"deprecated",
	"quarantine"
];
const SOURCES_KEYS = ["modelsDevAt", "liveAt"];
/** Wrap the state-file parsers' failures into a fixed-category cache error. */
function parseStateOrThrow(what, parse) {
	try {
		return parse();
	} catch {
		throw new CacheError(`${what} state is malformed`);
	}
}
/** Reject a persisted instant that lies beyond the future-tolerance window. */
function assertNotFuture(what, iso, nowMs) {
	if (Date.parse(iso) - nowMs > 3e5) throw new CacheError(`${what} lies beyond the future-timestamp tolerance`);
}
/** Reject a persisted instant that claims to be later than refreshedAt. */
function assertNotAfter(what, iso, refreshedAtMs) {
	if (Date.parse(iso) > refreshedAtMs) throw new CacheError(`${what} is later than the refresh that produced it`);
}
/** Require strictly ascending unique ids, matching the deterministic writer. */
function assertAscendingIds(what, entries) {
	let previous;
	for (const entry of entries) {
		if (previous !== void 0 && compareIds(previous, entry.id) >= 0) throw new CacheError(`${what} ids must be strictly ascending`);
		previous = entry.id;
	}
}
/** Reject a record object carrying keys outside the declared set. */
function assertExactKeys(what, record, keys) {
	for (const key of Object.keys(record)) if (!keys.some((declared) => declared === key)) throw new CacheError(`${what} carries an unknown field`);
}
/**
* Read and strictly validate the cache envelope. `undefined` means no cache
* file exists (a legitimate cold start); any other defect throws CacheError
* and the caller falls back to the embedded snapshot WITHOUT deleting the
* file. `now` is the injected clock instant for the future-timestamp window.
*/
function readCache(path, now) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return void 0;
		throw new CacheError("cannot read the cache file");
	}
	let parsed;
	try {
		parsed = parseJsonFile(text, CACHE_FILE_NAME);
	} catch {
		throw new CacheError("the cache is not valid JSON");
	}
	if (!isRecord(parsed)) throw new CacheError("payload is not an object");
	assertExactKeys("cache", parsed, ENVELOPE_KEYS);
	if (parsed.version !== 1) throw new CacheError("unsupported envelope version");
	const refreshedAt = isCanonicalIsoInstant(parsed.refreshedAt) ? parsed.refreshedAt : void 0;
	const generatedAt = isCanonicalIsoInstant(parsed.generatedAt) ? parsed.generatedAt : void 0;
	if (refreshedAt === void 0 || generatedAt === void 0) throw new CacheError("refreshedAt and generatedAt must be canonical ISO-8601 instants");
	const nowMs = now.getTime();
	const refreshedAtMs = Date.parse(refreshedAt);
	assertNotFuture("refreshedAt", refreshedAt, nowMs);
	assertNotFuture("generatedAt", generatedAt, nowMs);
	assertNotAfter("generatedAt", generatedAt, refreshedAtMs);
	if (!isRecord(parsed.sources)) throw new CacheError("sources must be an object");
	assertExactKeys("sources", parsed.sources, SOURCES_KEYS);
	const modelsDevAt = isCanonicalIsoInstant(parsed.sources.modelsDevAt) ? parsed.sources.modelsDevAt : void 0;
	const liveAt = isCanonicalIsoInstant(parsed.sources.liveAt) ? parsed.sources.liveAt : void 0;
	if (modelsDevAt === void 0 || liveAt === void 0) throw new CacheError("sources must carry canonical modelsDevAt and liveAt instants");
	if (modelsDevAt !== refreshedAt || liveAt !== refreshedAt) throw new CacheError("sources timestamps must equal refreshedAt (one observation instant)");
	if (!isUnknownArray(parsed.catalog)) throw new CacheError("catalog must be an array");
	parsed.catalog.forEach((raw, index) => assertStrictCatalogEntry(raw, `catalog model ${index}`));
	if (!isUnknownArray(parsed.deprecated)) throw new CacheError("deprecated must be an array");
	parsed.deprecated.forEach((raw, index) => assertStrictDeprecatedEntry(raw, `deprecated ${index}`));
	if (!isUnknownArray(parsed.quarantine)) throw new CacheError("quarantine must be an array");
	parsed.quarantine.forEach((raw, index) => assertStrictQuarantineEntry(raw, `quarantine ${index}`));
	const catalog = [];
	const seen = /* @__PURE__ */ new Set();
	let previous;
	for (const raw of parsed.catalog) {
		const model = parseCatalogModel(raw);
		if (model === void 0) throw new CacheError("catalog entry is not a valid catalog model");
		if (seen.has(model.id)) throw new CacheError("duplicate catalog id");
		if (previous !== void 0 && compareIds(previous, model.id) >= 0) throw new CacheError("catalog ids must be strictly ascending");
		seen.add(model.id);
		previous = model.id;
		catalog.push(model);
	}
	const deprecated = parseStateOrThrow("deprecated", () => parseDeprecatedFile(parsed.deprecated));
	const quarantine = parseStateOrThrow("quarantine", () => parseQuarantineFile(parsed.quarantine));
	assertAscendingIds("deprecated", deprecated);
	assertAscendingIds("quarantine", quarantine);
	for (const entry of deprecated) {
		assertNotFuture("deprecated deprecatedAt", entry.deprecatedAt, nowMs);
		assertNotAfter("deprecated deprecatedAt", entry.deprecatedAt, refreshedAtMs);
		if (entry.evictedAt !== void 0) {
			assertNotFuture("deprecated evictedAt", entry.evictedAt, nowMs);
			assertNotAfter("deprecated evictedAt", entry.evictedAt, refreshedAtMs);
		}
	}
	for (const record of quarantine) {
		assertNotFuture("quarantine detectedAt", record.detectedAt, nowMs);
		assertNotAfter("quarantine detectedAt", record.detectedAt, refreshedAtMs);
	}
	const byId = new Map(catalog.map((model) => [model.id, model]));
	for (const entry of deprecated) {
		const present = byId.get(entry.id);
		if (entry.evictedAt === void 0) {
			if (present === void 0) throw new CacheError("non-evicted deprecated id is missing from the catalog");
			if (renderModelsPayload([entry.model]) !== renderModelsPayload([present])) throw new CacheError("deprecated entry has a frozen model differing from its catalog entry");
		} else if (present !== void 0) throw new CacheError("evicted deprecated id is still present in the catalog");
	}
	for (const record of quarantine) if (byId.has(record.id)) throw new CacheError("quarantine id also appears in the catalog");
	return {
		version: 1,
		refreshedAt,
		generatedAt,
		sources: {
			modelsDevAt,
			liveAt
		},
		catalog,
		deprecated,
		quarantine
	};
}
//#endregion
//#region src/snapshot.ts
/**
* Catalog snapshot mapping: cache/embedded/refreshed → served snapshot.
*
* The lifecycle serves one immutable `CatalogSnapshot` at a time. This module
* owns the small, pure mappings between snapshot and its durable envelope or
* bootstrap form: cache envelope → cache-origin snapshot, reconcile result →
* refreshed snapshot, committed manifest → embedded snapshot. Keeping them
* here (instead of in the coordinator) keeps the lifecycle's scheduling and
* single-flight logic under the module-size ceiling and gives the mappings a
* single testable home.
*/
const EPOCH_ISO = (/* @__PURE__ */ new Date(0)).toISOString();
/** The bootstrap snapshot: committed manifest models, no observed timestamps. */
function embeddedSnapshot() {
	const manifest = embeddedCatalogManifest();
	return {
		catalog: manifest.models,
		deprecated: [],
		quarantine: [],
		generatedAt: manifest.generatedAt,
		refreshedAt: EPOCH_ISO,
		sources: {
			modelsDevAt: EPOCH_ISO,
			liveAt: EPOCH_ISO
		},
		origin: "embedded"
	};
}
/** Wrap a validated cache envelope into a served snapshot. */
function snapshotFromEnvelope(envelope, origin) {
	return {
		catalog: envelope.catalog,
		deprecated: envelope.deprecated,
		quarantine: envelope.quarantine,
		generatedAt: envelope.generatedAt,
		refreshedAt: envelope.refreshedAt,
		sources: envelope.sources,
		origin
	};
}
/** The snapshot's durable envelope (origin is in-memory state, not persisted). */
function envelopeOf(snapshot) {
	return {
		version: 1,
		refreshedAt: snapshot.refreshedAt,
		generatedAt: snapshot.generatedAt,
		sources: snapshot.sources,
		catalog: snapshot.catalog,
		deprecated: snapshot.deprecated,
		quarantine: snapshot.quarantine
	};
}
/** Build the post-reconcile snapshot: a fresh immutable catalog identity. */
function buildSnapshot(result, sources) {
	return {
		catalog: result.catalog,
		deprecated: result.deprecated,
		quarantine: result.quarantine,
		generatedAt: result.generatedAt,
		refreshedAt: sources.liveAt,
		sources,
		origin: "refreshed"
	};
}
/**
* Read the initial snapshot synchronously: validated cache → embedded, in
* that order. A missing cache yields the embedded bootstrap; a malformed one
* falls back to embedded WITHOUT deleting the bad file (origin "corrupt").
*/
function loadInitial(deps) {
	try {
		const envelope = readCache(deps.cachePath(), deps.clock.now());
		if (envelope !== void 0) return {
			snapshot: snapshotFromEnvelope(envelope, "cache"),
			origin: "cache"
		};
	} catch {
		return {
			snapshot: embeddedSnapshot(),
			origin: "corrupt"
		};
	}
	return {
		snapshot: embeddedSnapshot(),
		origin: "embedded"
	};
}
//#endregion
//#region src/lifecycle.ts
/**
* SWR catalog lifecycle: current snapshot, scheduling, single-flight, disposal.
*
* Cold startup synchronously chooses validated cache → embedded snapshot and
* publishes it before any background work; reads never await network. A fresh
* snapshot suppresses redundant refresh; a stale read returns immediately and
* schedules ONE background refresh; the periodic timer re-arms with the live
* validated config. All refresh work is single-flight, persisted atomically
* BEFORE the in-memory snapshot swaps, and an abort observed at any point —
* including mid-persistence — prevents publication. Concurrent disposers
* share one cleanup promise; every dependency is injected.
*/
/**
* Owns the current catalog snapshot, its freshness/scheduling, single-flight
* refresh and disposal. `catalog()` is the adapter seam: it always returns the
* current immutable array and never awaits network.
*/
var CatalogLifecycle = class {
	deps;
	snapshot;
	inFlight;
	periodicHandle;
	immediateHandle;
	abort;
	disposePromise;
	started = false;
	disposed = false;
	stats;
	constructor(deps) {
		this.deps = deps;
		const initial = loadInitial(deps);
		this.snapshot = initial.snapshot;
		this.stats = {
			attemptsStarted: 0,
			attemptsSucceeded: 0,
			attemptsFailed: 0,
			cacheWrites: 0,
			cacheWriteFailures: 0,
			swaps: 0,
			freshnessHits: 0,
			initialOrigin: initial.origin
		};
	}
	/** The current immutable catalog; a stale read also schedules one refresh. */
	catalog() {
		if (!this.disposed && this.tryResolveConfig() !== void 0 && !this.isFreshNow()) this.kickRefresh();
		return this.snapshot.catalog;
	}
	current() {
		return this.snapshot;
	}
	start() {
		if (this.disposed || this.started) return;
		this.started = true;
		if (!this.isFreshNow()) this.kickRefresh();
		this.armPeriodic();
	}
	/** Re-judge scheduling after a config commit: re-arm periodic, maybe refresh. */
	notifyConfigChanged() {
		if (this.disposed || !this.started) return;
		this.armPeriodic();
		if (!this.isFreshNow()) this.kickRefresh();
	}
	/**
	* Request a refresh: fresh resolves immediately with zero network; stale
	* starts (or joins) the single-flight attempt. Never rejects.
	*/
	refresh() {
		if (this.disposed) return Promise.resolve({ kind: "disposed" });
		if (this.inFlight !== void 0) return this.inFlight;
		const config = this.tryResolveConfig();
		if (config === void 0) return Promise.resolve({
			kind: "failed",
			code: "INTERNAL",
			message: failureMessage("INTERNAL")
		});
		if (this.isFresh(config)) {
			this.stats.freshnessHits += 1;
			this.observe({ kind: "refresh-fresh" });
			return Promise.resolve({ kind: "fresh" });
		}
		this.stats.attemptsStarted += 1;
		this.observe({ kind: "refresh-started" });
		this.abort = new AbortController();
		const attempt = this.performAttempt(config);
		this.inFlight = attempt;
		attempt.finally(() => {
			if (this.inFlight === attempt) {
				this.inFlight = void 0;
				this.abort = void 0;
			}
		});
		return attempt;
	}
	/**
	* Stop scheduling, abort and settle the active pair. Every caller — even
	* concurrent ones — awaits the SAME cleanup promise; later calls are
	* await-equivalent and the cleanup itself is idempotent.
	*/
	dispose() {
		if (this.disposePromise === void 0) this.disposePromise = this.runDispose();
		return this.disposePromise;
	}
	async runDispose() {
		this.disposed = true;
		if (this.immediateHandle !== void 0) {
			this.deps.scheduler.clearTimer(this.immediateHandle);
			this.immediateHandle = void 0;
		}
		if (this.periodicHandle !== void 0) {
			this.deps.scheduler.clearTimer(this.periodicHandle);
			this.periodicHandle = void 0;
		}
		this.abort?.abort();
		const pending = this.inFlight;
		if (pending !== void 0) await pending;
	}
	observe(event) {
		this.deps.observe?.(event);
	}
	previousState() {
		return {
			models: this.snapshot.catalog,
			quarantine: this.snapshot.quarantine,
			deprecated: this.snapshot.deprecated,
			generatedAt: this.snapshot.generatedAt
		};
	}
	tryResolveConfig() {
		try {
			return resolveConfig(this.deps.currentConfig());
		} catch {
			return;
		}
	}
	isFresh(config) {
		return this.deps.clock.now().getTime() - Date.parse(this.snapshot.refreshedAt) < config.freshnessMs;
	}
	isFreshNow() {
		const config = this.tryResolveConfig();
		return config !== void 0 && this.isFresh(config);
	}
	/** Arm (or re-arm) a 0-delay refresh timer; deduplicated while pending. */
	kickRefresh() {
		if (this.disposed || this.immediateHandle !== void 0) return;
		this.immediateHandle = this.deps.scheduler.setTimer(() => {
			this.immediateHandle = void 0;
			this.refresh();
		}, 0);
	}
	/** Re-arm the periodic timer with the live validated refreshMs. */
	armPeriodic() {
		if (this.disposed || !this.started) return;
		if (this.periodicHandle !== void 0) {
			this.deps.scheduler.clearTimer(this.periodicHandle);
			this.periodicHandle = void 0;
		}
		const refreshMs = this.tryResolveConfig()?.refreshMs ?? DEFAULTS.refreshMs;
		this.periodicHandle = this.deps.scheduler.setTimer(() => {
			this.periodicHandle = void 0;
			this.refresh();
			this.armPeriodic();
		}, refreshMs);
	}
	/** An abort observed anywhere (sync failure, persist, or post-write) settles the attempt as failed. */
	abortedOutcome() {
		this.stats.attemptsFailed += 1;
		this.observe({
			kind: "refresh-failed",
			code: "ABORTED",
			message: failureMessage("ABORTED")
		});
		return {
			kind: "failed",
			code: "ABORTED",
			message: failureMessage("ABORTED")
		};
	}
	/**
	* Run the bounded attempt, persist atomically, then swap around an explicit
	* commit point. A writer that reports COMMITTED (its rename published the
	* new file) is adopted even if disposal races in after the rename — disk
	* and memory must stay on the same generation. A writer that did NOT commit
	* (abort or failure before rename) never publishes: the disposed/aborted
	* guard retains old memory+disk; a genuine non-abort write failure counts
	* CACHE_WRITE_FAILED. Accounting after settlement: started = succeeded +
	* failed (+ 0 active).
	*/
	async performAttempt(config) {
		try {
			const outcome = await attemptReconcile({
				fetch: this.deps.fetch,
				resolveKey: this.deps.resolveKey,
				config,
				previous: this.previousState(),
				patches: this.deps.patches,
				clock: this.deps.clock,
				scheduler: this.deps.scheduler,
				signal: this.abort?.signal
			});
			if (outcome.kind === "failed") {
				this.stats.attemptsFailed += 1;
				this.observe({
					kind: "refresh-failed",
					code: outcome.code,
					message: outcome.message
				});
				return {
					kind: "failed",
					code: outcome.code,
					message: outcome.message
				};
			}
			const next = buildSnapshot(outcome.result, outcome.sources);
			let commit;
			try {
				commit = await this.deps.persistCache(this.deps.cachePath(), envelopeOf(next), this.abort?.signal);
			} catch {
				commit = { kind: "not-committed" };
			}
			if (commit.kind === "committed") {
				this.snapshot = next;
				this.stats.cacheWrites += 1;
				this.stats.swaps += 1;
				this.stats.attemptsSucceeded += 1;
				this.observe({
					kind: "refresh-ok",
					modelCount: next.catalog.length,
					transitioned: outcome.result.transitioned
				});
				return {
					kind: "ok",
					result: outcome.result,
					refreshedAt: next.refreshedAt
				};
			}
			if (this.disposed || this.abort?.signal.aborted) return this.abortedOutcome();
			this.stats.cacheWriteFailures += 1;
			this.stats.attemptsFailed += 1;
			this.observe({
				kind: "refresh-failed",
				code: "CACHE_WRITE_FAILED",
				message: failureMessage("CACHE_WRITE_FAILED")
			});
			return {
				kind: "failed",
				code: "CACHE_WRITE_FAILED",
				message: failureMessage("CACHE_WRITE_FAILED")
			};
		} catch {
			this.stats.attemptsFailed += 1;
			this.observe({
				kind: "refresh-failed",
				code: "INTERNAL",
				message: failureMessage("INTERNAL")
			});
			return {
				kind: "failed",
				code: "INTERNAL",
				message: failureMessage("INTERNAL")
			};
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
const NS = settingsNamespace(SETTINGS_NS);
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
/** Narrow a host-provided fetch (tests inject one); production falls back to nodeFetch. */
function isSyncFetchLike(value) {
	return typeof value === "function";
}
/** The network seam: a harness-provided fetch, or the real fetch adapter. */
function resolveHostFetch(ctx) {
	const provided = ctx.get("opencodeGoFetch");
	return isSyncFetchLike(provided) ? provided : nodeFetch();
}
/** The cache home: a harness-provided path, else $DSH_HOME, else ~/.dsh. */
function resolveDshHome(ctx) {
	const provided = ctx.get("opencodeGoHome");
	if (typeof provided === "string" && provided.length > 0) return provided;
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** Cordis plugin factory: mount the provider's reversible Host effects. */
function apply(ctx, rawConfig) {
	const entry = Config(rawConfig ?? {});
	assertServiceable(entry);
	let current = () => entry;
	const tracker = trackLifecycleEvents();
	const lifecycle = new CatalogLifecycle({
		fetch: resolveHostFetch(ctx),
		resolveKey: (ref) => resolveApiKey(ctx, ref),
		currentConfig: () => current(),
		clock: { now: () => /* @__PURE__ */ new Date() },
		scheduler: defaultScheduler(),
		cachePath: () => resolveCachePath(resolveDshHome(ctx)),
		patches: embeddedPatches(),
		persistCache: writeCacheAtomic,
		observe: tracker.observe
	});
	const control = mountControl(ctx, {
		lifecycle,
		tracker,
		current: () => current(),
		resolveKey: (ref) => resolveApiKey(ctx, ref),
		fetch: resolveHostFetch(ctx),
		scheduler: defaultScheduler()
	});
	ctx.inject(["webServer"], (webCtx) => {
		registerControlRoutes(webCtx, control);
	});
	const adapter = new OpenCodeGoAdapter({
		currentConfig: () => current(),
		resolveKey: (ref) => resolveApiKey(ctx, ref),
		catalog: () => lifecycle.catalog(),
		resolveAttachments: () => ctx.get("attachments")
	});
	let directory;
	const ensureDirectory = () => {
		if (directory !== void 0) return;
		if (ctx.llm.listConfigurableProviders().some((entry) => entry.provider === "opencode-go")) return;
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
			lifecycle.notifyConfigChanged();
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
			lifecycle.notifyConfigChanged();
		});
		if (sctx.settings.get(NS) === void 0) attachScope(sctx.settings.register(NS, Config, {
			base: entry,
			validate: assertServiceable
		}));
	});
	ctx.effect(() => () => lifecycle.dispose());
	lifecycle.start();
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
