/**
 * Committed catalog-entry parser (the models.json model shape).
 *
 * The committed artifact format is this toolchain's own: camelCase fields,
 * flattened tiers (threshold/tierType) and normalized reasoning kinds. State
 * files cross the boundary as `unknown`, so corruption or hand-editing —
 * unsafe ids, duplicate modalities, impossible numbers — is caught here with
 * a typed `undefined` result that the caller turns into a StateFileParseError.
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
import { MODALITY_LITERALS, PROTOCOLS, PROVIDER_ID } from "./types.ts";
import { parseBaseUrl } from "./urls.ts";
import type {
  CatalogModel,
  CostTier,
  InterleavedField,
  ModalityLiteral,
  ModelCost,
  Protocol,
  ReasoningOption,
} from "./types.ts";

function parseProtocol(value: unknown): Protocol | undefined {
  if (!isString(value)) return undefined;
  return PROTOCOLS.find((protocol) => protocol === value);
}

function parsePrice(value: unknown): ModelCost | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonnegativeFiniteNumber(value.input) || !isNonnegativeFiniteNumber(value.output)) return undefined;
  const cacheRead = value.cacheRead === undefined ? undefined : isNonnegativeFiniteNumber(value.cacheRead) ? value.cacheRead : null;
  const cacheWrite = value.cacheWrite === undefined ? undefined : isNonnegativeFiniteNumber(value.cacheWrite) ? value.cacheWrite : null;
  if (cacheRead === null || cacheWrite === null) return undefined;
  return {
    input: value.input,
    output: value.output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** Only the documented "context" tier type is accepted. */
function parseTier(value: unknown): CostTier | undefined {
  const base = parsePrice(value);
  if (base === undefined || !isRecord(value)) return undefined;
  const threshold = isPositiveInteger(value.threshold) ? value.threshold : undefined;
  const tierType = isString(value.tierType) && value.tierType === "context" ? value.tierType : undefined;
  if (threshold === undefined || tierType === undefined) return undefined;
  return { ...base, threshold, tierType };
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

function parseReasoningOption(value: unknown): ReasoningOption | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "toggle") return { kind: "toggle" };
  if (value.kind === "effort") {
    const values = parseEffortValues(value.values);
    if (values === undefined) return undefined;
    return { kind: "effort", values };
  }
  if (value.kind === "budgetTokens") {
    const min = value.min === undefined ? undefined : isNonnegativeFiniteNumber(value.min) && Number.isInteger(value.min) ? value.min : null;
    const max = value.max === undefined ? undefined : isNonnegativeFiniteNumber(value.max) && Number.isInteger(value.max) ? value.max : null;
    if (min === null || max === null) return undefined;
    if (min !== undefined && max !== undefined && min > max) return undefined;
    return {
      kind: "budgetTokens",
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    };
  }
  return undefined;
}

function parseInterleaved(value: unknown): InterleavedField | undefined {
  if (!isRecord(value) || !isSafeText(value.field)) return undefined;
  return { field: value.field };
}

/** Input modalities must be documented literals, each listed once. */
function parseInputModalities(value: unknown): readonly ModalityLiteral[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: ModalityLiteral[] = [];
  for (const entry of value) {
    if (!isString(entry)) return undefined;
    const literal = MODALITY_LITERALS.find((candidate) => candidate === entry);
    if (literal === undefined) return undefined;
    if (seen.has(literal)) return undefined;
    seen.add(literal);
    out.push(literal);
  }
  return out;
}

/** Parse one committed catalog model; `undefined` means malformed. */
export function parseCatalogModel(value: unknown): CatalogModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = isSafeModelId(value.id) ? value.id : undefined;
  const name = isSafeText(value.name) ? value.name : undefined;
  const baseUrl = parseBaseUrl(value.baseUrl);
  const provider = isString(value.provider) ? value.provider : undefined;
  const protocol = parseProtocol(value.protocol);
  const contextWindow = isPositiveInteger(value.contextWindow) ? value.contextWindow : undefined;
  const maxTokens = isPositiveInteger(value.maxTokens) ? value.maxTokens : undefined;
  const reasoning = isBoolean(value.reasoning) ? value.reasoning : undefined;
  if (id === undefined || name === undefined || baseUrl === undefined || provider !== PROVIDER_ID ||
      protocol === undefined || contextWindow === undefined || maxTokens === undefined || reasoning === undefined) {
    return undefined;
  }
  const input = parseInputModalities(value.input);
  if (value.input !== undefined && input === undefined) return undefined;
  let cost: ModelCost | undefined;
  if (value.cost !== undefined) {
    if (!isRecord(value.cost)) return undefined;
    const base = parsePrice(value.cost);
    if (base === undefined) return undefined;
    let tiers: readonly CostTier[] | undefined;
    if (value.cost.tiers !== undefined) {
      if (!Array.isArray(value.cost.tiers)) return undefined;
      const parsed: CostTier[] = [];
      for (const raw of value.cost.tiers) {
        const tier = parseTier(raw);
        if (tier === undefined) return undefined;
        parsed.push(tier);
      }
      tiers = parsed;
    }
    let contextOver200k: ModelCost["contextOver200k"];
    if (value.cost.contextOver200k !== undefined) {
      const over = parsePrice(value.cost.contextOver200k);
      if (over === undefined) return undefined;
      contextOver200k = over;
    }
    cost = {
      ...base,
      ...(tiers === undefined ? {} : { tiers }),
      ...(contextOver200k === undefined ? {} : { contextOver200k }),
    };
  }
  let reasoningOptions: readonly ReasoningOption[] | undefined;
  if (value.reasoningOptions !== undefined) {
    if (!Array.isArray(value.reasoningOptions)) return undefined;
    const options: ReasoningOption[] = [];
    for (const raw of value.reasoningOptions) {
      const option = parseReasoningOption(raw);
      if (option === undefined) return undefined;
      options.push(option);
    }
    reasoningOptions = options;
  }
  const interleaved = value.interleaved === undefined ? undefined : parseInterleaved(value.interleaved);
  if (value.interleaved !== undefined && interleaved === undefined) return undefined;
  return {
    id,
    name,
    protocol,
    provider: PROVIDER_ID,
    baseUrl,
    ...(input === undefined ? {} : { input }),
    contextWindow,
    maxTokens,
    reasoning,
    ...(reasoningOptions === undefined ? {} : { reasoningOptions }),
    ...(interleaved === undefined ? {} : { interleaved }),
    ...(cost === undefined ? {} : { cost }),
  };
}
