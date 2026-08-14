/**
 * Per-record models.dev boundary parsing.
 *
 * One model record becomes typed metadata: capacities, tiered costs,
 * reasoning options and the interleaved reasoning field. Everything outside
 * the documented schema — unsafe ids, impossible numbers, unknown tier types,
 * malformed reasoning metadata — yields a machine-readable invalid reason
 * instead of being preserved. This module owns no provider-map concerns.
 */
import {
  isBoolean,
  isNonnegativeFiniteNumber,
  isPositiveInteger,
  isRecord,
  isSafeModelId,
  isSafeText,
  isString,
} from "./guards.ts";
import { MODALITY_LITERALS } from "./types.ts";
import { parseBaseUrl } from "./urls.ts";
import type {
  CostTier,
  InterleavedField,
  ModalityLiteral,
  ModelCost,
  ModelCostBase,
  ModelRecordParseResult,
  ReasoningOption,
} from "./types.ts";

/** String field reader: undefined = absent, null = present but malformed. */
function parseStringField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return isString(value) ? value : null;
}

function parsePrice(value: unknown): ModelCostBase | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonnegativeFiniteNumber(value.input) || !isNonnegativeFiniteNumber(value.output)) {
    return undefined;
  }
  const cacheRead = value.cache_read === undefined ? undefined : isNonnegativeFiniteNumber(value.cache_read) ? value.cache_read : null;
  const cacheWrite = value.cache_write === undefined ? undefined : isNonnegativeFiniteNumber(value.cache_write) ? value.cache_write : null;
  if (cacheRead === null || cacheWrite === null) {
    return undefined;
  }
  return {
    input: value.input,
    output: value.output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** Only the documented "context" tier type is accepted. */
function parseTier(value: unknown): CostTier | undefined {
  if (!isRecord(value)) return undefined;
  const tier = isRecord(value.tier) ? value.tier : undefined;
  const threshold = tier === undefined ? undefined : isPositiveInteger(tier.size) ? tier.size : undefined;
  const tierType = tier === undefined ? undefined : parseStringField(tier, "type");
  if (threshold === undefined || tierType === null || tierType === undefined || tierType !== "context") {
    return undefined;
  }
  const base = parsePrice(value);
  if (base === undefined) return undefined;
  return { ...base, threshold, tierType };
}

function parseCost(value: unknown): ModelCost | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const base = parsePrice(value);
  if (base === undefined) return undefined;
  let tiers: readonly CostTier[] | undefined;
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) return undefined;
    const parsed: CostTier[] = [];
    for (const raw of value.tiers) {
      const tier = parseTier(raw);
      if (tier === undefined) return undefined;
      parsed.push(tier);
    }
    tiers = parsed;
  }
  let contextOver200k: ModelCostBase | undefined;
  if (value.context_over_200k !== undefined) {
    const over = parsePrice(value.context_over_200k);
    if (over === undefined) return undefined;
    contextOver200k = over;
  }
  return {
    ...base,
    ...(tiers === undefined ? {} : { tiers }),
    ...(contextOver200k === undefined ? {} : { contextOver200k }),
  };
}

/** Effort values must be safe, nonempty and unique (nulls are schema-allowed). */
function parseEffortValues(value: unknown): readonly (string | null)[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry === null) continue;
    if (!isString(entry) || !isSafeModelId(entry) || seen.has(entry)) return undefined;
    seen.add(entry);
  }
  return value;
}

function parseReasoningOptions(value: unknown): readonly ReasoningOption[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const options: ReasoningOption[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    if (raw.type === "toggle") {
      options.push({ kind: "toggle" });
      continue;
    }
    if (raw.type === "effort") {
      const values = parseEffortValues(raw.values);
      if (values === undefined) return undefined;
      options.push({ kind: "effort", values });
      continue;
    }
    if (raw.type === "budget_tokens") {
      const min = raw.min === undefined ? undefined : isNonnegativeFiniteNumber(raw.min) && Number.isInteger(raw.min) ? raw.min : null;
      const max = raw.max === undefined ? undefined : isNonnegativeFiniteNumber(raw.max) && Number.isInteger(raw.max) ? raw.max : null;
      if (min === null || max === null) return undefined;
      if (min !== undefined && max !== undefined && min > max) return undefined;
      options.push({
        kind: "budgetTokens",
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      });
      continue;
    }
    return undefined;
  }
  return options;
}

function parseInterleaved(value: unknown): InterleavedField | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return undefined;
  const field = parseStringField(value, "field");
  if (field === null || field === undefined || !isSafeText(field)) return undefined;
  return { field };
}

/** Input modalities must be documented literals, each listed once. */
function parseModalities(value: unknown): readonly ModalityLiteral[] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.input)) return undefined;
  const seen = new Set<string>();
  const out: ModalityLiteral[] = [];
  for (const entry of value.input) {
    if (!isString(entry)) return undefined;
    const literal = MODALITY_LITERALS.find((candidate) => candidate === entry);
    if (literal === undefined) return undefined;
    if (seen.has(literal)) return undefined;
    seen.add(literal);
    out.push(literal);
  }
  return out;
}

/**
 * Parse one models.dev model record. Structural, identity and numeric
 * problems yield a machine-readable reason; the caller decides placement.
 */
export function parseModelRecord(value: unknown): ModelRecordParseResult {
  if (!isRecord(value)) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  const id = parseStringField(value, "id");
  const name = parseStringField(value, "name");
  const reasoning = isBoolean(value.reasoning) ? value.reasoning : undefined;
  const limit = isRecord(value.limit) ? value.limit : undefined;
  const contextWindow = limit === undefined ? undefined : isPositiveInteger(limit.context) ? limit.context : undefined;
  const maxTokens = limit === undefined ? undefined : isPositiveInteger(limit.output) ? limit.output : undefined;
  if (id === undefined || name === undefined || id === null || name === null || reasoning === undefined ||
      (id !== null && !isSafeModelId(id)) || (name !== null && !isSafeText(name))) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  if (contextWindow === undefined && (limit === undefined || limit.context === undefined)) {
    return { kind: "invalid", reasonCode: "MISSING_CONTEXT" };
  }
  if (maxTokens === undefined && (limit === undefined || limit.output === undefined)) {
    return { kind: "invalid", reasonCode: "MISSING_OUTPUT_LIMIT" };
  }
  if (contextWindow === undefined || maxTokens === undefined) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  const cost = parseCost(value.cost);
  if (value.cost !== undefined && cost === undefined) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  const input = parseModalities(value.modalities);
  if (value.modalities !== undefined && input === undefined) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  const reasoningOptions = parseReasoningOptions(value.reasoning_options);
  if (value.reasoning_options !== undefined && reasoningOptions === undefined) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  const interleaved = parseInterleaved(value.interleaved);
  if (value.interleaved !== undefined && value.interleaved !== null && interleaved === undefined) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  const provider = isRecord(value.provider) ? value.provider : undefined;
  const npm = provider === undefined ? undefined : parseStringField(provider, "npm");
  const api = provider === undefined ? undefined : parseStringField(provider, "api");
  if (npm === null || api === null) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  if (api !== undefined && parseBaseUrl(api) === undefined) {
    return { kind: "invalid", reasonCode: "INVALID_MODEL_RECORD" };
  }
  return {
    kind: "parsed",
    metadata: {
      id,
      name,
      reasoning,
      contextWindow,
      maxTokens,
      ...(cost === undefined ? {} : { cost }),
      ...(input === undefined ? {} : { input }),
      ...(reasoningOptions === undefined ? {} : { reasoningOptions }),
      ...(interleaved === undefined ? {} : { interleaved }),
      ...(npm === undefined ? {} : { npm }),
      ...(api === undefined ? {} : { api }),
    },
  };
}
