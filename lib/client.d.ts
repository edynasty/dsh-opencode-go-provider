import { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
//#region src/contract.d.ts
/** DSH credentials environment variable resolved at operation time. */
declare const API_KEY_ENV: "OPENCODE_GO_API_KEY";
/** Provider route registered on ctx.llm and addressed by the settings card. */
declare const PROVIDER_ROUTE: "opencode-go";
//#endregion
//#region src/client/connect-remote.d.ts
/** Plugin-owned same-origin routes; the Host registers them on `ctx.webServer`. */
declare const CONNECT_ROUTES: {
  readonly status: "/plugins/dsh-opencode-go/status";
  readonly connect: "/plugins/dsh-opencode-go/connect";
  readonly disconnect: "/plugins/dsh-opencode-go/disconnect";
  readonly doctor: "/plugins/dsh-opencode-go/doctor";
};
type ClientConnectResult = {
  readonly kind: "connected";
} | {
  readonly kind: "invalid";
  readonly message: string;
} | {
  readonly kind: "store-failed";
  readonly message: string;
};
type ClientDisconnectResult = {
  readonly kind: "disconnected";
} | {
  readonly kind: "store-failed";
  readonly message: string;
};
type ClientDoctorSummary = {
  readonly kind: "configured";
  readonly liveModelCount: number;
} | {
  readonly kind: "unconfigured";
} | {
  readonly kind: "unavailable";
} | {
  readonly kind: "failed";
  readonly code: string;
};
interface ClientStatus {
  readonly configured: boolean;
  readonly origin: "embedded" | "cache" | "refreshed" | "corrupt";
  readonly modelCount: number;
  readonly refreshedAt: string;
  readonly lastAttempt: {
    readonly kind: "ok";
  } | {
    readonly kind: "failed";
    readonly code: string;
  } | {
    readonly kind: "none";
  };
}
/** The credential/status/doctor surface the Host exposes to the card. */
interface ConnectRemote {
  readonly connect: (key: string) => Promise<ClientConnectResult>;
  readonly disconnect: () => Promise<ClientDisconnectResult>;
  readonly status: () => Promise<ClientStatus>;
  readonly doctor: () => Promise<ClientDoctorSummary>;
}
/** The fetch-backed remote wired by the browser-plugin registration. */
declare function createConnectRemote(): ConnectRemote;
//#endregion
//#region src/client/locales.d.ts
/**
 * Bilingual Connect card copy, following the DSH client locale convention
 * (a plain `en` dictionary plus a `zh` mirror typed by its keys).
 */
/** English copy for the OpenCode Go Connect card. */
declare const en: {
  readonly title: "OpenCode Go";
  readonly intro: "Connect your OpenCode Go API key.";
  readonly keyLabel: "API key";
  readonly keyPlaceholder: "sk-…";
  readonly keyHelp: "The key is stored through DSH credentials and is never shown again.";
  readonly connected: "Connected";
  readonly notConnected: "Not connected";
  readonly connect: "Connect";
  readonly testConnection: "Test connection";
  readonly disconnect: "Disconnect";
  readonly loading: "Loading…";
  readonly invalidKey: "The provided key was refused before storing.";
  readonly storeFailed: "The credential could not be stored.";
  readonly statusUnavailable: "The status could not be loaded.";
  readonly testResultPrefix: "Live /models reports ";
  readonly testUnconfigured: "No credential configured; connect first.";
  readonly testUnavailable: "No usable live endpoint in the current catalog.";
  readonly testFailed: "Connection test failed.";
};
/** Keys shared by both dictionaries. */
type ConnectCardKey = keyof typeof en;
/** Chinese copy for the OpenCode Go Connect card. */
declare const zh: { [Key in ConnectCardKey]: string; };
//#endregion
//#region src/client/connect-card.d.ts
interface ConnectCardProps {
  readonly remote: ConnectRemote;
  readonly t: (key: ConnectCardKey) => string;
}
/**
 * The Connect card. The key input value lives only in local state and reaches
 * exactly one destination: `remote.connect`. Every action — resolved or
 * rejected — clears it; the unmount cleanup only cancels in-flight reads and
 * never updates state.
 */
declare function ConnectCard({ remote, t }: ConnectCardProps): JSX.Element;
//#endregion
//#region src/client/index.d.ts
/** The card's business face injected by the slot registration. */
interface ConnectCardInjected {
  readonly t: (key: ConnectCardKey) => string;
  readonly remote: ConnectRemote;
}
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "settings.opencode-go": ConnectCardKey;
  }
}
/** Stable browser-plugin name, namespaced to avoid colliding with the Host. */
declare const name: "dsh-opencode-go-provider-client";
/** DSH client services this bundle consumes (declared for the web host). */
declare const inject: readonly ["slots", "locale"];
/** Locale namespace owning this card's copy. */
declare const LOCALE_NS: "settings.opencode-go";
/** Browser-plugin registration: locale copy + the Connect card slot. */
declare function apply(ctx: ClientContext): void;
interface ClientContract {
  readonly name: typeof name;
  readonly providerRoute: typeof PROVIDER_ROUTE;
  readonly apiKeyEnv: typeof API_KEY_ENV;
  readonly inject: readonly string[];
  readonly remoteRoutes: readonly string[];
}
/** Machine-consumed client contract surfaced by the `./client` entry. */
declare const clientContract: ClientContract;
//#endregion
export { CONNECT_ROUTES, type ClientConnectResult, ClientContract, type ClientDisconnectResult, type ClientDoctorSummary, type ClientStatus, ConnectCard, ConnectCardInjected, type ConnectCardKey, type ConnectCardProps, type ConnectRemote, LOCALE_NS, apply, clientContract, createConnectRemote, en, inject, name, zh };