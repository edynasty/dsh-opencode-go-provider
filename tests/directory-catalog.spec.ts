/**
 * Task 4 directory/adapter/catalog contract (red-first remediation split).
 *
 * Reads public host observables (`listProviders`, `listConfigurableProviders`,
 * `listModels`, `resolveModelInfo`, `stream`) through the real `LlmRuntime`:
 * exactly one directory entry and one owned route, catalog browsing with zero
 * credential, and the pre-network credential gate on generation.
 */
import { describe, expect, it } from "vitest";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { withResolvedKey } from "../src/credentials.ts";
import { Config } from "../src/config.ts";
import { embeddedCatalogModels } from "../src/catalog-loader.ts";
import { UNKNOWN_MODEL } from "../src/errors.ts";
import { OpenCodeGoAdapter } from "../src/adapter.ts";
import { boot, requireCredentials, streamCodes } from "./helpers/context-harness.ts";

const MISSING_CREDENTIAL = "MISSING_CREDENTIAL";
const FAKE_SECRET_A = "sk-fake-secret-a-0123456789";

describe("provider directory contract", () => {
  it("registers exactly one opencode-go entry even while disconnected", async () => {
    // Given: a booted plugin with no credential stored anywhere.
    const { llm } = await boot({ withCredentials: true });
    // When: the configurable-provider directory is read.
    const entries = llm.listConfigurableProviders();
    // Then: exactly one entry describes the route with its settings address.
    expect(entries).toEqual([
      {
        provider: "opencode-go",
        displayName: "OpenCode Go",
        settingsNs: "llm-opencode-go",
        settingsPath: [],
        declared: false,
      },
    ]);
  });
});

describe("adapter registration contract", () => {
  it("registers exactly one owned adapter route", async () => {
    const { llm } = await boot({ withCredentials: true });
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
  });
});

describe("catalog browsing while disconnected", () => {
  it("serves the embedded catalog without any credential", async () => {
    const { llm } = await boot({ withCredentials: true });
    const models = await llm.listModels("opencode-go");
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.provider).toBe("opencode-go");
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.name.length).toBeGreaterThan(0);
    }
    // Catalog order is deterministic: ids ascending.
    const ids = models.map((model) => model.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("rejects browsing an unowned provider route", async () => {
    const { llm } = await boot({ withCredentials: true });
    try {
      await llm.listModels("not-ours");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error instanceof LlmError && error.code).toBe("NO_ADAPTER");
    }
  });

  it("resolves exact model metadata from the embedded catalog", async () => {
    const { llm } = await boot({ withCredentials: true });
    const models = embeddedCatalogModels();
    const known = models[0];
    if (known === undefined) throw new Error("test setup: embedded catalog is empty");
    const resolved = await llm.resolveModelInfo("opencode-go", known.id);
    expect(resolved.provider).toBe("opencode-go");
    expect(resolved.id).toBe(known.id);
    expect(resolved.context?.contextWindow).toBeGreaterThan(0);
  });
});

describe("stream credential gate (end to end)", () => {
  it("throws MISSING_CREDENTIAL before network when disconnected", async () => {
    const { llm } = await boot({ withCredentials: true });
    expect(await streamCodes(llm)).toEqual([MISSING_CREDENTIAL]);
  });

  it("throws INVALID_CREDENTIAL for a non-canonical stored key", async () => {
    // Given: a credentials service holding a whitespace-padded key.
    const { llm, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(credentialRef("OPENCODE_GO_API_KEY"), `  ${FAKE_SECRET_A}  `);
    // When: a stream runs over the real runtime.
    const codes = await streamCodes(llm);
    // Then: the failure is INVALID_CREDENTIAL with zero network (no other chunk).
    expect(codes).toEqual(["INVALID_CREDENTIAL"]);
  });

  it("passes the credential gate and drives the real adapter once a valid key exists", async () => {
    // Given: a valid stored credential and an already-cancelled request.
    const { llm, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(credentialRef("OPENCODE_GO_API_KEY"), FAKE_SECRET_A);
    const controller = new AbortController();
    controller.abort();
    // When: a generation stream is requested through the real runtime.
    const codes = await streamCodes(llm, { signal: controller.signal });
    // Then: the Task 5 adapter (not the placeholder seam) takes the request —
    // the pre-cancelled signal yields a deterministic ABORTED finish with zero
    // network, whereas the placeholder refused with NOT_IMPLEMENTED.
    expect(codes).toEqual(["ABORTED"]);
  });
});

describe("adapter per-operation resolution", () => {
  it("resolves the current config snapshot on every operation", async () => {
    // Given: an adapter whose config source can be swapped (the dynamic source).
    let source = Config({ apiKeyEnv: "OPENCODE_GO_API_KEY" });
    const resolved: string[] = [];
    const adapter = new OpenCodeGoAdapter({
      currentConfig: () => source,
      resolveKey: (ref) => {
        resolved.push(ref);
        return Promise.resolve(FAKE_SECRET_A);
      },
      catalog: () => embeddedCatalogModels(),
    });
    // When: operations run before and after a hot config change.
    const failCode = async (): Promise<string> => {
      try {
        for await (const _chunk of adapter.stream({
          provider: "opencode-go",
          model: "no-such-catalog-model",
          messages: [],
        })) {
          // the stream must never yield a chunk before the gate fails
        }
        throw new Error("expected rejection");
      } catch (error) {
        return error instanceof LlmError ? error.code : "NO_CODE";
      }
    };
    expect(await failCode()).toBe(UNKNOWN_MODEL);
    source = Config({ apiKeyEnv: "OPENCODE_GO_ALT_KEY" });
    expect(await failCode()).toBe(UNKNOWN_MODEL);
    // Then: each operation resolved the reference active at that moment.
    expect(resolved).toEqual(["OPENCODE_GO_API_KEY", "OPENCODE_GO_ALT_KEY"]);
  });

  it("gates through the live credential resolver on every operation", async () => {
    // Given: a live context whose stored key rotates between operations.
    const { ctx, credentials } = await boot({ withCredentials: true });
    const store = requireCredentials({ credentials });
    await store.set(credentialRef("OPENCODE_GO_API_KEY"), FAKE_SECRET_A);
    const seen: string[] = [];
    const run = (): Promise<string> =>
      withResolvedKey(ctx, credentialRef("OPENCODE_GO_API_KEY"), async (key) => {
        seen.push(key);
        return key;
      });
    await run();
    await store.set(credentialRef("OPENCODE_GO_API_KEY"), "sk-fake-secret-b-9876543210");
    await run();
    // Then: the two operations saw A then B, never a cached value.
    expect(seen).toEqual([FAKE_SECRET_A, "sk-fake-secret-b-9876543210"]);
  });
});
