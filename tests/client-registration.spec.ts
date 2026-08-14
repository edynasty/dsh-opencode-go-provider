/**
 * Task 7 browser-plugin registration contract (red-first).
 *
 * `apply` uses the REAL public DSH client services — the `SlotRegistry`
 * (dsh-client-runtime) and `LocaleRuntime` (dsh-client-locale) — exactly like
 * the shipped dsh-codex-connect browser half: the locale dictionaries are
 * registered under `settings.opencode-go`, and the Connect card is
 * contributed to the `settings.plugin.item` slot with the fetch-backed
 * control remote. Fiber disposal withdraws both registrations.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Context, type Fiber } from "@deepseek-ai/cordis";
import { apply, inject, LOCALE_NS } from "../src/client/index.tsx";
import { loadClientModules } from "./helpers/client-bundles.ts";

type LoadedModules = Awaited<ReturnType<typeof loadClientModules>>;

interface MountedClient {
  readonly fiber: Fiber;
  readonly slots: InstanceType<LoadedModules["SlotRegistry"]>;
  readonly locale: InstanceType<LoadedModules["LocaleRuntime"]>;
}

async function mountClient(): Promise<MountedClient> {
  const { SlotRegistry, LocaleRuntime } = await loadClientModules();
  const ctx = new Context();
  await ctx.plugin(SlotRegistry);
  const slots = ctx.get("slots");
  if (!(slots instanceof SlotRegistry)) {
    throw new Error("test setup: SlotRegistry was not mounted");
  }
  // Declare the plugin-item slot the way the settings UI declares it: as a
  // child of the root seat, so the registration is not deferred. The marker
  // property is the slot contract's RendersCheck for a declared child.
  const rootSeat = Object.assign(() => null, {
    "children declared but the component consumes no renderSlot": "settings.plugin.item",
  } as const);
  slots.register(
    { name: "root", children: { "settings.plugin.item": { kind: "list", scope: "root" } } },
    rootSeat,
  );
  const locale = new LocaleRuntime(ctx);
  ctx.provide("locale", locale);
  const fiber = ctx.plugin({ inject, apply });
  await fiber;
  return { fiber, slots, locale };
}

async function disposeFiber(fiber: Fiber): Promise<void> {
  try {
    await fiber.dispose();
  } catch {
    // an already-disposed fiber is a no-op for cleanup purposes
  }
}

describe("client registration", () => {
  it("registers the locale namespace with bilingual dictionaries", async () => {
    const { fiber, locale } = await mountClient();
    try {
      const translate = locale.bind(LOCALE_NS);
      expect(translate("title")).toBe("OpenCode Go");
      expect(translate("connect")).toBe("Connect");
      expect(translate("disconnect")).toBe("Disconnect");
    } finally {
      await disposeFiber(fiber);
    }
  });

  it("registers the Connect card into the settings.plugin.item slot", async () => {
    const { fiber, slots } = await mountClient();
    try {
      const entries = slots.entries("settings.plugin.item");
      expect(entries).toHaveLength(1);
      const first = entries[0];
      if (first === undefined) throw new Error("test: expected one slot entry");
      expect(first.options.id).toBe("opencode-go");
    } finally {
      await disposeFiber(fiber);
    }
  });

  it("disposal of the plugin fiber withdraws the locale and slot registrations", async () => {
    const { fiber, slots, locale } = await mountClient();
    expect(slots.entries("settings.plugin.item")).toHaveLength(1);
    await disposeFiber(fiber);
    expect(slots.entries("settings.plugin.item")).toHaveLength(0);
    // The locale namespace is unregistered: the fallback renders the key itself.
    expect(locale.bind(LOCALE_NS)("title")).toBe("title");
  });
});
