/**
 * Task 6 reconciliation-attempt specs (red-first).
 *
 * `attemptReconcile` fetches models.dev and the authenticated live /models
 * endpoint as ONE bounded attempt under a single deadline: if either source
 * fails validation/status/timeout, there is no reconcile, no persist and no
 * partial result. The credential is resolved through the seam per attempt and
 * only ever reaches the live endpoint (never models.dev, never the cache).
 * Concurrent callers rely on the lifecycle's single-flight; here we prove the
 * attempt itself is bounded, source-paired and secret-safe.
 */
import { describe, expect, it } from "vitest";
import { INVALID_CREDENTIAL_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { MISSING_CREDENTIAL_CODE } from "../src/credentials.ts";
import { Config, resolveConfig } from "../src/config.ts";
import { MODELS_DEV_API_URL, SYNC_DEADLINE_CODE, attemptReconcile } from "../src/sync.ts";
import type { ReconcileAttemptDeps, SyncFetch } from "../src/sync.ts";
import { raceCancellation } from "../src/cancellation.ts";
import { parsePatchesFile } from "../src/state-file.ts";
import type { PreviousState } from "../src/types.ts";
import { readFixture, makePatches } from "./helpers/catalog-fixtures.ts";
import { FakeClock, FakeScheduler } from "./helpers/fake-clock.ts";
import { FIXTURE_LIVE_URL, jsonResponse, makeFetch } from "./helpers/fake-network.ts";

const T0 = new Date("2026-08-14T00:00:00.000Z");
const FAKE_KEY = "sk-sync-fake-key-0123456789";

/** The full models.dev provider map (fixture record wrapped in its map key). */
function modelsDevMap(): unknown {
  return { "opencode-go": JSON.parse(readFixture("models-dev-opencode-go.json")) };
}

/** The frozen 25-id live payload. */
function livePayload(): unknown {
  return JSON.parse(readFixture("live-models.json"));
}

function previous(): PreviousState {
  return { models: [], quarantine: [], deprecated: [] };
}

interface AttemptOverrides {
  readonly fetch?: ReconcileAttemptDeps["fetch"];
  readonly resolveKey?: ReconcileAttemptDeps["resolveKey"];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Build a full dep set with deterministic clock/scheduler and sane defaults. */
function makeAttempt(overrides: AttemptOverrides = {}): {
  readonly deps: ReconcileAttemptDeps;
  readonly clock: FakeClock;
  readonly scheduler: FakeScheduler;
} {
  const clock = new FakeClock(T0.getTime());
  const scheduler = new FakeScheduler(clock);
  const deps: ReconcileAttemptDeps = {
    fetch: overrides.fetch ?? failClosed(),
    resolveKey: overrides.resolveKey ?? (() => Promise.resolve(FAKE_KEY)),
    config: resolveConfig(Config({ ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }) })),
    previous: previous(),
    patches: parsePatchesFile(makePatches()),
    clock: { now: () => clock.now() },
    scheduler,
    signal: overrides.signal,
  };
  return { deps, clock, scheduler };
}

/** A fetch that throws for anything — the hard guard for unexpected traffic. */
function failClosed(): SyncFetch {
  return (url) => {
    throw new Error(`test guard: unexpected network URL ${url}`);
  };
}

/** Flush microtasks until a condition holds (deterministic, no real timers). */
async function flushUntil(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("test: condition not reached after microtask flushes");
}

describe("successful bounded attempt", () => {
  it("fetches exactly the models.dev map and the authenticated live endpoint", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { deps } = makeAttempt({ fetch: spy.fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.result.catalog.length).toBeGreaterThan(0);
    expect(outcome.result.catalog.every((model) => model.provider === "opencode-go")).toBe(true);
    // The synthetic live-only id lands in quarantine, never in the catalog.
    expect(outcome.result.catalog.some((model) => model.id === "synthetic-unknown-live-probe")).toBe(false);
    expect(outcome.result.quarantine.some((record) => record.id === "synthetic-unknown-live-probe")).toBe(true);
    // Both sources observed at the attempt's clock instant.
    expect(outcome.sources.modelsDevAt).toBe(T0.toISOString());
    expect(outcome.sources.liveAt).toBe(T0.toISOString());
    // Exactly one source pair executed, in order, with auth only on live.
    expect(spy.calls.map((call) => call.url)).toEqual([MODELS_DEV_API_URL, FIXTURE_LIVE_URL]);
    expect(spy.calls[0]?.headerNames).not.toContain("authorization");
    expect(spy.calls[1]?.headerNames).toContain("authorization");
  });

  it("sends the resolved credential to the live endpoint and never to models.dev", async () => {
    const seen: string[] = [];
    const fetch: SyncFetch = (url, init) => {
      if (url === MODELS_DEV_API_URL) {
        seen.push(init.headers?.authorization ?? "<none>");
        return Promise.resolve(jsonResponse(200, modelsDevMap()));
      }
      if (url === FIXTURE_LIVE_URL) {
        seen.push(init.headers?.authorization ?? "<none>");
        return Promise.resolve(jsonResponse(200, livePayload()));
      }
      throw new Error(`test guard: unexpected network URL ${url}`);
    };
    const { deps } = makeAttempt({ fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome.kind).toBe("ok");
    expect(seen).toEqual(["<none>", `Bearer ${FAKE_KEY}`]);
  });

  it("resolves the credential through the seam exactly once per attempt", async () => {
    let resolutions = 0;
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { deps } = makeAttempt({
      fetch: spy.fetch,
      resolveKey: () => {
        resolutions += 1;
        return Promise.resolve(FAKE_KEY);
      },
    });
    await attemptReconcile(deps);
    expect(resolutions).toBe(1);
  });
});

describe("credential failures happen before any network", () => {
  it("fails MISSING_CREDENTIAL with zero fetches", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { deps } = makeAttempt({
      fetch: spy.fetch,
      resolveKey: () => Promise.reject(new LlmError("no key", MISSING_CREDENTIAL_CODE)),
    });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toEqual({ kind: "failed", code: "MISSING_CREDENTIAL", message: expect.any(String) });
    expect(spy.calls).toEqual([]);
  });

  it("fails INVALID_CREDENTIAL with zero fetches", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { deps } = makeAttempt({
      fetch: spy.fetch,
      resolveKey: () => Promise.reject(new LlmError("bad key", INVALID_CREDENTIAL_CODE)),
    });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toEqual({ kind: "failed", code: "INVALID_CREDENTIAL", message: expect.any(String) });
    expect(spy.calls).toEqual([]);
  });
});

describe("source failures fail the whole attempt", () => {
  it("fails MODELS_DEV_HTTP_503 and never fetches live", async () => {
    const spy = makeFetch({
      modelsDev: { status: 503, body: { error: "unavailable" } },
      live: { status: 200, body: livePayload() },
    });
    const { deps } = makeAttempt({ fetch: spy.fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.code).toBe("MODELS_DEV_HTTP_503");
    expect(spy.calls.length).toBe(1);
  });

  it("fails LIVE_HTTP_401 without reconciling from the partial pair", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 401, body: { error: "unauthorized" } },
    });
    const { deps } = makeAttempt({ fetch: spy.fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.code).toBe("LIVE_HTTP_401");
    expect(spy.calls.length).toBe(2);
  });

  it("fails LIVE_HTTP_403 with the same no-partial-reconcile guarantee", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 403, body: { error: "forbidden" } },
    });
    const { deps } = makeAttempt({ fetch: spy.fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "LIVE_HTTP_403" });
  });

  it("fails MODELS_DEV_PARSE for a malformed models.dev payload", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, rawText: "{ not json" },
      live: { status: 200, body: livePayload() },
    });
    const { deps } = makeAttempt({ fetch: spy.fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "MODELS_DEV_PARSE" });
    expect(spy.calls.length).toBe(1);
  });

  it("fails LIVE_PARSE for a malformed live payload", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, rawText: '{"data": [{"id": 123}]}' },
    });
    const { deps } = makeAttempt({ fetch: spy.fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "LIVE_PARSE" });
  });

  it("fails NO_LIVE_BASE_URL when models.dev carries no provider api and skips live", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: { "opencode-go": { id: "opencode-go", name: "OpenCode Go", models: {} } } },
      live: { status: 200, body: livePayload() },
    });
    const { deps } = makeAttempt({ fetch: spy.fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "NO_LIVE_BASE_URL" });
    expect(spy.calls.length).toBe(1);
  });
});

describe("deadline and cancellation", () => {
  it("times out while models.dev hangs and never issues a live request", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap(), hang: true },
      live: { status: 200, body: livePayload(), hang: true },
    });
    const { deps, scheduler } = makeAttempt({ fetch: spy.fetch, timeoutMs: 10_000 });
    const promise = attemptReconcile(deps);
    // Let the key resolve and the models.dev hang start before advancing.
    await flushUntil(() => spy.calls.length === 1);
    scheduler.advance(10_000);
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    // The live URL only exists after models.dev is parsed, so a hung
    // models.dev leaves exactly one outstanding request.
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.aborted).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("times out with both sources outstanding once models.dev has resolved", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload(), hang: true },
    });
    const { deps, scheduler } = makeAttempt({ fetch: spy.fetch, timeoutMs: 10_000 });
    const promise = attemptReconcile(deps);
    // Let both fetches start (models.dev resolves, live hangs) before advancing.
    await flushUntil(() => spy.calls.length === 2);
    scheduler.advance(10_000);
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    expect(spy.calls.length).toBe(2);
    expect(spy.calls.every((call) => call.aborted)).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("fails ABORTED when the caller aborts a hung live request after models.dev resolves", async () => {
    const controller = new AbortController();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload(), hang: true },
    });
    const { deps, scheduler } = makeAttempt({ fetch: spy.fetch, signal: controller.signal, timeoutMs: 60_000 });
    const promise = attemptReconcile(deps);
    // Let both fetches start (models.dev resolves, live hangs), then abort.
    await flushUntil(() => spy.calls.length === 2);
    controller.abort();
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(spy.calls.length).toBe(2);
    expect(spy.calls.every((call) => call.aborted)).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("never leaves an armed deadline timer behind on success", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { deps, scheduler } = makeAttempt({ fetch: spy.fetch, timeoutMs: 10_000 });
    const outcome = await attemptReconcile(deps);
    expect(outcome.kind).toBe("ok");
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("deadline covers credential resolution", () => {
  it("times out a never-resolving credential seam with zero fetches", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { deps, scheduler } = makeAttempt({
      fetch: spy.fetch,
      resolveKey: () => new Promise<string>(() => undefined),
      timeoutMs: 10_000,
    });
    const promise = attemptReconcile(deps);
    await Promise.resolve();
    scheduler.advance(10_000);
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    expect(spy.calls).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  }, 5_000);

  it("aborts a never-resolving credential seam with zero fetches", async () => {
    const controller = new AbortController();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { deps, scheduler } = makeAttempt({
      fetch: spy.fetch,
      resolveKey: () => new Promise<string>(() => undefined),
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    const promise = attemptReconcile(deps);
    await Promise.resolve();
    controller.abort();
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(spy.calls).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  }, 5_000);

  it("never uses a credential that resolves after the deadline", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    let releaseKey: ((key: string) => void) | undefined;
    const keyPromise = new Promise<string>((resolve) => {
      releaseKey = resolve;
    });
    const { deps, scheduler } = makeAttempt({
      fetch: spy.fetch,
      resolveKey: () => keyPromise,
      timeoutMs: 10_000,
    });
    const promise = attemptReconcile(deps);
    await Promise.resolve();
    scheduler.advance(10_000);
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    // The late key value must never start a fetch or reconcile.
    releaseKey?.(FAKE_KEY);
    await Promise.resolve();
    expect(spy.calls).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  }, 5_000);

  it("keeps a fetch that ignores abort and resolves late from continuing the success path", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lateFetch: SyncFetch = async (url) => {
      if (url !== MODELS_DEV_API_URL) {
        throw new Error(`test guard: unexpected network URL ${url}`);
      }
      await gate;
      return jsonResponse(200, modelsDevMap());
    };
    const { deps, scheduler } = makeAttempt({ fetch: lateFetch, timeoutMs: 10_000 });
    const promise = attemptReconcile(deps);
    await Promise.resolve();
    scheduler.advance(10_000);
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    // The late models.dev response must never trigger the live follow-up.
    release?.();
    await Promise.resolve();
    expect(outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    expect(scheduler.pendingCount()).toBe(0);
  }, 5_000);
});

describe("deadline covers body readers and pre-aborted owners", () => {
  it("times out a hanging models.dev body reader with no live request", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap(), hangText: true },
      live: { status: 200, body: livePayload() },
    });
    const { deps, scheduler } = makeAttempt({ fetch: spy.fetch, timeoutMs: 10_000 });
    const promise = attemptReconcile(deps);
    await flushUntil(() => spy.calls.length === 1);
    scheduler.advance(10_000);
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "TIMEOUT" });
    // The unresolved models.dev body means the live request never exists.
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.aborted).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
  }, 5_000);

  it("aborts a hanging live body reader once models.dev has resolved", async () => {
    const controller = new AbortController();
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload(), hangText: true },
    });
    const { deps, scheduler } = makeAttempt({
      fetch: spy.fetch,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    const promise = attemptReconcile(deps);
    await flushUntil(() => spy.calls.length === 2);
    controller.abort();
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(spy.calls.length).toBe(2);
    expect(spy.calls.every((call) => call.aborted)).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
  }, 5_000);

  it("a pre-aborted owner signal causes zero credential calls and zero fetches", async () => {
    const controller = new AbortController();
    controller.abort();
    let keyCalls = 0;
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { deps, scheduler } = makeAttempt({
      fetch: spy.fetch,
      resolveKey: () => {
        keyCalls += 1;
        return Promise.resolve(FAKE_KEY);
      },
      signal: controller.signal,
    });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(keyCalls).toBe(0);
    expect(spy.calls).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("failure messages never echo injected text", () => {
  const MALICIOUS =
    "sk-literal-leak-abcdef authorization=Bearer bogus-token /Users/tangxingpeng/.dsh/cache/catalog.json {data:[id]}";
  it("credential error text is replaced by a fixed code message", async () => {
    const { deps } = makeAttempt({
      resolveKey: () => Promise.reject(new Error(MALICIOUS)),
    });
    const outcome = await attemptReconcile(deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).not.toContain("sk-literal-leak");
    expect(outcome.message).not.toContain("authorization");
    expect(outcome.message).not.toContain("/Users/");
  });

  it("fetch error text is replaced by a fixed code message", async () => {
    const hostile: SyncFetch = () => Promise.reject(new Error(MALICIOUS));
    const { deps } = makeAttempt({ fetch: hostile });
    const outcome = await attemptReconcile(deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).not.toContain("sk-literal-leak");
    expect(outcome.message).not.toContain("authorization");
    expect(outcome.message).not.toContain("/Users/");
    expect(outcome.message).not.toContain("data:[id]");
  });

  it("malformed-body messages never echo the raw payload", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, rawText: MALICIOUS },
      live: { status: 200, body: livePayload() },
    });
    const { deps } = makeAttempt({ fetch: spy.fetch });
    const outcome = await attemptReconcile(deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).not.toContain("sk-literal-leak");
    expect(outcome.message).not.toContain("/Users/");
  });
});

describe("cancellation observes seams without evaluating later ones", () => {
  it("raceCancellation observes an already-created promise even when pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let rejectLate: ((error: Error) => void) | undefined;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const outcome = await raceCancellation(promise, controller.signal, SYNC_DEADLINE_CODE);
    expect(outcome).toMatchObject({ kind: "cancelled", code: "ABORTED" });
    // The late rejection must be observed by the race, never an unhandled one.
    rejectLate?.(new Error("late fetch rejection"));
    await Promise.resolve();
    expect(outcome).toMatchObject({ kind: "cancelled", code: "ABORTED" });
  });

  it("an abort fired as the key resolves never evaluates the fetch seam", async () => {
    const controller = new AbortController();
    let fetchCalls = 0;
    const keyPromise = Promise.resolve(FAKE_KEY);
    void keyPromise.then(() => {
      controller.abort();
    });
    const fetch: SyncFetch = () => {
      fetchCalls += 1;
      return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve("{}") });
    };
    const { deps, scheduler } = makeAttempt({ fetch, resolveKey: () => keyPromise, signal: controller.signal });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(fetchCalls).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("an abort fired as the models.dev fetch resolves never evaluates text()", async () => {
    const controller = new AbortController();
    let textCalls = 0;
    const fetch: SyncFetch = (url) => {
      if (url !== MODELS_DEV_API_URL) throw new Error(`test guard: unexpected network URL ${url}`);
      const response = Promise.resolve({
        status: 200,
        ok: true,
        text: () => {
          textCalls += 1;
          return Promise.resolve(JSON.stringify(modelsDevMap()));
        },
      });
      void response.then(() => {
        controller.abort();
      });
      return response;
    };
    const { deps, scheduler } = makeAttempt({ fetch, signal: controller.signal });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(textCalls).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("an abort fired as models.dev text resolves never evaluates the authenticated live fetch", async () => {
    const controller = new AbortController();
    let liveCalls = 0;
    let seenAuthorization: string | undefined;
    const fetch: SyncFetch = (url, init) => {
      if (url === MODELS_DEV_API_URL) {
        const textPromise = Promise.resolve(JSON.stringify(modelsDevMap()));
        void textPromise.then(() => {
          controller.abort();
        });
        return Promise.resolve({ status: 200, ok: true, text: () => textPromise });
      }
      if (url === FIXTURE_LIVE_URL) {
        liveCalls += 1;
        seenAuthorization = init.headers?.authorization;
        return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(livePayload())) });
      }
      throw new Error(`test guard: unexpected network URL ${url}`);
    };
    const { deps, scheduler } = makeAttempt({ fetch, signal: controller.signal });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(liveCalls).toBe(0);
    expect(seenAuthorization).toBeUndefined();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("an abort fired as the live fetch resolves never evaluates live text()", async () => {
    const controller = new AbortController();
    let liveTextCalls = 0;
    const fetch: SyncFetch = (url) => {
      if (url === MODELS_DEV_API_URL) {
        return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(modelsDevMap())) });
      }
      if (url === FIXTURE_LIVE_URL) {
        const response = Promise.resolve({
          status: 200,
          ok: true,
          text: () => {
            liveTextCalls += 1;
            return Promise.resolve(JSON.stringify(livePayload()));
          },
        });
        void response.then(() => {
          controller.abort();
        });
        return response;
      }
      throw new Error(`test guard: unexpected network URL ${url}`);
    };
    const { deps, scheduler } = makeAttempt({ fetch, signal: controller.signal });
    const outcome = await attemptReconcile(deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "ABORTED" });
    expect(liveTextCalls).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
  });
});
