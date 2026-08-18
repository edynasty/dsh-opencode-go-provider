/**
 * DSH Web client plugin: registers the OpenCode Go Connect card.
 *
 * `apply` rides the browser-plugin fiber: the locale dictionaries are
 * registered under `settings.opencode-go`, and the card is contributed to the
 * `settings.plugin.item` slot with the fetch-backed control remote — the same
 * registration shape the shipped web browser half uses against the public
 * `dsh-client-runtime`/`dsh-client-locale`/`dsh-client-ui-slots` services.
 * Fiber disposal removes both registrations.
 *
 * Since DSH rc.7, `settings.plugin.item` is a KEYED slot keyed by the settings
 * namespace a card edits. The configurable-plugins tab enumerates the settings
 * namespaces the Host serves and dispatches each namespace's card via
 * `renderSlot("settings.plugin.item", {}, { entryKey: ns })`, so a card is
 * paired only when its `key` equals a served namespace. This card registers
 * under `SETTINGS_NS` (the `llm-opencode-go` namespace this bundle owns on the
 * Host, see src/service.ts), so the tab pairs that namespace with this card.
 */
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { API_KEY_ENV, PLUGIN_NAME, PROVIDER_ROUTE, SETTINGS_NS } from "../contract.ts";
import { ConnectCard } from "./connect-card.tsx";
import type { ConnectCardProps } from "./connect-card.tsx";
import { createConnectRemote } from "./connect-remote.ts";
import type { ConnectRemote } from "./connect-remote.ts";
import type { ConnectCardKey } from "./locales.ts";
import { en, zh } from "./locales.ts";

export type { ConnectCardKey } from "./locales.ts";
export { ConnectCard } from "./connect-card.tsx";
export type { ConnectCardProps } from "./connect-card.tsx";
export { createConnectRemote, CONNECT_ROUTES } from "./connect-remote.ts";
export type {
  ClientConnectResult,
  ClientDisconnectResult,
  ClientDoctorSummary,
  ClientStatus,
  ConnectRemote,
} from "./connect-remote.ts";
export { en, zh } from "./locales.ts";

/** The card's business face injected by the slot registration. */
export interface ConnectCardInjected {
  readonly t: (key: ConnectCardKey) => string;
  readonly remote: ConnectRemote;
}

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "settings.opencode-go": ConnectCardKey;
  }
}

/** Stable browser-plugin name, namespaced to avoid colliding with the Host. */
export const name = `${PLUGIN_NAME}-client` as const;

/** DSH client services this bundle consumes (declared for the web host). */
export const inject = ["slots", "locale"] as const;

/** Locale namespace owning this card's copy. */
export const LOCALE_NS = "settings.opencode-go" as const;

/** Browser-plugin registration: locale copy + the Connect card slot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    `${PLUGIN_NAME}-client: settings copy`,
  );
  const t = ctx.locale.bind(LOCALE_NS);
  const remote = createConnectRemote();
  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: SETTINGS_NS,
        inject: (): ConnectCardInjected => ({ t, remote }),
      },
      ConnectCard,
    ),
  );
}

export interface ClientContract {
  readonly name: typeof name;
  readonly providerRoute: typeof PROVIDER_ROUTE;
  readonly apiKeyEnv: typeof API_KEY_ENV;
  readonly inject: readonly string[];
  readonly remoteRoutes: readonly string[];
}

/** Machine-consumed client contract surfaced by the `./client` entry. */
export const clientContract: ClientContract = {
  name,
  providerRoute: PROVIDER_ROUTE,
  apiKeyEnv: API_KEY_ENV,
  inject,
  remoteRoutes: ["status", "connect", "disconnect", "doctor"],
};
