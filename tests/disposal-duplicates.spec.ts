/**
 * Task 4 disposal and duplicate-ownership contract (red-first remediation
 * split). Disposal withdraws exactly the owned route/directory/namespace and
 * leaves foreign routes untouched; duplicate claims and a second mount fail
 * closed without disturbing the first registration.
 */
import { describe, expect, it } from "vitest";
import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { AdapterRegistrationHandle } from "@deepseek-ai/dsh-llm";
import { LlmError, LlmRuntime } from "@deepseek-ai/dsh-llm";
import { Config } from "../src/config.ts";
import { DIRECTORY_ENTRY, NS } from "../src/service.ts";
import {
  ForeignAdapter,
  boot,
  bootServices,
  countTopologyAnnouncements,
  flushAsync,
  mountPlugin,
  requireSettings,
} from "./helpers/context-harness.ts";

describe("disposal contract", () => {
  it("disposes exactly the owned route and directory entry, leaving foreign routes", async () => {
    // Given: a booted plugin plus a foreign adapter on an unrelated route.
    const services = await boot({ withCredentials: true });
    const { ctx, llm, fiber } = services;
    llm.registerAdapter(["deepseek-official"], new ForeignAdapter());
    // When: the plugin fiber disposes.
    await fiber.dispose();
    // Then: the owned route and directory entry are gone.
    expect(llm.listProviders().map((provider) => provider.id)).toEqual(["deepseek-official"]);
    expect(llm.listConfigurableProviders()).toEqual([]);
    // And the settings namespace registration is gone.
    expect(ctx.get("settings")?.get(NS)).toBeUndefined();
  });

  it("refuses replace on a disposed registration with a stable code", async () => {
    // Given: a registration owned by a disposable fiber, created through the
    // scoped context so its effects ride the plugin fiber.
    const ctx = new Context();
    new LlmRuntime(ctx);
    let handle: AdapterRegistrationHandle | undefined;
    const fiber: Fiber & PromiseLike<Fiber> = ctx.plugin((scoped) => {
      handle = scoped.llm.registerAdapter(["temp-route"], new ForeignAdapter());
    });
    await fiber;
    if (handle === undefined) throw new Error("test setup: registration handle missing");
    const registration = handle;
    // When: the owning fiber disposes and the handle is replaced.
    await fiber.dispose();
    expect(() => registration.replace(["temp-route"])).toThrow(LlmError);
    try {
      registration.replace(["temp-route"]);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error instanceof LlmError && error.code).toBe("REGISTRATION_DISPOSED");
    }
  });
});

describe("duplicate ownership fail-closed", () => {
  it("refuses a second adapter claiming the owned route", async () => {
    const { llm } = await boot({ withCredentials: true });
    try {
      llm.registerAdapter(["opencode-go"], new ForeignAdapter());
      throw new Error("expected rejection");
    } catch (error) {
      expect(error instanceof LlmError && error.code).toBe("DUPLICATE_ADAPTER");
    }
  });

  it("refuses a second directory declaration of the owned route", async () => {
    const { llm } = await boot({ withCredentials: true });
    try {
      llm.registerConfigurableProviders([
        { provider: "opencode-go", displayName: "Other", settingsNs: "other", settingsPath: [] },
      ]);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error instanceof LlmError && error.code).toBe("DUPLICATE_DIRECTORY");
    }
  });

  it("refuses a second mount of the plugin itself without disturbing the first", async () => {
    // Given: a booted plugin that already owns the route and directory.
    const services = await boot({ withSettings: true });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    const before = announced.count();
    // When: the same plugin is mounted a second time on the same context.
    const second = mountPlugin(ctx, Config({}));
    // Then: the second mount fails closed with zero additional announcements.
    try {
      await second;
      throw new Error("expected rejection");
    } catch {
      // expected: duplicate namespace or duplicate directory refusal
    }
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
    expect(llm.listConfigurableProviders().map((entry) => entry.provider)).toEqual([
      "opencode-go",
    ]);
    expect(announced.count()).toBe(before);
    expect(requireSettings(services).get(NS)).toBeDefined();
  });
});

describe("valid mount after an invalid mount leaves no leaked ownership", () => {
  it("succeeds once the invalid composition is corrected", async () => {
    // Given: host services without settings and an invalid first composition.
    const services = await bootServices({ withSettings: false, withCredentials: true });
    const { ctx, llm } = services;
    const first = mountPlugin(ctx, { apiKey: "sk-invalid-first-1234567890" });
    await expect(first).rejects.toThrow();
    // When: a valid composition mounts on the same context.
    const second = mountPlugin(ctx, Config({}));
    await second;
    // Then: exactly one route and one directory entry exist — nothing leaked.
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
    expect(llm.listConfigurableProviders().map((entry) => entry.provider)).toEqual([
      "opencode-go",
    ]);
    await second.dispose();
  });
});

describe("cross-registration rollback on failed mounts", () => {
  it("rejects when a foreign adapter owns the route and rolls back the new directory", async () => {
    // Given: a foreign adapter already owns opencode-go; no directory exists.
    const services = await bootServices({ withSettings: true });
    const { ctx, llm } = services;
    const settings = requireSettings(services);
    llm.registerAdapter(["opencode-go"], new ForeignAdapter());
    const foreignOwnership = llm.listProviders();
    const announced = countTopologyAnnouncements(ctx);
    const before = announced.count();
    // When: the plugin mounts and the adapter conflict rejects the fiber.
    const fiber = mountPlugin(ctx, {});
    await expect(fiber).rejects.toThrow();
    // Then: the failed mount left no plugin directory or namespace effect.
    expect(llm.listConfigurableProviders()).toEqual([]);
    expect(settings.get(NS)).toBeUndefined();
    // The transient directory was created and withdrawn exactly once each.
    expect(announced.count()).toBe(before + 2);
    const settled = announced.count();
    await flushAsync();
    // And the announcement count is stable: no async residual rollback.
    expect(announced.count()).toBe(settled);
    // The foreign adapter still owns the route, untouched.
    expect(llm.listProviders()).toEqual(foreignOwnership);
  });

  it("rejects when a foreign directory owns the route and rolls back the namespace", async () => {
    // Given: a foreign directory already declares opencode-go; no adapter.
    const services = await bootServices({ withSettings: true });
    const { ctx, llm } = services;
    const settings = requireSettings(services);
    llm.registerConfigurableProviders([{ ...DIRECTORY_ENTRY, displayName: "Foreign" }]);
    const foreignDirectory = llm.listConfigurableProviders();
    const announced = countTopologyAnnouncements(ctx);
    const before = announced.count();
    // When: the plugin mounts and the directory conflict rejects the fiber.
    const fiber = mountPlugin(ctx, {});
    await expect(fiber).rejects.toThrow();
    // Then: the failed mount left no plugin adapter or namespace effect.
    expect(llm.listProviders()).toEqual([]);
    expect(settings.get(NS)).toBeUndefined();
    // The conflict was refused before any topology was created: no announcements.
    expect(announced.count()).toBe(before);
    const settled = announced.count();
    await flushAsync();
    expect(announced.count()).toBe(settled);
    // The foreign directory entry is untouched.
    expect(llm.listConfigurableProviders()).toEqual(foreignDirectory);
  });
});
