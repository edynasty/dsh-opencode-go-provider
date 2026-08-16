/**
 * Host coexistence contract (Task 12 owning-todo regression, red-first).
 *
 * The DSH web base bundle (`@deepseek-ai/dsh-llm-pi-ai`) declares EVERY
 * catalog apiKey provider in the configurable-provider directory, and its
 * native catalog ships `opencode-go` — so by the time this bundle mounts, the
 * directory already holds an `opencode-go` entry. This spec pins the
 * co-existence contract:
 *
 * 1. The plugin mounts WITHOUT the generic DUPLICATE_DIRECTORY failure: it
 *    adopts the foreign directory entry (no self-registration) and takes over
 *    the route through its own adapter + Connect/doctor surfaces.
 * 2. The directory holds exactly ONE `opencode-go` entry (the adopted one).
 * 3. The route's adapter is THIS bundle's (provider info + pre-network
 *    credential gate prove it), not the foreign entry's owner.
 * 4. Disposal of this bundle's fiber never withdraws the foreign entry (the
 *    base bundle still owns it).
 * 5. Without a foreign declaration the bundle still self-registers its own
 *    directory entry (unchanged solo contract).
 */
import { describe, expect, it } from "vitest";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type { LlmConfigurableProvider } from "@deepseek-ai/dsh-llm";
import { DISPLAY_NAME, PROVIDER_ROUTE } from "../src/contract.ts";
import {
  boot,
  bootServices,
  mountPlugin,
  streamCodes,
} from "./helpers/context-harness.ts";

/** The base-bundle directory entry for `opencode-go` (pi-ai catalog shape). */
const PI_AI_ENTRY: LlmConfigurableProvider = {
  provider: PROVIDER_ROUTE,
  displayName: "Pi AI",
  settingsNs: "llm-pi-ai",
  settingsPath: ["providers", PROVIDER_ROUTE],
  declared: true,
};

/** This bundle's own directory entry (self-registered solo shape). */
const OWN_ENTRY: LlmConfigurableProvider = {
  provider: PROVIDER_ROUTE,
  displayName: DISPLAY_NAME,
  settingsNs: "llm-opencode-go",
  settingsPath: [],
  declared: false,
};

describe("host coexistence with a pre-declared directory entry", () => {
  it("mounts without DUPLICATE_DIRECTORY and adopts the foreign entry", async () => {
    // Given: the base bundle already declared opencode-go in the directory.
    const services = await bootServices({ withCredentials: true });
    const foreign = services.ctx.llm.registerConfigurableProviders([PI_AI_ENTRY]);
    try {
      // When: this bundle mounts on the same runtime.
      const fiber = mountPlugin(services.ctx);
      await fiber;
      try {
        // Then: exactly one directory entry remains — the adopted foreign one.
        expect(services.llm.listConfigurableProviders()).toEqual([PI_AI_ENTRY]);
        // ...and exactly one adapter owns the route, this bundle's (its
        // display name, not the foreign entry's).
        expect(services.llm.listProviders()).toEqual([
          { id: PROVIDER_ROUTE, name: DISPLAY_NAME },
        ]);
        // ...and the pre-network credential gate is THIS bundle's adapter:
        // disconnected → MISSING_CREDENTIAL with zero network.
        expect(await streamCodes(services.llm)).toEqual(["MISSING_CREDENTIAL"]);
      } finally {
        await fiber.dispose();
      }
      // Then: disposing this bundle never withdraws the base-bundle entry.
      expect(services.llm.listConfigurableProviders()).toEqual([PI_AI_ENTRY]);
    } finally {
      foreign();
    }
  });

  it("self-registers beside an unrelated foreign route (unchanged guard)", async () => {
    // Given: only a DIFFERENT route is pre-declared by the base bundle.
    const services = await bootServices({ withCredentials: true });
    const foreign = services.ctx.llm.registerConfigurableProviders([
      { ...PI_AI_ENTRY, provider: "other-route" },
    ]);
    try {
      // When: this bundle mounts.
      const fiber = mountPlugin(services.ctx);
      // Then: it self-registers its own entry beside the foreign one.
      await fiber;
      try {
        expect(services.llm.listConfigurableProviders()).toEqual([
          { ...PI_AI_ENTRY, provider: "other-route" },
          OWN_ENTRY,
        ]);
      } finally {
        await fiber.dispose();
      }
    } finally {
      foreign();
    }
  });
});

describe("host standalone directory contract (no base bundle)", () => {
  it("self-registers exactly one opencode-go entry while disconnected", async () => {
    // Given: a bare harness with no foreign declaration.
    const { llm } = await boot({ withCredentials: true });
    // When: the configurable-provider directory is read.
    // Then: exactly one entry describes the route with its settings address.
    expect(llm.listConfigurableProviders()).toEqual([OWN_ENTRY]);
  });
});

describe("host registry behavior under a duplicate declaration", () => {
  it("rejects a second registration with DUPLICATE_DIRECTORY, all-or-nothing", async () => {
    // Given: the base-bundle entry is pre-declared.
    const services = await bootServices({ withCredentials: true });
    const foreign = services.ctx.llm.registerConfigurableProviders([PI_AI_ENTRY]);
    try {
      // When: a plain registration for the same route is attempted directly
      // on the runtime (the pre-fix path the plugin took).
      let failure: unknown;
      try {
        services.ctx.llm.registerConfigurableProviders([PI_AI_ENTRY]);
      } catch (error) {
        failure = error;
      }
      // Then: the host rejects with the generic code and stable message.
      expect(failure instanceof LlmError && failure.code).toBe("DUPLICATE_DIRECTORY");
      expect(failure instanceof Error && failure.message).toContain("already declared");
      // ...and the directory was left untouched (all-or-nothing).
      expect(services.llm.listConfigurableProviders()).toEqual([PI_AI_ENTRY]);
    } finally {
      foreign();
    }
  });
});
