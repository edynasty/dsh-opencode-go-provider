//#region src/contract.d.ts
/** DSH credentials environment variable resolved at operation time. */
declare const API_KEY_ENV: "OPENCODE_GO_API_KEY";
/** Provider route registered on ctx.llm and addressed by the settings card. */
declare const PROVIDER_ROUTE: "opencode-go";
//#endregion
//#region src/client/index.d.ts
/** Stable browser-plugin name, namespaced to avoid colliding with the Host. */
declare const name: "dsh-opencode-go-provider-client";
interface ClientContract {
  readonly name: typeof name;
  readonly providerRoute: typeof PROVIDER_ROUTE;
  readonly apiKeyEnv: typeof API_KEY_ENV;
}
/** Machine-consumed client contract surfaced by the `./client` entry. */
declare const clientContract: ClientContract;
//#endregion
export { ClientContract, clientContract, name };