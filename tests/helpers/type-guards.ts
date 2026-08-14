/**
 * Runtime type guards shared by the Task 2 QA helpers.
 *
 * These narrow `unknown` values (JSON.parse results, external process output)
 * into typed values at the trust boundary. Guards are runtime checks, not
 * casts; no production code imports them.
 */

/** True when `value` is a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is an array (element type preserved as `unknown`). */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** True when `value` is a string. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** True when `value` is an array of only strings. */
export function isStringArray(value: unknown): value is readonly string[] {
  return isUnknownArray(value) && value.every((entry) => typeof entry === "string");
}
