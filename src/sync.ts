/**
 * Bounded reconciliation attempt: models.dev + authenticated live /models.
 *
 * models.dev is the authority for protocol/baseUrl/capacity metadata; the
 * authenticated live endpoint contributes ONLY availability ids, and its URL
 * is derived from the parsed models.dev provider api — never hardcoded, never
 * inferred from ids. The two sources form ONE logical attempt whose deadline
 * and owner cancellation begin BEFORE credential resolution: the key, each
 * fetch, each body reader and the parse are raced against the fused signal,
 * so a never-resolving seam — including an ignoring-abort `text()` — yields
 * TIMEOUT/ABORTED and a late result after abort is discarded — never
 * reconciled, persisted or published. Every failure carries a fixed
 * sanitized message; injected error text, bodies, keys and paths never reach
 * outcomes.
 */
import { LlmError } from "@deepseek-ai/dsh-llm";
import { TimeoutReason } from "@deepseek-ai/dsh-timeout";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { MISSING_CREDENTIAL_CODE } from "./credentials.ts";
import { AttemptCancelled, cancellationCode, raceCancellation, throwIfCancelled } from "./cancellation.ts";
import { failureMessage } from "./failure.ts";
import type { ResolvedConfig } from "./config.ts";
import { parseLiveIds, parseModelsDevApiJson } from "./models-dev.ts";
import { reconcile } from "./reconcile.ts";
import { parseJsonFile } from "./state-file.ts";
import { buildLiveModelsEndpoint } from "./urls.ts";
import type { ModelsDevProvider, Patches, PreviousState, ReconcileResult } from "./types.ts";

/** The authoritative models.dev provider-map URL (constant, validated at use). */
export const MODELS_DEV_API_URL = "https://models.opencode.ai/api.json" as const;

/** Deadline code stamped onto the attempt's TimeoutReason. */
export const SYNC_DEADLINE_CODE = "OPENCODE_GO_SYNC_DEADLINE" as const;

/** Injected clock: the attempt never reads the wall clock. */
export interface Clock {
  now(): Date;
}

/** Opaque timer handle owned by the injected scheduler. */
export interface TimerHandle {
  readonly id: number;
}

/** Injected scheduler: the attempt's deadline is deterministic under tests. */
export interface Scheduler {
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

/** Minimal response contract; injected fetches satisfy it (node-fetch adapter too). */
export interface SyncResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/** Injected fetch: the only network seam. Header VALUES never leave call sites. */
export type SyncFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers?: Readonly<Record<string, string>> },
) => Promise<SyncResponse>;

/** Every typed failure a reconciliation attempt can produce. */
export const SYNC_FAILURE_CODES = [
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
  "MODELS_DEV_HTTP_401",
  "MODELS_DEV_HTTP_403",
  "MODELS_DEV_HTTP_503",
  "MODELS_DEV_HTTP_5XX",
  "MODELS_DEV_HTTP_ERROR",
  "MODELS_DEV_PARSE",
  "LIVE_HTTP_401",
  "LIVE_HTTP_403",
  "LIVE_HTTP_503",
  "LIVE_HTTP_5XX",
  "LIVE_HTTP_ERROR",
  "LIVE_PARSE",
  "NO_LIVE_BASE_URL",
  "FETCH_FAILED",
  "TIMEOUT",
  "ABORTED",
  "INTERNAL",
] as const;
export type SyncFailureCode = (typeof SYNC_FAILURE_CODES)[number];

/** Everything one bounded attempt needs; all dependencies are injected. */
export interface ReconcileAttemptDeps {
  readonly fetch: SyncFetch;
  readonly resolveKey: (ref: CredentialRef) => Promise<string>;
  readonly config: ResolvedConfig;
  readonly previous: PreviousState;
  readonly patches: Patches;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  /** Owner cancellation (lifecycle disposal); undefined means owner-less. */
  readonly signal: AbortSignal | undefined;
}

/** Typed attempt outcome: ok carries the reconcile result, never a partial pair. */
export type ReconcileAttemptResult =
  | {
      readonly kind: "ok";
      readonly result: ReconcileResult;
      readonly sources: { readonly modelsDevAt: string; readonly liveAt: string };
    }
  | { readonly kind: "failed"; readonly code: SyncFailureCode; readonly message: string };

/** A failed outcome carries only its code and the fixed sanitized message. */
function failedOutcome(code: SyncFailureCode): ReconcileAttemptResult {
  return { kind: "failed", code, message: failureMessage(code) };
}

/** Map a credential-seam rejection to its stable code; never echoes the value. */
function credentialFailureCode(error: unknown): SyncFailureCode {
  if (error instanceof LlmError) {
    if (error.code === "INVALID_CREDENTIAL") return "INVALID_CREDENTIAL";
    if (error.code === MISSING_CREDENTIAL_CODE) return "MISSING_CREDENTIAL";
  }
  return "INTERNAL";
}

/** Map an HTTP status to the source-specific failure code (no casts). */
function statusFailure(source: "MODELS_DEV" | "LIVE", status: number): SyncFailureCode {
  if (source === "MODELS_DEV") {
    if (status === 401) return "MODELS_DEV_HTTP_401";
    if (status === 403) return "MODELS_DEV_HTTP_403";
    if (status === 503) return "MODELS_DEV_HTTP_503";
    if (status >= 500) return "MODELS_DEV_HTTP_5XX";
    return "MODELS_DEV_HTTP_ERROR";
  }
  if (status === 401) return "LIVE_HTTP_401";
  if (status === 403) return "LIVE_HTTP_403";
  if (status === 503) return "LIVE_HTTP_503";
  if (status >= 500) return "LIVE_HTTP_5XX";
  return "LIVE_HTTP_ERROR";
}

/**
 * Run one bounded source pair under a single fused deadline. The credential
 * resolves FIRST but inside the deadline: missing/invalid credentials still
 * fail before any fetch, while a hanging seam yields TIMEOUT/ABORTED. The
 * live endpoint is derived from the parsed models.dev provider api; the
 * reconcile result is returned only when both sources validated and the
 * signal never aborted.
 */
export async function attemptReconcile(deps: ReconcileAttemptDeps): Promise<ReconcileAttemptResult> {
  const now = deps.clock.now();
  const observedAt = now.toISOString();
  const controller = new AbortController();
  const signal =
    deps.signal === undefined ? controller.signal : AbortSignal.any([deps.signal, controller.signal]);
  const timeoutHandle = deps.scheduler.setTimer(() => {
    controller.abort(new TimeoutReason(SYNC_DEADLINE_CODE, deps.config.timeoutMs));
  }, deps.config.timeoutMs);
  try {
    // An already-aborted owner must not even invoke the credential seam.
    throwIfCancelled(signal, SYNC_DEADLINE_CODE);
    const keyRace = await raceCancellation(deps.resolveKey(deps.config.apiKeyEnv), signal, SYNC_DEADLINE_CODE);
    if (keyRace.kind === "cancelled") return failedOutcome(keyRace.code);
    if (keyRace.kind === "error") return failedOutcome(credentialFailureCode(keyRace.error));
    const key = keyRace.value;

    throwIfCancelled(signal, SYNC_DEADLINE_CODE);
    const modelsDevRace = await raceCancellation(
      deps.fetch(MODELS_DEV_API_URL, { signal }),
      signal,
      SYNC_DEADLINE_CODE,
    );
    if (modelsDevRace.kind === "cancelled") return failedOutcome(modelsDevRace.code);
    if (modelsDevRace.kind === "error") throw modelsDevRace.error;
    const modelsDev = modelsDevRace.value;
    if (!modelsDev.ok) return failedOutcome(statusFailure("MODELS_DEV", modelsDev.status));
    throwIfCancelled(signal, SYNC_DEADLINE_CODE);
    const modelsDevTextRace = await raceCancellation(modelsDev.text(), signal, SYNC_DEADLINE_CODE);
    if (modelsDevTextRace.kind === "cancelled") return failedOutcome(modelsDevTextRace.code);
    if (modelsDevTextRace.kind === "error") throw modelsDevTextRace.error;
    const modelsDevText = modelsDevTextRace.value;
    let provider: ModelsDevProvider;
    try {
      provider = parseModelsDevApiJson(parseJsonFile(modelsDevText, "models.dev"));
    } catch {
      return failedOutcome("MODELS_DEV_PARSE");
    }
    const liveEndpoint = buildLiveModelsEndpoint(provider.api);
    if (liveEndpoint === undefined) return failedOutcome("NO_LIVE_BASE_URL");
    throwIfCancelled(signal, SYNC_DEADLINE_CODE);
    const liveRace = await raceCancellation(
      deps.fetch(liveEndpoint, { signal, headers: { authorization: `Bearer ${key}` } }),
      signal,
      SYNC_DEADLINE_CODE,
    );
    if (liveRace.kind === "cancelled") return failedOutcome(liveRace.code);
    if (liveRace.kind === "error") throw liveRace.error;
    const live = liveRace.value;
    if (!live.ok) return failedOutcome(statusFailure("LIVE", live.status));
    throwIfCancelled(signal, SYNC_DEADLINE_CODE);
    const liveTextRace = await raceCancellation(live.text(), signal, SYNC_DEADLINE_CODE);
    if (liveTextRace.kind === "cancelled") return failedOutcome(liveTextRace.code);
    if (liveTextRace.kind === "error") throw liveTextRace.error;
    const liveText = liveTextRace.value;
    let liveIds: readonly string[];
    try {
      liveIds = parseLiveIds(parseJsonFile(liveText, "live /models"));
    } catch {
      return failedOutcome("LIVE_PARSE");
    }
    throwIfCancelled(signal, SYNC_DEADLINE_CODE);
    const result = reconcile({
      provider,
      liveIds,
      patches: deps.patches,
      previous: deps.previous,
      now,
    });
    return { kind: "ok", result, sources: { modelsDevAt: observedAt, liveAt: observedAt } };
  } catch (error) {
    if (error instanceof AttemptCancelled) return failedOutcome(error.code);
    const cancelled = cancellationCode(signal, SYNC_DEADLINE_CODE);
    if (cancelled !== undefined) return failedOutcome(cancelled);
    return failedOutcome("FETCH_FAILED");
  } finally {
    deps.scheduler.clearTimer(timeoutHandle);
  }
}

/** Production fetch adapter: wraps global fetch into the injected contract. */
export function nodeFetch(): SyncFetch {
  return async (url, init) => {
    const response = await globalThis.fetch(url, {
      signal: init.signal,
      ...(init.headers === undefined ? {} : { headers: init.headers }),
    });
    return { status: response.status, ok: response.ok, text: () => response.text() };
  };
}
