/**
 * Runtime type guards and the exhaustive-match sink.
 *
 * Guards narrow `unknown` values into typed values at trust boundaries (JSON
 * payloads, state files). They are runtime checks, not casts. Production and
 * test code share these; nothing else imports node builtins.
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

/** True when `value` is a finite number (JSON numbers are always finite). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when `value` is a boolean. */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** True when `value` is an array of only strings. */
export function isStringArray(value: unknown): value is readonly string[] {
  return isUnknownArray(value) && value.every((entry) => typeof entry === "string");
}

/** True when `value` is a canonical finite ISO-8601 instant (toISOString form). */
export function isCanonicalIsoInstant(value: unknown): value is string {
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
export function isSafeModelId(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (value !== value.trim()) return false;
  return !WHITESPACE_OR_CONTROL.test(value);
}

/** True when `value` is a positive integer (capacities, limits, thresholds). */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** True when `value` is a finite nonnegative number (prices). */
export function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Control characters no persisted/external text may contain. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u;

/**
 * True when `value` is safe text: a nonempty (after trim) string free of
 * control characters. Internal whitespace is allowed (model names contain
 * spaces); ids and keys use the stricter isSafeModelId.
 */
export function isSafeText(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  return !CONTROL_CHARS.test(value);
}

/**
 * True when `value` is a canonical API key: nonempty, already trimmed, and
 * free of whitespace and control characters. Non-canonical keys are rejected,
 * never silently trimmed or mutated.
 */
export function isCanonicalApiKey(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (value !== value.trim()) return false;
  return !WHITESPACE_OR_CONTROL.test(value);
}

/** Exhaustive-match sink for closed unions; never returns. */
export function assertNever(value: never): never {
  throw new Error(`unreachable union member: ${JSON.stringify(value)}`);
}
