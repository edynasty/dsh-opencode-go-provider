/**
 * Task 6 service integration (red-first).
 *
 * The plugin mounts the SWR lifecycle behind the adapter: the injected
 * network and cache-home seams are resolved through the Cordis context, so a
 * booted plugin can never touch a real endpoint or a real DSH_HOME. Catalog
 * swaps happen through snapshot identity only — the provider route never
 * churns on refresh — and fiber disposal propagates to the lifecycle, which
 * aborts and settles the active source pair. Every test disposes its fiber
 * in a finally so real unref'd timers/effects never survive the test and the
 * temp-home cleanup never races an in-flight write.
 */
import { describe, expect, it } from "vitest";
import type { Fiber } from "@deepseek-ai/cordis";
import { boot, countTopologyAnnouncements, flushAsync } from "./helpers/context-harness.ts";
import { MODELS_DEV_API_URL } from "../src/sync.ts";
import type { SyncFetch } from "../src/sync.ts";
import { FIXTURE_LIVE_URL, makeFetch } from "./helpers/fake-network.ts";
import { readRepoFile } from "./helpers/catalog-fixtures.ts";

const FAKE_KEY = "sk-service-lifecycle-fake-key-0123456789";

function modelsDevMap(): unknown {
  return { "opencode-go": JSON.parse(readRepoFile("catalog/fixtures/models-dev-opencode-go.json")) };
}

function livePayload(): unknown {
  return JSON.parse(readRepoFile("catalog/fixtures/live-models.json"));
}

/** Wait (bounded) for a real-async condition; fails loudly on timeout. */
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("test: condition not met within the bound");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Dispose the plugin fiber, tolerating an already-disposed fiber. */
async function disposeFiber(fiber: Fiber): Promise<void> {
  try {
    await fiber.dispose();
  } catch {
    // a fiber that already disposed is a no-op for cleanup purposes
  }
}

describe("service network wiring", () => {
  it("routes the background refresh through the injected fetch, never a real endpoint", async () => {
    // Given: a booted plugin whose network seam is an injected source pair.
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const { fiber, llm } = await boot({ fetch: spy.fetch, credentials: { OPENCODE_GO_API_KEY: FAKE_KEY } });
    try {
      // When: the immediate background refresh runs after boot.
      await waitUntil(() => spy.calls.length === 2);
      // Then: exactly the two authoritative sources were requested in order,
      // auth reaching only the live endpoint.
      expect(spy.calls.map((call) => call.url)).toEqual([MODELS_DEV_API_URL, FIXTURE_LIVE_URL]);
      expect(spy.calls[0]?.headerNames).not.toContain("authorization");
      expect(spy.calls[1]?.headerNames).toContain("authorization");
      // And catalog browsing is served without ever blocking on the network.
      const models = await llm.listModels("opencode-go");
      expect(models.length).toBeGreaterThan(0);
    } finally {
      await disposeFiber(fiber);
    }
  });

  it("boots and serves the embedded catalog when the network is fail-closed", async () => {
    // Given: a booted plugin with the default fail-closed network guard.
    const { fiber, llm } = await boot();
    try {
      // Then: the route is live and catalog browsing works offline.
      const models = await llm.listModels("opencode-go");
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((model) => model.provider === "opencode-go")).toBe(true);
    } finally {
      await disposeFiber(fiber);
    }
  });
});

describe("route stability across catalog swaps", () => {
  it("never churns the provider route when a refresh swaps the catalog identity", async () => {
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap() },
      live: { status: 200, body: livePayload() },
    });
    const services = await boot({ fetch: spy.fetch, credentials: { OPENCODE_GO_API_KEY: FAKE_KEY } });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    try {
      // The immediate refresh swaps the catalog identity after boot.
      await waitUntil(() => spy.calls.length === 2);
      await flushAsync();
      // Then: the route set and directory are unchanged — catalog updates flow
      // through snapshot identity only, never registration churn.
      expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
      expect(llm.listConfigurableProviders().map((entry) => entry.provider)).toEqual(["opencode-go"]);
      expect(announced.count()).toBe(0);
    } finally {
      await disposeFiber(services.fiber);
    }
  });
});

describe("fiber disposal propagation", () => {
  it("fiber disposal aborts and settles the lifecycle's active source pair", async () => {
    // Given: a booted plugin whose immediate refresh hangs on both sources.
    const spy = makeFetch({
      modelsDev: { status: 200, body: modelsDevMap(), hang: true },
      live: { status: 200, body: livePayload(), hang: true },
    });
    const { fiber } = await boot({ fetch: spy.fetch, credentials: { OPENCODE_GO_API_KEY: FAKE_KEY } });
    // Let the immediate refresh start its hung fetch.
    await waitUntil(() => spy.calls.length >= 1);
    try {
      // When: the owning fiber disposes.
      await fiber.dispose();
      // Then: every outstanding fetch was aborted and no attempt escaped.
      expect(spy.calls.every((call) => call.aborted)).toBe(true);
    } finally {
      await disposeFiber(fiber);
    }
  });

  it("a recording fail-closed guard proves no URL escapes the injected seam", async () => {
    // Given: a guard that records every attempted URL and throws before any
    // socket exists (the default harness network).
    const attempted: string[] = [];
    const guard: SyncFetch = (url) => {
      attempted.push(url);
      throw new Error(`test guard: unexpected network URL ${url}`);
    };
    const { fiber, llm } = await boot({ fetch: guard, credentials: { OPENCODE_GO_API_KEY: FAKE_KEY } });
    try {
      await flushAsync();
      // Then: the lifecycle attempted refresh through the guard and catalog
      // browsing still serves the embedded snapshot.
      expect(attempted.length).toBeGreaterThan(0);
      expect(attempted.every((url) => url === MODELS_DEV_API_URL)).toBe(true);
      expect((await llm.listModels("opencode-go")).length).toBeGreaterThan(0);
    } finally {
      await disposeFiber(fiber);
    }
  });
});
