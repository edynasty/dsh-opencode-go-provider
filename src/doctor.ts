/**
 * Authenticated /models doctor for the OpenCode Go provider.
 *
 * The doctor is the one live surface that may touch the network, and only as a
 * GET on the /v1/models endpoint derived from VALIDATED catalog metadata —
 * never a caller-supplied URL or header, never a generation or metadata
 * endpoint. The credential resolves per operation; the deadline covers the
 * credential and every fetch/body seam exactly like the refresh attempt, so a
 * never-resolving seam yields TIMEOUT/ABORTED and a late result is discarded.
 * Outcomes are typed and sanitized: counts, codes and fixed messages only —
 * response bodies and key fragments never reach them.
 */
import { LlmError } from "@deepseek-ai/dsh-llm";
import { TimeoutReason } from "@deepseek-ai/dsh-timeout";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { MISSING_CREDENTIAL_CODE } from "./credentials.ts";
import { AttemptCancelled, cancellationCode, raceCancellation, throwIfCancelled } from "./cancellation.ts";
import { failureMessage } from "./failure.ts";
import type { ResolvedConfig } from "./config.ts";
import { parseLiveIds } from "./models-dev.ts";
import { parseJsonFile } from "./state-file.ts";
import { parseBaseUrl } from "./urls.ts";
import type { Clock, Scheduler, SyncFetch } from "./sync.ts";
import type { CatalogModel } from "./types.ts";

/** Deadline code stamped onto the doctor's TimeoutReason. */
export const DOCTOR_DEADLINE_CODE = "OPENCODE_GO_DOCTOR_DEADLINE" as const;

/** Every typed failure a doctor attempt can produce. */
export const DOCTOR_FAILURE_CODES = [
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
  "LIVE_HTTP_401",
  "LIVE_HTTP_403",
  "LIVE_HTTP_429",
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
export type DoctorFailureCode = (typeof DOCTOR_FAILURE_CODES)[number];

/** Sanitized doctor outcome; never carries keys, URLs or response bodies. */
export type DoctorOutcome =
  | {
      readonly kind: "configured";
      readonly liveModelCount: number;
      readonly httpStatus: number;
      readonly observedAt: string;
    }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly code: DoctorFailureCode; readonly message: string };

/** Everything one bounded doctor attempt needs; every dependency is injected. */
export interface DoctorDeps {
  readonly fetch: SyncFetch;
  readonly resolveKey: (ref: CredentialRef) => Promise<string>;
  readonly config: ResolvedConfig;
  /** Validated current catalog; the ONLY source the live endpoint derives from. */
  readonly models: () => readonly CatalogModel[];
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  /** Caller cancellation; undefined means owner-less. */
  readonly signal?: AbortSignal;
}

function failedOutcome(code: DoctorFailureCode): DoctorOutcome {
  return { kind: "failed", code, message: failureMessage(code) };
}

/** Map a credential-seam rejection to its stable code; never echoes the value. */
function credentialFailureCode(error: unknown): DoctorFailureCode {
  if (error instanceof LlmError) {
    if (error.code === "INVALID_CREDENTIAL") return "INVALID_CREDENTIAL";
    if (error.code === MISSING_CREDENTIAL_CODE) return "MISSING_CREDENTIAL";
  }
  return "INTERNAL";
}

/** Map a live /models HTTP status to its stable failure code. */
function statusFailure(status: number): DoctorFailureCode {
  if (status === 401) return "LIVE_HTTP_401";
  if (status === 403) return "LIVE_HTTP_403";
  if (status === 429) return "LIVE_HTTP_429";
  if (status === 503) return "LIVE_HTTP_503";
  if (status >= 500) return "LIVE_HTTP_5XX";
  return "LIVE_HTTP_ERROR";
}

/**
 * Derive the live /models endpoint from the validated catalog: every candidate
 * base URL is re-validated, and only a pathname EXACTLY `/zen/go/v1` (after
 * URL canonicalization) yields the exact `https://opencode.ai/zen/go/v1/models`
 * endpoint. A sibling path like `/zen/go/rogue/v1` is never accepted.
 * `undefined` means no usable endpoint exists in the current catalog.
 */
export function deriveLiveEndpoint(models: readonly CatalogModel[]): string | undefined {
  for (const model of models) {
    const base = parseBaseUrl(model.baseUrl);
    if (base === undefined) continue;
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      continue;
    }
    if (url.pathname !== "/zen/go/v1") continue;
    return "https://opencode.ai/zen/go/v1/models";
  }
  return undefined;
}

/**
 * Run one bounded doctor: resolve the credential (inside the deadline), derive
 * the endpoint, issue exactly one authenticated GET, parse only live ids, and
 * report the sanitized count. The deadline and caller cancellation are fused,
 * so a hanging or abort-ignoring seam settles TIMEOUT/ABORTED.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorOutcome> {
  const now = deps.clock.now();
  const observedAt = now.toISOString();
  const controller = new AbortController();
  const signal =
    deps.signal === undefined ? controller.signal : AbortSignal.any([deps.signal, controller.signal]);
  const timeoutHandle = deps.scheduler.setTimer(() => {
    controller.abort(new TimeoutReason(DOCTOR_DEADLINE_CODE, deps.config.timeoutMs));
  }, deps.config.timeoutMs);
  try {
    throwIfCancelled(signal, DOCTOR_DEADLINE_CODE);
    const keyRace = await raceCancellation(
      deps.resolveKey(deps.config.apiKeyEnv),
      signal,
      DOCTOR_DEADLINE_CODE,
    );
    if (keyRace.kind === "cancelled") return failedOutcome(keyRace.code);
    if (keyRace.kind === "error") {
      const code = credentialFailureCode(keyRace.error);
      return code === "MISSING_CREDENTIAL" ? { kind: "unconfigured" } : failedOutcome(code);
    }
    const key = keyRace.value;

    const endpoint = deriveLiveEndpoint(deps.models());
    if (endpoint === undefined) return { kind: "unavailable" };
    throwIfCancelled(signal, DOCTOR_DEADLINE_CODE);
    const liveRace = await raceCancellation(
      deps.fetch(endpoint, { signal, headers: { authorization: `Bearer ${key}` } }),
      signal,
      DOCTOR_DEADLINE_CODE,
    );
    if (liveRace.kind === "cancelled") return failedOutcome(liveRace.code);
    if (liveRace.kind === "error") throw liveRace.error;
    const live = liveRace.value;
    if (!live.ok) return failedOutcome(statusFailure(live.status));
    throwIfCancelled(signal, DOCTOR_DEADLINE_CODE);
    const textRace = await raceCancellation(live.text(), signal, DOCTOR_DEADLINE_CODE);
    if (textRace.kind === "cancelled") return failedOutcome(textRace.code);
    if (textRace.kind === "error") throw textRace.error;
    let ids: readonly string[];
    try {
      ids = parseLiveIds(parseJsonFile(textRace.value, "live /models"));
    } catch {
      return failedOutcome("LIVE_PARSE");
    }
    throwIfCancelled(signal, DOCTOR_DEADLINE_CODE);
    return { kind: "configured", liveModelCount: ids.length, httpStatus: live.status, observedAt };
  } catch (error) {
    if (error instanceof AttemptCancelled) return failedOutcome(error.code);
    const cancelled = cancellationCode(signal, DOCTOR_DEADLINE_CODE);
    if (cancelled !== undefined) return failedOutcome(cancelled);
    return failedOutcome("FETCH_FAILED");
  } finally {
    deps.scheduler.clearTimer(timeoutHandle);
  }
}
