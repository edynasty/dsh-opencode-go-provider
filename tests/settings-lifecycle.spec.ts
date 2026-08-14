/**
 * Task 4 settings lifecycle (red-first remediation split).
 *
 * Hot apply through the dynamic source with atomic `replace`, invalid writes
 * refused and rolled back, and the ordering regressions: an invalid composition
 * entry or an invalid already-persisted settings section must reject the mount
 * BEFORE any route/directory topology exists, with zero topology announcements
 * and no partial effects — never relying on the host's eventual rollback.
 */
import { describe, expect, it } from "vitest";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { NS } from "../src/service.ts";
import { isRecord } from "../src/guards.ts";
import {
  MemorySettings,
  boot,
  bootServices,
  countTopologyAnnouncements,
  flushAsync,
  mountPlugin,
  requireSettings,
} from "./helpers/context-harness.ts";

const FAKE_SECRET = "sk-literal-secret-value-abcdef";

/** Narrow the settings section's refreshMs without any cast. */
function refreshMsOf(settings: SettingsProvider): number {
  const value = settings.get(NS);
  if (!isRecord(value)) throw new Error("test setup: settings section is not an object");
  if (typeof value.refreshMs !== "number") throw new Error("test setup: refreshMs missing");
  return value.refreshMs;
}

describe("hot settings apply", () => {
  it("atomically re-registers on a committed settings change with no empty interval", async () => {
    // Given: a booted plugin whose settings section can be written.
    const services = await boot({ withSettings: true });
    const { ctx, llm } = services;
    const settings = requireSettings(services);
    const announced = countTopologyAnnouncements(ctx);
    const before = announced.count();
    // When: the section's intervals change and the write commits.
    await settings.update(NS, { refreshMs: 6_000_000, freshnessMs: 600_000 });
    await flushAsync();
    // Then: the swap was atomic — the route set is still exactly one owned route.
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
    expect(llm.listConfigurableProviders().map((entry) => entry.provider)).toEqual([
      "opencode-go",
    ]);
    // And the replacement announced itself exactly once.
    expect(announced.count()).toBe(before + 1);
  });
});

describe("invalid settings writes are refused and rolled back", () => {
  it("refuses an over-bound interval write and keeps the last good value", async () => {
    const services = await boot({ withSettings: true });
    const { llm } = services;
    const settings = requireSettings(services);
    await expect(settings.update(NS, { refreshMs: MAX_TIMER_DELAY_MS + 1 })).rejects.toThrow();
    // The last good value is preserved and the route set never dropped.
    expect(refreshMsOf(settings)).toBe(3_600_000);
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
  });

  it("refuses an unknown literal-secret key and never leaks its value", async () => {
    const services = await boot({ withSettings: true });
    const settings = requireSettings(services);
    try {
      await settings.update(NS, { apiKey: FAKE_SECRET });
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).toContain("apiKey");
      expect(String(error)).not.toContain(FAKE_SECRET);
    }
  });

  it("refuses an invalid credential reference at write time", async () => {
    const services = await boot({ withSettings: true });
    const settings = requireSettings(services);
    await expect(settings.update(NS, { apiKeyEnv: "not a ref!" })).rejects.toThrow();
  });

  it("refuses a cross-field violation at write time", async () => {
    const services = await boot({ withSettings: true });
    const settings = requireSettings(services);
    // refreshMs shrinks below the stored freshnessMs (300_000 default).
    await expect(settings.update(NS, { refreshMs: 60_000 })).rejects.toThrow(/refreshMs/);
  });
});

describe("settings attach and detach", () => {
  it("falls back to the composition entry when no settings service exists", async () => {
    // Given: a booted plugin with no settings service mounted.
    const { llm } = await boot({ withSettings: false });
    // Then: the route and directory still register from the composition entry.
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
    expect(llm.listConfigurableProviders().map((entry) => entry.provider)).toEqual([
      "opencode-go",
    ]);
  });

  it("attaches to a settings service mounted later and detaches cleanly", async () => {
    // Given: a booted plugin without settings, then a settings service appears.
    const services = await boot({ withSettings: false });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    const before = announced.count();
    const settingsFiber = await ctx.plugin(MemorySettings, {
      "llm-opencode-go": { refreshMs: 7_200_000 },
    });
    await flushAsync();
    // When: the settings scope becomes authoritative.
    const settings = ctx.get("settings");
    if (settings === undefined) throw new Error("test setup: settings service missing");
    // Then: the section resolves and the source switch re-announced the routes.
    expect(refreshMsOf(settings)).toBe(7_200_000);
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
    expect(announced.count()).toBe(before + 1);
    // When: the settings service detaches.
    await settingsFiber.dispose();
    await flushAsync();
    // Then: the route set stays (fallback to the composition entry) and the
    // namespace registration is gone.
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
    expect(settings.get(NS)).toBeUndefined();
  });
});

describe("invalid composition entry is rejected before topology", () => {
  it("rejects an unknown literal-secret field with zero registration", async () => {
    // Given: host services without settings, so the composition is the source.
    const services = await bootServices({ withSettings: false, withCredentials: true });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    // When: the plugin mounts with an invalid composition entry.
    const fiber = mountPlugin(ctx, { apiKey: FAKE_SECRET });
    try {
      await fiber;
      throw new Error("expected rejection");
    } catch (error) {
      // Then: the rejection names the key, never the secret value.
      expect(String(error)).toContain("apiKey");
      expect(String(error)).not.toContain(FAKE_SECRET);
    }
    // And no topology was created and no announcement was made.
    expect(llm.listProviders()).toEqual([]);
    expect(llm.listConfigurableProviders()).toEqual([]);
    expect(announced.count()).toBe(0);
  });

  it("rejects an invalid apiKeyEnv reference with zero registration", async () => {
    const services = await bootServices({ withSettings: false, withCredentials: true });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    const fiber = mountPlugin(ctx, { apiKeyEnv: "not a ref!" });
    await expect(fiber).rejects.toThrow();
    expect(llm.listProviders()).toEqual([]);
    expect(llm.listConfigurableProviders()).toEqual([]);
    expect(announced.count()).toBe(0);
  });

  it("rejects a cross-field violation with zero registration", async () => {
    const services = await bootServices({ withSettings: false, withCredentials: true });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    const fiber = mountPlugin(ctx, { refreshMs: 60_000, freshnessMs: 120_000 });
    await expect(fiber).rejects.toThrow();
    expect(llm.listProviders()).toEqual([]);
    expect(llm.listConfigurableProviders()).toEqual([]);
    expect(announced.count()).toBe(0);
  });
});

describe("invalid persisted settings section is rejected before topology", () => {
  it("rejects an unknown literal-secret stored section, rolls back, and allows a repaired remount", async () => {
    // Given: a settings service whose stored section contains a literal secret.
    const doc: Record<string, unknown> = { "llm-opencode-go": { apiKey: FAKE_SECRET } };
    const services = await bootServices({ settingsDoc: doc });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    // When: the plugin mounts against that stored section.
    const fiber = mountPlugin(ctx, {});
    try {
      await fiber;
      throw new Error("expected rejection");
    } catch (error) {
      // Then: the rejection names the key, never the stored secret.
      expect(String(error)).toContain("apiKey");
      expect(String(error)).not.toContain(FAKE_SECRET);
    }
    // And the mount left zero topology, zero announcements, and no partial
    // namespace effect (the provider keeps its prior state).
    expect(llm.listProviders()).toEqual([]);
    expect(llm.listConfigurableProviders()).toEqual([]);
    expect(announced.count()).toBe(0);
    const settings = requireSettings(services);
    expect(settings.get(NS)).toBeUndefined();
    // The stored document was not touched by the failed mount.
    expect(doc["llm-opencode-go"]).toEqual({ apiKey: FAKE_SECRET });
    // When: the document is repaired, a second mount succeeds with one route.
    doc["llm-opencode-go"] = { refreshMs: 60_000, freshnessMs: 30_000, timeoutMs: 10_000 };
    const second = mountPlugin(ctx, {});
    await second;
    expect(llm.listProviders()).toEqual([{ id: "opencode-go", name: "OpenCode Go" }]);
    expect(llm.listConfigurableProviders().map((entry) => entry.provider)).toEqual([
      "opencode-go",
    ]);
    await second.dispose();
  });

  it("rejects an invalid stored credential reference before topology", async () => {
    const doc: Record<string, unknown> = { "llm-opencode-go": { apiKeyEnv: "not a ref!" } };
    const services = await bootServices({ settingsDoc: doc });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    const fiber = mountPlugin(ctx, {});
    await expect(fiber).rejects.toThrow();
    expect(llm.listProviders()).toEqual([]);
    expect(llm.listConfigurableProviders()).toEqual([]);
    expect(announced.count()).toBe(0);
    expect(requireSettings(services).get(NS)).toBeUndefined();
  });

  it("rejects an invalid stored cross-field section before topology", async () => {
    const doc: Record<string, unknown> = {
      "llm-opencode-go": { refreshMs: 60_000, freshnessMs: 120_000 },
    };
    const services = await bootServices({ settingsDoc: doc });
    const { ctx, llm } = services;
    const announced = countTopologyAnnouncements(ctx);
    const fiber = mountPlugin(ctx, {});
    await expect(fiber).rejects.toThrow();
    expect(llm.listProviders()).toEqual([]);
    expect(llm.listConfigurableProviders()).toEqual([]);
    expect(announced.count()).toBe(0);
    expect(requireSettings(services).get(NS)).toBeUndefined();
  });
});
