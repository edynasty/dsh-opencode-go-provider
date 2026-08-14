/**
 * Task 7 doctor contract (red-first).
 *
 * The doctor is the ONLY live surface that may touch the network, and it is
 * limited to an authenticated GET on the /v1/models endpoint derived from
 * validated catalog metadata. These tests pin: the endpoint derivation, the
 * GET-only single authenticated request, the typed sanitized outcome variants
 * (configured / unconfigured / unavailable / auth / rate-limit / server /
 * transport / timeout / aborted / malformed), the injected deadline, and the
 * never-echo rule for response bodies. Every fetch is an injected seam that
 * throws on any URL outside the derived live endpoint, so a real socket can
 * never be reached.
 */
import { describe, expect, it } from "vitest";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { embeddedCatalogModels } from "../src/catalog-loader.ts";
import { resolveConfig } from "../src/config.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { deriveLiveEndpoint, runDoctor } from "../src/doctor.ts";
import type { DoctorDeps } from "../src/doctor.ts";
import { failureMessage } from "../src/failure.ts";
import { FakeClock, FakeScheduler } from "./helpers/fake-clock.ts";
import type { SyncFetch, SyncResponse } from "../src/sync.ts";
import type { CatalogModel } from "../src/types.ts";

/** Fake credential shared by the doctor fixtures (allowlisted, never real). */
const FAKE_KEY = "sk-doctor-fake-key-0123456789abcdef";

const CONFIG: ResolvedConfig = resolveConfig({
  apiKeyEnv: "OPENCODE_GO_API_KEY",
  refreshMs: 3_600_000,
  freshnessMs: 300_000,
  timeoutMs: 10_000,
  graceMs: 1_209_600_000,
});

/** The live /models endpoint derived from the shipped catalog metadata. */
const DERIVED_LIVE_URL = "https://opencode.ai/zen/go/v1/models";

function liveResponse(status: number, payload: unknown): SyncResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

function textResponse(status: number, text: string): SyncResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(text),
  };
}

export interface DoctorCall {
  readonly url: string;
  readonly initKeys: readonly string[];
  readonly headerNames: readonly string[];
  readonly aborted: boolean;
}

/** A fetch seam serving exactly the derived live endpoint; any other URL throws. */
function makeDoctorFetch(plan: {
  readonly status: number;
  readonly body?: unknown;
  readonly rawText?: string;
  readonly hang?: boolean;
  readonly hangText?: boolean;
}): { readonly fetch: SyncFetch; readonly calls: readonly DoctorCall[] } {
  const internal: DoctorCall[] = [];
  const fetch: SyncFetch = (url, init) => {
    internal.push({
      url,
      initKeys: Object.keys(init),
      headerNames: Object.keys(init.headers ?? {}),
      aborted: init.signal.aborted,
    });
    if (url !== DERIVED_LIVE_URL) {
      throw new Error(`test guard: unexpected doctor URL ${url}`);
    }
    if (plan.hang) {
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) {
          reject(init.signal.reason ?? new Error("test doctor fetch aborted"));
          return;
        }
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason ?? new Error("test doctor fetch aborted")),
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
    return Promise.resolve(liveResponse(plan.status, plan.body));
  };
  return { fetch, calls: internal };
}

function doctorDeps(overrides: Partial<DoctorDeps>): DoctorDeps {
  const clock = new FakeClock(1_800_000_000_000);
  return {
    fetch: makeDoctorFetch({ status: 200, body: { data: [] } }).fetch,
    resolveKey: async () => FAKE_KEY,
    config: CONFIG,
    models: () => embeddedCatalogModels(),
    clock,
    scheduler: new FakeScheduler(clock),
    ...overrides,
  };
}

describe("deriveLiveEndpoint", () => {
  it("derives the /v1/models endpoint from validated catalog base URLs", () => {
    // Given: the shipped catalog mixes /zen/go (anthropic) and /zen/go/v1 bases.
    // Then: only the canonical /v1 family yields the live list endpoint.
    expect(deriveLiveEndpoint(embeddedCatalogModels())).toBe(DERIVED_LIVE_URL);
  });

  it("returns undefined when no catalog model yields a /v1 base URL", () => {
    // Given: only anthropic-style base URLs (no /v1 family).
    const models: readonly CatalogModel[] = [
      { id: "qwen", name: "Qwen", provider: "opencode-go", protocol: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go", contextWindow: 256000, maxTokens: 65536, reasoning: false },
    ];
    expect(deriveLiveEndpoint(models)).toBeUndefined();
  });

  it("accepts only the exact /zen/go/v1 base and never a sibling v1 path", () => {
    const rogue: readonly CatalogModel[] = [
      { id: "rogue", name: "Rogue", provider: "opencode-go", protocol: "openai-completions", baseUrl: "https://opencode.ai/zen/go/rogue/v1", contextWindow: 1, maxTokens: 1, reasoning: false },
    ];
    expect(deriveLiveEndpoint(rogue)).toBeUndefined();
    const trailingSlash: readonly CatalogModel[] = [
      { id: "ts", name: "TS", provider: "opencode-go", protocol: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1/", contextWindow: 1, maxTokens: 1, reasoning: false },
    ];
    expect(deriveLiveEndpoint(trailingSlash)).toBeUndefined();
    const exact: readonly CatalogModel[] = [
      { id: "exact", name: "Exact", provider: "opencode-go", protocol: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", contextWindow: 1, maxTokens: 1, reasoning: false },
    ];
    expect(deriveLiveEndpoint(exact)).toBe("https://opencode.ai/zen/go/v1/models");
  });

  it("a rogue /zen/go/rogue/v1 catalog never receives Authorization (zero fetch)", async () => {
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] } });
    const rogue: readonly CatalogModel[] = [
      { id: "rogue", name: "Rogue", provider: "opencode-go", protocol: "openai-completions", baseUrl: "https://opencode.ai/zen/go/rogue/v1", contextWindow: 1, maxTokens: 1, reasoning: false },
    ];
    const outcome = await runDoctor(doctorDeps({ fetch: fetchPlan.fetch, models: () => rogue }));
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(fetchPlan.calls).toHaveLength(0);
  });

  it("skips invalid base URLs and returns undefined for an empty catalog", () => {
    const models: readonly CatalogModel[] = [
      { id: "bad", name: "Bad", provider: "opencode-go", protocol: "openai-completions", baseUrl: "http://evil.example/v1", contextWindow: 1, maxTokens: 1, reasoning: false },
    ];
    expect(deriveLiveEndpoint(models)).toBeUndefined();
    expect(deriveLiveEndpoint([])).toBeUndefined();
  });
});

describe("runDoctor", () => {
  it("issues one authenticated GET /models and reports sanitized live counts", async () => {
    // Given: a live endpoint answering two distinct ids (one duplicate).
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [{ id: "grok-4.5" }, { id: "gpt-5.6" }, { id: "grok-4.5" }] } });
    const outcome = await runDoctor(doctorDeps({ fetch: fetchPlan.fetch }));
    // Then: exactly one request to the derived endpoint, GET-only (no method
    // key in the init), carrying the authorization header name.
    expect(fetchPlan.calls).toHaveLength(1);
    expect(fetchPlan.calls[0]?.url).toBe(DERIVED_LIVE_URL);
    expect(fetchPlan.calls[0]?.initKeys).not.toContain("method");
    expect(fetchPlan.calls[0]?.headerNames).toEqual(["authorization"]);
    // And the outcome is the sanitized configured variant with deduplicated count.
    expect(outcome).toEqual({
      kind: "configured",
      liveModelCount: 2,
      httpStatus: 200,
      observedAt: new Date(1_800_000_000_000).toISOString(),
    });
  });

  it("accepts no caller URL or header override: only the derived endpoint is reachable", async () => {
    // Given: a hostile caller would love to inject a custom URL or header; the
    // doctor deps expose none. The guard fetch proves only the derived URL is
    // ever requested and only the constructed authorization header is sent.
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] } });
    const outcome = await runDoctor(doctorDeps({ fetch: fetchPlan.fetch }));
    expect(outcome.kind).toBe("configured");
    expect(fetchPlan.calls).toHaveLength(1);
    expect(fetchPlan.calls[0]?.headerNames).toEqual(["authorization"]);
  });

  it("reports unconfigured with zero fetches when the credential is missing", async () => {
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] } });
    const missing = new LlmError("no credential", "MISSING_CREDENTIAL");
    const outcome = await runDoctor(
      doctorDeps({ fetch: fetchPlan.fetch, resolveKey: async () => Promise.reject(missing) }),
    );
    expect(outcome).toEqual({ kind: "unconfigured" });
    expect(fetchPlan.calls).toHaveLength(0);
  });

  it("reports INVALID_CREDENTIAL with zero fetches for a non-canonical key", async () => {
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] } });
    const invalid = new LlmError("not canonical", "INVALID_CREDENTIAL");
    const outcome = await runDoctor(
      doctorDeps({ fetch: fetchPlan.fetch, resolveKey: async () => Promise.reject(invalid) }),
    );
    expect(outcome).toEqual({
      kind: "failed",
      code: "INVALID_CREDENTIAL",
      message: failureMessage("INVALID_CREDENTIAL"),
    });
    expect(fetchPlan.calls).toHaveLength(0);
  });

  it("reports unavailable with zero fetches when no live endpoint is derivable", async () => {
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] } });
    const outcome = await runDoctor(doctorDeps({ fetch: fetchPlan.fetch, models: () => [] }));
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(fetchPlan.calls).toHaveLength(0);
  });

  it.each([
    { status: 401, expected: "LIVE_HTTP_401" },
    { status: 403, expected: "LIVE_HTTP_403" },
    { status: 429, expected: "LIVE_HTTP_429" },
    { status: 503, expected: "LIVE_HTTP_503" },
    { status: 500, expected: "LIVE_HTTP_5XX" },
    { status: 404, expected: "LIVE_HTTP_ERROR" },
  ])("maps HTTP $status to the stable $expected outcome", async ({ status, expected }) => {
    const fetchPlan = makeDoctorFetch({ status, body: { error: { message: "hostile body" } } });
    const outcome = await runDoctor(doctorDeps({ fetch: fetchPlan.fetch }));
    expect(outcome).toEqual({ kind: "failed", code: expected, message: failureMessage(expected) });
  });

  it("reports LIVE_PARSE for a malformed body without echoing its text", async () => {
    // Given: a body that is not JSON and carries a fake secret.
    const secret = "sk-malformed-fake-secret-abcdef0123456789";
    const fetchPlan = makeDoctorFetch({ status: 200, rawText: `not-json ${secret}` });
    const outcome = await runDoctor(doctorDeps({ fetch: fetchPlan.fetch }));
    expect(outcome).toEqual({ kind: "failed", code: "LIVE_PARSE", message: failureMessage("LIVE_PARSE") });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it("reports TIMEOUT when the deadline elapses before the seam settles", async () => {
    // Given: a hanging fetch and an injected scheduler.
    const clock = new FakeClock(1_800_000_000_000);
    const scheduler = new FakeScheduler(clock);
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] }, hang: true });
    // When: the attempt starts, the key microtask resolves, then the deadline
    // fires beyond the 10s configured timeout.
    const pending = runDoctor(doctorDeps({ fetch: fetchPlan.fetch, clock, scheduler }));
    await Promise.resolve();
    await Promise.resolve();
    scheduler.advance(10_001);
    const outcome = await pending;
    expect(outcome).toEqual({ kind: "failed", code: "TIMEOUT", message: failureMessage("TIMEOUT") });
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("reports ABORTED with zero fetches when the caller signal is already aborted", async () => {
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] } });
    const controller = new AbortController();
    controller.abort();
    const outcome = await runDoctor(doctorDeps({ fetch: fetchPlan.fetch, signal: controller.signal }));
    expect(outcome).toEqual({ kind: "failed", code: "ABORTED", message: failureMessage("ABORTED") });
    expect(fetchPlan.calls).toHaveLength(0);
  });

  it("never echoes response-body text into any outcome", async () => {
    // Given: a body carrying the fake secret and hostile prose.
    const secret = "sk-body-fake-secret-abcdef0123456789";
    const fetchPlan = makeDoctorFetch({ status: 200, rawText: `{"data":[{${JSON.stringify(`id: ${secret}`)}}]}` });
    const outcome = await runDoctor(doctorDeps({ fetch: fetchPlan.fetch }));
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it("aborts between the credential seam and the fetch: zero requests, no Authorization", async () => {
    // Given: the caller aborts DURING key resolution, after the key promise
    // started but before any fetch seam is evaluated.
    const controller = new AbortController();
    const clock = new FakeClock(1_800_000_000_000);
    const scheduler = new FakeScheduler(clock);
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] } });
    const outcome = await runDoctor(
      doctorDeps({
        fetch: fetchPlan.fetch,
        clock,
        scheduler,
        signal: controller.signal,
        resolveKey: async () => {
          controller.abort();
          return FAKE_KEY;
        },
      }),
    );
    expect(outcome).toEqual({ kind: "failed", code: "ABORTED", message: failureMessage("ABORTED") });
    expect(fetchPlan.calls).toHaveLength(0);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("a hanging body reader yields TIMEOUT with zero pending timers", async () => {
    const clock = new FakeClock(1_800_000_000_000);
    const scheduler = new FakeScheduler(clock);
    const fetchPlan = makeDoctorFetch({ status: 200, body: { data: [] }, hangText: true });
    const pending = runDoctor(doctorDeps({ fetch: fetchPlan.fetch, clock, scheduler }));
    await Promise.resolve();
    await Promise.resolve();
    scheduler.advance(10_001);
    const outcome = await pending;
    expect(outcome).toEqual({ kind: "failed", code: "TIMEOUT", message: failureMessage("TIMEOUT") });
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("a late seam rejection after abort stays observed and never changes the outcome", async () => {
    // Given: the fetch rejects on a later microtask even though the deadline
    // already settled the attempt — the race observes the rejection (no
    // unhandled rejection) and the outcome stays TIMEOUT.
    const clock = new FakeClock(1_800_000_000_000);
    const scheduler = new FakeScheduler(clock);
    const fetch: SyncFetch = (url, init) => {
      if (url !== DERIVED_LIVE_URL) throw new Error(`test guard: unexpected doctor URL ${url}`);
      void init.signal;
      return new Promise((_resolve, reject) => {
        queueMicrotask(() => reject(new Error("late seam rejection")));
      });
    };
    const pending = runDoctor(doctorDeps({ fetch, clock, scheduler }));
    await Promise.resolve();
    await Promise.resolve();
    scheduler.advance(10_001);
    const outcome = await pending;
    expect(outcome).toEqual({ kind: "failed", code: "TIMEOUT", message: failureMessage("TIMEOUT") });
    expect(scheduler.pendingCount()).toBe(0);
  });
});
