/**
 * Fake network for the Task 6 sync/lifecycle specs.
 *
 * Every network dependency in `src/sync.ts` flows through the injected
 * `SyncFetch`. This helper serves canned responses for exactly the two
 * authoritative source URLs (models.dev api.json and the authenticated live
 * /models endpoint) and throws for ANY other URL — a hard guard that makes
 * accidental real traffic a loud test failure before any socket exists. Each
 * call is recorded as a sanitized fact (url, header names' presence, whether
 * the caller aborted); header VALUES are never recorded, so no key material
 * can reach assertions or evidence.
 */
import { MODELS_DEV_API_URL } from "../../src/sync.ts";
import type { SyncFetch, SyncResponse } from "../../src/sync.ts";

/** The live /models endpoint derived from the committed models.dev fixture. */
export const FIXTURE_LIVE_URL = "https://opencode.ai/zen/go/v1/models";

/** A canned JSON response the injected fetch serves. */
export function jsonResponse(status: number, payload: unknown): SyncResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

/** A canned plain-text response (malformed payloads, truncation). */
export function textResponse(status: number, text: string): SyncResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(text),
  };
}

/** Per-source behavior plan; `hang` never resolves until the caller aborts. */
export interface SourcePlan {
  readonly status: number;
  /** JSON payload served as the response body (when `rawText` is absent). */
  readonly body?: unknown;
  /** Verbatim response text served instead of `body` (malformed payloads). */
  readonly rawText?: string;
  /** When set, the response stays open until `init.signal` aborts. */
  readonly hang?: boolean;
  /** When set, the fetch resolves but `text()` never settles (ignores abort). */
  readonly hangText?: boolean;
}

/** Sanitized record of one fetch call: no header values, no bodies. */
export interface FetchCall {
  readonly url: string;
  /** Header NAMES only (authorization present/absent), never values. */
  readonly headerNames: readonly string[];
  readonly aborted: boolean;
}

export interface FetchSpy {
  readonly fetch: SyncFetch;
  readonly calls: readonly FetchCall[];
  setModelsDev(plan: SourcePlan): void;
  setLive(plan: SourcePlan): void;
}

/**
 * Build the injected fetch plus a mutable plan and a call recorder. Any URL
 * outside the two authoritative sources throws before a response exists.
 */
export function makeFetch(initial: {
  readonly modelsDev: SourcePlan;
  readonly live: SourcePlan;
  readonly liveUrl?: string;
}): FetchSpy {
  const liveUrl = initial.liveUrl ?? FIXTURE_LIVE_URL;
  let modelsDev = initial.modelsDev;
  let live = initial.live;
  interface MutableCall {
    url: string;
    headerNames: readonly string[];
    aborted: boolean;
  }
  const internal: MutableCall[] = [];
  const fetch: SyncFetch = (url, init) => {
    const plan = url === MODELS_DEV_API_URL ? modelsDev : url === liveUrl ? live : undefined;
    if (plan === undefined) {
      throw new Error(`test guard: unexpected network URL ${url}`);
    }
    const call: MutableCall = {
      url,
      headerNames: Object.keys(init.headers ?? {}),
      aborted: false,
    };
    internal.push(call);
    if (init.signal.aborted) {
      call.aborted = true;
    } else {
      init.signal.addEventListener(
        "abort",
        () => {
          call.aborted = true;
        },
        { once: true },
      );
    }
    if (plan.hang) {
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) {
          reject(init.signal.reason ?? new Error("test fetch aborted"));
          return;
        }
        init.signal.addEventListener(
          "abort",
          () => {
            reject(init.signal.reason ?? new Error("test fetch aborted"));
          },
          { once: true },
        );
      });
    }
    if (plan.hangText) {
      return Promise.resolve({
        status: plan.status,
        ok: plan.status >= 200 && plan.status < 300,
        text: () => new Promise<string>(() => undefined),
      });
    }
    if (plan.rawText !== undefined) {
      return Promise.resolve(textResponse(plan.status, plan.rawText));
    }
    return Promise.resolve(jsonResponse(plan.status, plan.body));
  };
  return {
    fetch,
    get calls(): readonly FetchCall[] {
      return internal.map((call) => ({
        url: call.url,
        headerNames: call.headerNames,
        aborted: call.aborted,
      }));
    },
    setModelsDev: (plan) => {
      modelsDev = plan;
    },
    setLive: (plan) => {
      live = plan;
    },
  };
}

/**
 * The fail-closed guard the test harness injects by default: ANY URL throws
 * before a socket exists, so a booted plugin can never contact a real
 * endpoint. Tests that exercise refresh behavior provide their own `makeFetch`.
 */
export function failClosedFetch(): SyncFetch {
  return (url) => {
    throw new Error(`test guard: unexpected network URL ${url}`);
  };
}
