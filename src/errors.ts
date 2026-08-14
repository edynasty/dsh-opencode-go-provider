/**
 * Stable error taxonomy for the OpenCode Go adapter.
 *
 * Every failure an operation can produce carries one machine-routable code.
 * HTTP status classes, transport conditions, idle timeout and caller abort map
 * deterministically; anything unrecognized keeps the catch-all `PI_AI_ERROR`
 * so a terminal outcome always has a stable code and never fabricates success.
 */
import { isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import type { LlmErrorOptions } from "@deepseek-ai/dsh-llm";

/** Credential/authorization failures (HTTP 401/403). */
export const AUTH = "AUTH";
/** Provider rate limiting (HTTP 429). */
export const RATE_LIMIT = "RATE_LIMIT";
/** Provider-side server failures (HTTP 5xx). */
export const SERVER = "SERVER";
/** Connection, DNS, socket or stream failures. */
export const TRANSPORT = "TRANSPORT";
/** The configured per-operation idle deadline elapsed. */
export const TIMEOUT = "TIMEOUT";
/** The caller cancelled the request. */
export const ABORTED = "ABORTED";
/** HTTP 400 / invalid request wording. */
export const INVALID_REQUEST = "INVALID_REQUEST";
/** Provider error text no stable class matches. */
export const PI_AI_ERROR = "PI_AI_ERROR";
/** A model id the catalog does not describe. */
export const UNKNOWN_MODEL = "UNKNOWN_MODEL";
/** A provider route this adapter does not own. */
export const NO_ADAPTER = "NO_ADAPTER";
/** A request option the transports cannot express. */
export const UNSUPPORTED_OPTION = "UNSUPPORTED_OPTION";
/** Media or message content the selected model cannot carry. */
export const UNSUPPORTED_CONTENT = "UNSUPPORTED_CONTENT";
/** A reasoning effort the selected model does not offer. */
export const UNSUPPORTED_REASONING_EFFORT = "UNSUPPORTED_REASONING_EFFORT";
/** Catalog metadata naming a wire protocol this bundle cannot serve. */
export const UNSUPPORTED_PROTOCOL = "UNSUPPORTED_PROTOCOL";
/** A pi-ai event stream ended without a terminal event. */
export const STREAM_CLOSED = "STREAM_CLOSED";
/** Durable replay metadata failed validation. */
export const INVALID_REPLAY_STATE = "INVALID_REPLAY_STATE";

/** Construct one typed adapter failure with the stable code taxonomy. */
export function llmError(message: string, code: string, options?: LlmErrorOptions): LlmError {
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
export function classifyProviderFailure(detail: string): string {
  if (/\b(?:401|403)\b/.test(detail)) return AUTH;
  if (/\b429\b|rate.?limit/i.test(detail)) return RATE_LIMIT;
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (/\b5\d\d\b/.test(detail)) return SERVER;
  if (/\b400\b|invalid.?request/i.test(detail)) return INVALID_REQUEST;
  if (/\btime(?:d)?\s*out\b|timeout/i.test(detail)) return TIMEOUT;
  if (/stream ended (?:before|without)\b/i.test(detail)) return TRANSPORT;
  if (
    /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(detail)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(detail)
    || /\bterminated\b|premature close/i.test(detail)
  ) {
    return TRANSPORT;
  }
  return PI_AI_ERROR;
}
