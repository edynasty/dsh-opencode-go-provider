/**
 * models.dev provider and live /v1/models boundary parsers.
 *
 * External JSON crosses the trust boundary here: the provider record (and the
 * full api.json provider map, from which only `opencode-go` is selected) is
 * parsed from `unknown` into typed metadata, and live responses yield only
 * normalized ids. Provider identity and map-key/record-id consistency are
 * enforced; anything foreign fails closed instead of being relabeled.
 */
import { assertNever, isRecord, isSafeModelId, isString, isUnknownArray } from "./guards.ts";
import { PROVIDER_ID } from "./types.ts";
import { parseBaseUrl } from "./urls.ts";
import type { ModelsDevModelMetadata, ModelsDevProvider, Protocol, QuarantineReasonCode } from "./types.ts";
import { parseModelRecord } from "./model-record.ts";

/** Provider-level parse failure (payload not a provider record). */
export class ModelsDevParseError extends Error {
  readonly name = "ModelsDevParseError";
  constructor(reason: string) {
    super(`models.dev provider parse failed: ${reason}`);
  }
}

/** Live /v1/models parse failure (payload shape, id shape or normalization). */
export class LiveModelsParseError extends Error {
  readonly name = "LiveModelsParseError";
  constructor(reason: string) {
    super(`live /v1/models parse failed: ${reason}`);
  }
}

/** String field reader: undefined = absent, null = present but malformed. */
function parseStringField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return isString(value) ? value : null;
}

/** Whitespace and control characters no live model id may contain. */
function normalizeLiveId(raw: string): string {
  const trimmed = raw.trim();
  if (!isSafeModelId(trimmed)) {
    throw new LiveModelsParseError("entry id must be a nonempty trimmed id without whitespace or control characters");
  }
  return trimmed;
}

/**
 * Parse the models.dev provider record (the opencode-go entry of api.json).
 * The record id must be exactly `opencode-go`; every models map key must equal
 * its record's string id. Valid records populate `models`; invalid ones
 * populate `invalid` with a machine-readable reason.
 */
export function parseModelsDevProvider(value: unknown): ModelsDevProvider {
  if (!isRecord(value)) {
    throw new ModelsDevParseError("payload is not an object");
  }
  const id = parseStringField(value, "id");
  const name = parseStringField(value, "name");
  const npm = parseStringField(value, "npm");
  const api = parseStringField(value, "api");
  if (id === undefined || name === undefined || id === null || name === null || !isRecord(value.models)) {
    throw new ModelsDevParseError("provider must declare string id/name and a models object");
  }
  if (id !== PROVIDER_ID) {
    throw new ModelsDevParseError(`expected provider id "${PROVIDER_ID}", got "${id}"`);
  }
  if (npm === null || api === null) {
    throw new ModelsDevParseError("provider npm/api must be strings when present");
  }
  if (api !== undefined && parseBaseUrl(api) === undefined) {
    throw new ModelsDevParseError(`provider api "${api}" is not a valid OpenCode Go base URL`);
  }
  const models = new Map<string, ModelsDevModelMetadata>();
  const invalid = new Map<string, QuarantineReasonCode>();
  for (const [key, raw] of Object.entries(value.models)) {
    if (!isSafeModelId(key)) {
      throw new ModelsDevParseError(`models map key "${key}" is not a safe canonical model id`);
    }
    const recordId = isRecord(raw) ? parseStringField(raw, "id") : undefined;
    if (recordId !== undefined && recordId !== null && recordId !== key) {
      throw new ModelsDevParseError(`models map key "${key}" does not match record id "${recordId}"`);
    }
    const parsed = parseModelRecord(raw);
    switch (parsed.kind) {
      case "parsed":
        models.set(key, parsed.metadata);
        break;
      case "invalid":
        invalid.set(key, parsed.reasonCode);
        break;
      default:
        assertNever(parsed);
    }
  }
  return {
    id,
    name,
    ...(npm === undefined ? {} : { npm }),
    ...(api === undefined ? {} : { api }),
    models,
    invalid,
  };
}

/**
 * Parse the full models.dev api.json provider map and select only the
 * `opencode-go` record, whose declared id must match the key exactly.
 */
export function parseModelsDevApiJson(value: unknown): ModelsDevProvider {
  if (!isRecord(value)) {
    throw new ModelsDevParseError("api.json must be a provider map object");
  }
  const record = value[PROVIDER_ID];
  if (record === undefined) {
    throw new ModelsDevParseError(`provider map has no "${PROVIDER_ID}" entry`);
  }
  if (!isRecord(record) || record.id !== PROVIDER_ID) {
    throw new ModelsDevParseError(`map key "${PROVIDER_ID}" must hold a record with id "${PROVIDER_ID}"`);
  }
  return parseModelsDevProvider(record);
}

/** The sole SDK-to-protocol mapping; unknown packages map to undefined. */
export function sdkToProtocol(npm: string | undefined): Protocol | undefined {
  switch (npm) {
    case "@ai-sdk/openai":
      return "openai-responses";
    case "@ai-sdk/openai-compatible":
      return "openai-completions";
    case "@ai-sdk/anthropic":
      return "anthropic-messages";
    default:
      return undefined;
  }
}

/**
 * Parse a live /v1/models response into normalized, deduplicated ids only.
 * Accepts the OpenAI-style `{ data: [...] }` shape or a bare array; entries
 * must carry a string id that survives normalization.
 */
export function parseLiveIds(value: unknown): readonly string[] {
  const entries = isRecord(value) ? value.data : value;
  if (!isUnknownArray(entries)) {
    throw new LiveModelsParseError("payload must be an object with a data array or a bare array");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || !isString(entry.id)) {
      throw new LiveModelsParseError("every entry must declare a string id");
    }
    const normalized = normalizeLiveId(entry.id);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      ids.push(normalized);
    }
  }
  return ids;
}
