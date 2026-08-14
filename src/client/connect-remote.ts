/**
 * Browser-side remote for the OpenCode Go Connect card.
 *
 * The card talks to the Host control seam over same-origin plugin routes
 * (the `ctx.webServer` registrations in `src/web-routes.ts`). Responses cross
 * the fetch boundary here and are treated as HOSTILE: unknown payloads are
 * parsed with runtime guards into the narrow client types, arbitrary Host
 * message text is replaced by fixed local messages, failure codes pass an
 * explicit safe allowlist (unknown → `MALFORMED`/`UNKNOWN`), and numeric/
 * string fields are strictly validated (finite nonnegative integers,
 * canonical ISO instants). No Host string, code, count or timestamp can
 * reach the card or the DOM raw.
 */
import { isCanonicalIsoInstant, isRecord } from "../guards.ts";

/** Plugin-owned same-origin routes; the Host registers them on `ctx.webServer`. */
export const CONNECT_ROUTES = {
  status: "/plugins/dsh-opencode-go/status",
  connect: "/plugins/dsh-opencode-go/connect",
  disconnect: "/plugins/dsh-opencode-go/disconnect",
  doctor: "/plugins/dsh-opencode-go/doctor",
} as const;

export type ClientConnectResult =
  | { readonly kind: "connected" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "store-failed"; readonly message: string };

export type ClientDisconnectResult =
  | { readonly kind: "disconnected" }
  | { readonly kind: "store-failed"; readonly message: string };

export type ClientDoctorSummary =
  | { readonly kind: "configured"; readonly liveModelCount: number }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly code: string };

export interface ClientStatus {
  readonly configured: boolean;
  readonly origin: "embedded" | "cache" | "refreshed" | "corrupt";
  readonly modelCount: number;
  readonly refreshedAt: string;
  readonly lastAttempt:
    | { readonly kind: "ok" }
    | { readonly kind: "failed"; readonly code: string }
    | { readonly kind: "none" };
}

/** The credential/status/doctor surface the Host exposes to the card. */
export interface ConnectRemote {
  readonly connect: (key: string) => Promise<ClientConnectResult>;
  readonly disconnect: () => Promise<ClientDisconnectResult>;
  readonly status: () => Promise<ClientStatus>;
  readonly doctor: () => Promise<ClientDoctorSummary>;
}

/** Fixed local messages: Host payload text never crosses this boundary. */
export const FIXED_REQUEST_FAILED = "the connection request failed" as const;
const FIXED_KEY_REFUSED = "the key was refused before storing" as const;
const FIXED_UNKNOWN_CODE = "UNKNOWN" as const;
const FIXED_MALFORMED_CODE = "MALFORMED" as const;

/** The Host's stable doctor failure codes; anything else is MALFORMED. */
const SAFE_DOCTOR_CODES = [
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

/** The Host's stable refresh attempt codes; anything else is UNKNOWN. */
const SAFE_ATTEMPT_CODES = [
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
  "CACHE_WRITE_FAILED",
] as const;

function isSafeCode(value: unknown, allowlist: readonly string[]): value is string {
  return typeof value === "string" && allowlist.some((code) => code === value);
}

function isFiniteNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && Number.isFinite(value);
}

/** Parse the connect response; Host message text is never propagated. */
export function parseConnectResult(value: unknown): ClientConnectResult {
  if (!isRecord(value)) return { kind: "store-failed", message: FIXED_REQUEST_FAILED };
  switch (value.kind) {
    case "connected":
      return { kind: "connected" };
    case "invalid":
      return { kind: "invalid", message: FIXED_KEY_REFUSED };
    case "store-failed":
      return { kind: "store-failed", message: FIXED_REQUEST_FAILED };
    default:
      return { kind: "store-failed", message: FIXED_REQUEST_FAILED };
  }
}

/** Parse the disconnect response; Host message text is never propagated. */
export function parseDisconnectResult(value: unknown): ClientDisconnectResult {
  if (!isRecord(value)) return { kind: "store-failed", message: FIXED_REQUEST_FAILED };
  switch (value.kind) {
    case "disconnected":
      return { kind: "disconnected" };
    case "store-failed":
      return { kind: "store-failed", message: FIXED_REQUEST_FAILED };
    default:
      return { kind: "store-failed", message: FIXED_REQUEST_FAILED };
  }
}

/** Parse the doctor response; only allowlisted codes and sane counts pass. */
export function parseDoctorSummary(value: unknown): ClientDoctorSummary {
  if (!isRecord(value)) return { kind: "failed", code: FIXED_MALFORMED_CODE };
  switch (value.kind) {
    case "configured":
      return isFiniteNonnegativeInteger(value.liveModelCount)
        ? { kind: "configured", liveModelCount: value.liveModelCount }
        : { kind: "failed", code: FIXED_MALFORMED_CODE };
    case "unconfigured":
      return { kind: "unconfigured" };
    case "unavailable":
      return { kind: "unavailable" };
    case "failed":
      return isSafeCode(value.code, SAFE_DOCTOR_CODES)
        ? { kind: "failed", code: value.code }
        : { kind: "failed", code: FIXED_MALFORMED_CODE };
    default:
      return { kind: "failed", code: FIXED_MALFORMED_CODE };
  }
}

/** Parse the status response; a single malformed field fails the whole read. */
export function parseStatus(value: unknown): ClientStatus {
  if (
    !isRecord(value)
    || typeof value.configured !== "boolean"
    || !isFiniteNonnegativeInteger(value.modelCount)
    || typeof value.refreshedAt !== "string"
    || !isCanonicalIsoInstant(value.refreshedAt)
    || !isRecord(value.lastAttempt)
  ) {
    throw new Error("the status response was malformed");
  }
  const origin = value.origin;
  if (origin !== "embedded" && origin !== "cache" && origin !== "refreshed" && origin !== "corrupt") {
    throw new Error("the status response was malformed");
  }
  let lastAttempt: ClientStatus["lastAttempt"];
  if (value.lastAttempt.kind === "ok" || value.lastAttempt.kind === "none") {
    lastAttempt = { kind: value.lastAttempt.kind };
  } else if (value.lastAttempt.kind === "failed" && isSafeCode(value.lastAttempt.code, SAFE_ATTEMPT_CODES)) {
    lastAttempt = { kind: "failed", code: value.lastAttempt.code };
  } else if (value.lastAttempt.kind === "failed") {
    lastAttempt = { kind: "failed", code: FIXED_UNKNOWN_CODE };
  } else {
    throw new Error("the status response was malformed");
  }
  return {
    configured: value.configured,
    origin,
    modelCount: value.modelCount,
    refreshedAt: value.refreshedAt,
    lastAttempt,
  };
}

async function jsonRequest(
  path: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    credentials: "same-origin",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error("the connection request failed");
  }
  return value;
}

/** The fetch-backed remote wired by the browser-plugin registration. */
export function createConnectRemote(): ConnectRemote {
  return {
    connect: async (key) => {
      try {
        return parseConnectResult(await jsonRequest(CONNECT_ROUTES.connect, "POST", { key }));
      } catch {
        return { kind: "store-failed", message: FIXED_REQUEST_FAILED };
      }
    },
    disconnect: async () => {
      try {
        return parseDisconnectResult(await jsonRequest(CONNECT_ROUTES.disconnect, "POST", undefined));
      } catch {
        return { kind: "store-failed", message: FIXED_REQUEST_FAILED };
      }
    },
    status: async () => {
      try {
        return parseStatus(await jsonRequest(CONNECT_ROUTES.status, "GET", undefined));
      } catch {
        throw new Error("the status request failed");
      }
    },
    doctor: async () => {
      try {
        return parseDoctorSummary(await jsonRequest(CONNECT_ROUTES.doctor, "POST", undefined));
      } catch {
        return { kind: "failed", code: "REQUEST_FAILED" };
      }
    },
  };
}
