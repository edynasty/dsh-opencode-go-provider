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
import { isRecord, isUnknownArray } from "./guards.ts";
import { CacheError } from "./cache.ts";

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
  "cost",
] as const;

const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const TIER_KEYS = ["input", "output", "cacheRead", "cacheWrite", "threshold", "tierType"] as const;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "tiers", "contextOver200k"] as const;
const EFFORT_KEYS = ["kind", "values"] as const;
const BUDGET_KEYS = ["kind", "min", "max"] as const;
const TOGGLE_KEYS = ["kind"] as const;
const INTERLEAVED_KEYS = ["field"] as const;

const DEPRECATED_KEYS = ["id", "deprecatedAt", "evictedAt", "model"] as const;
const QUARANTINE_KEYS = ["id", "detectedAt", "source", "reasonCode"] as const;

/**
 * Reject any key outside the declared set with a fixed category. Field names
 * are attacker-controlled persisted strings and are NEVER echoed; only the
 * static `what` label (tool-generated) appears.
 */
function assertExact(what: string, record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!keys.some((declared) => declared === key)) {
      throw new CacheError(`${what} carries an unknown field`);
    }
  }
}

/** Validate one raw catalog model and its nested structures recursively. */
export function assertStrictCatalogEntry(raw: unknown, what: string): void {
  if (!isRecord(raw)) throw new CacheError(`${what} is not an object`);
  assertExact(what, raw, CATALOG_MODEL_KEYS);
  if (raw.cost !== undefined) {
    if (!isRecord(raw.cost)) throw new CacheError(`${what} cost is not an object`);
    assertExact(`${what} cost`, raw.cost, COST_KEYS);
    if (raw.cost.tiers !== undefined) {
      if (!isUnknownArray(raw.cost.tiers)) throw new CacheError(`${what} cost tiers is not an array`);
      raw.cost.tiers.forEach((tier, index) => {
        if (!isRecord(tier)) throw new CacheError(`${what} cost tier is not an object`);
        assertExact(`${what} cost tier ${index}`, tier, TIER_KEYS);
      });
    }
    if (raw.cost.contextOver200k !== undefined) {
      if (!isRecord(raw.cost.contextOver200k)) throw new CacheError(`${what} cost contextOver200k is not an object`);
      assertExact(`${what} cost contextOver200k`, raw.cost.contextOver200k, PRICE_KEYS);
    }
  }
  if (raw.reasoningOptions !== undefined) {
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
        default:
          throw new CacheError(`${label} has an unrecognized kind`);
      }
    });
  }
  if (raw.interleaved !== undefined) {
    if (!isRecord(raw.interleaved)) throw new CacheError(`${what} interleaved is not an object`);
    assertExact(`${what} interleaved`, raw.interleaved, INTERLEAVED_KEYS);
  }
}

/** Validate one raw deprecated entry and its frozen model recursively. */
export function assertStrictDeprecatedEntry(raw: unknown, what: string): void {
  if (!isRecord(raw)) throw new CacheError(`${what} is not an object`);
  assertExact(what, raw, DEPRECATED_KEYS);
  assertStrictCatalogEntry(raw.model, `${what} model`);
}

/** Validate one raw quarantine entry. */
export function assertStrictQuarantineEntry(raw: unknown, what: string): void {
  if (!isRecord(raw)) throw new CacheError(`${what} is not an object`);
  assertExact(what, raw, QUARANTINE_KEYS);
}
